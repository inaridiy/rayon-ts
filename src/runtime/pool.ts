/**
 * Main-thread side of the worker pool. A pool is single-job-at-a-time and is
 * discarded after any timeout, worker exit, publish failure, or protocol
 * violation. That rule prevents an abandoned epoch from corrupting the next.
 */
import { availableParallelism } from "node:os";
import {
  MessageChannel,
  type MessagePort,
  receiveMessageOnPort,
  Worker,
} from "node:worker_threads";
import { workerSource } from "../generated/workerSource.js";
import { isRayonWorker } from "./context.js";
import { KernelRuntimeError, RayonError, RayonTimeoutError } from "./errors.js";
import {
  CTRL,
  CTRL_LEN,
  type JobMessage,
  type KernelSource,
  type KernelSourceId,
  type ResultMessage,
} from "./protocol.js";
import { transferList } from "./transfer.js";

type DispatchJob = Omit<JobMessage, "type" | "epoch" | "sources">;

export interface FollowUpDispatch {
  job: DispatchJob;
  sources: Map<KernelSourceId, KernelSource>;
}

type FollowUpFactory =
  | ((results: ResultMessage[]) => FollowUpDispatch)
  | undefined;

export interface RayonConfig {
  /** Worker count. 0 is sequential. Default: min(cores - 1, 8). */
  threads?: number;
  /** Elements claimed per atomic cursor update. Default: adaptive per job. */
  chunkSize?: number;
  /** Per-job deadline in ms; a timeout discards the pool. Default: 120_000. */
  timeoutMs?: number;
  /** Worker startup deadline used by initThreadPool(). Default: 10_000. */
  startupTimeoutMs?: number;
}

let config: RayonConfig = {};
let pool: Pool | null | undefined; // undefined = absent, null = sequential
let configurationLocked = false;

function assertNonNegativeInt(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RayonError(`${name} must be a non-negative safe integer, got ${value}`);
  }
}

function assertPositiveInt(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RayonError(`${name} must be a positive safe integer, got ${value}`);
  }
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RayonError(`${name} must be a positive finite number, got ${value}`);
  }
}

function validateConfig(cfg: RayonConfig): void {
  if (cfg.threads !== undefined) assertNonNegativeInt(cfg.threads, "threads");
  if (cfg.chunkSize !== undefined) assertPositiveInt(cfg.chunkSize, "chunkSize");
  if (cfg.timeoutMs !== undefined) assertPositiveFinite(cfg.timeoutMs, "timeoutMs");
  if (cfg.startupTimeoutMs !== undefined) {
    assertPositiveFinite(cfg.startupTimeoutMs, "startupTimeoutMs");
  }
}

export function configureRayon(cfg: RayonConfig): void {
  if (configurationLocked) {
    throw new RayonError("configureRayon() must be called before the first parallel operation");
  }
  validateConfig(cfg);
  config = { ...config, ...cfg };
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new RayonError(`${name} must be a finite number, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function envNonNegativeInt(name: string): number | undefined {
  const value = envNumber(name);
  if (value === undefined) return undefined;
  assertNonNegativeInt(value, name);
  return value;
}

function envPositiveInt(name: string): number | undefined {
  const value = envNumber(name);
  if (value === undefined) return undefined;
  assertPositiveInt(value, name);
  return value;
}

function envPositiveFinite(name: string): number | undefined {
  const value = envNumber(name);
  if (value === undefined) return undefined;
  assertPositiveFinite(value, name);
  return value;
}

function resolveThreads(): number {
  // A kernel can statically import rayon-ts and therefore bundle another copy
  // of this module. Never let that copy recursively spawn a child pool.
  if (isRayonWorker()) return 0;
  if (process.env.RAYON_SEQUENTIAL === "1") return 0;
  return (
    config.threads ??
    envNonNegativeInt("RAYON_NUM_THREADS") ??
    Math.min(8, Math.max(0, availableParallelism() - 1))
  );
}

function resolveTimeoutMs(): number {
  return config.timeoutMs ?? envPositiveFinite("RAYON_TIMEOUT_MS") ?? 120_000;
}

function resolveStartupTimeoutMs(): number {
  return config.startupTimeoutMs ?? 10_000;
}

function workerExecArgv(): string[] {
  const sanitized: string[] = [];
  for (let index = 0; index < process.execArgv.length; index++) {
    const argument = process.execArgv[index]!;
    if (argument === "--input-type") {
      index += 1;
      continue;
    }
    if (argument.startsWith("--input-type=")) continue;
    sanitized.push(argument);
  }
  return sanitized;
}

/** Resolves sequential mode without spawning workers. */
export function isSequentialMode(): boolean {
  return resolveThreads() === 0;
}

/** Returns a healthy pool, or null when running in sequential mode. */
export function getPool(): Pool | null {
  configurationLocked = true;
  if (pool instanceof Pool && !pool.isUsable()) pool = undefined;
  if (pool === undefined) {
    const threads = resolveThreads();
    pool = threads === 0 ? null : new Pool(threads);
  }
  return pool;
}

/** Terminates the current pool. A later operation lazily creates a fresh one. */
export async function shutdownThreadPool(): Promise<void> {
  const current = pool;
  pool = undefined;
  if (current instanceof Pool) await current.close();
}

export function defaultChunk(total: number, workers: number): number {
  const configured = config.chunkSize ?? envPositiveInt("RAYON_CHUNK");
  if (configured !== undefined) return configured;
  return Math.max(1, Math.min(65_536, Math.ceil(total / (workers * 8))));
}

export interface JobStats {
  workers: number;
  threadsUsed: number;
}

let lastStats: JobStats | null = null;

/** Diagnostics for the most recent completed parallel job. */
export function rayonStats(): JobStats | null {
  return lastStats;
}

type PoolState = "healthy" | "broken" | "closing" | "closed";

export class Pool {
  readonly size: number;
  private readonly ctrl: Int32Array<SharedArrayBuffer>;
  private readonly ports: MessagePort[] = [];
  private readonly workers: Worker[] = [];
  private readonly sentSources: Set<KernelSourceId>[];
  private epoch = 0;
  private state: PoolState = "healthy";
  private failure: Error | undefined;
  private asyncPending = 0;
  private asyncTail: Promise<void> = Promise.resolve();

  constructor(size: number) {
    assertPositiveInt(size, "worker pool size");
    this.size = size;
    this.ctrl = new Int32Array(new SharedArrayBuffer(CTRL_LEN * 4));
    this.sentSources = Array.from({ length: size }, () => new Set());
    try {
      for (let i = 0; i < size; i++) {
        const { port1, port2 } = new MessageChannel();
        const worker = new Worker(workerSource, {
          eval: true,
          // An eval worker is CommonJS. Inheriting --input-type=module from a
          // `node -e` host would reinterpret the generated `require()` bundle.
          execArgv: workerExecArgv(),
          name: `rayon-worker-${i}`,
          workerData: { ctrlSab: this.ctrl.buffer, port: port2 },
          transferList: [port2],
        });
        worker.once("error", (error) => {
          const detail = error instanceof Error ? error.message : String(error);
          this.breakPool(new RayonError(`worker ${i} failed: ${detail}`));
        });
        worker.once("exit", (code) => {
          if (this.state === "healthy") {
            this.breakPool(new RayonError(`worker ${i} exited unexpectedly with code ${code}`));
          }
        });
        worker.unref();
        port1.unref();
        this.workers.push(worker);
        this.ports.push(port1);
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.breakPool(error);
      throw new RayonError(`failed to create worker pool: ${error.message}`);
    }
  }

  isUsable(): boolean {
    return this.state === "healthy";
  }

  /** Blocks until all workers booted, invalidating the pool on failure. */
  warmup(timeoutMs = resolveStartupTimeoutMs()): void {
    assertPositiveFinite(timeoutMs, "worker startup timeout");
    const deadline = Date.now() + timeoutMs;
    let ready: number;
    while ((ready = Atomics.load(this.ctrl, CTRL.READY)) < this.size) {
      this.throwIfWorkerExited();
      this.throwIfBroken();
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const error = new RayonTimeoutError(
          `worker pool warmup timed out (${ready}/${this.size} ready); the pool was discarded`,
        );
        this.breakPool(error);
        throw error;
      }
      Atomics.wait(this.ctrl, CTRL.READY, ready, Math.min(50, remaining));
    }
    this.throwIfWorkerExited();
  }

  dispatch(
    job: DispatchJob,
    allSources: Map<KernelSourceId, KernelSource>,
  ): ResultMessage[] {
    return this.dispatchSequence(job, allSources, undefined);
  }

  /**
   * Runs an optional targeted follow-up without allowing another operation to
   * interleave. Parallel reduce uses this to merge worker partials with the
   * exact same compiled kernel capture snapshot.
   */
  dispatchSequence(
    job: DispatchJob,
    allSources: Map<KernelSourceId, KernelSource>,
    followUp: FollowUpFactory,
  ): ResultMessage[] {
    this.throwIfBroken();
    if (this.asyncPending > 0) {
      throw new RayonError(
        "an async parallel operation is in flight - await it before starting a synchronous one",
      );
    }
    const first = this.dispatchSyncOnce(job, allSources, undefined, true);
    const next = followUp?.(first);
    return next === undefined
      ? first
      : this.dispatchSyncOnce(next.job, next.sources, 0, false);
  }

  private dispatchSyncOnce(
    job: DispatchJob,
    allSources: Map<KernelSourceId, KernelSource>,
    targetWorker: number | undefined,
    recordStats: boolean,
  ): ResultMessage[] {
    const {
      epoch,
      deadline,
      timeoutMs,
      workerIndices,
      publishedSources,
    } = this.publish(
      job,
      allSources,
      targetWorker,
    );
    const expected = workerIndices.length;
    let posted: number;
    while ((posted = Atomics.load(this.ctrl, CTRL.POSTED)) < expected) {
      this.throwIfWorkerExited();
      this.throwIfBroken();
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const error = this.timeoutError(timeoutMs, posted, expected, job.total);
        this.breakPool(error);
        throw error;
      }
      Atomics.wait(this.ctrl, CTRL.POSTED, posted, Math.min(250, remaining));
    }
    this.throwIfWorkerExited();
    const results = this.collectOrBreak(epoch, workerIndices, recordStats);
    this.recordPublishedSources(publishedSources);
    return results;
  }

  dispatchAsync(
    job: DispatchJob,
    allSources: Map<KernelSourceId, KernelSource>,
  ): Promise<ResultMessage[]> {
    return this.dispatchSequenceAsync(job, allSources, undefined);
  }

  dispatchSequenceAsync(
    job: DispatchJob,
    allSources: Map<KernelSourceId, KernelSource>,
    followUp: FollowUpFactory,
  ): Promise<ResultMessage[]> {
    this.throwIfBroken();
    this.asyncPending += 1;
    const run = async (): Promise<ResultMessage[]> => {
      this.throwIfBroken();
      const first = await this.dispatchAsyncOnce(job, allSources, undefined, true);
      const next = followUp?.(first);
      return next === undefined
        ? first
        : this.dispatchAsyncOnce(next.job, next.sources, 0, false);
    };
    const result = this.asyncTail.then(run);
    this.asyncTail = result.then(
      () => {
        this.asyncPending -= 1;
      },
      () => {
        this.asyncPending -= 1;
      },
    );
    return result;
  }

  private async dispatchAsyncOnce(
    job: DispatchJob,
    allSources: Map<KernelSourceId, KernelSource>,
    targetWorker: number | undefined,
    recordStats: boolean,
  ): Promise<ResultMessage[]> {
    const {
      epoch,
      deadline,
      timeoutMs,
      workerIndices,
      publishedSources,
    } = this.publish(
      job,
      allSources,
      targetWorker,
    );
    const expected = workerIndices.length;
    const heldWorker = this.workers[targetWorker ?? 0];
    heldWorker?.ref();
    try {
      let posted: number;
      while ((posted = Atomics.load(this.ctrl, CTRL.POSTED)) < expected) {
        this.throwIfWorkerExited();
        this.throwIfBroken();
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          const error = this.timeoutError(timeoutMs, posted, expected, job.total);
          this.breakPool(error);
          throw error;
        }
        const waited = Atomics.waitAsync(
          this.ctrl,
          CTRL.POSTED,
          posted,
          Math.min(250, remaining),
        );
        if (waited.async) await waited.value;
      }
    } finally {
      heldWorker?.unref();
    }
    this.throwIfWorkerExited();
    const results = this.collectOrBreak(epoch, workerIndices, recordStats);
    this.recordPublishedSources(publishedSources);
    return results;
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    if (this.state === "healthy") {
      this.state = "closing";
      this.failure = new RayonError("worker pool is closing");
      Atomics.notify(this.ctrl, CTRL.POSTED);
      Atomics.notify(this.ctrl, CTRL.READY);
    }
    await this.terminateWorkers();
    this.state = "closed";
  }

  private publish(
    job: DispatchJob,
    allSources: Map<KernelSourceId, KernelSource>,
    targetWorker: number | undefined,
  ): {
    epoch: number;
    deadline: number;
    timeoutMs: number;
    workerIndices: number[];
    publishedSources: Array<{
      workerIndex: number;
      sourceIds: KernelSourceId[];
    }>;
  } {
    this.throwIfWorkerExited();
    this.throwIfBroken();
    const timeoutMs = resolveTimeoutMs();
    this.epoch = this.epoch >= 0x7fff_ffff ? 1 : this.epoch + 1;
    const epoch = this.epoch;

    let workerIndices: number[];
    if (targetWorker === undefined) {
      const activeWorkers = Math.max(
        1,
        Math.min(this.size, Math.ceil(job.total / job.chunk)),
      );
      workerIndices = Array.from({ length: activeWorkers }, (_, index) => index);
    } else {
      if (this.ports[targetWorker] === undefined) {
        throw new RayonError(`target worker ${targetWorker} does not exist`);
      }
      workerIndices = [targetWorker];
    }

    Atomics.store(this.ctrl, CTRL.CURSOR, 0);
    Atomics.store(this.ctrl, CTRL.POSTED, 0);
    Atomics.store(this.ctrl, CTRL.ERR, 0);

    const publishedSources: Array<{
      workerIndex: number;
      sourceIds: KernelSourceId[];
    }> = [];
    try {
      for (const workerIndex of workerIndices) {
        const sent = this.sentSources[workerIndex]!;
        const sources = Object.create(null) as Record<KernelSourceId, KernelSource>;
        for (const [id, source] of allSources) {
          if (!sent.has(id)) sources[id] = source;
        }
        const message: JobMessage = {
          ...job,
          type: "job",
          epoch,
          sources,
        };
        const port = this.ports[workerIndex]!;
        if (targetWorker === undefined) port.postMessage(message);
        else port.postMessage(message, transferList(message.input));
        publishedSources.push({
          workerIndex,
          sourceIds: Object.keys(sources),
        });
      }
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      const error = new RayonError(`failed to publish parallel job: ${detail}`);
      this.breakPool(error);
      throw error;
    }
    Atomics.store(this.ctrl, CTRL.EPOCH, epoch);
    return {
      epoch,
      deadline: Date.now() + timeoutMs,
      timeoutMs,
      workerIndices,
      publishedSources,
    };
  }

  private timeoutError(
    timeoutMs: number,
    posted: number,
    expected: number,
    total: number,
  ): RayonTimeoutError {
    return new RayonTimeoutError(
      `parallel job timed out after ${timeoutMs}ms (${posted}/${expected} active workers reported; ` +
        `cursor=${Atomics.load(this.ctrl, CTRL.CURSOR)}/${total}); the worker pool was discarded`,
    );
  }

  private collectOrBreak(
    epoch: number,
    workerIndices: number[],
    recordStats: boolean,
  ): ResultMessage[] {
    try {
      return this.collect(epoch, workerIndices, recordStats);
    } catch (cause) {
      if (!(cause instanceof KernelRuntimeError)) {
        this.breakPool(cause instanceof Error ? cause : new Error(String(cause)));
      }
      throw cause;
    }
  }

  private collect(
    epoch: number,
    workerIndices: number[],
    recordStats: boolean,
  ): ResultMessage[] {
    const results: ResultMessage[] = [];
    for (const workerIndex of workerIndices) {
      const port = this.ports[workerIndex]!;
      let found: ResultMessage | undefined;
      let entry: ReturnType<typeof receiveMessageOnPort>;
      while ((entry = receiveMessageOnPort(port)) !== undefined) {
        const msg = entry.message as ResultMessage;
        if (msg.type === "result" && msg.epoch === epoch) {
          found = msg;
          break;
        }
      }
      if (found === undefined) {
        throw new RayonError(
          "protocol violation: worker result missing after every active worker reported",
        );
      }
      results.push(found);
    }

    if (recordStats) {
      lastStats = {
        workers: this.size,
        threadsUsed: results.filter((result) => result.processed > 0).length,
      };
    }
    const failed = results.find((result) => !result.ok);
    if (failed?.error !== undefined) throw new KernelRuntimeError(failed.error);
    return results;
  }

  private recordPublishedSources(
    published: Array<{
      workerIndex: number;
      sourceIds: KernelSourceId[];
    }>,
  ): void {
    for (const { workerIndex, sourceIds } of published) {
      const sent = this.sentSources[workerIndex]!;
      for (const id of sourceIds) sent.add(id);
    }
  }

  private throwIfBroken(): void {
    if (this.state !== "healthy") {
      throw this.failure ?? new RayonError(`worker pool is ${this.state}`);
    }
  }

  private throwIfWorkerExited(): void {
    const threadId = Atomics.load(this.ctrl, CTRL.FATAL);
    if (threadId === 0) return;
    const error = new RayonError(
      `worker thread ${threadId} exited before reporting its result; the pool was discarded`,
    );
    this.breakPool(error);
    throw error;
  }

  private breakPool(cause: Error): void {
    if (this.state !== "healthy") return;
    this.state = "broken";
    this.failure = cause;
    Atomics.store(this.ctrl, CTRL.ERR, 1);
    Atomics.notify(this.ctrl, CTRL.POSTED);
    Atomics.notify(this.ctrl, CTRL.READY);
    void this.terminateWorkers();
  }

  private async terminateWorkers(): Promise<void> {
    for (const port of this.ports) port.close();
    await Promise.allSettled(this.workers.map((worker) => worker.terminate()));
  }
}

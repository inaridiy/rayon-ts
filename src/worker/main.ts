/**
 * Worker entry. This file is bundled to a self-contained CommonJS string by
 * scripts/build-worker.mjs and spawned with `new Worker(source, { eval: true })`,
 * so it works no matter how the host application is bundled.
 *
 * Jobs arrive through a dedicated MessagePort. The listener also keeps the
 * worker event loop available between CPU-bound jobs, which is required by
 * cross-thread Web Stream proxies.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  MessagePort,
  threadId,
  type Transferable,
  workerData,
} from "node:worker_threads";
import {
  claimWork,
  CTRL,
  type CollectSegment,
  type EncodedNode,
  type EncodedValue,
  type FoldPartial,
  type InvokeValue,
  type JobMessage,
  type KernelBindingId,
  type KernelSource,
  type KernelSourceId,
  type ResultMessage,
  type ValueSegment,
  type WorkerError,
} from "../runtime/protocol.js";
import { markRayonWorker } from "../runtime/context.js";
import { collectTransferables } from "../runtime/transfer.js";

const ctrl = new Int32Array(workerData.ctrlSab as SharedArrayBuffer);
const port = workerData.port as MessagePort;

// Ambient thread id so kernels (which cannot import modules) can observe
// which thread ran them. The main thread sets this to 0 for sequential runs.
markRayonWorker();
(globalThis as Record<string, unknown>).RAYON_THREAD_ID = threadId;

type Kernel = (...args: unknown[]) => unknown;
type KernelFactory = (env: Record<string, unknown>) => Kernel;

const factories = new Map<KernelSourceId, KernelFactory>();

function sourceUrl(id: string): string {
  return `rayon-kernel://${id.replace(/[\r\n\u2028\u2029]/g, "_")}`;
}

function makeFactory(id: KernelSourceId, source: KernelSource): KernelFactory {
  try {
    if (source.format === "bundle") {
      const workerRequire = createRequire(
        source.resolveFrom ?? join(process.cwd(), "__rayon-worker__.cjs"),
      );
      // eslint-disable-next-line no-new-func
      const factory = new Function(
        "require",
        `"use strict";\n${source.code}\nreturn __rayonBundle.default;\n//# sourceURL=${sourceUrl(id)}`,
      )(workerRequire) as unknown;
      if (typeof factory !== "function") throw new TypeError("bundle did not export a kernel factory");
      return factory as KernelFactory;
    }
    // The expression has captured references rewritten to `__env.name`.
    // eslint-disable-next-line no-new-func
    return new Function(
      "__env",
      `"use strict"; return (${source.code});\n//# sourceURL=${sourceUrl(id)}`,
    ) as KernelFactory;
  } catch (cause) {
    throw new Error(`failed to compile kernel "${id}": ${(cause as Error).message}`);
  }
}

/** Two-phase instantiation so mutually recursive kernels resolve cleanly. */
function instantiate(job: JobMessage): {
  fns: Map<KernelBindingId, Kernel>;
  input: JobMessage["input"];
} {
  const bindingIds = Object.keys(job.bindings);
  const envObjs = new Map<KernelBindingId, Record<string, unknown>>();
  const fns = new Map<KernelBindingId, Kernel>();
  for (const bindingId of bindingIds) {
    const sourceId = job.bindings[bindingId]!.sourceId;
    const factory = factories.get(sourceId);
    if (factory === undefined) throw new Error(`kernel source "${sourceId}" is missing in this worker`);
    const env: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    envObjs.set(bindingId, env);
    fns.set(bindingId, factory(env));
  }
  const decode = createGraphDecoder(job.graphNodes, fns);
  for (const bindingId of bindingIds) {
    const decoded = decode(job.bindings[bindingId]!.env);
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new Error(`kernel binding "${bindingId}" has an invalid environment`);
    }
    Object.defineProperties(envObjs.get(bindingId)!, Object.getOwnPropertyDescriptors(decoded));
  }
  const input =
    job.inputRoot === undefined
      ? job.input
      : decode(job.inputRoot);
  if (
    input !== null &&
    !Array.isArray(input) &&
    !ArrayBuffer.isView(input)
  ) {
    throw new Error("job graph decoded an invalid input value");
  }
  return { fns, input: input as JobMessage["input"] };
}

function createGraphDecoder(
  graphNodes: EncodedNode[],
  fns: Map<KernelBindingId, Kernel>,
): (value: EncodedValue) => unknown {
  const decoded = graphNodes.map((node) => {
    switch (node.kind) {
      case "array":
        return Object.assign([], { length: node.length });
      case "object":
        return node.nullPrototype ? Object.create(null) : {};
      case "map":
        return new Map();
      case "set":
        return new Set();
    }
  });

  const decode = (value: EncodedValue): unknown => {
    if (value === null || typeof value !== "object") return value;
    switch (value.kind) {
      case "clone":
        return value.value;
      case "kernel": {
        const fn = fns.get(value.bindingId);
        if (fn === undefined) throw new Error(`kernel binding "${value.bindingId}" is missing from the job`);
        return fn;
      }
      case "node": {
        const node = decoded[value.index];
        if (node === undefined) throw new Error(`capture graph references missing node ${value.index}`);
        return node;
      }
    }
  };

  graphNodes.forEach((node, index) => {
    const target = decoded[index]!;
    switch (node.kind) {
      case "array":
        for (const [key, value] of node.entries) {
          Object.defineProperty(target, key, {
            value: decode(value),
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
        break;
      case "object":
        for (const [key, value] of node.entries) {
          Object.defineProperty(target, key, {
            value: decode(value),
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
        break;
      case "map":
        for (const [key, value] of node.entries) (target as Map<unknown, unknown>).set(decode(key), decode(value));
        break;
      case "set":
        for (const value of node.values) (target as Set<unknown>).add(decode(value));
        break;
    }
  });

  return decode;
}

function safeString(value: unknown, fallback: string): string {
  try {
    return String(value);
  } catch {
    return fallback;
  }
}

/** This function is called from catch blocks and must itself never throw. */
function serializeError(cause: unknown): WorkerError {
  try {
    if (cause instanceof Error) {
      const name = safeString(cause.name, "Error") || "Error";
      const message = safeString(
        cause.message,
        "<error message could not be read>",
      );
      let stack: string | undefined;
      try {
        if (cause.stack !== undefined) stack = String(cause.stack);
      } catch {
        // A hostile Error subclass may expose a throwing stack getter.
      }
      return { name, message, ...(stack === undefined ? {} : { stack }) };
    }
  } catch {
    // Proxies can even throw while evaluating instanceof.
  }
  return {
    name: "Error",
    message: safeString(cause, "<unprintable thrown value>"),
  };
}

function freshReductionIdentity(identity: unknown): unknown {
  // Primitive identities are immutable; avoid structuredClone in the hot
  // claim loop used by numeric reductions.
  return identity !== null && typeof identity === "object"
    ? structuredClone(identity)
    : identity;
}

function postResult(result: ResultMessage): void {
  try {
    const transfers = new Set<Transferable>(
      result.segments?.map((segment) => segment.buffer) ?? [],
    );
    const seen = new Set<object>();
    for (const fold of result.folds ?? []) {
      collectTransferables(fold.value, transfers, seen);
    }
    for (const value of result.values ?? []) collectTransferables(value.value, transfers, seen);
    for (const segment of result.valueSegments ?? []) {
      for (const value of segment.values) collectTransferables(value, transfers, seen);
    }
    port.postMessage(result, [...transfers]);
  } catch (cause) {
    Atomics.store(ctrl, CTRL.ERR, 1);
    const fallback: ResultMessage = {
      type: "result",
      epoch: result.epoch,
      threadId,
      processed: result.processed,
      ok: false,
      error: serializeError(
        new Error(`worker result is not serializable or transferable: ${serializeError(cause).message}`),
      ),
    };
    try {
      port.postMessage(fallback);
    } catch {
      // The main thread detects the missing message and invalidates the pool.
    }
  } finally {
    Atomics.add(ctrl, CTRL.POSTED, 1);
    Atomics.notify(ctrl, CTRL.POSTED);
  }
}

function runJob(job: JobMessage, result: ResultMessage): void {
  for (const [id, source] of Object.entries(job.sources)) {
    factories.set(id, makeFactory(id, source));
  }
  const { fns, input } = instantiate(job);
  const chain = job.chain.map((stage) => ({ kind: stage.kind, fn: fns.get(stage.bindingId)! }));
  const { out, total, chunk, rangeStart, terminal, sourceLen, chunkLen } = job;

  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let count = 0;
  const folds: FoldPartial[] = [];
  const segments: CollectSegment[] = [];
  const valueSegments: ValueSegment[] = [];
  const values: InvokeValue[] = [];
  const combine = terminal.kind === "fold" ? fns.get(terminal.combineBindingId)! : undefined;
  let processed = 0;

  while (true) {
    const start = claimWork(ctrl, total, chunk);
    if (start >= total) break;
    if (Atomics.load(ctrl, CTRL.ERR) !== 0) break;
    const end = Math.min(start + chunk, total);

    if (terminal.kind === "invoke") {
      for (let i = start; i < end; i++) {
        const fn = fns.get(terminal.bindingIds[i]!);
        if (fn === undefined) throw new Error(`invoke kernel #${i} missing`);
        values.push({ index: i, value: fn() });
      }
      processed += end - start;
      continue;
    }

    // A worker may claim multiple chunks. Each fold needs an independent
    // identity so mutating associative reducers cannot alias across partials.
    let foldAcc: unknown =
      terminal.kind === "fold" ? freshReductionIdentity(terminal.identity) : 0;
    const segment: number[] | null = terminal.kind === "collect" && terminal.filtered ? [] : null;
    const valueSegment: unknown[] | null = terminal.kind === "collectValues" ? [] : null;

    elements: for (let i = start; i < end; i++) {
      let value: unknown;
      if (chunkLen > 0) {
        const cs = i * chunkLen;
        const ce = Math.min(cs + chunkLen, sourceLen);
        if (input === null) value = { start: rangeStart + cs, end: rangeStart + ce };
        else if (Array.isArray(input)) value = input.slice(cs, ce);
        else value = input.subarray(cs, ce);
      } else {
        value = input !== null ? input[i] : rangeStart + i;
      }
      for (const stage of chain) {
        if (stage.kind === "map") {
          value = stage.fn(value, i);
        } else if (!stage.fn(value, i)) {
          continue elements;
        }
      }
      switch (terminal.kind) {
        case "forEach":
          break;
        case "sum":
          sum += value as number;
          break;
        case "min":
          if ((value as number) < min) min = value as number;
          break;
        case "max":
          if ((value as number) > max) max = value as number;
          break;
        case "count":
          count += 1;
          break;
        case "fold":
          foldAcc = combine!(foldAcc, value);
          break;
        case "collect":
          if (segment !== null) segment.push(value as number);
          else out![i] = value as number;
          break;
        case "collectValues":
          valueSegment!.push(value);
          break;
      }
    }

    if (terminal.kind === "fold") folds.push({ start, value: foldAcc });
    if (segment !== null && segment.length > 0) {
      const buf = Float64Array.from(segment);
      segments.push({ start, buffer: buf.buffer as ArrayBuffer, length: buf.length });
    }
    if (valueSegment !== null && valueSegment.length > 0) {
      valueSegments.push({ start, values: valueSegment });
    }
    processed += end - start;
  }

  result.processed = processed;
  result.sum = sum;
  result.min = min;
  result.max = max;
  result.count = count;
  result.folds = folds;
  result.segments = segments;
  result.valueSegments = valueSegments;
  result.values = values;
}

function handleJob(job: JobMessage): void {
  const result: ResultMessage = {
    type: "result",
    epoch: job.epoch,
    threadId,
    processed: 0,
    ok: true,
  };
  try {
    if (job.type !== "job") {
      throw new Error("protocol violation: worker received a non-job message");
    }
    runJob(job, result);
  } catch (cause) {
    Atomics.store(ctrl, CTRL.ERR, 1);
    result.ok = false;
    result.error = serializeError(cause);
  }
  postResult(result);
}

port.on("message", handleJob);
Atomics.add(ctrl, CTRL.READY, 1);
Atomics.notify(ctrl, CTRL.READY);

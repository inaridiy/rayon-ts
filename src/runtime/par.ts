/**
 * Rayon-style parallel iterator API. All default operations are synchronous:
 * the main thread blocks in Atomics.wait while workers chew through chunks,
 * so `par(xs).map(f).sum()` reads exactly like `xs.par_iter().map(f).sum()`.
 * Append `.async()` before a terminal to get a Promise instead — the event
 * loop keeps running while workers compute (Atomics.waitAsync underneath).
 *
 * Every function handed to a combinator must be a "use parallel" kernel
 * (compiled by the Vite plugin). In sequential mode (RAYON_SEQUENTIAL=1 or
 * threads: 0) the original functions run in-place instead — handy for
 * debugging with breakpoints.
 */
import type { KeyObject, X509Certificate } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import type { BlockList } from "node:net";
import type { Histogram } from "node:perf_hooks";
import type { MessagePort } from "node:worker_threads";
import { KernelNotCompiledError, RayonError } from "./errors.js";
import {
  allocateShared,
  type ChunkArrayView,
  copyToShared,
  fromNumbers,
  isSupportedTypedArray,
  type SharedArrayView,
  type SharedChunkArrayView,
  type TypedArrayishCtor,
} from "./arrays.js";
export type { SharedArrayView } from "./arrays.js";
import {
  defaultChunk,
  getPool,
  isSequentialMode,
  type FollowUpDispatch,
  type Pool,
} from "./pool.js";
import type {
  FoldPartial,
  InvokeValue,
  JobMessage,
  KernelSource,
  KernelSourceId,
  ResultMessage,
  SharedFloat64Array,
  SharedTypedArray,
  TerminalSpec,
  TypedArray,
  ValueSegment,
} from "./protocol.js";
import { isSharedArray } from "./protocol.js";
import { type AnyFn, encodeKernelGraph, type KernelInfo, kernelOf } from "./registry.js";
import { reductionIdentityIsolationIssue } from "./transfer.js";

export type MapFn<T = number, U = number> = (x: T, i: number) => U;
export type EachFn<T = number> = (x: T, i: number) => unknown;
export type PredFn<T = number> = (x: T, i: number) => boolean;

type CloneAtomic =
  | ArrayBuffer
  | SharedArrayBuffer
  | ArrayBufferView
  | Date
  | RegExp
  | Error
  | Blob
  | File
  | CryptoKey
  | KeyObject
  | X509Certificate
  | BlockList
  | Histogram
  | FileHandle
  | MessagePort
  | AbortSignal
  | ReadableStream<unknown>
  | WritableStream<unknown>
  | TransformStream<unknown, unknown>;

/** Recursive canonicalization performed by Node's worker structured clone. */
export type WorkerResult<T> =
  T extends Buffer
    ? Uint8Array<ArrayBufferLike>
    : T extends (...args: never[]) => unknown
      ? never
      : T extends readonly unknown[]
        ? { [Key in keyof T]: WorkerResult<T[Key]> }
        : T extends ReadonlyMap<infer Key, infer Value>
          ? Map<WorkerResult<Key>, WorkerResult<Value>>
          : T extends ReadonlySet<infer Value>
            ? Set<WorkerResult<Value>>
            : T extends CloneAtomic
              ? T
              : T extends object
                ? { [Key in keyof T]: WorkerResult<T[Key]> }
                : T;
export type CombineFn<T = number> = (
  left: WorkerResult<T>,
  right: WorkerResult<T>,
) => WorkerResult<T>;

/** Element produced by `par.range(...).chunks(n)`: the sub-range [start, end). */
export interface RangeChunk {
  start: number;
  end: number;
}

type Source =
  | { kind: "range"; start: number; end: number }
  | { kind: "array"; data: TypedArray }
  | { kind: "serialized"; data: readonly unknown[] };

interface Stage {
  kind: "map" | "filter";
  fn: AnyFn;
}

interface IterOpts {
  /** .chunks(n) grouping; 0 = element-wise iteration. */
  chunkLen: number;
  /** Reject non-shared array inputs before exposing mutable chunk views. */
  mutableChunks: boolean;
  /** Rayon's with_min_len / with_max_len: bounds on elements claimed per steal. */
  minLen: number | undefined;
  maxLen: number | undefined;
}

const DEFAULT_OPTS: IterOpts = {
  chunkLen: 0,
  mutableChunks: false,
  minLen: undefined,
  maxLen: undefined,
};

const MAX_JOB_ELEMENTS = 0x7fff_ffff;

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key) || process.env.RAYON_SILENT === "1") return;
  warned.add(key);
  console.warn(`[rayon-ts] ${message}`);
}

function requireKernel(fn: AnyFn, context: string): KernelInfo {
  const info = kernelOf(fn);
  if (info === undefined) throw new KernelNotCompiledError(context);
  return info;
}

function requirePositiveInt(n: number, what: string): void {
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new RayonError(`${what} expects a positive safe integer, got ${n}`);
  }
}

/** A prepared parallel job: dispatch it (sync or async), then merge results. */
interface Prepared {
  job: Omit<JobMessage, "type" | "epoch" | "sources">;
  sources: Map<KernelSourceId, KernelSource>;
  followUp: ((results: ResultMessage[]) => FollowUpDispatch) | undefined;
  merge: (results: ResultMessage[]) => unknown;
}

export class ParIter<T = number> {
  protected readonly source: Source;
  protected readonly chain: readonly Stage[];
  protected readonly opts: IterOpts;

  constructor(source: Source, chain: readonly Stage[] = [], opts: IterOpts = DEFAULT_OPTS) {
    this.source = source;
    this.chain = chain;
    this.opts = opts;
  }

  map<U>(fn: MapFn<T, U>): ParIter<U> {
    return new ParIter<U>(this.source, [...this.chain, { kind: "map", fn }], this.opts);
  }

  filter(fn: PredFn<T>): ParIter<T> {
    return new ParIter(this.source, [...this.chain, { kind: "filter", fn }], this.opts);
  }

  /** Lower bound on iterator elements claimed per worker steal. */
  withMinLen(n: number): ParIter<T> {
    requirePositiveInt(n, "withMinLen()");
    if (this.opts.maxLen !== undefined && n > this.opts.maxLen) {
      throw new RayonError(`withMinLen(${n}) cannot exceed withMaxLen(${this.opts.maxLen})`);
    }
    return new ParIter(this.source, this.chain, { ...this.opts, minLen: n });
  }

  /** Upper bound on iterator elements claimed per worker steal. */
  withMaxLen(n: number): ParIter<T> {
    requirePositiveInt(n, "withMaxLen()");
    if (this.opts.minLen !== undefined && n < this.opts.minLen) {
      throw new RayonError(`withMaxLen(${n}) cannot be smaller than withMinLen(${this.opts.minLen})`);
    }
    return new ParIter(this.source, this.chain, { ...this.opts, maxLen: n });
  }

  /** Switches to Promise-returning terminals; the event loop stays free. */
  async(): AsyncParIter<T> {
    return new AsyncParIter(this);
  }

  forEach(fn: EachFn<T>): void {
    void this.withEachStage(fn as AnyFn).runSync({ kind: "forEach" });
  }

  sum(this: ParIter<number>): number {
    return this.runSync({ kind: "sum" }) as number;
  }

  min(this: ParIter<number>): number {
    return this.runSync({ kind: "min" }) as number;
  }

  max(this: ParIter<number>): number {
    return this.runSync({ kind: "max" }) as number;
  }

  count(): number {
    return this.runSync({ kind: "count" }) as number;
  }

  /**
   * Associative reduction with a true identity element. Structured-clone
   * identities are snapshotted and isolated for every worker chunk.
   */
  reduce(
    combine: CombineFn<T>,
    identity: T | WorkerResult<T>,
  ): WorkerResult<T> {
    return this.runSync(
      { kind: "fold", combineBindingId: "", identity },
      combine as AnyFn,
    ) as WorkerResult<T>;
  }

  collect(this: ParIter<number>): SharedFloat64Array;
  collect(this: ParIter<T>, Ctor: ArrayConstructor): WorkerResult<T>[];
  collect<C extends TypedArrayishCtor>(
    this: ParIter<number>,
    Ctor: C,
  ): SharedArrayView<InstanceType<C>>;
  collect(Ctor?: ArrayConstructor | TypedArrayishCtor): unknown {
    if (Ctor === Array) return this.runSync({ kind: "collectValues" }) as T[];
    const filtered = this.chain.some((s) => s.kind === "filter");
    return this.runSync(
      { kind: "collect", filtered },
      undefined,
      (Ctor ?? Float64Array) as TypedArrayishCtor,
    ) as TypedArray;
  }

  /** Collects any Node.js structured-cloneable values in source order. */
  toArray(): WorkerResult<T>[] {
    return this.runSync({ kind: "collectValues" }) as WorkerResult<T>[];
  }

  /** @internal appends a consuming map stage for forEach terminals. */
  withEachStage(fn: AnyFn): ParIter<never> {
    return new ParIter<never>(this.source, [...this.chain, { kind: "map", fn }], this.opts);
  }

  /** @internal */
  hasFilter(): boolean {
    return this.chain.some((s) => s.kind === "filter");
  }

  /** @internal shared by ParIter terminals and AsyncParIter. */
  runSync(terminal: TerminalSpec, combineFn?: AnyFn, outCtor?: TypedArrayishCtor): unknown {
    const plan = this.plan(terminal, combineFn, outCtor);
    if ("value" in plan) return plan.value;
    if ("sequential" in plan) return plan.sequential();
    const { pool, prepared } = plan;
    return prepared.merge(
      pool.dispatchSequence(prepared.job, prepared.sources, prepared.followUp),
    );
  }

  /** @internal */
  async runAsync(terminal: TerminalSpec, combineFn?: AnyFn, outCtor?: TypedArrayishCtor): Promise<unknown> {
    const plan = this.plan(terminal, combineFn, outCtor);
    if ("value" in plan) return plan.value;
    if ("sequential" in plan) return plan.sequential();
    const { pool, prepared } = plan;
    return prepared.merge(
      await pool.dispatchSequenceAsync(
        prepared.job,
        prepared.sources,
        prepared.followUp,
      ),
    );
  }

  private sourceLen(): number {
    return this.source.kind === "range" ? Math.max(0, this.source.end - this.source.start) : this.source.data.length;
  }

  private elements(): number {
    const len = this.sourceLen();
    return this.opts.chunkLen > 0 ? Math.ceil(len / this.opts.chunkLen) : len;
  }

  private plan(
    terminal: TerminalSpec,
    combineFn?: AnyFn,
    outCtor?: TypedArrayishCtor,
  ):
    | { value: unknown }
    | { sequential: () => unknown }
    | { pool: Pool; prepared: Prepared } {
    terminal = snapshotReductionIdentity(terminal);
    const total = this.elements();
    if (!Number.isSafeInteger(total) || total > MAX_JOB_ELEMENTS) {
      throw new RayonError(
        `parallel jobs support at most ${MAX_JOB_ELEMENTS.toLocaleString("en-US")} iterator elements; got ${total}. ` +
          "Use .chunks(n) to reduce the number of scheduled elements.",
      );
    }

    if (
      this.opts.mutableChunks &&
      this.source.kind === "array" &&
      !isSharedArray(this.source.data)
    ) {
      throw new RayonError(
        "chunksMut() requires a SharedArrayBuffer-backed typed array; allocate it with shared.f64(...) (etc.)",
      );
    }

    if (total === 0) return { value: emptyResult(terminal, outCtor) };
    if (isSequentialMode()) {
      void getPool(); // lock configuration without creating workers
      return { sequential: () => this.executeSequential(terminal, combineFn, outCtor) };
    }

    const chainInfos = this.chain.map((stage) =>
      requireKernel(stage.fn, `the function passed to .${stage.kind === "map" ? "map()/forEach()" : "filter()"}`),
    );
    const roots = [...chainInfos];
    if (terminal.kind === "fold") {
      const combineInfo = requireKernel(combineFn as AnyFn, "the combine function passed to .reduce()");
      terminal = { ...terminal, combineBindingId: combineInfo.bindingId };
      roots.push(combineInfo);
    }
    const {
      bindings,
      sources,
      graphNodes,
      inputRoot,
    } = encodeKernelGraph(
      roots,
      this.source.kind === "serialized" ? this.source.data : undefined,
    );

    let input: TypedArray | unknown[] | null = null;
    let rangeStart = 0;
    if (this.source.kind === "array") {
      input = this.source.data;
      if (!isSharedArray(input)) {
        warnOnce(
          "unshared-input",
          "input typed array is not backed by a SharedArrayBuffer; copying it once per operation. " +
            "Allocate it with shared.f64(...) (etc.) for zero-copy dispatch.",
        );
        input = copyToShared(input);
      }
    } else if (this.source.kind === "range") {
      rangeStart = this.source.start;
    }

    let out: TypedArray | null = null;
    if (terminal.kind === "collect" && !terminal.filtered) {
      const Ctor = outCtor ?? Float64Array;
      out = allocateShared(Ctor, total);
    }

    const pool = getPool();
    if (pool === null) throw new RayonError("internal: parallel mode resolved without a worker pool");
    let claim = defaultChunk(total, pool.size);
    if (this.opts.minLen !== undefined) claim = Math.max(claim, this.opts.minLen);
    if (this.opts.maxLen !== undefined) claim = Math.min(claim, this.opts.maxLen);
    claim = Math.max(1, Math.min(claim, total));

    const finalTerminal = terminal;
    return {
      pool,
      prepared: {
        job: {
          total,
          chunk: claim,
          sourceLen: this.sourceLen(),
          chunkLen: this.opts.chunkLen,
          rangeStart,
          input,
          ...(inputRoot === undefined ? {} : { inputRoot }),
          out,
          chain: this.chain.map((stage, i) => ({
            kind: stage.kind,
            bindingId: chainInfos[i]!.bindingId,
          })),
          terminal: finalTerminal,
          bindings,
          graphNodes,
        },
        sources,
        followUp:
          finalTerminal.kind === "fold"
            ? (results) =>
                prepareFoldFollowUp(
                  finalTerminal,
                  bindings,
                  graphNodes,
                  sources,
                  results,
                )
            : undefined,
        merge: (results) => mergeResults(finalTerminal, results, out, outCtor),
      },
    };
  }

  private executeSequential(terminal: TerminalSpec, combineFn?: AnyFn, outCtor?: TypedArrayishCtor): unknown {
    const total = this.elements();
    const sourceLen = this.sourceLen();
    const { chunkLen } = this.opts;
    const src = this.source;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    let count = 0;
    let foldAcc = terminal.kind === "fold" ? terminal.identity : 0;
    const collected: number[] = [];
    const collectedValues: unknown[] = [];
    const Ctor = outCtor ?? Float64Array;
    const out =
      terminal.kind === "collect" && !terminal.filtered
        ? allocateShared(Ctor, total)
        : null;

    elements: for (let i = 0; i < total; i++) {
      let value: unknown;
      if (chunkLen > 0) {
        const cs = i * chunkLen;
        const ce = Math.min(cs + chunkLen, sourceLen);
        if (src.kind === "array") value = src.data.subarray(cs, ce);
        else if (src.kind === "serialized") value = src.data.slice(cs, ce);
        else value = { start: src.start + cs, end: src.start + ce };
      } else {
        value = src.kind === "range" ? src.start + i : src.data[i];
      }
      for (const stage of this.chain) {
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
          foldAcc = (combineFn as AnyFn)(foldAcc, value);
          break;
        case "collect":
          if (out !== null) out[i] = value as number;
          else collected.push(value as number);
          break;
        case "collectValues":
          collectedValues.push(value);
          break;
        case "invoke":
          throw new RayonError("unreachable: invoke terminal on iterator");
      }
    }

    switch (terminal.kind) {
      case "forEach":
        return undefined;
      case "sum":
        return sum;
      case "min":
        return min;
      case "max":
        return max;
      case "count":
        return count;
      case "fold":
        return foldAcc;
      case "collect":
        return out ?? fromNumbers(Ctor, collected);
      case "collectValues":
        return collectedValues;
      default:
        return undefined;
    }
  }
}

/** Promise-returning terminals over an already-built chain. */
export class AsyncParIter<T = number> {
  private readonly iter: ParIter<T>;

  constructor(iter: ParIter<T>) {
    this.iter = iter;
  }

  forEach(fn: EachFn<T>): Promise<void> {
    return this.iter
      .withEachStage(fn as AnyFn)
      .runAsync({ kind: "forEach" })
      .then(() => undefined);
  }

  sum(this: AsyncParIter<number>): Promise<number> {
    return this.iter.runAsync({ kind: "sum" }) as Promise<number>;
  }

  min(this: AsyncParIter<number>): Promise<number> {
    return this.iter.runAsync({ kind: "min" }) as Promise<number>;
  }

  max(this: AsyncParIter<number>): Promise<number> {
    return this.iter.runAsync({ kind: "max" }) as Promise<number>;
  }

  count(): Promise<number> {
    return this.iter.runAsync({ kind: "count" }) as Promise<number>;
  }

  reduce(
    combine: CombineFn<T>,
    identity: T | WorkerResult<T>,
  ): Promise<WorkerResult<T>> {
    return this.iter.runAsync(
      { kind: "fold", combineBindingId: "", identity },
      combine as AnyFn,
    ) as Promise<WorkerResult<T>>;
  }

  collect(this: AsyncParIter<number>): Promise<SharedFloat64Array>;
  collect(
    this: AsyncParIter<T>,
    Ctor: ArrayConstructor,
  ): Promise<WorkerResult<T>[]>;
  collect<C extends TypedArrayishCtor>(
    this: AsyncParIter<number>,
    Ctor: C,
  ): Promise<SharedArrayView<InstanceType<C>>>;
  async collect(
    Ctor?: ArrayConstructor | TypedArrayishCtor,
  ): Promise<unknown> {
    if (Ctor === Array) {
      return this.iter.runAsync(
        { kind: "collectValues" },
      ) as Promise<WorkerResult<T>[]>;
    }
    const filtered = this.iter.hasFilter();
    return (await this.iter.runAsync(
      { kind: "collect", filtered },
      undefined,
      (Ctor ?? Float64Array) as TypedArrayishCtor,
    )) as TypedArray;
  }

  async toArray(): Promise<WorkerResult<T>[]> {
    return this.iter.runAsync(
      { kind: "collectValues" },
    ) as Promise<WorkerResult<T>[]>;
  }
}

/** Iterator over a typed array; `.chunks(n)` yields zero-copy subarray views. */
export class ParArrayIter<A extends TypedArray> extends ParIter<number> {
  /**
   * Groups the array into sub-slices of `n` elements (the last may be
   * shorter). Treat these views as read-only. Use chunksMut() when kernels
   * intentionally write through a SharedArrayBuffer-backed input.
   */
  chunks(n: number): ParIter<ChunkArrayView<A>> {
    requirePositiveInt(n, "chunks()");
    return new ParIter<ChunkArrayView<A>>(this.source, [], {
      ...this.opts,
      chunkLen: n,
      mutableChunks: false,
    });
  }

  /**
   * Groups a SharedArrayBuffer-backed array into disjoint writable views.
   * Non-shared inputs are rejected so mutations can never disappear into a copy.
   */
  chunksMut(
    this: A extends SharedTypedArray ? ParArrayIter<A> : never,
    n: number,
  ): ParIter<SharedChunkArrayView<A>> {
    requirePositiveInt(n, "chunksMut()");
    const iter = this as ParArrayIter<A>;
    return new ParIter<SharedChunkArrayView<A>>(iter.source, [], {
      ...iter.opts,
      chunkLen: n,
      mutableChunks: true,
    });
  }
}

/** Iterator over an integer range; `.chunks(n)` yields {start, end} sub-ranges. */
export class ParRangeIter extends ParIter<number> {
  chunks(n: number): ParIter<RangeChunk> {
    requirePositiveInt(n, "chunks()");
    return new ParIter<RangeChunk>(this.source, [], {
      ...this.opts,
      chunkLen: n,
      mutableChunks: false,
    });
  }
}

/** Iterator over structured-clone data; chunks are cloned array slices. */
export class ParSerializedIter<T> extends ParIter<T> {
  chunks(n: number): ParIter<readonly T[]> {
    requirePositiveInt(n, "chunks()");
    return new ParIter<readonly T[]>(this.source, [], {
      ...this.opts,
      chunkLen: n,
      mutableChunks: false,
    });
  }
}

function snapshotReductionIdentity(terminal: TerminalSpec): TerminalSpec {
  if (terminal.kind !== "fold") return terminal;
  let identity: unknown;
  try {
    // Clone exactly once before validation. Besides producing the dispatch
    // snapshot, this prevents accessor side effects from creating a TOCTOU
    // gap between validation and the value sent to workers.
    identity = structuredClone(terminal.identity);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new RayonError(
      `reduce() identity is not Node.js structured-cloneable: ${detail}. ` +
        "Transfer-only values cannot be broadcast to every worker.",
    );
  }
  const isolationIssue = reductionIdentityIsolationIssue(identity);
  if (isolationIssue !== undefined) {
    throw new RayonError(
      `reduce() identity cannot be isolated per worker chunk: ${isolationIssue}`,
    );
  }
  return { ...terminal, identity };
}

function emptyResult(terminal: TerminalSpec, outCtor?: TypedArrayishCtor): unknown {
  switch (terminal.kind) {
    case "forEach":
      return undefined;
    case "sum":
    case "count":
      return 0;
    case "min":
      return Infinity;
    case "max":
      return -Infinity;
    case "fold":
      return terminal.identity;
    case "collect":
      return allocateShared(outCtor ?? Float64Array, 0);
    case "collectValues":
    case "invoke":
      return [];
  }
}

function sortedFoldPartials(results: ResultMessage[]): FoldPartial[] {
  return results
    .flatMap((result) => result.folds ?? [])
    .sort((first, second) => first.start - second.start);
}

function prepareFoldFollowUp(
  terminal: Extract<TerminalSpec, { kind: "fold" }>,
  bindings: JobMessage["bindings"],
  graphNodes: JobMessage["graphNodes"],
  sources: Map<KernelSourceId, KernelSource>,
  results: ResultMessage[],
): FollowUpDispatch {
  const partials = sortedFoldPartials(results);
  if (partials.length === 0) {
    throw new RayonError("protocol violation: parallel reduce produced no partial results");
  }
  const input = partials.map((partial) => partial.value);
  return {
    sources,
    job: {
      total: input.length,
      chunk: input.length,
      sourceLen: input.length,
      chunkLen: 0,
      rangeStart: 0,
      input,
      out: null,
      chain: [],
      terminal,
      bindings,
      graphNodes,
    },
  };
}

function mergeResults(
  terminal: TerminalSpec,
  results: ResultMessage[],
  out: TypedArray | null,
  outCtor?: TypedArrayishCtor,
): unknown {
  switch (terminal.kind) {
    case "forEach":
      return undefined;
    case "sum":
      return results.reduce((acc, r) => acc + (r.sum ?? 0), 0);
    case "min":
      return results.reduce((acc, r) => Math.min(acc, r.min ?? Infinity), Infinity);
    case "max":
      return results.reduce((acc, r) => Math.max(acc, r.max ?? -Infinity), -Infinity);
    case "count":
      return results.reduce((acc, r) => acc + (r.count ?? 0), 0);
    case "fold": {
      const partials = sortedFoldPartials(results);
      if (partials.length !== 1) {
        throw new RayonError(
          `protocol violation: final reduce merge produced ${partials.length} partial results`,
        );
      }
      return partials[0]!.value;
    }
    case "collect": {
      if (!terminal.filtered) return out;
      const segments = results.flatMap((r) => r.segments ?? []).sort((a, b) => a.start - b.start);
      const length = segments.reduce((acc, s) => acc + s.length, 0);
      const Ctor = outCtor ?? Float64Array;
      const merged = allocateShared(Ctor, length);
      let offset = 0;
      for (const s of segments) {
        merged.set(new Float64Array(s.buffer, 0, s.length) as never, offset);
        offset += s.length;
      }
      return merged;
    }
    case "collectValues": {
      const segments: ValueSegment[] = results
        .flatMap((result) => result.valueSegments ?? [])
        .sort((a, b) => a.start - b.start);
      return segments.flatMap((segment) => segment.values);
    }
    case "invoke": {
      const values: InvokeValue[] = results.flatMap((r) => r.values ?? []).sort((a, b) => a.index - b.index);
      return values.map((v) => v.value);
    }
  }
}

interface ParFn {
  /** Node Buffer views cross worker boundaries as their canonical Uint8Array. */
  (input: Buffer): ParArrayIter<Uint8Array>;
  <A extends TypedArray>(input: A): ParArrayIter<A>;
  (input: readonly number[]): ParArrayIter<SharedFloat64Array>;
  <T>(input: readonly T[]): ParSerializedIter<T>;
  /** Parallel iterator over the integer range [start, end). */
  range(start: number, end: number): ParRangeIter;
}

export const par: ParFn = (<A extends TypedArray, T>(
  input: A | readonly T[],
): ParArrayIter<A> | ParSerializedIter<T> => {
  if (!Array.isArray(input)) {
    if (!isSupportedTypedArray(input)) {
      throw new RayonError(
        "par() expects a supported numeric TypedArray or an array",
      );
    }
    return new ParArrayIter({ kind: "array", data: input as A });
  }
  if (input.every((value) => typeof value === "number")) {
    const data = allocateShared(Float64Array, input.length) as Float64Array;
    data.set(input as readonly number[]);
    return new ParArrayIter({ kind: "array", data });
  }
  return new ParSerializedIter<T>({ kind: "serialized", data: input });
}) as ParFn;

par.range = (start: number, end: number): ParRangeIter => {
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new RayonError(`par.range() expects integers, got [${start}, ${end})`);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    throw new RayonError(`par.range() expects safe integers, got [${start}, ${end})`);
  }
  return new ParRangeIter({ kind: "range", start, end });
};

interface ParallelJoinPlan {
  prepared: Omit<JobMessage, "type" | "epoch" | "sources">;
  sources: Map<KernelSourceId, KernelSource>;
  terminal: TerminalSpec;
  pool: Pool;
}

function prepareJoin(
  thunks: readonly (() => unknown)[],
): { value: unknown[] } | ParallelJoinPlan {
  if (thunks.length === 0) return { value: [] };
  if (isSequentialMode()) {
    void getPool(); // lock configuration without creating workers
    return { value: thunks.map((thunk) => thunk()) };
  }
  const infos = thunks.map((t, i) => requireKernel(t as AnyFn, `join() argument #${i}`));
  const { bindings, sources, graphNodes } = encodeKernelGraph(infos);
  const terminal: TerminalSpec = {
    kind: "invoke",
    bindingIds: infos.map((info) => info.bindingId),
  };
  const pool = getPool();
  if (pool === null) {
    throw new RayonError("internal: parallel mode resolved without a worker pool");
  }
  return {
    prepared: {
      total: thunks.length,
      chunk: 1,
      sourceLen: thunks.length,
      chunkLen: 0,
      rangeStart: 0,
      input: null,
      out: null,
      chain: [],
      terminal,
      bindings,
      graphNodes,
    },
    sources,
    terminal,
    pool,
  };
}

/**
 * Runs every thunk concurrently across the pool and returns their results in
 * order — Rayon's join/scope. Each thunk must be a "use parallel" kernel.
 */
export function join<T extends readonly (() => unknown)[]>(
  ...thunks: T
): { [K in keyof T]: WorkerResult<ReturnType<T[K]>> } {
  type R = { [K in keyof T]: WorkerResult<ReturnType<T[K]>> };
  const plan = prepareJoin(thunks);
  if ("value" in plan) return plan.value as R;
  return mergeResults(
    plan.terminal,
    plan.pool.dispatch(plan.prepared, plan.sources),
    null,
  ) as R;
}

/** Async variant of join(): resolves when every thunk finished. */
export async function joinAsync<T extends readonly (() => unknown)[]>(
  ...thunks: T
): Promise<{ [K in keyof T]: WorkerResult<ReturnType<T[K]>> }> {
  type R = { [K in keyof T]: WorkerResult<ReturnType<T[K]>> };
  const plan = prepareJoin(thunks);
  if ("value" in plan) return plan.value as R;
  return mergeResults(
    plan.terminal,
    await plan.pool.dispatchAsync(plan.prepared, plan.sources),
    null,
  ) as R;
}

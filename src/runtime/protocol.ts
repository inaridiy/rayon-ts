/**
 * Wire protocol shared between the main thread and workers.
 *
 * Control plane: one SharedArrayBuffer of Int32 slots, driven with Atomics.
 * Data plane: one MessageChannel per worker. The main thread drains results
 * synchronously so it may block in `Atomics.wait`; workers receive jobs through
 * an event listener so transferred Web Stream proxies stay live while idle.
 */

/** Int32Array slot indices in the control SharedArrayBuffer. */
export const CTRL = {
  /** Last job sequence number published by the main thread. */
  EPOCH: 0,
  /** Next unclaimed element index. Workers claim chunks via compareExchange. */
  CURSOR: 1,
  /** Number of workers that posted their result message for this epoch. */
  POSTED: 2,
  /** Set to 1 by a failing worker so others bail at the next chunk boundary. */
  ERR: 3,
  /** Number of workers that finished booting. */
  READY: 4,
  /**
   * Thread id of a worker that began exiting without completing the pool
   * lifecycle. Unlike parent-side Worker "exit" events, this remains visible
   * while the main thread is blocked in Atomics.wait().
   */
  FATAL: 5,
} as const;

export const CTRL_LEN = 8;

/**
 * Atomically claims [start, min(start + chunk, total)) without ever storing a
 * value above signed Int32 max. Atomics.add() would wrap on the final claim of
 * a near-2^31 job even though `total` itself is representable.
 */
export function claimWork(ctrl: Int32Array, total: number, chunk: number): number {
  while (true) {
    const start = Atomics.load(ctrl, CTRL.CURSOR);
    if (start >= total) return total;
    const next = Math.min(total, start + chunk);
    if (Atomics.compareExchange(ctrl, CTRL.CURSOR, start, next) === start) return start;
  }
}

/** Stable identity of compiled worker code. Shared by equivalent closures. */
export type KernelSourceId = string;

/** Runtime identity of one registered function and its captured environment. */
export type KernelBindingId = string;

export interface KernelSource {
  /** Plain function expression, or an esbuild-produced factory bundle. */
  format: "expression" | "bundle";
  code: string;
  /** Runtime module URL used to resolve configured external dependencies. */
  resolveFrom?: string;
}

export type EncodedValue =
  | undefined
  | null
  | boolean
  | number
  | bigint
  | string
  | { kind: "kernel"; bindingId: KernelBindingId }
  | { kind: "node"; index: number }
  | { kind: "clone"; value: unknown };

export type EncodedNode =
  | { kind: "array"; length: number; entries: [string, EncodedValue][] }
  | { kind: "object"; entries: [string, EncodedValue][]; nullPrototype: boolean }
  | { kind: "map"; entries: [EncodedValue, EncodedValue][] }
  | { kind: "set"; values: EncodedValue[] };

export interface KernelBindingSpec {
  sourceId: KernelSourceId;
  /** Named factory inside a shared bundle; absent for a single expression. */
  factoryName?: string;
  /** Root in the job-wide graphNodes table. */
  env: EncodedValue;
}

export interface StageSpec {
  kind: "map" | "filter";
  bindingId: KernelBindingId;
}

export type TerminalSpec =
  | { kind: "forEach" }
  | { kind: "sum" }
  | { kind: "min" }
  | { kind: "max" }
  | { kind: "count" }
  | { kind: "fold"; combineBindingId: KernelBindingId; identity: unknown }
  | { kind: "collect"; filtered: boolean }
  | { kind: "collectValues" }
  | { kind: "invoke"; bindingIds: KernelBindingId[] };

export interface JobMessage {
  type: "job";
  epoch: number;
  /** Total number of iterator elements (chunks when chunkLen > 0; invoke tasks). */
  total: number;
  /** Elements claimed per atomic cursor update. */
  chunk: number;
  /** Physical source length (elements before .chunks() grouping). */
  sourceLen: number;
  /** When > 0, element i is the sub-slice [i*chunkLen, min((i+1)*chunkLen, sourceLen)). */
  chunkLen: number;
  /** For range sources: element value = rangeStart + index. */
  rangeStart: number;
  /** SAB-backed typed input, cloned structured data, or null for ranges. */
  input: TypedArray | unknown[] | null;
  /** Generic input root in graphNodes; shares identity with captured values. */
  inputRoot?: EncodedValue;
  /** SAB-backed output array for unfiltered collect, else null. */
  out: TypedArray | null;
  chain: StageSpec[];
  terminal: TerminalSpec;
  /** Runtime function instances and their encoded captured environments. */
  bindings: Record<KernelBindingId, KernelBindingSpec>;
  /** One graph table shared by every binding and generic input value. */
  graphNodes: EncodedNode[];
  /** Compiled sources this worker has not seen yet. */
  sources: Record<KernelSourceId, KernelSource>;
}

export interface WorkerError {
  name: string;
  message: string;
  stack?: string | undefined;
}

export interface FoldPartial {
  /** Chunk start index — used to fold partials in source order. */
  start: number;
  value: unknown;
}

export interface CollectSegment {
  start: number;
  buffer: ArrayBuffer;
  length: number;
}

export interface InvokeValue {
  index: number;
  value: unknown;
}

export interface ValueSegment {
  start: number;
  values: unknown[];
}

export interface ResultMessage {
  type: "result";
  epoch: number;
  threadId: number;
  processed: number;
  ok: boolean;
  error?: WorkerError;
  sum?: number;
  min?: number;
  max?: number;
  count?: number;
  folds?: FoldPartial[];
  segments?: CollectSegment[];
  valueSegments?: ValueSegment[];
  values?: InvokeValue[];
}

export type TypedArray =
  | Float64Array
  | Float32Array
  | Int32Array
  | Uint32Array
  | Int16Array
  | Uint16Array
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray;

export type SharedFloat64Array = Float64Array<SharedArrayBuffer>;
export type SharedFloat32Array = Float32Array<SharedArrayBuffer>;
export type SharedInt32Array = Int32Array<SharedArrayBuffer>;
export type SharedUint32Array = Uint32Array<SharedArrayBuffer>;
export type SharedInt16Array = Int16Array<SharedArrayBuffer>;
export type SharedUint16Array = Uint16Array<SharedArrayBuffer>;
export type SharedInt8Array = Int8Array<SharedArrayBuffer>;
export type SharedUint8Array = Uint8Array<SharedArrayBuffer>;
export type SharedUint8ClampedArray =
  Uint8ClampedArray<SharedArrayBuffer>;

export type SharedTypedArray =
  | SharedFloat64Array
  | SharedFloat32Array
  | SharedInt32Array
  | SharedUint32Array
  | SharedInt16Array
  | SharedUint16Array
  | SharedInt8Array
  | SharedUint8Array
  | SharedUint8ClampedArray;

/** Constructor shape shared by numeric collection and shared allocators. */
export interface TypedArrayConstructor<T extends TypedArray = TypedArray> {
  new (length: number): T;
  new (
    buffer: ArrayBufferLike,
    byteOffset?: number,
    length?: number,
  ): T;
  /** Buffer exposes this at runtime, though some Node type versions omit it. */
  readonly BYTES_PER_ELEMENT?: number;
}

export function isSharedArray(view: ArrayBufferView): boolean {
  return view.buffer instanceof SharedArrayBuffer;
}

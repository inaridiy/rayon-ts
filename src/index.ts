/**
 * rayon-ts — Rayon-like data parallelism for Node.js.
 *
 * Mark a function with the "use parallel" directive, feed it to par()/join(),
 * and the Vite plugin ("rayon-ts/vite") compiles it into a worker_threads
 * kernel. Dispatch is synchronous (SharedArrayBuffer + Atomics), so the API
 * feels like Rayon rather than Promise plumbing.
 */
export { CaptureError, KernelNotCompiledError, KernelRuntimeError, RayonError, RayonTimeoutError } from "./runtime/errors.js";
export { createParallelBatcher } from "./runtime/batcher.js";
export type {
  ParallelBatcher,
  ParallelBatcherOptions,
} from "./runtime/batcher.js";
export { join, joinAsync, par } from "./runtime/par.js";
export type {
  CombineFn,
  EachFn,
  MapFn,
  PredFn,
  RangeChunk,
  SharedArrayView,
  WorkerResult,
} from "./runtime/par.js";
export { configureRayon, rayonStats, shutdownThreadPool } from "./runtime/pool.js";
export type { RayonConfig } from "./runtime/pool.js";
export { isSharedArray } from "./runtime/protocol.js";
export type {
  SharedFloat32Array,
  SharedFloat64Array,
  SharedInt16Array,
  SharedInt32Array,
  SharedInt8Array,
  SharedTypedArray,
  SharedUint16Array,
  SharedUint32Array,
  SharedUint8Array,
  SharedUint8ClampedArray,
} from "./runtime/protocol.js";
export { shared } from "./runtime/shared.js";

import { getPool } from "./runtime/pool.js";
import type { RayonConfig } from "./runtime/pool.js";
import { configureRayon } from "./runtime/pool.js";
import { isRayonWorker } from "./runtime/context.js";

declare global {
  /** Thread running the current code: 0 on the main thread, worker id inside kernels. */
  // eslint-disable-next-line no-var
  var RAYON_THREAD_ID: number;
}

// A statically imported copy of rayon-ts can be bundled into a kernel. Keep
// the id installed by the worker bootstrap instead of resetting it to main.
if (!isRayonWorker()) globalThis.RAYON_THREAD_ID = 0;

/** Eagerly spawns the worker pool and blocks until every worker booted. */
export function initThreadPool(config?: RayonConfig): void {
  if (config !== undefined) configureRayon(config);
  getPool()?.warmup();
}

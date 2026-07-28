/**
 * Allocators for SharedArrayBuffer-backed typed arrays. Arrays created here
 * cross the thread boundary zero-copy, and writes made by kernels are visible
 * to the main thread once the parallel operation returns.
 */
import type {
  SharedFloat32Array,
  SharedFloat64Array,
  SharedInt16Array,
  SharedInt32Array,
  SharedInt8Array,
  SharedUint16Array,
  SharedUint32Array,
  SharedUint8Array,
  TypedArray,
  TypedArrayConstructor,
} from "./protocol.js";
import { RayonError } from "./errors.js";

type SharedArrayConstructor<T extends TypedArray> =
  TypedArrayConstructor<T> & { readonly BYTES_PER_ELEMENT: number };

function alloc<T extends TypedArray>(
  Ctor: SharedArrayConstructor<T>,
  init: number | ArrayLike<number>,
): T {
  const length = typeof init === "number" ? init : init.length;
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RayonError(`shared array length must be a non-negative safe integer, got ${length}`);
  }
  const out = new Ctor(new SharedArrayBuffer(length * Ctor.BYTES_PER_ELEMENT));
  if (typeof init !== "number") out.set(init);
  return out;
}

interface SharedAllocators {
  f64(init: number | ArrayLike<number>): SharedFloat64Array;
  f32(init: number | ArrayLike<number>): SharedFloat32Array;
  i32(init: number | ArrayLike<number>): SharedInt32Array;
  u32(init: number | ArrayLike<number>): SharedUint32Array;
  i16(init: number | ArrayLike<number>): SharedInt16Array;
  u16(init: number | ArrayLike<number>): SharedUint16Array;
  i8(init: number | ArrayLike<number>): SharedInt8Array;
  u8(init: number | ArrayLike<number>): SharedUint8Array;
}

export const shared: SharedAllocators = {
  f64: (init) => alloc(Float64Array, init) as unknown as SharedFloat64Array,
  f32: (init) => alloc(Float32Array, init) as unknown as SharedFloat32Array,
  i32: (init) => alloc(Int32Array, init) as unknown as SharedInt32Array,
  u32: (init) => alloc(Uint32Array, init) as unknown as SharedUint32Array,
  i16: (init) => alloc(Int16Array, init) as unknown as SharedInt16Array,
  u16: (init) => alloc(Uint16Array, init) as unknown as SharedUint16Array,
  i8: (init) => alloc(Int8Array, init) as unknown as SharedInt8Array,
  u8: (init) => alloc(Uint8Array, init) as unknown as SharedUint8Array,
};

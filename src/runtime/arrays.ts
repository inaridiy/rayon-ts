import { RayonError } from "./errors.js";
import type {
  SharedFloat32Array,
  SharedFloat64Array,
  SharedInt16Array,
  SharedInt32Array,
  SharedInt8Array,
  SharedUint16Array,
  SharedUint32Array,
  SharedUint8Array,
  SharedUint8ClampedArray,
  TypedArray,
  TypedArrayConstructor,
} from "./protocol.js";

export type TypedArrayishCtor = TypedArrayConstructor;

export type SharedArrayView<T extends TypedArray> =
  T extends Buffer
    ? T & { readonly buffer: SharedArrayBuffer }
    : T extends Float64Array
      ? SharedFloat64Array
      : T extends Float32Array
        ? SharedFloat32Array
        : T extends Int32Array
          ? SharedInt32Array
          : T extends Uint32Array
            ? SharedUint32Array
            : T extends Int16Array
              ? SharedInt16Array
              : T extends Uint16Array
                ? SharedUint16Array
                : T extends Int8Array
                  ? SharedInt8Array
                  : T extends Uint8ClampedArray
                    ? SharedUint8ClampedArray
                    : SharedUint8Array;

export type ChunkArrayView<A extends TypedArray> =
  A extends Buffer
    ? Uint8Array<ArrayBufferLike>
    : A extends Float64Array
      ? Float64Array<ArrayBufferLike>
      : A extends Float32Array
        ? Float32Array<ArrayBufferLike>
        : A extends Int32Array
          ? Int32Array<ArrayBufferLike>
          : A extends Uint32Array
            ? Uint32Array<ArrayBufferLike>
            : A extends Int16Array
              ? Int16Array<ArrayBufferLike>
              : A extends Uint16Array
                ? Uint16Array<ArrayBufferLike>
                : A extends Int8Array
                  ? Int8Array<ArrayBufferLike>
                  : A extends Uint8ClampedArray
                    ? Uint8ClampedArray<ArrayBufferLike>
                    : Uint8Array<ArrayBufferLike>;

export type SharedChunkArrayView<A extends TypedArray> =
  A extends Float64Array
    ? SharedFloat64Array
    : A extends Float32Array
      ? SharedFloat32Array
      : A extends Int32Array
        ? SharedInt32Array
        : A extends Uint32Array
          ? SharedUint32Array
          : A extends Int16Array
            ? SharedInt16Array
            : A extends Uint16Array
              ? SharedUint16Array
              : A extends Int8Array
                ? SharedInt8Array
                : A extends Uint8ClampedArray
                  ? SharedUint8ClampedArray
                  : SharedUint8Array;

const TYPED_ARRAY_CTORS = new Map<string, TypedArrayishCtor>([
  ["[object Float64Array]", Float64Array],
  ["[object Float32Array]", Float32Array],
  ["[object Int32Array]", Int32Array],
  ["[object Uint32Array]", Uint32Array],
  ["[object Int16Array]", Int16Array],
  ["[object Uint16Array]", Uint16Array],
  ["[object Int8Array]", Int8Array],
  ["[object Uint8Array]", Uint8Array],
  ["[object Uint8ClampedArray]", Uint8ClampedArray],
]);

export function isSupportedTypedArray(value: unknown): value is TypedArray {
  return (
    ArrayBuffer.isView(value) &&
    TYPED_ARRAY_CTORS.has(Object.prototype.toString.call(value))
  );
}

function canonicalTypedArrayConstructor(
  value: TypedArray,
): TypedArrayishCtor {
  const Ctor = TYPED_ARRAY_CTORS.get(Object.prototype.toString.call(value));
  if (Ctor === undefined) {
    throw new RayonError(
      "internal: supported TypedArray has no canonical constructor",
    );
  }
  return Ctor;
}

export function allocateShared(
  Ctor: TypedArrayishCtor,
  length: number,
): TypedArray {
  const bytesPerElement =
    Ctor.BYTES_PER_ELEMENT ??
    (Ctor === (Buffer as unknown as TypedArrayishCtor)
      ? Uint8Array.BYTES_PER_ELEMENT
      : undefined);
  if (bytesPerElement === undefined) {
    throw new RayonError("collect() expects a TypedArray constructor");
  }
  const buffer = new SharedArrayBuffer(length * bytesPerElement);
  const out =
    Ctor === (Buffer as unknown as TypedArrayishCtor)
      ? Buffer.from(buffer)
      : new Ctor(buffer);
  if (
    !isSupportedTypedArray(out) ||
    !(out instanceof Ctor) ||
    out.buffer !== buffer ||
    out.byteOffset !== 0 ||
    out.byteLength !== buffer.byteLength ||
    out.length !== length
  ) {
    throw new RayonError(
      "collect() constructor must create an exact-length numeric TypedArray view " +
        "over the supplied SharedArrayBuffer",
    );
  }
  return out;
}

export function copyToShared(input: TypedArray): TypedArray {
  const Ctor = canonicalTypedArrayConstructor(input);
  const copy = allocateShared(Ctor, input.length);
  copy.set(input as never);
  return copy;
}

export function fromNumbers(
  Ctor: TypedArrayishCtor,
  values: number[],
): TypedArray {
  const out = allocateShared(Ctor, values.length);
  for (let index = 0; index < values.length; index++) {
    out[index] = values[index]!;
  }
  return out;
}

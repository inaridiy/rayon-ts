import {
  par,
  shared,
  type WorkerResult,
} from "rayon-ts";

const values = shared.f64([1, 2, 3]);
const valuesBuffer: SharedArrayBuffer = values.buffer;
const exactValues: Float64Array<SharedArrayBuffer> = values;

const collected = par.range(0, 3).collect();
const collectedBuffer: SharedArrayBuffer = collected.buffer;
const exactCollected: Float64Array<SharedArrayBuffer> = collected;

const bufferResult = par(Buffer.from([1, 2, 3])).collect(Buffer);
const bufferBacking: SharedArrayBuffer = bufferResult.buffer;
declare const nestedClone: WorkerResult<{
  data: Buffer;
  nested: Buffer[];
}>;
const nestedData: Uint8Array<ArrayBufferLike> = nestedClone.data;
const nestedItem: Uint8Array<ArrayBufferLike> = nestedClone.nested[0]!;

par(new Float64Array(3))
  .chunks(1)
  .map((chunk: Float64Array<ArrayBufferLike>) => chunk.length);

void [
  valuesBuffer,
  exactValues,
  collectedBuffer,
  exactCollected,
  bufferBacking,
  nestedData,
  nestedItem,
];

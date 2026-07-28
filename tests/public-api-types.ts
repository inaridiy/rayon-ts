/**
 * Compile-only public API assertions. This file is included by tsconfig.json
 * but deliberately does not match Vitest's `*.test.ts` pattern.
 */
import {
  createParallelBatcher,
  join,
  par,
  shared,
  type CombineFn,
  type MapFn,
  type PredFn,
} from "../src/index.js";

interface Row {
  id: number;
  labels: Set<string>;
}

interface MappedRow {
  id: string;
  metadata: Map<string, number>;
}

interface Summary {
  count: number;
  ids: string[];
}

declare const rows: readonly Row[];
declare const mapRow: MapFn<Row, MappedRow>;
declare const keepRow: PredFn<Row>;
declare const summarize: MapFn<MappedRow, Summary>;
declare const mergeSummary: CombineFn<Summary>;
declare const makeBuffer: MapFn<number, Buffer>;
declare const bufferThunk: () => Buffer;
declare const mergeWorkerBuffers: CombineFn<Buffer>;
declare const nestedBufferKernel: MapFn<number, {
  data: Buffer;
  nested: Buffer[];
  byName: Map<string, Buffer>;
}>;

const objects: MappedRow[] = par(rows).filter(keepRow).map(mapRow).toArray();
const asyncObjects: Promise<MappedRow[]> = par(rows).map(mapRow).async().toArray();
const collectedObjects: MappedRow[] = par(rows).filter(keepRow).map(mapRow).collect(Array);
const asyncCollectedObjects: Promise<MappedRow[]> = par(rows).map(mapRow).async().collect(Array);
const clonedBuffers: Uint8Array<ArrayBufferLike>[] = par
  .range(0, 3)
  .map(makeBuffer)
  .toArray();
const [joinedBuffer] = join(bufferThunk);
const exactJoinedBuffer: Uint8Array<ArrayBufferLike> = joinedBuffer;
const bufferBatcher = createParallelBatcher(makeBuffer);
const batchedBuffer: Promise<Uint8Array<ArrayBufferLike>> = bufferBatcher(1);
const reducedBuffer: Uint8Array<ArrayBufferLike> = par
  .range(0, 3)
  .map(makeBuffer)
  .reduce(mergeWorkerBuffers, Buffer.alloc(1));
// @ts-expect-error worker-cloned Buffer accumulators have no Buffer-only methods
const unsafeBufferMerge: CombineFn<Buffer> = (left: Buffer, right: Buffer) =>
  Buffer.from([left.readUInt8(0) + right.readUInt8(0)]);
const nestedBuffers: Array<{
  data: Uint8Array<ArrayBufferLike>;
  nested: Uint8Array<ArrayBufferLike>[];
  byName: Map<string, Uint8Array<ArrayBufferLike>>;
}> = par.range(0, 1).map(nestedBufferKernel).toArray();
const summary: Summary = par(rows)
  .map(mapRow)
  .map(summarize)
  .reduce(mergeSummary, { count: 0, ids: [] });
const asyncSummary: Promise<Summary> = par(rows)
  .map(mapRow)
  .map(summarize)
  .async()
  .reduce(mergeSummary, { count: 0, ids: [] });
const numeric = par([1, 2, 3] as const).collect();
const numericBuffer: SharedArrayBuffer = numeric.buffer;
const sharedValues = shared.f64(3);
const sharedBuffer: SharedArrayBuffer = sharedValues.buffer;
const sharedGeneric: Float64Array<SharedArrayBuffer> = sharedValues;
const collected = par(Buffer.from([1, 2, 3])).collect(Buffer);
const buffer: Buffer = collected;
const collectedBuffer: SharedArrayBuffer = collected.buffer;
const bufferChunks = par(Buffer.from([1, 2, 3])).chunks(2);
bufferChunks.map((_chunk: Uint8Array) => 0);
// @ts-expect-error Buffer is canonicalized to Uint8Array across worker boundaries
bufferChunks.map((_chunk: Buffer) => 0);
const ordinaryChunks = par(new Float64Array(3)).chunks(1);
ordinaryChunks.map((chunk) => {
  const backing: ArrayBufferLike = chunk.buffer;
  return backing.byteLength;
});
const mutableChunks = par(sharedValues).chunksMut(1);
mutableChunks.map((chunk) => {
  const backing: SharedArrayBuffer = chunk.buffer;
  return backing.byteLength;
});
// @ts-expect-error chunksMut requires a statically shared input view
par(new Float64Array(3)).chunksMut(1);

void [
  objects,
  asyncObjects,
  collectedObjects,
  asyncCollectedObjects,
  clonedBuffers,
  exactJoinedBuffer,
  bufferBatcher,
  batchedBuffer,
  reducedBuffer,
  unsafeBufferMerge,
  nestedBuffers,
  summary,
  asyncSummary,
  numeric,
  numericBuffer,
  sharedValues,
  sharedBuffer,
  sharedGeneric,
  buffer,
  collectedBuffer,
  bufferChunks,
  ordinaryChunks,
  mutableChunks,
];

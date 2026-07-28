/**
 * Feeds real TypeScript through transformModule, then imports and runs the
 * transformed output against the live worker pool — the full pipeline minus
 * Vite itself (e2e.test.ts covers that).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { transformModule } from "../src/plugin/emit.js";

const here = dirname(fileURLToPath(import.meta.url));
const tmpDir = join(here, ".tmp");
mkdirSync(tmpDir, { recursive: true });

let seq = 0;
async function compileAndImport(source: string): Promise<Record<string, unknown>> {
  const name = `integration-${seq++}.ts`;
  const file = join(tmpDir, name);
  const out = transformModule(file, source, {
    moduleName: name,
    // tmp file lives in tests/.tmp/, so the runtime registry is two dirs up
    runtimeModule: "../../src/runtime/registry.js",
  });
  if (out === null) throw new Error("fixture contained no kernels");
  writeFileSync(file, out.code);
  return import(file);
}

describe("transformed code end to end", () => {
  it("registers a hoisted kernel before an earlier top-level dispatch", async () => {
    const mod = await compileAndImport(`
import { par, initThreadPool } from "../../src/index.js";
initThreadPool({ threads: 4, timeoutMs: 20_000 });

export const result = par.range(0, 3).map(later).toArray();
export function later(value: number): number {
  "use parallel";
  return value + 10;
}
`);
    expect(mod.result).toEqual([10, 11, 12]);
  });

  it("registers a hoisted nested kernel before an earlier dispatch", async () => {
    const mod = await compileAndImport(`
import { par, shared } from "../../src/index.js";

function run(offset: number) {
  const result = par.range(0, 3).map(later).toArray();
  function later(value: number): number {
    "use parallel";
    return value + offset;
  }
  return result;
}

export const first = run(1);
export const second = run(10);
`);
    expect(mod.first).toEqual([1, 2, 3]);
    expect(mod.second).toEqual([10, 11, 12]);
  });

  it("runs a captured-scalar kernel in parallel", async () => {
    const mod = await compileAndImport(`
import { par } from "../../src/index.js";

const OFFSET = 100;
export function withOffset(x: number): number {
  "use parallel";
  return x + OFFSET;
}

export const result = par.range(0, 1000).map(withOffset).sum();
`);
    // Σ(i + 100) = Σi + 1000*100
    expect(mod.result).toBe((1000 * 999) / 2 + 100_000);
  });

  it("runs inline closures capturing enclosing function scope", async () => {
    const mod = await compileAndImport(`
import { par, shared } from "../../src/index.js";

export function scaledSum(data: Float64Array, factor: number): number {
  return par(data).map((x: number) => {
    "use parallel";
    return x * factor;
  }).sum();
}

const input = shared.f64(Array.from({ length: 10_000 }, (_, i) => i));
export const result = scaledSum(input, 3);
`);
    expect(mod.result).toBe(3 * ((10_000 * 9_999) / 2));
  });

  it("supports kernels calling kernels and self-recursion", async () => {
    const mod = await compileAndImport(`
import { par } from "../../src/index.js";

export function fib(n: number): number {
  "use parallel";
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

export function fibDoubled(n: number): number {
  "use parallel";
  return fib(n) * 2;
}

export const result = par.range(0, 15).map(fibDoubled).collect(Int32Array);
`);
    expect(Array.from((mod.result as Int32Array).slice(10, 13))).toEqual([
      110,
      178,
      288,
    ]);
  });

  it("writes into captured shared arrays from workers", async () => {
    const mod = await compileAndImport(`
import { par, shared, rayonStats } from "../../src/index.js";

const out = shared.i32(50_000);
par.range(0, 50_000).forEach((_x: number, i: number) => {
  "use parallel";
  out[i] = RAYON_THREAD_ID;
});
export const threads = new Set(out).size;
export const stats = rayonStats();
`);
    expect(mod.threads).toBeGreaterThan(1);
    expect((mod.stats as { threadsUsed: number }).threadsUsed).toBeGreaterThan(1);
  });

  it("join runs directive thunks concurrently", async () => {
    const mod = await compileAndImport(`
import { join } from "../../src/index.js";

export function work(n: number): number {
  "use parallel";
  let acc = 0;
  for (let i = 0; i < n; i++) acc += Math.sqrt(i);
  return Math.floor(acc);
}

export const result = join(
  () => { "use parallel"; return work(100_000); },
  () => { "use parallel"; return work(10_000); },
);
`);
    const work = (n: number) => {
      let acc = 0;
      for (let i = 0; i < n; i++) acc += Math.sqrt(i);
      return Math.floor(acc);
    };
    const [a, b] = mod.result as [number, number];
    expect(a).toBe(work(100_000));
    expect(b).toBe(work(10_000));
  });

  it("bundles local and node module imports used inside kernels", async () => {
    const mod = await compileAndImport(`
import { basename } from "node:path";
import { par } from "../../src/index.js";
import { importedLabel, importedScale } from "../fixtures/imported-math.js";

export function importedWork(x: number): number {
  "use parallel";
  return importedScale(x, 3) + basename(importedLabel(x)).length;
}

const nameBonus = 2;
export function importedNameLength(x: number): number {
  "use parallel";
  return basename(importedLabel(x)).length + nameBonus;
}

export function importedNameOnly(x: number): number {
  "use parallel";
  return basename(importedLabel(x)).length;
}

export const result = [
  par.range(0, 10).map(importedWork).sum(),
  par.range(0, 10).map(importedNameLength).sum(),
  par.range(0, 10).map(importedNameOnly).sum(),
];
`);
    let expected = 0;
    let expectedLength = 0;
    for (let i = 0; i < 10; i++) {
      expected += i * 3 + 7 + `value:${i}`.length;
      expectedLength += `value:${i}`.length + 2;
    }
    expect(mod.result).toEqual([
      expected,
      expectedLength,
      expectedLength - 20,
    ]);
  });

  it("shares imported module state between matching bundles in one worker", async () => {
    const mod = await compileAndImport(`
import { par } from "../../src/index.js";
import { nextImportedCount } from "../fixtures/imported-math.js";

function firstCount(): number {
  "use parallel";
  return nextImportedCount();
}

function secondCount(): number {
  "use parallel";
  return nextImportedCount();
}

export const result = [
  par.range(0, 1).map(firstCount).sum(),
  par.range(0, 1).map(secondCount).sum(),
];
`);
    expect(mod.result).toEqual([1, 2]);
  });

  it("does not re-evaluate a shared bundle after a kernel error", async () => {
    const mod = await compileAndImport(`
import { par } from "../../src/index.js";
import { nextImportedCount } from "../fixtures/imported-math.js";

function failingCount(): number {
  "use parallel";
  const count = nextImportedCount();
  throw new Error("expected failure at " + count);
}

function countAfterFailure(): number {
  "use parallel";
  return nextImportedCount();
}

let failed = false;
try {
  par.range(0, 1).map(failingCount).sum();
} catch {
  failed = true;
}

export const result = [
  failed,
  par.range(0, 1).map(countAfterFailure).sum(),
];
`);
    expect(mod.result).toEqual([true, 2]);
  });

  it("maps and filters structured-clone object arrays with inferred result types", async () => {
    const mod = await compileAndImport(`
import { par } from "../../src/index.js";

interface Row {
  id: number;
  when: Date;
  tags: Set<string>;
}

function keepOdd(row: Row): boolean {
  "use parallel";
  return row.id % 2 === 1;
}

function enrich(row: Row) {
  "use parallel";
  return {
    id: row.id,
    iso: row.when.toISOString(),
    metadata: new Map([["tagCount", row.tags.size], ["double", row.id * 2]]),
    blob: new Blob([String(row.id)]),
  };
}

const rows: Row[] = Array.from({ length: 20 }, (_, id) => ({
  id,
  when: new Date(Date.UTC(2024, 0, id + 1)),
  tags: new Set(["a", String(id)]),
}));
export const result = par(rows).filter(keepOdd).map(enrich).toArray();
`);
    const result = mod.result as Array<{
      id: number;
      iso: string;
      metadata: Map<string, number>;
      blob: Blob;
    }>;
    expect(result.map((row) => row.id)).toEqual([1, 3, 5, 7, 9, 11, 13, 15, 17, 19]);
    expect(result[0]!.iso).toBe("2024-01-02T00:00:00.000Z");
    expect(result[0]!.metadata).toEqual(new Map([["tagCount", 2], ["double", 2]]));
    expect(await result[0]!.blob.text()).toBe("1");
  });

  it("keeps distinct captured environments for closures from one source site", async () => {
    const mod = await compileAndImport(`
import { par } from "../../src/index.js";

function makeAdder(offset: number) {
  return (x: number) => {
    "use parallel";
    return x + offset;
  };
}

const add1 = makeAdder(1);
const add10 = makeAdder(10);
export const result = par.range(0, 3).map(add1).map(add10).toArray();
`);
    expect(mod.result).toEqual([11, 12, 13]);
  });

  it("supports shadowed globals and nested function execution semantics", async () => {
    const mod = await compileAndImport(`
import { par } from "../../src/index.js";

const Math = { offset: 5 };
function nested(value: number): number {
  "use parallel";
  function local(this: { offset: number }, input: number): number {
    function* values(item: number) { yield item; }
    return this.offset + (arguments[0] as number) + [...values(input)][0]!;
  }
  return local.call(Math, value);
}

export const result = par.range(0, 3).map(nested).toArray();
`);
    expect(mod.result).toEqual([5, 7, 9]);
  });

  it("runs kernels that use minimum-Node web globals without captures", async () => {
    const mod = await compileAndImport(`
import { par } from "../../src/index.js";

function nodeGlobals(value: number): number {
  "use parallel";
  const file = new File([String(value)], "value.txt");
  const highWater =
    new ByteLengthQueuingStrategy({ highWaterMark: 4 }).highWaterMark +
    new CountQueuingStrategy({ highWaterMark: 5 }).highWaterMark;
  return file.size + highWater +
    (typeof CompressionStream === "function" ? 1 : 0) +
    (typeof SubtleCrypto === "function" ? 1 : 0);
}

export const result = par.range(0, 1).map(nodeGlobals).sum();
`);
    expect(mod.result).toBe(12);
  });

  it("lowers newer syntax in expression-only kernels for Node 20 workers", async () => {
    const mod = await compileAndImport(`
import { par } from "../../src/index.js";

function managed(value: number): number {
  "use parallel";
  using resource = null;
  return value + 1;
}

export const result = par.range(0, 3).map(managed).toArray();
`);
    expect(mod.result).toEqual([1, 2, 3]);
  });

  it("micro-batches calls through a transformed parallel kernel", async () => {
    const mod = await compileAndImport(`
import { createParallelBatcher } from "../../src/index.js";

interface Event { id: number; valid: boolean }
function verifyEvent(event: Event): boolean {
  "use parallel";
  return event.valid && event.id >= 0;
}

const verify = createParallelBatcher(verifyEvent, {
  maxBatchSize: 3,
  maxWaitMs: 5,
  maxPending: 16,
});
export const result = await Promise.all([
  verify({ id: 1, valid: true }),
  verify({ id: 2, valid: false }),
  verify({ id: 3, valid: true }),
  verify({ id: -1, valid: true }),
]);
await verify.close();
`);
    expect(mod.result).toEqual([true, false, true, false]);
  });

  it("runs nested par and join inline on the current worker", async () => {
    const mod = await compileAndImport(`
import { join, par, rayonStats } from "../../src/index.js";

interface NestedResult {
  total: number;
  outerThread: number;
  innerThreads: number[];
  joinThreads: number[];
  innerStats: unknown;
}

function nested(end: number): NestedResult {
  "use parallel";
  const outerThread = RAYON_THREAD_ID;
  const values = par.range(0, end).map((value: number) => {
    "use parallel";
    return { value: value * value, thread: RAYON_THREAD_ID };
  }).collect(Array);
  const joined = join(
    () => { "use parallel"; return { value: end, thread: RAYON_THREAD_ID }; },
    () => { "use parallel"; return { value: end * 2, thread: RAYON_THREAD_ID }; },
  );
  return {
    total:
      values.reduce((sum, item) => sum + item.value, 0) +
      joined[0].value +
      joined[1].value,
    outerThread,
    innerThreads: [...new Set(values.map((item) => item.thread))],
    joinThreads: joined.map((item) => item.thread),
    innerStats: rayonStats(),
  };
}

export const result = par.range(3, 7).map(nested).collect(Array);
`);
    const results = mod.result as Array<{
      total: number;
      outerThread: number;
      innerThreads: number[];
      joinThreads: number[];
      innerStats: unknown;
    }>;
    expect(results).toHaveLength(4);
    for (let offset = 0; offset < results.length; offset++) {
      const end = offset + 3;
      const result = results[offset]!;
      const squares = Array.from({ length: end }, (_, i) => i * i)
        .reduce((sum, value) => sum + value, 0);
      expect(result.total).toBe(squares + end * 3);
      expect(result.outerThread).toBeGreaterThan(0);
      expect(result.innerThreads).toEqual([result.outerThread]);
      expect(result.joinThreads).toEqual([result.outerThread, result.outerThread]);
      expect(result.innerStats).toBeNull();
    }
  });

  it("transfers MessagePort values returned by join", async () => {
    const mod = await compileAndImport(`
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { join } from "../../src/index.js";

const [receivedPort] = join(() => {
  "use parallel";
  const { port1, port2 } = new MessageChannel();
  port2.postMessage({ ok: true, values: new Set([1, 2, 3]) });
  port2.close();
  return port1;
});
export const result = receiveMessageOnPort(receivedPort)?.message;
receivedPort.close();
`);
    expect(mod.result).toEqual({ ok: true, values: new Set([1, 2, 3]) });
  });

  it("transfers MessagePort values returned by par().toArray()", async () => {
    const mod = await compileAndImport(`
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { par } from "../../src/index.js";

function makePort(value: number) {
  "use parallel";
  const { port1, port2 } = new MessageChannel();
  port2.postMessage({ value, map: new Map([["worker", RAYON_THREAD_ID]]) });
  port2.close();
  return port1;
}

const [receivedPort] = par.range(7, 8).map(makePort).toArray();
export const result = receiveMessageOnPort(receivedPort)?.message;
receivedPort.close();
`);
    const result = mod.result as { value: number; map: Map<string, number> };
    expect(result.value).toBe(7);
    expect(result.map.get("worker")).toBeGreaterThan(0);
  });

  it("transfers AbortSignal values marked by node:util", async () => {
    const mod = await compileAndImport(`
import { transferableAbortController } from "node:util";
import { par } from "../../src/index.js";

function makeSignal() {
  "use parallel";
  const controller = transferableAbortController();
  controller.abort("worker stopped");
  return controller.signal;
}

export const [signal] = par.range(0, 1).map(makeSignal).toArray();
`);
    const signal = mod.signal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe("worker stopped");
  });
});

import { BlockList } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { initThreadPool, join, joinAsync, par, RayonError, shared } from "../src/index.js";
import { __rayonRegister } from "../src/runtime/registry.js";
import { fib, square } from "./helpers/manual-kernels.js";

initThreadPool({ threads: 4, timeoutMs: 20_000 });

const N = 100_000;
const sumTo = (n: number) => (n * (n - 1)) / 2;

/** Kernel over an array chunk: sums the sub-slice. */
const sumChunk = __rayonRegister((c: Float64Array) => {
  let acc = 0;
  for (let i = 0; i < c.length; i++) acc += c[i]!;
  return acc;
}, {
  id: "manual::sumChunk",
  source: "(c) => { let acc = 0; for (let i = 0; i < c.length; i++) acc += c[i]; return acc; }",
  getEnv: () => ({}),
});

/** Kernel over a range chunk: sums i*i over [start, end). */
const sumSquaresRange = __rayonRegister(({ start, end }: { start: number; end: number }) => {
  let acc = 0;
  for (let i = start; i < end; i++) acc += i * i;
  return acc;
}, {
  id: "manual::sumSquaresRange",
  source: "({ start, end }) => { let acc = 0; for (let i = start; i < end; i++) acc += i * i; return acc; }",
  getEnv: () => ({}),
});

/** In-place doubling of a chunk view — Rayon's par_chunks_mut. */
const doubleInPlace = __rayonRegister((c: Float64Array) => {
  for (let i = 0; i < c.length; i++) c[i] = c[i]! * 2;
  return 0;
}, {
  id: "manual::doubleInPlace",
  source: "(c) => { for (let i = 0; i < c.length; i++) c[i] = c[i] * 2; return 0; }",
  getEnv: () => ({}),
});

const isBufferChunk = __rayonRegister((chunk: Uint8Array): number => {
  return Buffer.isBuffer(chunk) ? 1 : 0;
}, {
  id: "manual::isBufferChunk",
  source: "(chunk) => Buffer.isBuffer(chunk) ? 1 : 0",
  getEnv: () => ({}),
});

describe("chunks()", () => {
  it("array chunks see zero-copy sub-slices", () => {
    const data = shared.f64(N);
    for (let i = 0; i < N; i++) data[i] = i;
    expect(par(data).chunks(1024).map(sumChunk).sum()).toBe(sumTo(N));
  });

  it("handles a trailing partial chunk", () => {
    const data = shared.f64(1000);
    data.fill(1);
    // 1000 / 333 -> chunks of 333, 333, 333, 1
    const counts = par(data).chunks(333).map(sumChunk).collect();
    expect([...counts]).toEqual([333, 333, 333, 1]);
  });

  it("range chunks receive {start, end} descriptors", () => {
    const total = par.range(0, 100_001).chunks(4096).map(sumSquaresRange).sum();
    let expected = 0;
    for (let i = 0; i <= 100_000; i++) expected += i * i;
    expect(total).toBe(expected);
  });

  it("generic array chunks preserve values and the trailing partial slice", () => {
    const chunkLabels = __rayonRegister(
      (chunk: readonly { label: string }[]): string =>
        chunk.map((item) => item.label).join(","),
      {
        id: "manual::genericChunkLabels",
        source: "(chunk) => chunk.map((item) => item.label).join(',')",
        getEnv: () => ({}),
      },
    );
    const values = ["a", "b", "c", "d", "e"].map((label) => ({ label }));

    expect(par(values).chunks(2).map(chunkLabels).toArray()).toEqual([
      "a,b",
      "c,d",
      "e",
    ]);
  });

  it("canonicalizes Buffer chunks to Uint8Array across worker boundaries", () => {
    const data = Buffer.from(new SharedArrayBuffer(8));
    expect(par(data).chunks(2).map(isBufferChunk).sum()).toBe(0);
  });

  it("kernels can mutate chunk views in place (par_chunks_mut)", () => {
    const data = shared.f64(10_000);
    for (let i = 0; i < data.length; i++) data[i] = i;
    par(data).chunksMut(512).forEach(doubleInPlace);
    expect(data[7777]).toBe(15554);
    expect(data[9999]).toBe(19998);
  });

  it("rejects invalid chunk sizes", () => {
    expect(() => par.range(0, 10).chunks(0)).toThrow(RayonError);
    expect(() => par(shared.f64(4)).chunks(1.5)).toThrow(RayonError);
    expect(() => par.range(0, 10).chunks(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      /safe integer/,
    );
    expect(() =>
      // @ts-expect-error runtime guard remains for untyped JavaScript callers
      par(new Float64Array(4)).chunksMut(2).forEach(doubleInPlace),
    ).toThrow(/SharedArrayBuffer/);
  });
});

describe("withMinLen / withMaxLen", () => {
  it("computes the same results with granularity bounds", () => {
    expect(par.range(0, N).withMinLen(10_000).map(square).sum()).toBe(par.range(0, N).map(square).sum());
    expect(par.range(0, N).withMaxLen(64).map(square).sum()).toBe(par.range(0, N).map(square).sum());
  });

  it("validates arguments", () => {
    expect(() => par.range(0, 10).withMinLen(0)).toThrow(RayonError);
    expect(() => par.range(0, 10).withMaxLen(-3)).toThrow(RayonError);
    expect(() => par.range(0, 10).withMinLen(10).withMaxLen(5)).toThrow(
      /cannot be smaller/,
    );
    expect(() => par.range(0, 10).withMaxLen(5).withMinLen(10)).toThrow(
      /cannot exceed/,
    );
  });
});

describe("async()", () => {
  it("resolves terminals without blocking the event loop", async () => {
    let ticked = false;
    setImmediate(() => {
      ticked = true;
    });
    const total = await par.range(0, N).map(square).async().sum();
    let expected = 0;
    for (let i = 0; i < N; i++) expected += i * i;
    expect(total).toBe(expected);
    // the timer fired while workers were busy — the loop was not blocked
    await new Promise((r) => setImmediate(r));
    expect(ticked).toBe(true);
  });

  it("supports chunked async collect and forEach", async () => {
    const data = shared.f64(50_000);
    data.fill(2);
    const sums = await par(data).chunks(5000).map(sumChunk).async().collect();
    expect([...sums]).toEqual(Array.from({ length: 10 }, () => 10_000));
    await par(data).chunksMut(5000).async().forEach(doubleInPlace);
    expect(data[123]).toBe(4);
  });

  it("queues concurrent async jobs in FIFO order", async () => {
    const [a, b, c] = await Promise.all([
      par.range(0, 50_000).async().sum(),
      par.range(0, 60_000).async().sum(),
      par.range(0, 70_000).async().sum(),
    ]);
    expect(a).toBe(sumTo(50_000));
    expect(b).toBe(sumTo(60_000));
    expect(c).toBe(sumTo(70_000));
  });

  it("joinAsync resolves ordered results", async () => {
    const ta = __rayonRegister(() => fib(18), { id: "manual::ajoinA", source: "() => __env.fib(18)", getEnv: () => ({ fib }) });
    const tb = __rayonRegister(() => fib(12), { id: "manual::ajoinB", source: "() => __env.fib(12)", getEnv: () => ({ fib }) });
    await expect(joinAsync(ta, tb)).resolves.toEqual([2584, 144]);
  });

  it("rejects sync dispatch while an async job is in flight", async () => {
    const pending = par.range(0, 5_000_000).map(square).async().sum();
    expect(() => par.range(0, 100).sum()).toThrow(/async parallel operation is in flight/);
    await pending; // pool is usable again afterwards
    expect(par.range(0, 100).sum()).toBe(sumTo(100));
  });

  it("propagates kernel errors as rejections and keeps the pool alive", async () => {
    const bad = __rayonRegister((x: number) => {
      if (x === 5555) throw new RangeError("async boom");
      return x;
    }, {
      id: "manual::asyncThrow",
      source: "(x) => { if (x === 5555) throw new RangeError('async boom'); return x; }",
      getEnv: () => ({}),
    });
    await expect(par.range(0, N).map(bad).async().sum()).rejects.toThrow(/async boom/);
    expect(await par.range(0, 100).async().sum()).toBe(sumTo(100));
    expect(join()).toEqual([]);
  });

  it("uses one capture snapshot for worker partials and the final reduce merge", async () => {
    interface Pair {
      left: number;
      right: number;
    }
    type Field = keyof Pair;

    const toPair = __rayonRegister(
      (value: number): Pair => ({ left: value, right: value }),
      {
        id: "manual::asyncSnapshotValue",
        source: "(value) => ({ left: value, right: value })",
        getEnv: () => ({}),
      },
    );
    let field: Field = "left";
    const combine = __rayonRegister(
      (first: Pair, second: Pair): Pair => ({
        ...first,
        [field]: first[field] + second[field],
      }),
      {
        id: "manual::asyncSnapshotCombine",
        source:
          "(first, second) => ({ ...first, " +
          "[__env.field]: first[__env.field] + second[__env.field] })",
        getEnv: () => ({ field }),
      },
    );

    const pending = par
      .range(0, 100_000)
      .map(toPair)
      .async()
      .reduce(combine, { left: 0, right: 0 });
    field = "right";

    await expect(pending).resolves.toEqual({ left: sumTo(100_000), right: 0 });
  });

  it("snapshots non-shared typed-array captures before async publication", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const bytes = new Uint8Array([1]);
      const addCapturedByte = __rayonRegister(
        (value: number): number => value + bytes[0]!,
        {
          id: "manual::asyncTypedArraySnapshot",
          source: "(value) => value + __env.bytes[0]",
          getEnv: () => ({ bytes }),
        },
      );

      const pending = par.range(0, 3).map(addCapturedByte).async().toArray();
      bytes[0] = 9;

      await expect(pending).resolves.toEqual([1, 2, 3]);
    } finally {
      warning.mockRestore();
    }
  });

  it("follows Node semantics for host captures with shared native state", async () => {
    const blockList = new BlockList();
    const checksList = __rayonRegister(
      (): boolean => blockList.check("127.0.0.1"),
      {
        id: "manual::sharedNativeCapture",
        source: '() => __env.blockList.check("127.0.0.1")',
        getEnv: () => ({ blockList }),
      },
    );

    const pending = par.range(0, 2).map(checksList).async().toArray();
    blockList.addAddress("127.0.0.1");

    await expect(pending).resolves.toEqual([true, true]);
  });
});

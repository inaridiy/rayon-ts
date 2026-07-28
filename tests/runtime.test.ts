import { createSecretKey } from "node:crypto";
import { BlockList } from "node:net";
import { createHistogram } from "node:perf_hooks";
import {
  MessageChannel,
  type MessagePort,
  receiveMessageOnPort,
} from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { initThreadPool, join, par, rayonStats, shared } from "../src/index.js";
import {
  CaptureError,
  KernelNotCompiledError,
  KernelRuntimeError,
} from "../src/runtime/errors.js";
import { claimWork, CTRL, CTRL_LEN } from "../src/runtime/protocol.js";
import { __rayonRegister } from "../src/runtime/registry.js";
import {
  add,
  fib,
  isEven,
  isEvenRec,
  makeThreadRecorder,
  scale,
  square,
  squarePlusOne,
  throwOn,
} from "./helpers/manual-kernels.js";

initThreadPool({ threads: 4, timeoutMs: 20_000 });

const N = 100_000;
const sumTo = (n: number) => (n * (n - 1)) / 2;

describe("reductions", () => {
  it("sums a range", () => {
    expect(par.range(0, N).sum()).toBe(sumTo(N));
  });

  it("sums with a map kernel", () => {
    // Σ x^2 for 0..9 = 285
    expect(par.range(0, 10).map(square).sum()).toBe(285);
  });

  it("min/max/count", () => {
    expect(par.range(5, N).min()).toBe(5);
    expect(par.range(0, N).map(square).max()).toBe((N - 1) ** 2);
    expect(par.range(0, N).filter(isEven).count()).toBe(N / 2);
  });

  it("reduce with an associative combiner folds in source order", () => {
    expect(par.range(1, 101).reduce(add, 0)).toBe(5050);
  });

  it("reduces structured-clone objects with an isolated identity per chunk", async () => {
    interface Summary {
      total: number;
      values: number[];
    }
    const summarize = __rayonRegister(
      (value: number): Summary => ({ total: value, values: [value] }),
      {
        id: "manual::objectSummary",
        source: "(value) => ({ total: value, values: [value] })",
        getEnv: () => ({}),
      },
    );
    const merge = __rayonRegister(
      (left: Summary, right: Summary): Summary => {
        left.total += right.total;
        left.values.push(...right.values);
        return left;
      },
      {
        id: "manual::objectSummaryMerge",
        source:
          "(left, right) => { left.total += right.total; " +
          "left.values.push(...right.values); return left; }",
        getEnv: () => ({}),
      },
    );
    const identity: Summary = { total: 0, values: [] };

    const result = par.range(0, 257).map(summarize).reduce(merge, identity);

    expect(result).not.toBe(identity);
    expect(identity).toEqual({ total: 0, values: [] });
    expect(result.total).toBe(sumTo(257));
    expect(result.values).toEqual(Array.from({ length: 257 }, (_, i) => i));

    const asyncResult = await par.range(0, 17).map(summarize).async().reduce(merge, identity);
    expect(asyncResult).toEqual({
      total: sumTo(17),
      values: Array.from({ length: 17 }, (_, i) => i),
    });
    expect(identity).toEqual({ total: 0, values: [] });
  });

  it("transfers ArrayBuffer values through the final object reduction merge", () => {
    interface Buffers {
      values: ArrayBuffer[];
    }
    const makeBuffer = __rayonRegister(
      (value: number): Buffers => ({
        values: [Uint8Array.of(value).buffer],
      }),
      {
        id: "manual::objectReductionBuffer",
        source: "(value) => ({ values: [Uint8Array.of(value).buffer] })",
        getEnv: () => ({}),
      },
    );
    const mergeBuffers = __rayonRegister(
      (left: Buffers, right: Buffers): Buffers => {
        left.values.push(...right.values);
        return left;
      },
      {
        id: "manual::objectReductionBufferMerge",
        source:
          "(left, right) => { left.values.push(...right.values); return left; }",
        getEnv: () => ({}),
      },
    );

    const result = par
      .range(0, 32)
      .withMaxLen(1)
      .map(makeBuffer)
      .reduce(mergeBuffers, { values: [] });

    expect(result.values.map((buffer) => new Uint8Array(buffer)[0])).toEqual(
      Array.from({ length: 32 }, (_, value) => value),
    );
  });

  it("reduces Buffer values through their worker-safe Uint8Array shape", () => {
    const makeByte = __rayonRegister(
      (value: number): Buffer => Buffer.from([value]),
      {
        id: "manual::bufferReductionValue",
        source: "(value) => Buffer.from([value])",
        getEnv: () => ({}),
      },
    );
    const mergeBytes = __rayonRegister(
      (left: Uint8Array, right: Uint8Array): Uint8Array =>
        Uint8Array.of(left[0]! + right[0]!),
      {
        id: "manual::bufferReductionMerge",
        source: "(left, right) => Uint8Array.of(left[0] + right[0])",
        getEnv: () => ({}),
      },
    );

    const result = par
      .range(1, 5)
      .map(makeByte)
      .reduce(mergeBytes, Buffer.alloc(1));

    expect(Buffer.isBuffer(result)).toBe(false);
    expect(result).toEqual(Uint8Array.of(10));
  });

  it("captured scalars are snapshotted per dispatch", () => {
    expect(par.range(0, 4).map(scale).sum()).toBe((0 + 1 + 2 + 3) * 2.5);
  });

  it("empty sources return identities without dispatch", () => {
    expect(par.range(0, 0).sum()).toBe(0);
    expect(par.range(3, 3).min()).toBe(Infinity);
    expect(par.range(3, 3).max()).toBe(-Infinity);
    expect(par.range(0, 0).collect()).toHaveLength(0);
  });

  it("validates shared-array lengths", () => {
    expect(() => shared.f64(-1)).toThrow(/non-negative safe integer/);
    expect(() => shared.i32(1.5)).toThrow(/non-negative safe integer/);
    expect(() => shared.u8(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      /non-negative safe integer/,
    );
  });
});

describe("map / collect / forEach", () => {
  it("collects a mapped range into a typed array", () => {
    const out = par.range(0, 1000).map(square).collect(Float64Array);
    expect(out).toHaveLength(1000);
    expect(out[31]).toBe(961);
    expect(out.buffer).toBeInstanceOf(SharedArrayBuffer);
  });

  it("collects into other dtypes", () => {
    const out = par.range(0, 100).map(square).collect(Int32Array);
    expect(out).toBeInstanceOf(Int32Array);
    expect(out[9]).toBe(81);
  });

  it("filtered collect preserves source order", () => {
    const out = par.range(0, 10_000).filter(isEven).map(square).collect();
    expect(out).toHaveLength(5000);
    for (let i = 0; i < 5000; i++) {
      if (out[i] !== (2 * i) ** 2) throw new Error(`order broken at ${i}`);
    }
  });

  it("iterates shared typed arrays zero-copy", () => {
    const data = shared.f64(N);
    for (let i = 0; i < N; i++) data[i] = i;
    expect(par(data).sum()).toBe(sumTo(N));
  });

  it("copies non-shared inputs and still computes correctly", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const data = Float64Array.from({ length: 1000 }, (_, i) => i);
      expect(par(data).map(square).sum()).toBe(
        par.range(0, 1000).map(square).sum(),
      );
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("input typed array is not backed by a SharedArrayBuffer"),
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("accepts plain number arrays", () => {
    expect(par([1, 2, 3, 4]).map(square).sum()).toBe(30);
  });

  it("supports Buffer input and collection without changing its view type", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const out = par(Buffer.from([2, 3, 4])).map(square).collect(Buffer);
      expect(Buffer.isBuffer(out)).toBe(true);
      expect([...out]).toEqual([4, 9, 16]);
      expect(out.buffer).toBeInstanceOf(SharedArrayBuffer);
    } finally {
      warning.mockRestore();
    }
  });

  it("canonicalizes typed-array subclasses when copying input", () => {
    class OddFloat64Array extends Float64Array {
      constructor(value: number | ArrayBufferLike) {
        // Deliberately ignores buffers, which used to corrupt the shared copy.
        super(typeof value === "number" ? value : 1);
      }
    }
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const input = new OddFloat64Array(10);
      input.fill(1);
      expect(par(input).sum()).toBe(10);
    } finally {
      warning.mockRestore();
    }
  });

  it("rejects typed-array constructors that ignore the supplied shared buffer", () => {
    class BrokenFloat64Array extends Float64Array {
      constructor(_value: number | ArrayBufferLike) {
        super(1);
      }
    }

    expect(() =>
      par.range(0, 10).collect(BrokenFloat64Array),
    ).toThrow(/constructor must create an exact-length/);
  });

  it("round-trips Node.js structured-clone data through par().toArray()", () => {
    interface Payload {
      id: number;
      big: bigint;
      date: Date;
      regex: RegExp;
      map: Map<string, number>;
      set: Set<number>;
      error: TypeError;
      bytes: Uint8Array;
      self?: Payload;
    }
    const echo = __rayonRegister((value: Payload): Payload => value, {
      id: "manual::echoSerializable",
      source: "(value) => value",
      getEnv: () => ({}),
    });
    const payload: Payload = {
      id: 7,
      big: 12345678901234567890n,
      date: new Date("2024-01-02T03:04:05.000Z"),
      regex: /rayon/gi,
      map: new Map([["answer", 42]]),
      set: new Set([1, 2]),
      error: new TypeError("typed"),
      bytes: new Uint8Array([1, 2, 3]),
    };
    payload.self = payload;

    const [value] = par([payload]).map(echo).toArray();
    expect(value).not.toBe(payload);
    expect(value!.id).toBe(7);
    expect(value!.big).toBe(12345678901234567890n);
    expect(value!.date).toEqual(new Date("2024-01-02T03:04:05.000Z"));
    expect(value!.regex).toEqual(/rayon/gi);
    expect(value!.map.get("answer")).toBe(42);
    expect(value!.set).toEqual(new Set([1, 2]));
    expect(value!.error).toBeInstanceOf(TypeError);
    expect(value!.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(value!.self).toBe(value);
  });

  it("preserves aliases shared by separate kernel captures", () => {
    const token = { id: 1 };
    const captured = __rayonRegister(() => token, {
      id: "manual::sharedCaptureProducer",
      source: "() => __env.token",
      getEnv: () => ({ token }),
    });
    const isSameCapture = __rayonRegister(
      (value: { id: number }): number => value === token ? 1 : 0,
      {
        id: "manual::sharedCaptureConsumer",
        source: "(value) => value === __env.token ? 1 : 0",
        getEnv: () => ({ token }),
      },
    );

    expect(par.range(0, 10).map(captured).map(isSameCapture).sum()).toBe(10);
  });

  it("preserves aliases shared by generic input and kernel captures", () => {
    const token = { id: 1 };
    const isCaptured = __rayonRegister(
      (value: { id: number }): number => value === token ? 1 : 0,
      {
        id: "manual::inputCaptureAlias",
        source: "(value) => value === __env.token ? 1 : 0",
        getEnv: () => ({ token }),
      },
    );

    expect(par([token]).map(isCaptured).sum()).toBe(1);
  });

  it("preserves each element graph without promising aliases across workers", () => {
    interface SharedPayload {
      id: number;
      self?: SharedPayload;
    }
    const payload: SharedPayload = { id: 1 };
    payload.self = payload;
    const input = Array.from({ length: 200 }, () => payload);
    const work = __rayonRegister(
      (value: SharedPayload): SharedPayload => value,
      {
        id: "manual::crossWorkerAliases",
        source: `(value) => {
          let total = 0;
          for (let index = 0; index < 50000; index++) total += index;
          if (total < 0) throw new Error("unreachable");
          return value;
        }`,
        getEnv: () => ({}),
      },
    );

    const result = par(input).withMaxLen(1).map(work).toArray();
    const threadsUsed = rayonStats()?.threadsUsed ?? 0;

    expect(threadsUsed).toBeGreaterThan(1);
    expect(result.every((value) => value.self === value)).toBe(true);
    expect(new Set(result).size).toBe(threadsUsed);
  });

  it("collects structured-clone objects with collect(Array)", async () => {
    interface Row {
      id: number;
      metadata: Map<string, number>;
    }
    const makeRow = __rayonRegister(
      (id: number): Row => ({ id, metadata: new Map([["double", id * 2]]) }),
      {
        id: "manual::collectObject",
        source: '(id) => ({ id, metadata: new Map([["double", id * 2]]) })',
        getEnv: () => ({}),
      },
    );

    const syncRows = par.range(0, 20).filter(isEven).map(makeRow).collect(Array);
    const asyncRows = await par.range(0, 5).map(makeRow).async().collect(Array);

    expect(syncRows.map((row) => row.id)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
    expect(syncRows[3]!.metadata).toEqual(new Map([["double", 12]]));
    expect(asyncRows.map((row) => row.id)).toEqual([0, 1, 2, 3, 4]);
  });

  it("forEach writes into captured shared memory", () => {
    const out = shared.i32(N);
    par.range(0, N).forEach(makeThreadRecorder(out));
    // every element written by exactly one worker thread (never 0 / main)
    const distinct = new Set<number>();
    for (let i = 0; i < N; i++) {
      if (out[i] === 0) throw new Error(`element ${i} not written`);
      distinct.add(out[i]!);
    }
    expect(distinct.size).toBeGreaterThan(1); // actually parallel
    expect(rayonStats()?.threadsUsed).toBeGreaterThan(1);
  });
});

describe("kernel composition", () => {
  it("kernels can call captured kernels", () => {
    expect(par.range(0, 10).map(squarePlusOne).sum()).toBe(295);
  });

  it("self-recursion works via the named function expression", () => {
    const out = par.range(0, 20).map(fib).collect();
    expect(out[10]).toBe(55);
    expect(out[19]).toBe(4181);
  });

  it("mutually recursive kernels survive the encode/decode cycle", () => {
    expect(par.range(0, 100).filter(isEvenRec).count()).toBe(50);
  });

  it("captures cyclic graphs, Map/Set, class data, Errors, and Node host objects", () => {
    class Payload {
      constructor(readonly value: number) {}
    }
    const payload = new Payload(5);
    const cyclic: { base: number; self?: unknown } = { base: 3 };
    cyclic.self = cyclic;
    const kernels = new Map<string, unknown>([["square", square]]);
    const flags = new Set(["a", "b"]);
    const error = new RangeError("boom");
    const key = createSecretKey(Buffer.from([1, 2, 3, 4]));
    const kernel = __rayonRegister((x: number) => x, {
      id: "manual::serializableCapture",
      source: `(x) =>
        __env.payload.value +
        (__env.cyclic.self === __env.cyclic ? __env.cyclic.base + 1 : 0) +
        __env.kernels.get("square")(x) +
        __env.flags.size +
        __env.error.message.length +
        __env.key.export().byteLength`,
      getEnv: () => ({ payload, cyclic, kernels, flags, error, key }),
    });
    expect(par.range(2, 3).map(kernel).sum()).toBe(23);
  });

  it("preserves capture names that collide with Object.prototype", () => {
    const env = Object.create(null) as Record<string, number>;
    env.__proto__ = 9;
    const kernel = __rayonRegister((x: number) => x, {
      id: "manual::prototypeCapture",
      source: "(x) => x + __env.__proto__",
      getEnv: () => env,
    });
    expect(par.range(0, 1).map(kernel).sum()).toBe(9);
  });

  it("publishes source ids that collide with Object.prototype", () => {
    const kernel = __rayonRegister((x: number) => x + 2, {
      id: "__proto__",
      source: "(x) => x + 2",
      getEnv: () => ({}),
    });
    expect(par.range(0, 3).map(kernel).toArray()).toEqual([2, 3, 4]);
  });

  it("preserves sparse captured arrays and their enumerable properties", () => {
    const sparse = Object.assign([] as number[], { extra: square });
    sparse.length = 3;
    sparse[1] = 5;
    const kernel = __rayonRegister((x: number) => x, {
      id: "manual::sparseCapture",
      source:
        "(x) => (!(0 in __env.sparse) && !(2 in __env.sparse) ? " +
        "__env.sparse.extra(x) + __env.sparse[1] + __env.sparse.length : -1)",
      getEnv: () => ({ sparse }),
    });
    expect(par.range(2, 3).map(kernel).sum()).toBe(12);
  });
});

describe("join", () => {
  it("runs thunk kernels concurrently and returns ordered results", () => {
    // register thunks manually, as the plugin would
    const ta = __rayonRegister(() => fib(20), { id: "manual::joinA", source: "() => __env.fib(20)", getEnv: () => ({ fib }) });
    const tb = __rayonRegister(() => fib(15), { id: "manual::joinB", source: "() => __env.fib(15)", getEnv: () => ({ fib }) });
    expect(join(ta, tb)).toEqual([6765, 610]);
  });

  it("join with zero thunks returns []", () => {
    expect(join()).toEqual([]);
  });

  it("returns structured-clone values, including cyclic data", () => {
    const thunk = __rayonRegister(() => null, {
      id: "manual::serializableResult",
      source: `() => {
        const out = {
          big: 12345678901234567890n,
          date: new Date("2024-01-02T03:04:05.000Z"),
          regex: /rayon/gi,
          map: new Map([["answer", 42]]),
          set: new Set([1, 2]),
          error: new TypeError("typed"),
          bytes: new Uint8Array([1, 2, 3])
        };
        out.self = out;
        return out;
      }`,
      getEnv: () => ({}),
    });
    const [value] = join(thunk) as unknown as [{
      big: bigint;
      date: Date;
      regex: RegExp;
      map: Map<string, number>;
      set: Set<number>;
      error: TypeError;
      bytes: Uint8Array;
      self: unknown;
    }];
    expect(value.big).toBe(12345678901234567890n);
    expect(value.date).toEqual(new Date("2024-01-02T03:04:05.000Z"));
    expect(value.regex).toEqual(/rayon/gi);
    expect(value.map.get("answer")).toBe(42);
    expect(value.set).toEqual(new Set([1, 2]));
    expect(value.error).toBeInstanceOf(TypeError);
    expect(value.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(value.self).toBe(value);
  });

  it("transfers values stored in enumerable properties on arrays", () => {
    const thunk = __rayonRegister(() => null, {
      id: "manual::arrayPropertyTransfer",
      source: `() => {
        const { port1, port2 } = new MessageChannel();
        const out = [];
        out.extra = port1;
        port2.postMessage({ ok: true });
        port2.close();
        return out;
      }`,
      getEnv: () => ({}),
    });

    const [value] = join(thunk) as unknown as [
      unknown[] & { extra: MessagePort },
    ];
    expect(receiveMessageOnPort(value.extra)?.message).toEqual({ ok: true });
    value.extra.close();
  });

  it("types and returns worker-created Buffer values as Uint8Array", () => {
    const thunk = __rayonRegister((): Buffer => Buffer.from([1, 2, 3]), {
      id: "manual::workerBufferResult",
      source: "() => Buffer.from([1, 2, 3])",
      getEnv: () => ({}),
    });

    const [value] = join(thunk);
    expect(Buffer.isBuffer(value)).toBe(false);
    expect(value).toBeInstanceOf(Uint8Array);
    expect([...value]).toEqual([1, 2, 3]);
  });

  it("canonicalizes Buffer values recursively inside worker results", () => {
    const thunk = __rayonRegister(
      (): {
        data: Buffer;
        nested: Buffer[];
        byName: Map<string, Buffer>;
      } => ({
        data: Buffer.from([1]),
        nested: [Buffer.from([2])],
        byName: new Map([["three", Buffer.from([3])]]),
      }),
      {
        id: "manual::nestedWorkerBufferResult",
        source: `() => ({
          data: Buffer.from([1]),
          nested: [Buffer.from([2])],
          byName: new Map([["three", Buffer.from([3])]])
        })`,
        getEnv: () => ({}),
      },
    );

    const [value] = join(thunk);
    expect(Buffer.isBuffer(value.data)).toBe(false);
    expect(Buffer.isBuffer(value.nested[0])).toBe(false);
    expect(Buffer.isBuffer(value.byName.get("three"))).toBe(false);
    expect([...value.data, ...value.nested[0]!, ...value.byName.get("three")!])
      .toEqual([1, 2, 3]);
  });

  it("transfers Node Web Streams returned by kernels", async () => {
    const thunk = __rayonRegister(() => null, {
      id: "manual::webStreamTransfer",
      source: `() => ({
        readable: new ReadableStream({
          start(controller) {
            controller.enqueue("readable");
            controller.close();
          }
        }),
        writable: new WritableStream(),
        transform: new TransformStream()
      })`,
      getEnv: () => ({}),
    });

    const [streams] = join(thunk) as unknown as [{
      readable: ReadableStream<string>;
      writable: WritableStream<string>;
      transform: TransformStream<string, string>;
    }];
    await expect(streams.readable.getReader().read()).resolves.toEqual({
      done: false,
      value: "readable",
    });

    const writable = streams.writable.getWriter();
    await writable.write("accepted");
    await writable.close();

    const transformWriter = streams.transform.writable.getWriter();
    const transformReader = streams.transform.readable.getReader();
    const [transformed] = await Promise.all([
      transformReader.read(),
      transformWriter.write("through").then(async () => {
        await transformWriter.close();
        return undefined;
      }),
    ]);
    expect(transformed).toEqual({ done: false, value: "through" });
  });
});

describe("errors", () => {
  it("rejects unsupported par() inputs at the public boundary", () => {
    expect(() => par({ length: 2 } as never)).toThrow(/TypedArray or an array/);
    expect(() => par(new DataView(new ArrayBuffer(8)) as never)).toThrow(
      /TypedArray or an array/,
    );
    expect(() => par(new BigInt64Array(2) as never)).toThrow(
      /TypedArray or an array/,
    );
  });

  it("rejects plain functions with a helpful message", () => {
    expect(() => par.range(0, 10).map((x) => x + 1).sum()).toThrow(KernelNotCompiledError);
    expect(() => par.range(0, 10).map((x) => x + 1).sum()).toThrow(/use parallel/);
  });

  it("propagates kernel exceptions with the worker stack and keeps the pool alive", () => {
    const bad = throwOn(7777);
    expect(() => par.range(0, N).map(bad).sum()).toThrow(KernelRuntimeError);
    try {
      par.range(0, N).map(bad).sum();
    } catch (err) {
      expect((err as KernelRuntimeError).workerError.message).toContain("boom at 7777");
    }
    // pool must remain usable after a failed job
    expect(par.range(0, 100).sum()).toBe(sumTo(100));
  });

  it("rejects capturing a non-kernel function", () => {
    const plain = (x: number) => x + 1;
    const k = __rayonRegister((x: number) => plain(x), {
      id: "manual::badCapture",
      source: "(x) => __env.plain(x)",
      getEnv: () => ({ plain }),
    });
    expect(() => par.range(0, 10).map(k).sum()).toThrow(/not a "use parallel" kernel/);
  });

  it("rejects transfer-only and non-serializable captures before publishing", () => {
    const { port1, port2 } = new MessageChannel();
    const withPort = __rayonRegister((x: number) => x, {
      id: "manual::portCapture",
      source: "(x) => x + (__env.port ? 1 : 0)",
      getEnv: () => ({ port: port1 }),
    });
    expect(() => par.range(0, 1).map(withPort).sum()).toThrow(CaptureError);
    port1.close();
    port2.close();

    const weak = new WeakMap<object, number>();
    const withWeakMap = __rayonRegister((x: number) => x, {
      id: "manual::weakCapture",
      source: "(x) => x + (__env.weak ? 1 : 0)",
      getEnv: () => ({ weak }),
    });
    expect(() => par.range(0, 1).map(withWeakMap).sum()).toThrow(CaptureError);
    expect(par.range(0, 100).sum()).toBe(sumTo(100));
  });

  it("rejects transfer-only and non-serializable par() inputs before publishing", () => {
    const identity = __rayonRegister((value: unknown): unknown => value, {
      id: "manual::inputIdentity",
      source: "(value) => value",
      getEnv: () => ({}),
    });
    const { port1, port2 } = new MessageChannel();
    expect(() => par([port1]).map(identity).toArray()).toThrow(/structured-cloneable/);
    port1.close();
    port2.close();

    expect(() => par([new WeakMap()]).map(identity).toArray()).toThrow(/structured-cloneable/);
    expect(par.range(0, 100).sum()).toBe(sumTo(100));
  });

  it("reports non-serializable worker results without killing the pool", () => {
    const badResult = __rayonRegister(() => null, {
      id: "manual::badResult",
      source: "() => ({ fn: () => 1 })",
      getEnv: () => ({}),
    });
    expect(() => join(badResult)).toThrow(/not serializable or transferable/);
    expect(par.range(0, 100).sum()).toBe(sumTo(100));
  });

  it("rejects a non-cloneable object reduction identity before publishing", () => {
    interface Summary {
      total: number;
      weak?: WeakMap<object, number>;
    }
    const summarize = __rayonRegister(
      (value: number): Summary => ({ total: value }),
      {
        id: "manual::identityValidationValue",
        source: "(value) => ({ total: value })",
        getEnv: () => ({}),
      },
    );
    const merge = __rayonRegister(
      (left: Summary, right: Summary): Summary => ({ total: left.total + right.total }),
      {
        id: "manual::identityValidationMerge",
        source: "(left, right) => ({ total: left.total + right.total })",
        getEnv: () => ({}),
      },
    );
    const identity: Summary = { total: 0, weak: new WeakMap() };

    expect(() => par.range(0, 10).map(summarize).reduce(merge as never, identity)).toThrow(
      /reduce\(\) identity.*structured-cloneable/,
    );
    expect(par.range(0, 100).sum()).toBe(sumTo(100));
  });

  it("rejects shared memory in reduction identities", () => {
    interface Summary {
      total: number;
      scratch?: Int32Array;
    }
    const summarize = __rayonRegister(
      (value: number): Summary => ({ total: value }),
      {
        id: "manual::sharedIdentityValue",
        source: "(value) => ({ total: value })",
        getEnv: () => ({}),
      },
    );
    const merge = __rayonRegister(
      (left: Summary, right: Summary): Summary => ({
        total: left.total + right.total,
      }),
      {
        id: "manual::sharedIdentityMerge",
        source: "(left, right) => ({ total: left.total + right.total })",
        getEnv: () => ({}),
      },
    );
    const scratch = new Int32Array(new SharedArrayBuffer(4));

    expect(() =>
      par
        .range(0, 10)
        .map(summarize)
        .reduce(merge, { total: 0, scratch }),
    ).toThrow(/identity.*SharedArrayBuffer/);
    expect(par.range(0, 100).sum()).toBe(sumTo(100));
  });

  it("rejects structured-clone host objects whose mutable state is not isolated", () => {
    interface Summary {
      total: number;
      host?: unknown;
    }
    const summarize = __rayonRegister(
      (value: number): Summary => ({ total: value }),
      {
        id: "manual::unsafeHostIdentityValue",
        source: "(value) => ({ total: value })",
        getEnv: () => ({}),
      },
    );
    const merge = __rayonRegister(
      (left: Summary, right: Summary): Summary => ({
        total: left.total + right.total,
      }),
      {
        id: "manual::unsafeHostIdentityMerge",
        source: "(left, right) => ({ total: left.total + right.total })",
        getEnv: () => ({}),
      },
    );
    const unsafeHosts = [
      new (
        globalThis as unknown as {
          WebAssembly: {
            Memory: new (descriptor: {
              initial: number;
              maximum: number;
              shared: boolean;
            }) => object;
          };
        }
      ).WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }),
      createHistogram(),
      new BlockList(),
      Object.assign([] as unknown[], { extra: new BlockList() }),
    ];

    for (const host of unsafeHosts) {
      expect(() =>
        par
          .range(0, 2)
          .map(summarize)
          .reduce(merge, { total: 0, host }),
      ).toThrow(/clone-isolation-unsafe type/);
    }
    expect(par.range(0, 100).sum()).toBe(sumTo(100));
  });

  it("reports a non-serializable object reduction partial without killing the pool", () => {
    interface Summary {
      total: number;
    }
    const summarize = __rayonRegister(
      (value: number): Summary => ({ total: value }),
      {
        id: "manual::badObjectFoldValue",
        source: "(value) => ({ total: value })",
        getEnv: () => ({}),
      },
    );
    const badMerge = __rayonRegister(
      (left: Summary, right: Summary): Summary => ({ total: left.total + right.total }),
      {
        id: "manual::badObjectFoldMerge",
        source:
          "(left, right) => ({ total: left.total + right.total, " +
          "notCloneable: () => 1 })",
        getEnv: () => ({}),
      },
    );

    expect(() =>
      par.range(0, 10).map(summarize).reduce(badMerge, { total: 0 }),
    ).toThrow(/not serializable or transferable/);
    expect(par.range(0, 100).sum()).toBe(sumTo(100));
  });

  it("reports result serialization getters that throw without timing out", () => {
    const badResult = __rayonRegister(() => null, {
      id: "manual::throwingResultGetter",
      source: `() => {
        const value = {};
        Object.defineProperty(value, "broken", {
          enumerable: true,
          get() { throw new Error("getter exploded"); }
        });
        return value;
      }`,
      getEnv: () => ({}),
    });
    expect(() => join(badResult)).toThrow(/getter exploded/);
    expect(par.range(0, 100).sum()).toBe(sumTo(100));
  });

  it("reports thrown values whose toString also throws without losing the worker", () => {
    const hostileThrow = __rayonRegister(() => undefined, {
      id: "manual::hostileThrownValue",
      source:
        '() => { throw { toString() { throw new Error("stringify exploded"); } }; }',
      getEnv: () => ({}),
    });

    expect(() => join(hostileThrow)).toThrow(/unprintable thrown value/);
    expect(par.range(0, 100).sum()).toBe(sumTo(100));
  });

  it("re-publishes a source id after worker compilation failed", () => {
    const broken = __rayonRegister((x: number) => x, {
      id: "manual::compileRetry",
      source: "(",
      getEnv: () => ({}),
    });
    expect(() => par.range(0, 1).map(broken).sum()).toThrow(/failed to compile kernel/);

    const repaired = __rayonRegister((x: number) => x + 1, {
      id: "manual::compileRetry",
      source: "(x) => x + 1",
      getEnv: () => ({}),
    });
    expect(par.range(0, 3).map(repaired).toArray()).toEqual([1, 2, 3]);
  });
});

describe("chunking edge cases", () => {
  it("handles totals smaller than the worker count", () => {
    expect(par.range(0, 2).map(square).sum()).toBe(1);
    expect(par.range(0, 1).sum()).toBe(0);
  });

  it("handles awkward prime-sized totals", () => {
    expect(par.range(0, 9973).sum()).toBe(sumTo(9973));
  });

  it("rejects jobs that would overflow the Int32 atomic cursor", () => {
    expect(() => par.range(0, 0x8000_0000).sum()).toThrow(/at most/);
    expect(() => par.range(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1)).toThrow(
      /safe integers/,
    );
  });

  it("saturates the final atomic claim without wrapping Int32", () => {
    const ctrl = new Int32Array(new SharedArrayBuffer(CTRL_LEN * Int32Array.BYTES_PER_ELEMENT));
    const total = 0x7fff_ffff;
    Atomics.store(ctrl, CTRL.CURSOR, total - 2);
    expect(claimWork(ctrl, total, 65_536)).toBe(total - 2);
    expect(Atomics.load(ctrl, CTRL.CURSOR)).toBe(total);
    expect(claimWork(ctrl, total, 65_536)).toBe(total);
    expect(Atomics.load(ctrl, CTRL.CURSOR)).toBe(total);
  });

  it("back-to-back jobs reuse the pool", () => {
    for (let i = 0; i < 25; i++) {
      expect(par.range(0, 1000).sum()).toBe(sumTo(1000));
    }
  });
});

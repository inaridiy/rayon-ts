/**
 * Hand-written equivalents of what the Vite plugin generates. Used to prove
 * the runtime protocol independently of the transform.
 */
import { __rayonRegister } from "../../src/runtime/registry.js";

export const square = __rayonRegister((x: number) => x * x, {
  id: "manual::square",
  source: "(x) => x * x",
  getEnv: () => ({}),
});

const SCALE = 2.5;
export const scale = __rayonRegister((x: number) => x * SCALE, {
  id: "manual::scale",
  source: "(x) => x * __env.SCALE",
  getEnv: () => ({ SCALE }),
});

export const isEven = __rayonRegister((x: number) => x % 2 === 0, {
  id: "manual::isEven",
  source: "(x) => x % 2 === 0",
  getEnv: () => ({}),
});

export const add = __rayonRegister((a: number, b: number) => a + b, {
  id: "manual::add",
  source: "(a, b) => a + b",
  getEnv: () => ({}),
});

/** Self-recursive kernel: the inner `fib` binds to the named function expression. */
export const fib = __rayonRegister(
  function fib(n: number): number {
    return n < 2 ? n : fib(n - 1) + fib(n - 2);
  },
  {
    id: "manual::fib",
    source: "(function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); })",
    getEnv: () => ({}),
  },
);

/** Kernel calling another kernel through a captured reference. */
export const squarePlusOne = __rayonRegister((x: number) => square(x) + 1, {
  id: "manual::squarePlusOne",
  source: "(x) => __env.square(x) + 1",
  getEnv: () => ({ square }),
});

/** Mutually recursive kernels (cycle in the captured-kernel graph). */
// eslint-disable-next-line prefer-const
let isOdd: (n: number) => boolean;
export const isEvenRec = __rayonRegister((n: number): boolean => (n === 0 ? true : isOdd(n - 1)), {
  id: "manual::isEvenRec",
  source: "(n) => n === 0 ? true : __env.isOdd(n - 1)",
  getEnv: () => ({ isOdd }),
});
isOdd = __rayonRegister((n: number): boolean => (n === 0 ? false : isEvenRec(n - 1)), {
  id: "manual::isOdd",
  source: "(n) => n === 0 ? false : __env.isEvenRec(n - 1)",
  getEnv: () => ({ isEvenRec }),
});

/** Writes the executing thread id into a shared array — parallelism witness. */
export function makeThreadRecorder(out: Int32Array) {
  return __rayonRegister((x: number, i: number) => {
    out[i] = RAYON_THREAD_ID;
    return x;
  }, {
    id: `manual::threadRecorder#${threadRecorderSeq++}`,
    source: "(x, i) => { __env.out[i] = RAYON_THREAD_ID; return x; }",
    getEnv: () => ({ out }),
  });
}
let threadRecorderSeq = 0;

export const throwOn = (needle: number) =>
  __rayonRegister((x: number) => {
    if (x === needle) throw new RangeError(`boom at ${needle}`);
    return x;
  }, {
    id: `manual::throwOn#${throwOnSeq++}`,
    source: "(x) => { if (x === __env.needle) throw new RangeError('boom at ' + __env.needle); return x; }",
    getEnv: () => ({ needle }),
  });
let throwOnSeq = 0;

/**
 * CPU-bound benchmark suite. Each workload runs the *same* kernel functions
 * sequentially (direct calls in a plain loop) and in parallel (worker pool),
 * verifies the results agree, and reports the median of several runs.
 */
import { initThreadPool, par, rayonStats, shared } from "rayon-ts";

// ---------------------------------------------------------------- workloads

export function mandelPoint(cx: number, cy: number): number {
  "use parallel";
  let x = 0;
  let y = 0;
  let iter = 0;
  while (x * x + y * y <= 4 && iter < 1000) {
    const nx = x * x - y * y + cx;
    y = 2 * x * y + cy;
    x = nx;
    iter += 1;
  }
  return iter;
}

const MW = 1000;
const MH = 700;
export function mandelPixel(idx: number): number {
  "use parallel";
  const cx = -2.2 + ((idx % MW) / MW) * 3.0;
  const cy = -1.0 + (Math.floor(idx / MW) / MH) * 2.0;
  return mandelPoint(cx, cy);
}

export function isPrime(n: number): boolean {
  "use parallel";
  if (n < 2) return false;
  if (n % 2 === 0) return n === 2;
  if (n % 3 === 0) return n === 3;
  for (let d = 5; d * d <= n; d += 6) {
    if (n % d === 0 || n % (d + 2) === 0) return false;
  }
  return true;
}

export function collatzSteps(n: number): number {
  "use parallel";
  let x = n;
  let steps = 0;
  while (x !== 1) {
    x = x % 2 === 0 ? x / 2 : 3 * x + 1;
    steps += 1;
  }
  return steps;
}

export function fib(n: number): number {
  "use parallel";
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

/** Uneven task sizes: fib(10..27), exponential spread — stresses chunk balancing. */
export function unevenFib(i: number): number {
  "use parallel";
  return fib(10 + (i % 18));
}

const MSIZE = 512;
const matA = shared.f64(MSIZE * MSIZE);
const matB = shared.f64(MSIZE * MSIZE);
for (let i = 0; i < MSIZE * MSIZE; i++) {
  matA[i] = (i % 97) / 97;
  matB[i] = (i % 89) / 89;
}

/** One output row of C = A x B (ikj order), written into a shared array. */
export function matmulRow(row: number, _i: number, C: Float64Array): void {
  "use parallel";
  const n = 512;
  const base = row * n;
  for (let j = 0; j < n; j++) C[base + j] = 0;
  for (let k = 0; k < n; k++) {
    const a = A[base + k]!;
    const kn = k * n;
    for (let j = 0; j < n; j++) C[base + j] = C[base + j]! + a * B[kn + j]!;
  }
}
// matmulRow captures these module bindings (renamed for kernel readability)
const A = matA;
const B = matB;

export function squareOf(x: number): number {
  "use parallel";
  return x * x;
}

/** Same workload as squareOf, but coarse-grained via .chunks(): one call per 64k elements. */
export function sumSquareChunk({ start, end }: { start: number; end: number }): number {
  "use parallel";
  let acc = 0;
  for (let i = start; i < end; i++) acc += i * i;
  return acc;
}

// ---------------------------------------------------------------- harness

interface Case {
  name: string;
  detail: string;
  seq: () => number;
  par: () => number;
  /** relative tolerance; 0 = exact match required */
  tol: number;
}

const cases: Case[] = [
  {
    name: "mandelbrot",
    detail: `${MW}x${MH}, iter<=1000`,
    seq: () => {
      let acc = 0;
      for (let i = 0; i < MW * MH; i++) acc += mandelPixel(i);
      return acc;
    },
    par: () => par.range(0, MW * MH).map(mandelPixel).sum(),
    tol: 0,
  },
  {
    name: "primes",
    detail: "count primes < 3e6 (trial division)",
    seq: () => {
      let acc = 0;
      for (let i = 0; i < 3_000_000; i++) if (isPrime(i)) acc += 1;
      return acc;
    },
    par: () => par.range(0, 3_000_000).filter(isPrime).count(),
    tol: 0,
  },
  {
    name: "collatz",
    detail: "total steps for 1..2e6",
    seq: () => {
      let acc = 0;
      for (let i = 1; i < 2_000_000; i++) acc += collatzSteps(i);
      return acc;
    },
    par: () => par.range(1, 2_000_000).map(collatzSteps).sum(),
    tol: 0,
  },
  {
    name: "uneven fib",
    detail: "5000 tasks, fib(10..27)",
    seq: () => {
      let acc = 0;
      for (let i = 0; i < 5000; i++) acc += unevenFib(i);
      return acc;
    },
    par: () => par.range(0, 5000).map(unevenFib).sum(),
    tol: 0,
  },
  {
    name: "matmul 512^3",
    detail: "row-parallel, shared A/B/C",
    seq: () => {
      const C = shared.f64(MSIZE * MSIZE);
      for (let r = 0; r < MSIZE; r++) matmulRow(r, r, C);
      return C[MSIZE + 7]!;
    },
    par: () => {
      const C = shared.f64(MSIZE * MSIZE);
      par.range(0, MSIZE).forEach((row: number, i: number) => {
        "use parallel";
        matmulRow(row, i, C);
      });
      return C[MSIZE + 7]!;
    },
    tol: 1e-12,
  },
  {
    name: "trivial sum",
    detail: "x*x over 2e7 (overhead-bound)",
    seq: () => {
      let acc = 0;
      for (let i = 0; i < 20_000_000; i++) acc += squareOf(i);
      return acc;
    },
    par: () => par.range(0, 20_000_000).map(squareOf).sum(),
    tol: 1e-9,
  },
  {
    name: "chunked sum",
    detail: "same, via chunks(65536)",
    seq: () => {
      let acc = 0;
      for (let i = 0; i < 20_000_000; i++) acc += squareOf(i);
      return acc;
    },
    par: () => par.range(0, 20_000_000).chunks(65_536).map(sumSquareChunk).sum(),
    tol: 1e-9,
  },
];

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function measure(fn: () => number, runs: number): { ms: number; value: number } {
  fn(); // warmup
  const times: number[] = [];
  let value = 0;
  for (let r = 0; r < runs; r++) {
    const start = performance.now();
    value = fn();
    times.push(performance.now() - start);
  }
  return { ms: median(times), value };
}

initThreadPool();
par.range(0, 1000).sum(); // ensure the pool is fully live before timing
const threads = rayonStats()?.workers ?? 0;

console.log(`\nCPU-bound benchmarks — Node ${process.version}, ${threads} worker threads, median of 3 runs\n`);
const header = `${"workload".padEnd(14)} ${"detail".padEnd(36)} ${"seq".padStart(9)} ${"par".padStart(9)} ${"speedup".padStart(9)}`;
console.log(header);
console.log("-".repeat(header.length));

let allOk = true;
for (const c of cases) {
  const seq = measure(c.seq, 3);
  const parallel = measure(c.par, 3);
  const diff = Math.abs(seq.value - parallel.value);
  const ok = c.tol === 0 ? diff === 0 : diff <= c.tol * Math.abs(seq.value);
  allOk &&= ok;
  console.log(
    `${c.name.padEnd(14)} ${c.detail.padEnd(36)} ${seq.ms.toFixed(0).padStart(7)}ms ${parallel.ms.toFixed(0).padStart(7)}ms ${(seq.ms / parallel.ms).toFixed(2).padStart(8)}x${ok ? "" : "  MISMATCH!"}`,
  );
}

console.log(`\nresults verified: ${allOk ? "all match" : "MISMATCH DETECTED"}`);
if (!allOk) process.exit(1);

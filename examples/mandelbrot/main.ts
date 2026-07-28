/**
 * Mandelbrot benchmark: identical kernel code runs sequentially (direct
 * function calls) and in parallel (worker pool), then the outputs are
 * compared bit-for-bit and rendered to a PGM image.
 */
import { writeFileSync } from "node:fs";
import { initThreadPool, par, rayonStats } from "rayon-ts";

const WIDTH = 1400;
const HEIGHT = 900;
const MAX_ITER = 2000;
const X_MIN = -2.2;
const X_MAX = 0.8;
const Y_MIN = -1.0;
const Y_MAX = 1.0;

export function mandelPoint(cx: number, cy: number): number {
  "use parallel";
  let x = 0;
  let y = 0;
  let iter = 0;
  while (x * x + y * y <= 4 && iter < MAX_ITER) {
    const nx = x * x - y * y + cx;
    y = 2 * x * y + cy;
    x = nx;
    iter += 1;
  }
  return iter;
}

export function pixel(idx: number): number {
  "use parallel";
  const px = idx % WIDTH;
  const py = Math.floor(idx / WIDTH);
  const cx = X_MIN + (px / WIDTH) * (X_MAX - X_MIN);
  const cy = Y_MIN + (py / HEIGHT) * (Y_MAX - Y_MIN);
  return mandelPoint(cx, cy);
}

function renderSequential(): Int32Array {
  const out = new Int32Array(WIDTH * HEIGHT);
  for (let i = 0; i < out.length; i++) out[i] = pixel(i);
  return out;
}

function renderParallel(): Int32Array {
  return par.range(0, WIDTH * HEIGHT).map(pixel).collect(Int32Array);
}

function time<T>(label: string, fn: () => T): T {
  const start = performance.now();
  const value = fn();
  const ms = performance.now() - start;
  console.log(`${label.padEnd(12)} ${ms.toFixed(0).padStart(6)} ms`);
  return value;
}

initThreadPool();
console.log(`mandelbrot ${WIDTH}x${HEIGHT}, maxIter=${MAX_ITER}`);

const seqStart = performance.now();
const seq = time("sequential", renderSequential);
const seqMs = performance.now() - seqStart;

const parStart = performance.now();
const parOut = time("parallel", renderParallel);
const parMs = performance.now() - parStart;

let identical = seq.length === parOut.length;
for (let i = 0; identical && i < seq.length; i++) identical = seq[i] === parOut[i];
console.log(`outputs identical: ${identical}`);
console.log(`threads used: ${rayonStats()?.threadsUsed}`);
console.log(`speedup: ${(seqMs / parMs).toFixed(2)}x`);

// PGM (P5) grayscale render, log-scaled for contrast
const pixels = Buffer.alloc(WIDTH * HEIGHT);
for (let i = 0; i < parOut.length; i++) {
  const v = parOut[i]!;
  pixels[i] = v >= MAX_ITER ? 0 : Math.min(255, Math.floor((255 * Math.log1p(v)) / Math.log1p(MAX_ITER)));
}
const header = Buffer.from(`P5\n${WIDTH} ${HEIGHT}\n255\n`, "ascii");
writeFileSync(new URL("./mandelbrot.pgm", import.meta.url), Buffer.concat([header, pixels]));
console.log("wrote mandelbrot.pgm");

if (!identical) process.exit(1);

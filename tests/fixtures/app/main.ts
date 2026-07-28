/**
 * E2E fixture: built by real `vite build`, then executed as a plain Node
 * process. Prints JSON so the test can assert on results and parallelism.
 */
import { initThreadPool, join, par, rayonStats, shared } from "rayon-ts";
import MagicString from "magic-string";
// @ts-expect-error resolved by the Vite RegExp alias exercised in e2e.test.ts
import { importedScore } from "@fixture/imported-helper.ts";

initThreadPool({ threads: 4, timeoutMs: 20_000 });

const LIMIT = 4;

export function collatzSteps(n: number): number {
  "use parallel";
  let x = n;
  let steps = 0;
  while (x !== 1 && steps < 10_000) {
    x = x % 2 === 0 ? x / 2 : 3 * x + 1;
    steps += 1;
  }
  return steps;
}

function analyse(count: number) {
  const steps = par.range(1, count + 1).map(collatzSteps).collect(Int32Array);
  const longest = par(steps).max();
  const busy = par.range(1, count + 1)
    .map(collatzSteps)
    .filter((s: number) => {
      "use parallel";
      return s > LIMIT;
    })
    .count();
  return { longest, busy, first10: Array.from(steps.slice(0, 10)) };
}

const threads = shared.i32(10_000);
par.range(0, 10_000).forEach((_x: number, i: number) => {
  "use parallel";
  threads[i] = RAYON_THREAD_ID;
});

function scoreWithImport(value: number): number {
  "use parallel";
  return importedScore(value);
}
const importedTotal = par.range(0, 10).map(scoreWithImport).sum();

function scoreWithExternalPackage(value: number): number {
  "use parallel";
  return new MagicString(String(value)).append("!").toString().length;
}
const externalTotal = par.range(0, 10).map(scoreWithExternalPackage).sum();

const [fibA, fibB] = join(
  () => {
    "use parallel";
    const fib = (n: number): number => (n < 2 ? n : fib(n - 1) + fib(n - 2));
    return fib(22);
  },
  () => {
    "use parallel";
    return collatzSteps(27);
  },
);

// async terminals in a standalone process: if the event-loop ref insurance
// failed, the process would exit before these resolve and the JSON never prints
const chunkedSum = await par.range(0, 1_000_000).chunks(65_536).map(({ start, end }: { start: number; end: number }) => {
  "use parallel";
  let acc = 0;
  for (let i = start; i < end; i++) acc += i;
  return acc;
}).async().sum();

let timerFired = 0;
const timer = setInterval(() => {
  timerFired += 1;
}, 1);
const asyncCollatz = await par.range(1, 100_000).map(collatzSteps).async().max();
clearInterval(timer);

console.log(
  JSON.stringify({
    ...analyse(10_000),
    distinctThreads: new Set(threads).size,
    threadsUsed: rayonStats()?.threadsUsed ?? 0,
    fibA,
    fibB,
    chunkedSum,
    asyncCollatz,
    timerFired,
    importedTotal,
    externalTotal,
  }),
);

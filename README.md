# rayon-ts

Rayon-style data parallelism for Node.js. Mark CPU-bound functions with
`"use parallel"` and the Vite plugin turns them into `worker_threads` kernels;
the runtime executes fused iterator pipelines on a persistent worker pool.
Terminals are synchronous by default, with Promise variants for I/O-serving apps.

## Quick example

```ts
import { createParallelBatcher, par } from "rayon-ts";

function cpuScore(value: number): number {
  "use parallel";
  let score = 0;
  for (let i = 0; i < 100_000; i++) score += Math.sqrt(value + i);
  return score;
}

const best = par.range(0, 1_000).map(cpuScore).max();
const scoreOne = createParallelBatcher(cpuScore, {
  maxBatchSize: 64,
  maxWaitMs: 1,
  maxPending: 4_096,
});
console.log(best, await scoreOne(42));
```

## Highlights

- Generic `map` / `filter` / object reductions / `collect` / `join` API.
- SharedArrayBuffer-backed TypedArrays take the zero-copy fast path.
- Plain arrays carry cyclic Node clone data: BigInt, Date, Map/Set, Error,
  TypedArray, Blob, CryptoKey, KeyObject, X509Certificate, BlockList, Histogram.
- Static imports referenced inside a kernel are bundled for the worker.

## Benchmark snapshot

`pnpm bench:cpu` compares identical kernels in direct and Rayon execution; all
results are checked for equality. Example run on an AMD Ryzen 9 8945HX with
Node 24.15.0, 8 workers, median of 3 runs (2026-07-28):

| Workload | Sequential | Parallel | Speedup |
| --- | ---: | ---: | ---: |
| Mandelbrot 1000x700 | 377 ms | 52 ms | 7.21x |
| Primes below 3 million | 152 ms | 27 ms | 5.59x |
| Collatz for 1..2 million | 3278 ms | 431 ms | 7.61x |

Hardware and load change the numbers. Tiny per-item work can be slower (0.26x
for the suite's trivial sum); batching with `chunks()` made that case 6.66x.
See [`examples/bench/main.ts`](examples/bench/main.ts) for every workload.

## Prerequisites and setup

- Node.js >= 20.19
- Vite >= 6 in the consuming application
- TypeScript >= 5.7 when consuming the bundled declarations

```bash
npm install rayon-ts
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { rayon } from "rayon-ts/vite";

export default defineConfig({
  plugins: [rayon({ external: ["wasm-package", "wasm-package/*"] })],
  build: { ssr: "src/main.ts", target: "node20.19" },
});
```

## API

```ts
par(typedArray | number[])       // numeric fast path
par(structuredCloneData[])       // generic object path
par.range(start, end)            // safe-integer range [start, end)
  .map(kernel).filter(kernel)    // lazy; fused into one worker pass
  .withMinLen(n).withMaxLen(n)   // worker-claim bounds
  .sum().min().max().count()
  .reduce(combineKernel, identity) // number or structured-clone object
  .collect(Ctor?)                // numeric TypedArray, Float64Array by default
  .collect(Array) / .toArray()   // structured-clone values, source order
  .forEach(kernel)
  .async()                       // Promise-returning terminals

par(typedArray).chunks(n)        // read-only views; Buffer becomes Uint8Array
par(sharedArray).chunksMut(n)    // disjoint writable shared views
par(dataArray).chunks(n)         // cloned array slices
par.range(a, b).chunks(n)        // { start, end } sub-ranges

join(...kernelThunks) / joinAsync(...kernelThunks)
createParallelBatcher(kernel, limits) // callable Promise API; .flush() / .close()
shared.f64(n | arrayLike)        // also f32/i32/u32/i16/u16/i8/u8
configureRayon({ threads, chunkSize, timeoutMs, startupTimeoutMs })
initThreadPool(config?) / rayonStats() / await shutdownThreadPool()
```

Environment overrides are `RAYON_NUM_THREADS`, `RAYON_CHUNK`,
`RAYON_TIMEOUT_MS`, `RAYON_SEQUENTIAL=1`, and `RAYON_SILENT=1`.
Default pool size is `min(availableParallelism() - 1, 8)`; configure larger hosts.
`RAYON_THREAD_ID` is `0` on the main thread and the Node thread id in a kernel.

## Kernels, imports, and data

A kernel may use parameters, locals, nested closures, recursion, standard Node/JavaScript globals, captured cloneable data, other kernels, and bindings from static local/npm/`node:` imports. Imported code is resolved and bundled by esbuild during the Vite transform; standard Vite aliases apply transitively. `rayon({ external: [...] })` leaves installed, require-compatible packages for Node to resolve from the deployed output module. Dynamic `import()` is unsupported.

Clone-isolated captures are snapshotted for each dispatch. Cycles, aliases, Map/Set, null prototypes, and kernel references are preserved. SharedArrayBuffer and host clones with shared native state (BlockList, Histogram, shared WebAssembly.Memory) remain live. Custom prototypes, accessors, and non-enumerable properties are not preserved. Non-shared TypedArrays are copied and warn once.

Generic `par(data)` input is cloned once per worker, so memory is `O(input × workers)`. Cycles and aliases inside each value graph survive, but aliases between elements processed by different workers are not preserved. Transfer-only input such as MessagePort/FileHandle is rejected before publish. Reduction identities are limited to clone-isolated plain data and cloned per chunk; shared/mutable host objects are rejected. Worker results are cloned, nested Buffer becomes Uint8Array, and ArrayBuffer, MessagePort, FileHandle, Web Streams, and Node-marked AbortSignal are transferred.

The plugin reports source-located errors for captured assignment, outer-kernel
`this`/`arguments`, `import.meta`, dynamic imports, JSX, async/generator
kernels, and object/class methods used as kernels. A captured function must
itself be a `"use parallel"` kernel.

## Failure semantics

A kernel exception becomes `KernelRuntimeError` with the worker stack and does not poison the pool. A timeout or infrastructure failure terminates that pool, so late results cannot corrupt a later job. `maxPending` rejects excess batch calls immediately; a failed batch rejects all pending calls. Shared-memory writes are not rolled back; synchronization and data-race freedom are the caller's responsibility. Use `chunksMut()` for disjoint mutable regions.

## Architecture

`src/plugin/` compiles; `src/runtime/` and `src/worker/` dispatch; `tests/`, `scripts/`, and `src/generated/` verify and package.

## Verify a fresh clone

1. Run `corepack enable`, then `pnpm install`.
2. Run `pnpm check` — generated drift, lint, types, coverage, dead code,
   Node package/type resolution, tarball contents, and runtime smoke all pass.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm check` | Run every required local/CI quality gate |
| `pnpm test:coverage` | Run tests with enforced source coverage thresholds |
| `pnpm build` | Build JavaScript, source maps, declarations, and worker source |
| `pnpm bench:cpu` | Run the CPU workload benchmark suite |
| `pnpm bench` | Build and render the Mandelbrot example |

## Current limits

Nested `par()`/`join()` calls from static imports run inline on the current worker. They are safe and composable, but do not add another layer of parallelism. They bundle the imported runtime into that kernel, increasing source size. The plugin targets Vite and statically resolvable imports.

## License

MIT

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function runIsolated(
  source: string,
  extraExecArgv: readonly string[] = [],
): Record<string, unknown> {
  const result = spawnSync(process.execPath, [
    ...extraExecArgv,
    "--import",
    "tsx",
    "-e",
    source,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.status !== 0) {
    throw new Error(`child failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

describe("worker-pool failure lifecycle", () => {
  it("discards a timed-out epoch and uses a fresh pool for the next job", () => {
    const result = runIsolated(`
      (async () => {
        const { initThreadPool, par, shutdownThreadPool } = await import("./src/index.ts");
        const { __rayonRegister } = await import("./src/runtime/registry.ts");
        initThreadPool({ threads: 2, timeoutMs: 300, startupTimeoutMs: 5000 });
        const slow = __rayonRegister((x) => x, {
          id: "isolated::slow",
          source: "(x) => { const end = Date.now() + 800; while (Date.now() < end) {} return x; }",
          getEnv: () => ({})
        });
        let first;
        try { par.range(0, 2).map(slow).sum(); }
        catch (error) { first = error.name; }
        const second = par.range(0, 10).sum();
        await shutdownThreadPool();
        console.log(JSON.stringify({ first, second }));
      })();
    `);
    expect(result).toEqual({ first: "RayonTimeoutError", second: 45 });
  });

  it("recovers when the targeted final reduction merge times out", () => {
    const result = runIsolated(`
      (async () => {
        const { initThreadPool, par, shutdownThreadPool } = await import("./src/index.ts");
        const { __rayonRegister } = await import("./src/runtime/registry.ts");
        initThreadPool({ threads: 2, timeoutMs: 300, startupTimeoutMs: 5000 });
        const item = __rayonRegister((value) => ({ count: 1, value }), {
          id: "isolated::foldItem",
          source: "(value) => ({ count: 1, value })",
          getEnv: () => ({})
        });
        const merge = __rayonRegister((left, right) => ({
          count: left.count + right.count,
          value: left.value + right.value
        }), {
          id: "isolated::slowFinalMerge",
          source: \`(left, right) => {
            const count = left.count + right.count;
            if (count > 1) {
              const end = Date.now() + 800;
              while (Date.now() < end) {}
            }
            return { count, value: left.value + right.value };
          }\`,
          getEnv: () => ({})
        });
        let first;
        try {
          par.range(0, 4)
            .withMaxLen(1)
            .map(item)
            .reduce(merge, { count: 0, value: 0 });
        } catch (error) {
          first = error.name;
        }
        const second = par.range(0, 10).sum();
        await shutdownThreadPool();
        console.log(JSON.stringify({ first, second }));
      })();
    `);
    expect(result).toEqual({ first: "RayonTimeoutError", second: 45 });
  });

  it("detects a worker exit while the synchronous API is blocked", () => {
    const result = runIsolated(`
      (async () => {
        const { initThreadPool, par, shutdownThreadPool } = await import("./src/index.ts");
        const { __rayonRegister } = await import("./src/runtime/registry.ts");
        initThreadPool({ threads: 2, timeoutMs: 5000, startupTimeoutMs: 5000 });
        const exitWorker = __rayonRegister((x) => x, {
          id: "isolated::exitWorker",
          source: "(x) => { if (x === 0) process.exit(17); return x; }",
          getEnv: () => ({})
        });
        const started = performance.now();
        let first;
        let message;
        try { par.range(0, 2).map(exitWorker).sum(); }
        catch (error) {
          first = error.name;
          message = error.message;
        }
        const elapsed = performance.now() - started;
        const second = par.range(0, 10).sum();
        await shutdownThreadPool();
        console.log(JSON.stringify({ first, message, elapsed, second }));
      })();
    `);

    expect(result.first).toBe("RayonError");
    expect(result.message).toMatch(/worker thread .* exited/);
    expect(result.elapsed).toBeLessThan(1000);
    expect(result.second).toBe(45);
  });

  it("rejects invalid configuration before creating workers", () => {
    const result = runIsolated(`
      (async () => {
        const { configureRayon } = await import("./src/index.ts");
        const messages = [];
        for (const config of [
          { threads: NaN },
          { threads: Infinity },
          { chunkSize: 0 },
          { timeoutMs: -1 }
        ]) {
          try { configureRayon(config); }
          catch (error) { messages.push(error.name); }
        }
        console.log(JSON.stringify({ messages }));
      })();
    `);
    expect(result.messages).toEqual([
      "RayonError",
      "RayonError",
      "RayonError",
      "RayonError",
    ]);
  });

  it("starts CommonJS eval workers from an --input-type=module host", () => {
    const result = runIsolated(`
      (async () => {
        const { initThreadPool, par, shutdownThreadPool } =
          await import("./src/index.ts");
        initThreadPool({ threads: 2, timeoutMs: 5000 });
        const total = par.range(0, 10).sum();
        await shutdownThreadPool();
        console.log(JSON.stringify({ total }));
      })();
    `, ["--input-type=module"]);

    expect(result).toEqual({ total: 45 });
  });
});

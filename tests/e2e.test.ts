/**
 * The real thing: `vite build` with the rayon() plugin over a TypeScript
 * fixture, then the bundle runs as a plain Node child process. Asserts both
 * correctness and that multiple worker threads actually participated.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { rayon } from "../src/plugin/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures/app");
const outDir = join(here, ".tmp/e2e-dist");

describe("vite build e2e", () => {
  it("bundles and runs a parallel app", { timeout: 60_000 }, async () => {
    await build({
      configFile: false,
      root: fixture,
      logLevel: "error",
      plugins: [rayon({ external: ["magic-string"] })],
      resolve: {
        alias: [
          { find: /^rayon-ts\/runtime$/, replacement: join(here, "../src/runtime/registry.ts") },
          { find: /^rayon-ts$/, replacement: join(here, "../src/index.ts") },
          { find: /^@fixture\//, replacement: `${fixture}/` },
        ],
      },
      ssr: { noExternal: true },
      build: {
        ssr: join(fixture, "main.ts"),
        outDir,
        emptyOutDir: true,
        target: "node20",
        minify: false,
        rollupOptions: { output: { entryFileNames: "main.mjs" } },
      },
    });
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "package.json"), JSON.stringify({ type: "module" }));

    const stdout = execFileSync(process.execPath, [join(outDir, "main.mjs")], {
      cwd: tmpdir(),
      encoding: "utf8",
      timeout: 30_000,
    });
    const result = JSON.parse(stdout.trim());

    // collatz step counts for n = 1..10
    expect(result.first10).toEqual([0, 1, 7, 2, 5, 8, 16, 3, 19, 6]);
    expect(result.longest).toBe(261); // longest collatz chain below 10_000 (n=6171)
    expect(result.busy).toBeGreaterThan(9000);
    expect(result.fibA).toBe(17711);
    expect(result.fibB).toBe(111);
    expect(result.distinctThreads).toBeGreaterThan(1);
    expect(result.threadsUsed).toBeGreaterThan(1);
    expect(result.chunkedSum).toBe((1_000_000 * 999_999) / 2);
    expect(result.asyncCollatz).toBe(350); // longest collatz chain for n < 100_000 (n=77031)
    expect(result.timerFired).toBeGreaterThan(0); // event loop stayed live during async job
    expect(result.importedTotal).toBe(165);
    expect(result.externalTotal).toBe(20);
  });
});

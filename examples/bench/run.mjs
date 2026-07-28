// Builds the benchmark suite with Vite (applying the rayon plugin) and runs it.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const outDir = join(here, "dist");

const { rayon } = await import(join(root, "src/plugin/index.ts"));

await build({
  configFile: false,
  root: here,
  logLevel: "error",
  plugins: [rayon()],
  resolve: {
    alias: [
      { find: /^rayon-ts\/runtime$/, replacement: join(root, "src/runtime/registry.ts") },
      { find: /^rayon-ts$/, replacement: join(root, "src/index.ts") },
    ],
  },
  ssr: { noExternal: true },
  build: {
    ssr: join(here, "main.ts"),
    outDir,
    emptyOutDir: true,
    target: "node20",
    minify: false,
    rollupOptions: { output: { entryFileNames: "main.mjs" } },
  },
});
writeFileSync(join(outDir, "package.json"), JSON.stringify({ type: "module" }));

execFileSync(process.execPath, [join(outDir, "main.mjs"), ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: here,
});

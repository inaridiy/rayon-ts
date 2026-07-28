import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const output = execFileSync(
  "npm",
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  { cwd: root, encoding: "utf8" },
);
const report = JSON.parse(output)[0];
const files = new Set(report.files.map((entry) => entry.path));
const required = [
  "LICENSE",
  "README.md",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/generated/workerSource.js",
  "dist/plugin/index.js",
  "dist/plugin/index.d.ts",
  "dist/runtime/registry.js",
  "dist/runtime/registry.d.ts",
];
for (const path of required) {
  if (!files.has(path)) throw new Error(`published package is missing ${path}`);
}
for (const path of files) {
  if (path.startsWith("src/") || path.startsWith("tests/") || path.startsWith("examples/")) {
    throw new Error(`development file leaked into package: ${path}`);
  }
}

const rayon = await import("rayon-ts");
await import("rayon-ts/vite");
const runtime = await import("rayon-ts/runtime");

rayon.configureRayon({ threads: 2, timeoutMs: 10_000 });
const double = runtime.__rayonRegister((value) => value * 2, {
  id: "package-check::double",
  source: "(value) => value * 2",
  getEnv: () => ({}),
});
const result = rayon.par.range(0, 4).map(double).toArray();
if (JSON.stringify(result) !== JSON.stringify([0, 2, 4, 6])) {
  throw new Error(`built package runtime smoke test failed: ${JSON.stringify(result)}`);
}
await rayon.shutdownThreadPool();

console.log(`package check passed (${files.size} files, ${report.unpackedSize} bytes unpacked)`);

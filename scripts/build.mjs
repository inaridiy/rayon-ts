import { readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(fileURLToPath(new URL("..", import.meta.url)));
const sourceDir = join(root, "src");
const outDir = join(root, "dist");

function typeScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return typeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

if (relative(root, outDir) !== "dist") {
  throw new Error(`refusing to clear unexpected output directory: ${outDir}`);
}
rmSync(outDir, { recursive: true, force: true });

await build({
  entryPoints: typeScriptFiles(sourceDir),
  outbase: sourceDir,
  outdir: outDir,
  bundle: false,
  platform: "node",
  format: "esm",
  target: "node20.19",
  packages: "external",
  sourcemap: true,
  legalComments: "none",
});

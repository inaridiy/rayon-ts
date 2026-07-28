/**
 * Vite plugin entry. Runs with enforce: "pre" so it sees the original
 * TypeScript before Vite's own transform strips types.
 */
import path from "node:path";
import type { Plugin } from "vite";
import {
  type ImportAlias,
  RayonTransformError,
  transformModuleAsync,
} from "./emit.js";

export interface RayonPluginOptions {
  /** Files to consider. Default: .ts/.tsx/.js/.jsx/.mjs/.mts outside node_modules. */
  include?: RegExp;
  exclude?: RegExp;
  /** Module specifier for the kernel registry. Default: "rayon-ts/runtime". */
  runtimeModule?: string;
  /**
   * Package/path patterns left out of kernel bundles and resolved by Node in
   * the worker. Supports esbuild external wildcards such as "pkg/*".
   */
  external?: readonly string[];
}

const DEFAULT_INCLUDE = /\.(?:m?ts|m?js|tsx|jsx)$/;
const DEFAULT_EXCLUDE = /node_modules/;

function matches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

export function rayon(options: RayonPluginOptions = {}): Plugin {
  const include = options.include ?? DEFAULT_INCLUDE;
  const exclude = options.exclude ?? DEFAULT_EXCLUDE;
  let root = process.cwd();
  let aliases: ImportAlias[] = [];

  return {
    name: "rayon-ts",
    enforce: "pre",
    configResolved(config) {
      root = config.root;
      aliases = config.resolve.alias.map(({ find, replacement }) => ({
        find,
        replacement,
      }));
    },
    async transform(code, id) {
      const clean = id.split("?")[0]!;
      if (clean.startsWith("\0") || !matches(include, clean) || matches(exclude, clean)) {
        return null;
      }
      if (!code.includes("use parallel")) return null;

      const moduleName = path.relative(root, clean).split(path.sep).join("/");
      try {
        const result = await transformModuleAsync(clean, code, {
          moduleName,
          runtimeModule: options.runtimeModule,
          aliases,
          external: options.external,
        });
        if (result === null) return null;
        // magic-string emits a Rollup-style map POJO; rolldown's SourceMapInput
        // typing is stricter than the runtime contract, hence the cast
        return { code: result.code, map: result.map as never };
      } catch (err) {
        if (err instanceof RayonTransformError) this.error(err.message);
        throw err;
      }
    },
  };
}

export default rayon;

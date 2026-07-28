/**
 * Code generation. The original module is only ever *augmented*: kernels keep
 * their source text (so direct calls, types, and sequential fallback behave
 * normally), and each kernel additionally gets a `__rayonRegister` call that
 * attaches the worker-executable source plus an env-snapshot thunk.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import {
  build,
  buildSync,
  type BuildOptions,
  type BuildResult,
  type Loader,
  type Plugin as EsbuildPlugin,
} from "esbuild";
import MagicString from "magic-string";
import { transformSync } from "oxc-transform";
import { analyzeModule, type Diagnostic, type KernelAnalysis } from "./analyze.js";
import type { KernelSource } from "../runtime/protocol.js";

export interface TransformResult {
  code: string;
  /** Plain source-map POJO — accepted by both Rollup and Rolldown. */
  map: Record<string, unknown>;
}

interface CompiledKernel {
  source: KernelSource;
  factoryName?: string;
}

interface EmittedSource {
  hash: string;
  srcConst: string;
}

export class RayonTransformError extends Error {
  override name = "RayonTransformError";
  readonly diagnostics: Diagnostic[];
  constructor(message: string, diagnostics: Diagnostic[]) {
    super(message);
    this.diagnostics = diagnostics;
  }
}

function offsetToPos(code: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < code.length; i++) {
    if (code[i] === "\n") {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

function formatDiags(moduleId: string, code: string, diags: Diagnostic[]): string {
  const lines = diags.map((d) => {
    const { line, column } = offsetToPos(code, d.start);
    const snippet = code.slice(d.start, Math.min(d.end, d.start + 60)).split("\n")[0];
    return `  ${moduleId}:${line}:${column}  ${d.message}\n    > ${snippet}`;
  });
  return `[rayon-ts] cannot compile "use parallel" kernel:\n${lines.join("\n")}`;
}

function kernelExt(filename: string): string {
  const clean = filename.split("?")[0]!;
  if (clean.endsWith(".tsx")) return ".tsx";
  if (clean.endsWith(".jsx")) return ".jsx";
  if (/\.(ts|mts|cts)$/.test(clean)) return ".ts";
  return ".js";
}

/** Applies `__env.` rewrites to the kernel slice (offsets relative to slice). */
function rewriteCaptures(slice: string, kernel: KernelAnalysis): string {
  const rewritten = new MagicString(slice);
  for (const site of kernel.rewrites) {
    const start = site.start - kernel.start;
    const end = site.end - kernel.start;
    const replacement = site.shorthand ? `${site.name}: __env.${site.name}` : `__env.${site.name}`;
    rewritten.overwrite(start, end, replacement);
  }
  return rewritten.toString();
}

/** Strips TypeScript types from a rewritten kernel expression. */
function stripTypesForNode20(expr: string, ext: string): string | undefined {
  const wrapped = `__K__ = (${expr});`;
  const result = transformSync(`kernel${ext}`, wrapped, {
    target: "node20.19",
  });
  if (result.errors.length > 0) {
    throw new Error(`internal: kernel type-strip failed: ${result.errors[0]?.message}`);
  }
  const match = result.code.match(/^__K__ = ([\s\S]*);\s*$/);
  // Syntax such as explicit resource management needs lowering helpers. Those
  // helpers live outside the expression, so route it through the self-contained
  // esbuild factory bundle instead of emitting an incomplete fast-path source.
  return match?.[1];
}

function freshIdentifier(base: string, code: string, used: Set<string>): string {
  let index = 0;
  let candidate = base;
  while (used.has(candidate) || code.includes(candidate)) {
    candidate = `${base}$${++index}`;
  }
  used.add(candidate);
  return candidate;
}

export interface ImportAlias {
  find: string | RegExp;
  replacement: string;
}

function resolveImportAlias(
  source: string,
  aliases: readonly ImportAlias[],
): string {
  for (const alias of aliases) {
    if (typeof alias.find === "string") {
      if (
        source === alias.find ||
        source.startsWith(`${alias.find}/`)
      ) {
        return `${alias.replacement}${source.slice(alias.find.length)}`;
      }
      continue;
    }
    alias.find.lastIndex = 0;
    if (alias.find.test(source)) {
      alias.find.lastIndex = 0;
      return source.replace(alias.find, alias.replacement);
    }
  }
  return source;
}

function kernelLoader(ext: string): Loader {
  if (ext === ".tsx") return "tsx";
  if (ext === ".jsx") return "jsx";
  if (ext === ".ts") return "ts";
  return "js";
}

function aliasPlugin(aliases: readonly ImportAlias[]): EsbuildPlugin {
  const resolvedByPlugin = {};
  return {
    name: "rayon-vite-alias",
    setup(context) {
      context.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData === resolvedByPlugin) return undefined;
        const resolved = resolveImportAlias(args.path, aliases);
        if (resolved === args.path) return undefined;
        return context.resolve(resolved, {
          importer: args.importer,
          kind: args.kind,
          namespace: args.namespace,
          resolveDir: args.resolveDir,
          pluginData: resolvedByPlugin,
        });
      });
    },
  };
}

function importDeclarations(
  code: string,
  kernels: readonly KernelAnalysis[],
  aliases: readonly ImportAlias[],
): string[] {
  return [
    ...new Map(
      kernels.flatMap((kernel) =>
        kernel.imports.map((binding) => [
          binding.declarationStart,
          binding,
        ] as const),
      ),
    ).values(),
  ].map((binding) => {
    const declaration = code.slice(
      binding.declarationStart,
      binding.declarationEnd,
    );
    const sourceStart = binding.sourceStart - binding.declarationStart;
    const sourceEnd = binding.sourceEnd - binding.declarationStart;
    const resolved = resolveImportAlias(binding.source, aliases);
    return (
      declaration.slice(0, sourceStart) +
      JSON.stringify(resolved) +
      declaration.slice(sourceEnd)
    );
  });
}

function bundleBuildOptions(
  filename: string,
  entry: string,
  ext: string,
  external: readonly string[],
  plugins: EsbuildPlugin[],
): BuildOptions {
  const absolute = path.resolve(filename.split("?")[0]!);
  return {
    stdin: {
      contents: entry,
      sourcefile: absolute,
      resolveDir: path.dirname(absolute),
      loader: kernelLoader(ext),
    },
    bundle: true,
    platform: "node",
    format: "iife",
    globalName: "__rayonBundle",
    target: "node20.19",
    sourcemap: "inline",
    sourcesContent: true,
    write: false,
    logLevel: "silent",
    external: [...external],
    plugins,
  };
}

function bundledSource(result: BuildResult): KernelSource {
  const output = result.outputFiles?.[0];
  if (output === undefined) throw new Error("esbuild produced no worker bundle");
  return { format: "bundle", code: output.text };
}

function bundleError(cause: unknown): never {
  const detail = cause instanceof Error ? cause.message : String(cause);
  throw new Error(`cannot bundle imports used by this kernel: ${detail}`);
}

function groupBundleEntry(
  code: string,
  kernels: readonly KernelAnalysis[],
  rewritten: readonly string[],
  aliases: readonly ImportAlias[],
): {
  entry: string;
  factoryNames: string[];
} {
  const declarations = importDeclarations(code, kernels, aliases);
  const combined = `${declarations.join("\n")}\n${rewritten.join("\n")}`;
  const factoryPrefix = freshIdentifier(
    "__rayonFactory$",
    combined,
    new Set(),
  );
  const variables = kernels.map((_kernel, index) =>
    `${factoryPrefix}${index}`,
  );
  const factoryNames = kernels.map((_kernel, index) => `kernel${index}`);
  const factories = rewritten.map(
    (source, index) =>
      `const ${variables[index]!} = (__env) => (${source});`,
  );
  const exported = factoryNames
    .map(
      (factoryName, index) =>
        `${JSON.stringify(factoryName)}: ${variables[index]!}`,
    )
    .join(",\n");
  return {
    entry: [
      ...declarations,
      ...factories,
      `export default {\n${exported}\n};`,
    ].join("\n"),
    factoryNames,
  };
}

interface BundledGroup {
  source: KernelSource;
  factoryNames: string[];
}

interface BundleRequest {
  filename: string;
  code: string;
  kernels: readonly KernelAnalysis[];
  rewritten: readonly string[];
  ext: string;
  aliases: readonly ImportAlias[];
  external: readonly string[];
}

function bundledGroupSync(request: BundleRequest): BundledGroup {
  const { filename, code, kernels, rewritten, ext, aliases, external } = request;
  const { entry, factoryNames } = groupBundleEntry(
    code,
    kernels,
    rewritten,
    aliases,
  );
  try {
    return {
      source: bundledSource(
        buildSync(
          bundleBuildOptions(
            filename,
            entry,
            ext,
            external,
            [],
          ),
        ),
      ),
      factoryNames,
    };
  } catch (cause) {
    return bundleError(cause);
  }
}

async function bundledGroupAsync(request: BundleRequest): Promise<BundledGroup> {
  const { filename, code, kernels, rewritten, ext, aliases, external } = request;
  const { entry, factoryNames } = groupBundleEntry(
    code,
    kernels,
    rewritten,
    aliases,
  );
  try {
    return {
      source: bundledSource(
        await build(
          bundleBuildOptions(
            filename,
            entry,
            ext,
            external,
            aliases.length === 0 ? [] : [aliasPlugin(aliases)],
          ),
        ),
      ),
      factoryNames,
    };
  } catch (cause) {
    return bundleError(cause);
  }
}

export interface TransformModuleOptions {
  /** Module id used in kernel ids and error messages (usually root-relative). */
  moduleName: string;
  runtimeModule?: string | undefined;
  /** Vite resolve.alias entries applied to imports bundled into kernels. */
  aliases?: readonly ImportAlias[] | undefined;
  /** Package/path patterns left for Node to resolve inside the worker. */
  external?: readonly string[] | undefined;
}

interface PreparedTransform {
  filename: string;
  code: string;
  options: TransformModuleOptions;
  kernels: KernelAnalysis[];
  headerEnd: number;
  ext: string;
}

function prepareTransform(
  filename: string,
  code: string,
  options: TransformModuleOptions,
): PreparedTransform | null {
  const { kernels, parseErrors, headerEnd } = analyzeModule(filename.split("?")[0]!, code);
  if (parseErrors.length > 0) return null; // let Vite surface the syntax error itself
  if (kernels.length === 0) return null;

  const diags = kernels.flatMap((k) => k.diags);
  for (const kernel of kernels) {
    if (kernel.kind === "expression" && kernel.node.type === "FunctionExpression") {
      const head = code.slice(kernel.start, kernel.start + 9);
      if (!head.startsWith("function")) {
        diags.push({
          message:
            'object/class methods cannot be "use parallel" kernels - ' +
            "use a function declaration, arrow function, or function expression instead",
          start: kernel.start,
          end: kernel.end,
        });
      }
    }
    if (kernel.kind === "declaration" && kernel.name === null) {
      diags.push({
        message: 'give this "use parallel" function a name so it can be registered',
        start: kernel.start,
        end: kernel.end,
      });
    }
  }
  if (diags.length > 0) {
    throw new RayonTransformError(formatDiags(options.moduleName, code, diags), diags);
  }
  return {
    filename,
    code,
    options,
    kernels,
    headerEnd,
    ext: kernelExt(filename),
  };
}

function kernelTransformError(
  prepared: PreparedTransform,
  kernel: KernelAnalysis,
  cause: unknown,
): never {
  const diagnostic: Diagnostic = {
    message: cause instanceof Error ? cause.message : String(cause),
    start: kernel.start,
    end: kernel.end,
  };
  throw new RayonTransformError(
    formatDiags(
      prepared.options.moduleName,
      prepared.code,
      [diagnostic],
    ),
    [diagnostic],
  );
}

function finishTransform(
  prepared: PreparedTransform,
  compiledKernels: readonly CompiledKernel[],
): TransformResult {
  const { filename, code, options, kernels, headerEnd } = prepared;
  const ms = new MagicString(code);
  const usedNames = new Set<string>();
  const sourcesByIdentity = new WeakMap<KernelSource, EmittedSource>();
  const sourcesByContent = new Map<string, EmittedSource>();
  const register = freshIdentifier("__rayon$register", code, usedNames);
  const header: string[] = [
    `import { __rayonRegister as ${register} } from ${JSON.stringify(options.runtimeModule ?? "rayon-ts/runtime")};`,
  ];
  const scopedRegistrations = new Map<number, string[]>();

  kernels.forEach((kernel, index) => {
    const compiled = compiledKernels[index];
    if (compiled === undefined) {
      throw new Error(`internal: worker source #${index} is missing`);
    }
    const { source: workerSource, factoryName } = compiled;
    let emittedSource = sourcesByIdentity.get(workerSource);
    if (emittedSource === undefined) {
      const sourceKey = `${workerSource.format}\0${workerSource.code}`;
      emittedSource = sourcesByContent.get(sourceKey);
      if (emittedSource === undefined) {
        emittedSource = {
          hash: createHash("sha256")
            .update(workerSource.format)
            .update("\0")
            .update(workerSource.code)
            .digest("hex")
            .slice(0, 16),
          srcConst: freshIdentifier(`__rayon$src$${index}`, code, usedNames),
        };
        sourcesByContent.set(sourceKey, emittedSource);
        header.push(
          `const ${emittedSource.srcConst} = ${JSON.stringify(workerSource)};`,
        );
      }
      sourcesByIdentity.set(workerSource, emittedSource);
    }
    const { hash, srcConst } = emittedSource;
    const name = kernel.name ?? `anon${index}`;
    const id =
      factoryName === undefined
        ? `${options.moduleName}::${name}@${hash}`
        : `${options.moduleName}::bundle@${hash}`;

    const env = `() => ({ ${kernel.captured.join(", ")} })`;
    const meta =
      `{ id: ${JSON.stringify(id)}, source: ${srcConst}, ` +
      (factoryName === undefined
        ? ""
        : `factoryName: ${JSON.stringify(factoryName)}, `) +
      `resolveFrom: import.meta.url, getEnv: ${env} }`;

    if (kernel.kind === "declaration") {
      const registration = `${register}(${kernel.name}, ${meta});`;
      if (kernel.topLevel) header.push(registration);
      else if (kernel.registrationOffset !== null) {
        const registrations = scopedRegistrations.get(kernel.registrationOffset) ?? [];
        registrations.push(registration);
        scopedRegistrations.set(kernel.registrationOffset, registrations);
      } else {
        ms.appendLeft(kernel.end, `\n${registration}`);
      }
    } else {
      ms.appendRight(kernel.start, `${register}(`);
      ms.appendLeft(kernel.end, `, ${meta})`);
    }
  });

  for (const [offset, registrations] of scopedRegistrations) {
    ms.appendLeft(offset, `\n${registrations.join("\n")}\n`);
  }
  const injected = `${header.join("\n")}\n`;
  if (headerEnd === 0) ms.prepend(injected);
  else ms.appendLeft(headerEnd, `\n${injected}`);
  return {
    code: ms.toString(),
    map: JSON.parse(ms.generateMap({ hires: true, source: filename, includeContent: true }).toString()),
  };
}

function expressionSource(
  prepared: PreparedTransform,
  rewritten: string,
): KernelSource | undefined {
  const code = stripTypesForNode20(rewritten, prepared.ext);
  return code === undefined ? undefined : { format: "expression", code };
}

function rewrittenKernel(
  prepared: PreparedTransform,
  kernel: KernelAnalysis,
): string {
  return rewriteCaptures(
    prepared.code.slice(kernel.start, kernel.end),
    kernel,
  );
}

interface KernelCandidate {
  kernel: KernelAnalysis;
  rewritten: string;
  expression: KernelSource | undefined;
}

interface KernelCompilation {
  candidates: KernelCandidate[];
  bundleGroups: KernelCandidate[][];
}

function prepareKernelCandidate(
  prepared: PreparedTransform,
  kernel: KernelAnalysis,
): KernelCandidate {
  try {
    const rewritten = rewrittenKernel(prepared, kernel);
    return {
      kernel,
      rewritten,
      expression:
        kernel.imports.length === 0
          ? expressionSource(prepared, rewritten)
          : undefined,
    };
  } catch (cause) {
    return kernelTransformError(prepared, kernel, cause);
  }
}

function prepareKernelCompilation(
  prepared: PreparedTransform,
): KernelCompilation {
  const candidates = prepared.kernels.map((kernel) =>
    prepareKernelCandidate(prepared, kernel),
  );
  const groups = new Map<string, KernelCandidate[]>();
  candidates.forEach((candidate, index) => {
    if (candidate.expression !== undefined) return;
    const declarations = [
      ...new Set(
        candidate.kernel.imports.map((binding) => binding.declarationStart),
      ),
    ].sort((first, second) => first - second);
    // Syntax-lowering-only bundles have no dependency code to share. Keeping
    // them separate avoids eagerly compiling unrelated kernels.
    const key =
      declarations.length === 0
        ? `lowered:${index}`
        : `imports:${declarations.join(",")}`;
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  });
  return {
    candidates,
    bundleGroups: [...groups.values()],
  };
}

function bundleRequest(
  prepared: PreparedTransform,
  candidates: readonly KernelCandidate[],
): BundleRequest {
  return {
    filename: prepared.filename,
    code: prepared.code,
    kernels: candidates.map((candidate) => candidate.kernel),
    rewritten: candidates.map((candidate) => candidate.rewritten),
    ext: prepared.ext,
    aliases: prepared.options.aliases ?? [],
    external: prepared.options.external ?? [],
  };
}

interface CompiledBundleGroup {
  candidates: readonly KernelCandidate[];
  bundled: BundledGroup;
}

function combineCompiledKernels(
  candidates: readonly KernelCandidate[],
  groups: readonly CompiledBundleGroup[],
): CompiledKernel[] {
  const grouped = new Map<KernelCandidate, CompiledKernel>();
  for (const { candidates: groupCandidates, bundled } of groups) {
    groupCandidates.forEach((candidate, index) => {
      const factoryName = bundled.factoryNames[index];
      if (factoryName === undefined) {
        throw new Error("internal: grouped kernel factory is missing");
      }
      grouped.set(candidate, { source: bundled.source, factoryName });
    });
  }
  return candidates.map((candidate) => {
    const { expression } = candidate;
    if (expression !== undefined) return { source: expression };
    const compiled = grouped.get(candidate);
    if (compiled === undefined) {
      throw new Error("internal: grouped kernel bundle is incomplete");
    }
    return compiled;
  });
}

type BundleOutcome =
  | { ok: true; value: BundledGroup }
  | { ok: false; cause: unknown };

function attemptBundleSync(request: BundleRequest): BundleOutcome {
  try {
    return { ok: true, value: bundledGroupSync(request) };
  } catch (cause) {
    return { ok: false, cause };
  }
}

async function attemptBundleAsync(
  request: BundleRequest,
): Promise<BundleOutcome> {
  try {
    return { ok: true, value: await bundledGroupAsync(request) };
  } catch (cause) {
    return { ok: false, cause };
  }
}

function resolveBundleCompilation(
  prepared: PreparedTransform,
  candidates: readonly KernelCandidate[],
  groupOutcome: BundleOutcome,
  individualOutcomes: readonly BundleOutcome[],
): BundledGroup {
  if (groupOutcome.ok) return groupOutcome.value;
  for (let index = 0; index < individualOutcomes.length; index++) {
    const outcome = individualOutcomes[index];
    const candidate = candidates[index];
    if (outcome !== undefined && !outcome.ok && candidate !== undefined) {
      return kernelTransformError(prepared, candidate.kernel, outcome.cause);
    }
  }
  const first = candidates[0];
  if (first === undefined) {
    throw new Error("internal: failed a bundle with no grouped kernels");
  }
  return kernelTransformError(prepared, first.kernel, groupOutcome.cause);
}

function compileBundleGroupSync(
  prepared: PreparedTransform,
  candidates: readonly KernelCandidate[],
): BundledGroup {
  const groupOutcome = attemptBundleSync(
    bundleRequest(prepared, candidates),
  );
  const individualOutcomes = groupOutcome.ok
    ? []
    : candidates.map((candidate) =>
        attemptBundleSync(bundleRequest(prepared, [candidate])),
      );
  return resolveBundleCompilation(
    prepared,
    candidates,
    groupOutcome,
    individualOutcomes,
  );
}

async function compileBundleGroupAsync(
  prepared: PreparedTransform,
  candidates: readonly KernelCandidate[],
): Promise<BundledGroup> {
  const groupOutcome = await attemptBundleAsync(
    bundleRequest(prepared, candidates),
  );
  const individualOutcomes = groupOutcome.ok
    ? []
    : await Promise.all(
        candidates.map((candidate) =>
          attemptBundleAsync(bundleRequest(prepared, [candidate])),
        ),
      );
  return resolveBundleCompilation(
    prepared,
    candidates,
    groupOutcome,
    individualOutcomes,
  );
}

function compileKernelsSync(
  prepared: PreparedTransform,
): CompiledKernel[] {
  const compilation = prepareKernelCompilation(prepared);
  const groups = compilation.bundleGroups.map((candidates) => ({
    candidates,
    bundled: compileBundleGroupSync(prepared, candidates),
  }));
  return combineCompiledKernels(compilation.candidates, groups);
}

async function compileKernelsAsync(
  prepared: PreparedTransform,
): Promise<CompiledKernel[]> {
  const compilation = prepareKernelCompilation(prepared);
  const groups = await Promise.all(
    compilation.bundleGroups.map(async (candidates) => ({
      candidates,
      bundled: await compileBundleGroupAsync(prepared, candidates),
    })),
  );
  return combineCompiledKernels(compilation.candidates, groups);
}

/**
 * Synchronous transform used by low-level tooling and unit tests. Vite uses
 * transformModuleAsync so aliases can also resolve inside transitive imports.
 */
export function transformModule(
  filename: string,
  code: string,
  options: TransformModuleOptions,
): TransformResult | null {
  const prepared = prepareTransform(filename, code, options);
  if (prepared === null) return null;
  return finishTransform(prepared, compileKernelsSync(prepared));
}

/** Async Vite transform with direct and transitive resolve.alias support. */
export async function transformModuleAsync(
  filename: string,
  code: string,
  options: TransformModuleOptions,
): Promise<TransformResult | null> {
  const prepared = prepareTransform(filename, code, options);
  if (prepared === null) return null;
  return finishTransform(prepared, await compileKernelsAsync(prepared));
}

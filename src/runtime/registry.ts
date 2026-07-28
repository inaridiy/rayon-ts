/**
 * Kernel registry. The Vite plugin rewrites every "use parallel" function into
 * a `__rayonRegister(fn, info)` call; the original function stays intact (so
 * direct calls and sequential fallback run the untouched code), while `info`
 * carries what workers need: a transpiled source string and a thunk that
 * snapshots the captured environment at dispatch time.
 */
import { CaptureError, RayonError } from "./errors.js";
import type {
  EncodedNode,
  EncodedValue,
  KernelBindingId,
  KernelBindingSpec,
  KernelSource,
  KernelSourceId,
} from "./protocol.js";

/**
 * Intentional dynamic-call boundary: kernels accept arbitrary parameter
 * shapes, while every value returned from one is treated as unknown.
 */
export type AnyFn = (...args: any[]) => unknown;

export interface KernelRegistration {
  /** Stable compiled-source identity emitted by the transform. */
  id: KernelSourceId;
  /** Worker source. Strings remain supported for hand-written test kernels. */
  source: string | KernelSource;
  /** Runtime module URL used as the base for external package resolution. */
  resolveFrom?: string;
  /** Snapshots captured bindings from the defining scope at dispatch time. */
  getEnv: () => Record<string, unknown>;
}

export interface KernelInfo {
  sourceId: KernelSourceId;
  bindingId: KernelBindingId;
  source: KernelSource;
  getEnv: () => Record<string, unknown>;
}

const byFn = new WeakMap<AnyFn, KernelInfo>();
let nextBindingId = 1;

/** Called by plugin-generated code. Returns `fn` so it can wrap expressions. */
export function __rayonRegister<F extends AnyFn>(fn: F, registration: KernelRegistration): F {
  const source: KernelSource =
    typeof registration.source === "string"
      ? { format: "expression", code: registration.source }
      : registration.source;
  const sourceId =
    source.format === "bundle" && registration.resolveFrom !== undefined
      ? `${registration.id}@${registration.resolveFrom}`
      : registration.id;
  const info: KernelInfo = {
    sourceId,
    bindingId: `${sourceId}#${nextBindingId++}`,
    source:
      source.format === "bundle" && registration.resolveFrom !== undefined
        ? { ...source, resolveFrom: registration.resolveFrom }
        : source,
    getEnv: registration.getEnv,
  };
  byFn.set(fn, info);
  return fn;
}

export function kernelOf(fn: AnyFn): KernelInfo | undefined {
  return byFn.get(fn);
}

const NESTED_PAR_HINT =
  "nested par()/join() must come from a static import; inside a Rayon worker the nested work runs inline on that worker";

const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key) || process.env.RAYON_SILENT === "1") return;
  warned.add(key);
  console.warn(`[rayon-ts] ${message}`);
}

/**
 * Deep-encodes the captured envs of `roots` and every kernel they reference,
 * producing runtime binding specs plus the involved compiled sources.
 * Kernel-valued captures become explicit graph references so mutual and
 * cross-module kernel calls resolve without colliding with user object keys.
 */
export function encodeKernelGraph(roots: KernelInfo[]): {
  bindings: Record<KernelBindingId, KernelBindingSpec>;
  sources: Map<KernelSourceId, KernelSource>;
  graphNodes: EncodedNode[];
  inputRoot: EncodedValue | undefined;
};
export function encodeKernelGraph(
  roots: KernelInfo[],
  serializedInput: readonly unknown[] | undefined,
): {
  bindings: Record<KernelBindingId, KernelBindingSpec>;
  sources: Map<KernelSourceId, KernelSource>;
  graphNodes: EncodedNode[];
  inputRoot: EncodedValue | undefined;
};
export function encodeKernelGraph(
  roots: KernelInfo[],
  serializedInput?: readonly unknown[],
): {
  bindings: Record<KernelBindingId, KernelBindingSpec>;
  sources: Map<KernelSourceId, KernelSource>;
  graphNodes: EncodedNode[];
  inputRoot: EncodedValue | undefined;
} {
  const bindings = Object.create(null) as Record<KernelBindingId, KernelBindingSpec>;
  const sources = new Map<KernelSourceId, KernelSource>();
  const graphNodes: EncodedNode[] = [];
  const seen = new Map<object, number>();
  const cloneLeaves: CloneLeaf[] = [];
  const queue = [...roots];

  let inputRoot: EncodedValue | undefined;
  if (serializedInput !== undefined) {
    try {
      // Encode generic input first. If the same object is also captured, its
      // node is reused below and reference identity survives in the worker.
      inputRoot = encodeValue(
        serializedInput,
        "input",
        undefined,
        queue,
        graphNodes,
        seen,
        cloneLeaves,
      );
    } catch (cause) {
      if (cause instanceof RayonError) throw cause;
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new RayonError(
        `par() input is not Node.js structured-cloneable: ${message}. ` +
          "Transfer-only values cannot be broadcast to every worker.",
      );
    }
  }

  while (queue.length > 0) {
    const info = queue.shift()!;
    if (bindings[info.bindingId] !== undefined) continue;
    sources.set(info.sourceId, info.source);
    try {
      bindings[info.bindingId] = {
        sourceId: info.sourceId,
        env: encodeValue(
          info.getEnv(),
          "environment",
          info,
          queue,
          graphNodes,
          seen,
          cloneLeaves,
        ),
      };
    } catch (cause) {
      if (cause instanceof CaptureError) throw cause;
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new CaptureError(
        `kernel "${info.sourceId}" has an environment that Node.js cannot snapshot or structured-clone: ${message}. ` +
          "Transfer-only values cannot be broadcast to every worker.",
      );
    }
  }

  try {
    // This one clone is both validation and the dispatch snapshot. Cloning the
    // whole graph at once preserves aliases across bindings and generic input.
    const snapshot = structuredClone({
      bindings,
      graphNodes,
      inputRoot,
    });
    return {
      bindings: snapshot.bindings,
      sources,
      graphNodes: snapshot.graphNodes,
      inputRoot: snapshot.inputRoot,
    };
  } catch (cause) {
    throwCloneFailure(cause, cloneLeaves, serializedInput !== undefined);
  }
}

interface CloneLeaf {
  value: object;
  path: string;
  rootInfo: KernelInfo | undefined;
}

function encodeValue(
  value: unknown,
  path: string,
  rootInfo: KernelInfo | undefined,
  queue: KernelInfo[],
  nodes: EncodedNode[],
  seen: Map<object, number>,
  cloneLeaves: CloneLeaf[],
): EncodedValue {
  if (typeof value === "function") {
    if (rootInfo === undefined) {
      const fnName = (value as AnyFn).name || "(anonymous)";
      throw new RayonError(
        `par() input is not Node.js structured-cloneable: function "${fnName}" appears at ${path}`,
      );
    }
    const info = byFn.get(value as AnyFn);
    if (info === undefined) {
      const fnName = (value as AnyFn).name || "(anonymous)";
      const hint = fnName === "par" || fnName === "join" ? ` (${NESTED_PAR_HINT})` : "";
      throw new CaptureError(
        `kernel "${rootInfo.sourceId}" captures the function "${fnName}" via "${path}", ` +
          `but it is not a "use parallel" kernel${hint}. ` +
          `Add the "use parallel" directive to "${fnName}" to make it callable from workers.`,
      );
    }
    queue.push(info);
    return { kind: "kernel", bindingId: info.bindingId };
  }
  if (value === null || typeof value !== "object") {
    return value as undefined | null | boolean | number | bigint | string;
  }

  if (ArrayBuffer.isView(value)) {
    if (!(value.buffer instanceof SharedArrayBuffer)) {
      if (rootInfo !== undefined) {
        warnOnce(
          "unshared-capture",
          "a captured typed array is not backed by SharedArrayBuffer; Node.js clones it once per worker, " +
            "so worker writes are not visible on the main thread",
        );
      }
    }
    cloneLeaves.push({ value, path, rootInfo });
    return { kind: "clone", value };
  }
  if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
    cloneLeaves.push({ value, path, rootInfo });
    return { kind: "clone", value };
  }

  const cached = seen.get(value);
  if (cached !== undefined) return { kind: "node", index: cached };

  if (Array.isArray(value)) {
    const index = nodes.length;
    const node: EncodedNode = { kind: "array", length: value.length, entries: [] };
    nodes.push(node);
    seen.set(value, index);
    for (const [key, item] of Object.entries(value)) {
      node.entries.push([
        key,
        encodeValue(
          item,
          `${path}[${JSON.stringify(key)}]`,
          rootInfo,
          queue,
          nodes,
          seen,
          cloneLeaves,
        ),
      ]);
    }
    return { kind: "node", index };
  }

  if (value instanceof Map) {
    const index = nodes.length;
    const node: EncodedNode = { kind: "map", entries: [] };
    nodes.push(node);
    seen.set(value, index);
    let item = 0;
    for (const [key, entryValue] of value) {
      node.entries.push([
        encodeValue(
          key,
          `${path}.<key:${item}>`,
          rootInfo,
          queue,
          nodes,
          seen,
          cloneLeaves,
        ),
        encodeValue(
          entryValue,
          `${path}.<value:${item}>`,
          rootInfo,
          queue,
          nodes,
          seen,
          cloneLeaves,
        ),
      ]);
      item += 1;
    }
    return { kind: "node", index };
  }

  if (value instanceof Set) {
    const index = nodes.length;
    const node: EncodedNode = { kind: "set", values: [] };
    nodes.push(node);
    seen.set(value, index);
    let item = 0;
    for (const entryValue of value) {
      node.values.push(
        encodeValue(
          entryValue,
          `${path}.<set:${item++}>`,
          rootInfo,
          queue,
          nodes,
          seen,
          cloneLeaves,
        ),
      );
    }
    return { kind: "node", index };
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    // Date, RegExp, Error, Node KeyObject/CryptoKey, Blob, and other host
    // objects retain their internal slots only when left to structured clone.
    cloneLeaves.push({ value, path, rootInfo });
    return { kind: "clone", value };
  }

  const index = nodes.length;
  const node: EncodedNode = { kind: "object", entries: [], nullPrototype: proto === null };
  nodes.push(node);
  seen.set(value, index);
  for (const [k, v] of Object.entries(value)) {
    node.entries.push([
      k,
      encodeValue(
        v,
        `${path}.${k}`,
        rootInfo,
        queue,
        nodes,
        seen,
        cloneLeaves,
      ),
    ]);
  }
  return { kind: "node", index };
}

function throwCloneFailure(
  cause: unknown,
  cloneLeaves: CloneLeaf[],
  hasInput: boolean,
): never {
  for (const leaf of cloneLeaves) {
    try {
      structuredClone(leaf.value);
    } catch (leafCause) {
      const message =
        leafCause instanceof Error ? leafCause.message : String(leafCause);
      if (leaf.rootInfo === undefined) {
        throw new RayonError(
          `par() input is not Node.js structured-cloneable at ${leaf.path}: ${message}. ` +
            "Transfer-only values cannot be broadcast to every worker.",
        );
      }
      throw new CaptureError(
        `kernel "${leaf.rootInfo.sourceId}" has an environment that Node.js cannot snapshot or ` +
          `structured-clone at ${leaf.path}: ${message}. ` +
          "Transfer-only values cannot be broadcast to every worker.",
      );
    }
  }

  const message = cause instanceof Error ? cause.message : String(cause);
  if (hasInput) {
    throw new RayonError(
      `parallel input/capture graph is not Node.js structured-cloneable: ${message}. ` +
        "Transfer-only values cannot be broadcast to every worker.",
    );
  }
  throw new CaptureError(
    `kernel environments cannot be snapshotted or structured-cloned: ${message}. ` +
      "Transfer-only values cannot be broadcast to every worker.",
  );
}

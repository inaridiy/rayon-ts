import * as workerThreads from "node:worker_threads";
import type { Transferable } from "node:worker_threads";

// Added in Node 21. Node 20 ignores marked buffers in a transfer list and
// clones them, so absence of this probe is safe and must not break imports.
const isMarkedAsUntransferable =
  typeof workerThreads.isMarkedAsUntransferable === "function"
    ? workerThreads.isMarkedAsUntransferable
    : undefined;

function isFileHandle(value: object): boolean {
  const record = value as { fd?: unknown; close?: unknown };
  return (
    Object.getPrototypeOf(value)?.constructor?.name === "FileHandle" &&
    typeof record.fd === "number" &&
    typeof record.close === "function"
  );
}

function isWebStream(value: object): value is Transferable {
  return (
    (typeof ReadableStream !== "undefined" &&
      value instanceof ReadableStream) ||
    (typeof WritableStream !== "undefined" &&
      value instanceof WritableStream) ||
    (typeof TransformStream !== "undefined" &&
      value instanceof TransformStream)
  );
}

function isTransferableAbortSignal(value: object): value is AbortSignal {
  if (
    typeof AbortSignal === "undefined" ||
    !(value instanceof AbortSignal)
  ) {
    return false;
  }
  try {
    // Ordinary AbortSignal clones to a plain object. Signals marked by
    // node:util.transferableAbortSignal require a transfer list instead.
    structuredClone(value);
    return false;
  } catch (cause) {
    return (
      cause instanceof Error &&
      (cause.name === "DataCloneError" || cause.name === "TypeError") &&
      cause.message.includes("needs transfer")
    );
  }
}

function* cloneChildren(value: object): Generator<unknown> {
  if (Array.isArray(value)) {
    yield* Object.values(value);
    return;
  }
  if (value instanceof Map) {
    for (const [key, item] of value) {
      yield key;
      yield item;
    }
    return;
  }
  if (value instanceof Set) {
    yield* value;
    return;
  }
  if (value instanceof Error && "cause" in value) yield value.cause;
  // Structured clone strips custom prototypes but walks enumerable own data.
  yield* Object.values(value);
}

function identityType(value: object): string {
  return Object.getPrototypeOf(value)?.constructor?.name ?? "null-prototype object";
}

/**
 * Mirrors Node's transferable traversal for the structured-clone containers
 * supported by rayon-ts. Getter failures deliberately propagate to the caller.
 */
export function collectTransferables(
  value: unknown,
  out: Set<Transferable>,
  seen: Set<object>,
): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (value instanceof workerThreads.MessagePort) {
    out.add(value);
    return;
  }
  if (value instanceof ArrayBuffer) {
    if (isMarkedAsUntransferable?.(value) !== true) out.add(value);
    return;
  }
  if (ArrayBuffer.isView(value)) {
    if (
      value.buffer instanceof ArrayBuffer &&
      isMarkedAsUntransferable?.(value.buffer) !== true
    ) {
      out.add(value.buffer);
    }
    return;
  }
  if (value instanceof SharedArrayBuffer) return;
  if (isWebStream(value) || isTransferableAbortSignal(value)) {
    out.add(value);
    return;
  }
  if (isFileHandle(value)) {
    out.add(value as Transferable);
    return;
  }
  for (const item of cloneChildren(value)) {
    collectTransferables(item, out, seen);
  }
}

/**
 * Returns why a reduction identity cannot be independently cloned per chunk.
 *
 * Node has structured-cloneable host objects (for example Histogram,
 * BlockList, and shared WebAssembly.Memory) whose clones retain mutable native
 * state. Reduction identities therefore use an explicit data-only allowlist
 * instead of assuming every structured-cloneable value is isolated.
 */
export function reductionIdentityIsolationIssue(
  value: unknown,
  seen = new Set<object>(),
  path = "identity",
): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (value instanceof SharedArrayBuffer) {
    return `${path} contains SharedArrayBuffer`;
  }
  if (ArrayBuffer.isView(value)) {
    return value.buffer instanceof SharedArrayBuffer
      ? `${path} contains a typed array backed by SharedArrayBuffer`
      : undefined;
  }
  if (
    value instanceof ArrayBuffer ||
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Blob
  ) {
    return undefined;
  }
  if (value instanceof Error) {
    if ("cause" in value) {
      return reductionIdentityIsolationIssue(value.cause, seen, `${path}.cause`);
    }
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const [key, item] of Object.entries(value)) {
      const issue = reductionIdentityIsolationIssue(
        item,
        seen,
        `${path}[${JSON.stringify(key)}]`,
      );
      if (issue !== undefined) return issue;
    }
    return undefined;
  }
  if (value instanceof Map) {
    let index = 0;
    for (const [key, item] of value) {
      const keyIssue = reductionIdentityIsolationIssue(
        key,
        seen,
        `${path}.mapKey(${index})`,
      );
      if (keyIssue !== undefined) return keyIssue;
      const valueIssue = reductionIdentityIsolationIssue(
        item,
        seen,
        `${path}.mapValue(${index})`,
      );
      if (valueIssue !== undefined) return valueIssue;
      index += 1;
    }
    return undefined;
  }
  if (value instanceof Set) {
    let index = 0;
    for (const item of value) {
      const issue = reductionIdentityIsolationIssue(
        item,
        seen,
        `${path}.setValue(${index})`,
      );
      if (issue !== undefined) return issue;
      index += 1;
    }
    return undefined;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return (
      `${path} has clone-isolation-unsafe type ${identityType(value)}; ` +
      "use plain objects, arrays, Map/Set, Error, Date, RegExp, Blob, " +
      "or non-shared ArrayBuffer/TypedArray data"
    );
  }
  for (const [key, item] of Object.entries(value)) {
    const issue = reductionIdentityIsolationIssue(
      item,
      seen,
      `${path}.${key}`,
    );
    if (issue !== undefined) return issue;
  }
  return undefined;
}

export function transferList(value: unknown): Transferable[] {
  const transfers = new Set<Transferable>();
  collectTransferables(value, transfers, new Set());
  return [...transfers];
}

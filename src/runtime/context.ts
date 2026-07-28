const RAYON_WORKER_MARKER = Symbol.for("rayon-ts.worker");

function globals(): Record<PropertyKey, unknown> {
  return globalThis as unknown as Record<PropertyKey, unknown>;
}

/** @internal Marks this isolate as one of rayon-ts's pool workers. */
export function markRayonWorker(): void {
  globals()[RAYON_WORKER_MARKER] = true;
}

/**
 * Detects a Rayon worker across separately bundled copies of the runtime.
 * Symbol.for() is intentional: a kernel may bundle its own rayon-ts copy.
 */
export function isRayonWorker(): boolean {
  return globals()[RAYON_WORKER_MARKER] === true;
}

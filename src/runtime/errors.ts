import type { WorkerError } from "./protocol.js";

export class RayonError extends Error {
  override name = "RayonError";
}

/** A plain function reached a parallel combinator without plugin compilation. */
export class KernelNotCompiledError extends RayonError {
  override name = "KernelNotCompiledError";
  constructor(context: string) {
    super(
      `${context} is not a compiled "use parallel" kernel. ` +
        `Make sure the function body starts with the "use parallel" directive ` +
        `and that the rayon() plugin from "rayon-ts/vite" is configured in vite.config.ts.`,
    );
  }
}

/** A kernel captured a value that cannot cross the thread boundary. */
export class CaptureError extends RayonError {
  override name = "CaptureError";
}

/** A kernel threw inside a worker; carries the original worker stack. */
export class KernelRuntimeError extends RayonError {
  override name = "KernelRuntimeError";
  readonly workerError: WorkerError;
  constructor(err: WorkerError) {
    super(`kernel threw in worker: ${err.name}: ${err.message}`);
    this.workerError = err;
    if (err.stack) this.stack = `${this.name}: ${this.message}\n--- worker stack ---\n${err.stack}`;
  }
}

export class RayonTimeoutError extends RayonError {
  override name = "RayonTimeoutError";
}

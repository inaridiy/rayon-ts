import { RayonError } from "./errors.js";
import { par, type MapFn, type WorkerResult } from "./par.js";

export interface ParallelBatcherOptions {
  /** Dispatch immediately once this many calls are queued. Default: 64. */
  maxBatchSize?: number;
  /** Maximum time the oldest queued call waits before dispatch. Default: 1 ms. */
  maxWaitMs?: number;
  /** Maximum unresolved calls, including the active batch. Default: 4096. */
  maxPending?: number;
}

export interface ParallelBatcher<Input, Output> {
  (value: Input): Promise<Output>;
  /** Calls accepted but not yet settled, including the active batch. */
  readonly pending: number;
  /** Dispatches an underfilled batch now and waits until the batcher is idle. */
  flush(): Promise<void>;
  /** Stops accepting calls, drains accepted work, and waits until idle. */
  close(): Promise<void>;
}

interface PendingCall<Input, Output> {
  value: Input;
  resolve: (value: Output) => void;
  reject: (cause: unknown) => void;
}

const DEFAULT_MAX_BATCH_SIZE = 64;
const DEFAULT_MAX_WAIT_MS = 1;
const DEFAULT_MAX_PENDING = 4096;
const MAX_TIMER_MS = 0x7fff_ffff;

function positiveSafeInteger(
  value: number,
  name: keyof ParallelBatcherOptions,
): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RayonError(`${name} must be a positive safe integer, got ${value}`);
  }
  return value;
}

function nonNegativeFinite(
  value: number,
  name: keyof ParallelBatcherOptions,
): number {
  if (!Number.isFinite(value) || value < 0 || value > MAX_TIMER_MS) {
    throw new RayonError(
      `${name} must be between 0 and ${MAX_TIMER_MS}, got ${value}`,
    );
  }
  return value;
}

/**
 * Coalesces concurrent single-value calls into bounded parallel iterator jobs.
 *
 * One failed batch rejects every call pending at that moment. The batcher
 * remains reusable, allowing the worker pool's normal recovery behavior to
 * apply to later calls.
 */
export function createParallelBatcher<Input, Output>(
  kernel: MapFn<Input, Output>,
  options: ParallelBatcherOptions = {},
): ParallelBatcher<Input, WorkerResult<Output>> {
  if (typeof kernel !== "function") {
    throw new RayonError("createParallelBatcher() expects a kernel function");
  }

  const maxBatchSize = positiveSafeInteger(
    options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
    "maxBatchSize",
  );
  const maxWaitMs = nonNegativeFinite(
    options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
    "maxWaitMs",
  );
  const maxPending = positiveSafeInteger(
    options.maxPending ?? DEFAULT_MAX_PENDING,
    "maxPending",
  );

  const queue: PendingCall<Input, WorkerResult<Output>>[] = [];
  const idleWaiters: Array<() => void> = [];
  let pending = 0;
  let active = false;
  let drainRequested = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let state: "open" | "closing" | "closed" = "open";

  const clearBatchTimer = (): void => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const settleIdle = (): void => {
    if (pending !== 0) return;
    if (state === "closing") state = "closed";
    for (const resolve of idleWaiters.splice(0)) resolve();
  };

  const whenIdle = (): Promise<void> =>
    pending === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          idleWaiters.push(resolve);
        });

  let requestDrain: () => void;

  const armTimer = (): void => {
    if (timer !== undefined || queue.length === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      requestDrain();
    }, maxWaitMs);
  };

  const rejectPending = (
    batch: PendingCall<Input, WorkerResult<Output>>[],
    cause: unknown,
  ): void => {
    clearBatchTimer();
    drainRequested = false;
    const rejected = [...batch, ...queue.splice(0)];
    pending -= rejected.length;
    for (const call of rejected) call.reject(cause);
  };

  const runBatch = async (): Promise<void> => {
    active = true;
    drainRequested = false;
    const batch = queue.splice(0, maxBatchSize);
    try {
      const output = await par(batch.map((call) => call.value))
        .map(kernel)
        .async()
        .toArray();
      if (output.length !== batch.length) {
        throw new RayonError(
          `parallel batch protocol returned ${output.length} results for ${batch.length} calls`,
        );
      }
      pending -= batch.length;
      for (let index = 0; index < batch.length; index++) {
        batch[index]!.resolve(output[index]!);
      }
    } catch (cause) {
      rejectPending(batch, cause);
    } finally {
      active = false;
    }

    if (queue.length === 0) {
      settleIdle();
      return;
    }
    if (
      state === "closing" ||
      drainRequested ||
      queue.length >= maxBatchSize
    ) {
      requestDrain();
    } else {
      armTimer();
    }
  };

  requestDrain = (): void => {
    clearBatchTimer();
    if (active) {
      drainRequested = true;
      return;
    }
    if (queue.length === 0) {
      settleIdle();
      return;
    }
    void runBatch();
  };

  const submit = ((value: Input): Promise<WorkerResult<Output>> => {
    if (state !== "open") {
      return Promise.reject(
        new RayonError("parallel batcher is closed and cannot accept new calls"),
      );
    }
    if (pending >= maxPending) {
      return Promise.reject(
        new RayonError(
          `parallel batcher has reached maxPending (${maxPending})`,
        ),
      );
    }

    pending += 1;
    const result = new Promise<WorkerResult<Output>>((resolve, reject) => {
      queue.push({ value, resolve, reject });
    });
    if (queue.length >= maxBatchSize) requestDrain();
    else armTimer();
    return result;
  }) as ParallelBatcher<Input, WorkerResult<Output>>;

  Object.defineProperties(submit, {
    pending: {
      enumerable: true,
      get: () => pending,
    },
    flush: {
      enumerable: true,
      value: (): Promise<void> => {
        requestDrain();
        return whenIdle();
      },
    },
    close: {
      enumerable: true,
      value: (): Promise<void> => {
        if (state === "open") state = "closing";
        requestDrain();
        return whenIdle();
      },
    },
  });

  return submit;
}

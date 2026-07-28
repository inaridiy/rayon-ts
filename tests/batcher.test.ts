import { describe, expect, it } from "vitest";
import {
  createParallelBatcher,
  initThreadPool,
} from "../src/index.js";
import { __rayonRegister } from "../src/runtime/registry.js";

initThreadPool({ threads: 4, timeoutMs: 20_000 });

interface VerifiedEvent {
  id: number;
  valid: boolean;
  threadId: number;
}

const verify = __rayonRegister(
  (event: { id: number; valid: boolean }): VerifiedEvent => ({
    id: event.id,
    valid: event.valid,
    threadId: RAYON_THREAD_ID,
  }),
  {
    id: "manual::batchVerify",
    source:
      "(event) => ({ id: event.id, valid: event.valid, threadId: RAYON_THREAD_ID })",
    getEnv: () => ({}),
  },
);

describe("createParallelBatcher", () => {
  it("coalesces concurrent calls and returns each result in call order", async () => {
    const batchedVerify = createParallelBatcher(verify, {
      maxBatchSize: 8,
      maxWaitMs: 5,
      maxPending: 64,
    });
    const input = Array.from({ length: 23 }, (_, id) => ({
      id,
      valid: id % 2 === 0,
    }));

    const result = await Promise.all(input.map((event) => batchedVerify(event)));

    expect(result.map(({ id }) => id)).toEqual(input.map(({ id }) => id));
    expect(result.map(({ valid }) => valid)).toEqual(
      input.map(({ valid }) => valid),
    );
    expect(result.every(({ threadId }) => threadId > 0)).toBe(true);
    expect(batchedVerify.pending).toBe(0);
    await batchedVerify.close();
  });

  it("flushes an underfilled batch without waiting for its timer", async () => {
    const batchedVerify = createParallelBatcher(verify, {
      maxBatchSize: 64,
      maxWaitMs: 10_000,
    });
    const result = batchedVerify({ id: 7, valid: true });

    await batchedVerify.flush();

    await expect(result).resolves.toMatchObject({ id: 7, valid: true });
    expect(batchedVerify.pending).toBe(0);
    await batchedVerify.close();
  });

  it("close drains accepted work and rejects later calls", async () => {
    const batchedVerify = createParallelBatcher(verify, {
      maxBatchSize: 64,
      maxWaitMs: 10_000,
    });
    const result = batchedVerify({ id: 9, valid: false });

    await batchedVerify.close();

    await expect(result).resolves.toMatchObject({ id: 9, valid: false });
    await expect(
      batchedVerify({ id: 10, valid: true }),
    ).rejects.toThrow(/batcher is closed/);
  });

  it("enforces maxPending across queued and active calls", async () => {
    const slowVerify = __rayonRegister(
      (value: number): number => value,
      {
        id: "manual::batchSlow",
        source: `(value) => {
          let total = 0;
          for (let index = 0; index < 5_000_000; index++) total += index;
          if (total < 0) throw new Error("unreachable");
          return value;
        }`,
        getEnv: () => ({}),
      },
    );
    const batch = createParallelBatcher(slowVerify, {
      maxBatchSize: 2,
      maxWaitMs: 10_000,
      maxPending: 2,
    });
    const first = batch(1);
    const second = batch(2);

    await expect(batch(3)).rejects.toThrow(/maxPending \(2\)/);
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    await batch.close();
  });

  it("rejects all work pending when a batch fails, then remains reusable", async () => {
    const failOnTwo = __rayonRegister(
      (value: number): number => {
        if (value === 2) throw new Error("invalid event");
        return value;
      },
      {
        id: "manual::batchFailure",
        source:
          '(value) => { if (value === 2) throw new Error("invalid event"); return value; }',
        getEnv: () => ({}),
      },
    );
    const batch = createParallelBatcher(failOnTwo, {
      maxBatchSize: 3,
      maxWaitMs: 10_000,
      maxPending: 16,
    });

    const failed = await Promise.allSettled([
      batch(1),
      batch(2),
      batch(3),
      batch(4),
    ]);
    expect(failed.every(({ status }) => status === "rejected")).toBe(true);
    expect(batch.pending).toBe(0);
    const recovered = batch(5);
    await batch.flush();
    await expect(recovered).resolves.toBe(5);
    await batch.close();
  });

  it("validates queue limits", () => {
    expect(() =>
      createParallelBatcher(verify, { maxBatchSize: 0 }),
    ).toThrow(/maxBatchSize/);
    expect(() =>
      createParallelBatcher(verify, { maxWaitMs: -1 }),
    ).toThrow(/maxWaitMs/);
    expect(() =>
      createParallelBatcher(verify, { maxWaitMs: 0x8000_0000 }),
    ).toThrow(/maxWaitMs/);
    expect(() =>
      createParallelBatcher(verify, { maxPending: Number.NaN }),
    ).toThrow(/maxPending/);
  });
});

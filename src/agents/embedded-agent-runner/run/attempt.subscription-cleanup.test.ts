// Coverage for ordered cleanup of embedded attempt subscriptions and resources.
import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../logger.js";
import {
  acquireEmbeddedAttemptCleanupSessionLock,
  EMBEDDED_ABORT_SETTLE_TIMEOUT_MS,
  cleanupEmbeddedAttemptResources,
  runOwnedPromptUntilSettled,
} from "./attempt.subscription-cleanup.js";

function createDeferred<T>() {
  // Manual deferreds let cleanup tests prove ordering around abort settlement.
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("embedded attempt subscription cleanup", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("waits for aborted prompt settlement before acquiring the cleanup lock", async () => {
    const order: string[] = [];
    const settle = createDeferred<void>();

    const cleanupLockPromise = acquireEmbeddedAttemptCleanupSessionLock({
      acquire: async () => {
        order.push("acquire");
        return { release: async () => {} };
      },
      abortSettlePromise: settle.promise,
      runId: "run-1",
      sessionId: "session-1",
    });

    await Promise.resolve();

    expect(order).toEqual([]);

    settle.resolve();
    await cleanupLockPromise;

    expect(order).toEqual(["acquire"]);
  });

  it("acquires the cleanup lock after the aborted settle timeout", async () => {
    vi.useFakeTimers();
    vi.spyOn(log, "warn").mockImplementation(() => {});
    const order: string[] = [];

    const cleanupLockPromise = acquireEmbeddedAttemptCleanupSessionLock({
      acquire: async () => {
        order.push("acquire");
        return { release: async () => {} };
      },
      abortSettlePromise: new Promise(() => {}),
      runId: "run-1",
      sessionId: "session-1",
    });

    await vi.advanceTimersByTimeAsync(EMBEDDED_ABORT_SETTLE_TIMEOUT_MS - 1);
    expect(order).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await cleanupLockPromise;

    expect(order).toEqual(["acquire"]);
  });

  it("acquires the cleanup lock immediately without pending abort work", async () => {
    const acquire = vi.fn(async () => ({ release: async () => {} }));

    await acquireEmbeddedAttemptCleanupSessionLock({
      acquire,
      abortSettlePromise: null,
      runId: "run-1",
      sessionId: "session-1",
    });

    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it("keeps transcript ownership active after the caller-facing abort rejects", async () => {
    const prompt = createDeferred<void>();
    const callerAbort = createDeferred<never>();
    let ownershipActive = false;
    const tracked: Promise<void>[] = [];

    const result = runOwnedPromptUntilSettled({
      withOwnership: async (run) => {
        ownershipActive = true;
        try {
          return await run();
        } finally {
          ownershipActive = false;
        }
      },
      runPrompt: () => prompt.promise,
      trackSettlement: (promise) => {
        tracked.push(promise);
        return promise;
      },
      abortable: (promise) => Promise.race([promise, callerAbort.promise]),
    });

    callerAbort.reject(new Error("idle timeout"));
    await expect(result).rejects.toThrow("idle timeout");
    expect(ownershipActive).toBe(true);
    expect(tracked).toHaveLength(1);

    prompt.resolve();
    await expect(tracked[0]).resolves.toBeUndefined();
    expect(ownershipActive).toBe(false);
  });

  it("releases the lock before runtime teardown can hang", async () => {
    // Bundle runtime disposal can hang; release transcript locks first so other
    // turns are not blocked by diagnostic cleanup.
    const order: string[] = [];
    let markRuntimeDisposeStarted!: () => void;
    const runtimeDisposeStarted = new Promise<void>((resolve) => {
      markRuntimeDisposeStarted = resolve;
    });

    void cleanupEmbeddedAttemptResources({
      flushPendingToolResultsAfterIdle: vi.fn(async () => {
        order.push("flush");
      }),
      session: {
        agent: {},
        dispose: () => {
          order.push("dispose");
        },
      },
      sessionManager: {},
      sessionLock: {
        release: async () => {
          order.push("release");
        },
      },
      bundleMcpRuntime: {
        dispose: async () => {
          order.push("runtime-dispose-start");
          markRuntimeDisposeStarted();
          await new Promise(() => {});
        },
      },
    });

    await runtimeDisposeStarted;

    expect(order).toEqual(["flush", "release", "dispose", "runtime-dispose-start"]);
  });

  it("still disposes resources when lock release fails", async () => {
    const releaseError = new Error("release failed");
    const dispose = vi.fn();
    const runtimeDispose = vi.fn(async () => {});

    await expect(
      cleanupEmbeddedAttemptResources({
        flushPendingToolResultsAfterIdle: vi.fn(async () => {}),
        session: {
          agent: {},
          dispose,
        },
        sessionManager: {},
        sessionLock: {
          release: async () => {
            throw releaseError;
          },
        },
        bundleMcpRuntime: {
          dispose: runtimeDispose,
        },
      }),
    ).rejects.toBe(releaseError);

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(runtimeDispose).toHaveBeenCalledTimes(1);
  });

  it("can skip stale session-manager flushing after session takeover", async () => {
    const flushPendingToolResultsAfterIdle = vi.fn(async () => {});
    const order: string[] = [];
    const dispose = vi.fn(() => {
      order.push("dispose");
    });
    const release = vi.fn(async () => {
      order.push("release");
    });

    await cleanupEmbeddedAttemptResources({
      flushPendingToolResultsAfterIdle,
      session: {
        agent: {},
        dispose,
      },
      sessionManager: {},
      sessionLock: { release },
      skipSessionFlush: true,
    });

    expect(flushPendingToolResultsAfterIdle).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["release", "dispose"]);
  });
});

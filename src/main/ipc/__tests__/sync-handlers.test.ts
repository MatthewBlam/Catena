import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));

import {
  activeSyncs,
  registerSync,
  cancelSync,
  cancelAllSyncs,
} from "../sync-handlers";

/** Resolves once every already-queued microtask has run. */
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * Stands in for a sync: registers, runs until released, then unwinds through a
 * `finally` exactly like `sync:start` and the scheduler tick do.
 */
function fakeSync(sourceId: string): {
  signal: AbortSignal;
  release: () => void;
  ran: Promise<void>;
} {
  const { controller, finish } = registerSync(sourceId);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const ran = (async () => {
    try {
      await gate;
    } finally {
      finish();
    }
  })();
  return { signal: controller.signal, release, ran };
}

beforeEach(() => {
  activeSyncs.clear();
  vi.useRealTimers();
});

describe("cancelSync (M5)", () => {
  it("does not resolve until the sync has actually unwound", async () => {
    const sync = fakeSync("s1");

    let cancelled = false;
    const cancelling = cancelSync("s1").then(() => {
      cancelled = true;
    });

    // The abort lands immediately — but aborting is cooperative, and the sync
    // is still running. This is the whole bug: `sources:remove` used to delete
    // the row at exactly this moment.
    await settle();
    expect(sync.signal.aborted).toBe(true);
    expect(cancelled).toBe(false);
    expect(activeSyncs.has("s1")).toBe(true);

    sync.release();
    await cancelling;

    expect(cancelled).toBe(true);
    expect(activeSyncs.has("s1")).toBe(false);
    await sync.ran;
  });

  it("resolves immediately when no sync is running for that source", async () => {
    await expect(cancelSync("nobody")).resolves.toBeUndefined();
  });

  it("gives up after 15s rather than wedging the caller forever", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sync = fakeSync("wedged");

    let cancelled = false;
    const cancelling = cancelSync("wedged").then(() => {
      cancelled = true;
    });

    await vi.advanceTimersByTimeAsync(14_999);
    expect(cancelled).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    await cancelling;

    expect(cancelled).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("wedged"));

    // The sync is still out there — we abandoned it, we did not kill it.
    expect(sync.signal.aborted).toBe(true);
    sync.release();
    await sync.ran;
    vi.useRealTimers();
  });

  it("cancelAllSyncs waits for every sync, not just the first", async () => {
    const a = fakeSync("a");
    const b = fakeSync("b");

    let done = false;
    const cancelling = cancelAllSyncs().then(() => {
      done = true;
    });

    await settle();
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
    expect(done).toBe(false);

    a.release();
    await settle();
    expect(done).toBe(false); // b is still unwinding

    b.release();
    await cancelling;

    expect(done).toBe(true);
    expect(activeSyncs.size).toBe(0);
  });

  it("leaves no entry behind when a sync unwinds on its own", async () => {
    const sync = fakeSync("s1");
    sync.release();
    await sync.ran;
    expect(activeSyncs.size).toBe(0);
    // The old cancelAllSyncs() called activeSyncs.clear(), which would have
    // orphaned any `done` promise still being awaited. Each finally owns its
    // own entry now.
    await expect(cancelAllSyncs()).resolves.toBeUndefined();
  });
});

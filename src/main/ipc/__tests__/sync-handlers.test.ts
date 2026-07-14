import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";

interface FakeWindow {
  destroyed: boolean;
  isDestroyed: () => boolean;
  webContents: { send: ReturnType<typeof vi.fn> };
}

const h = vi.hoisted(() => ({ windows: [] as unknown[] }));
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => h.windows },
}));

function fakeWindow(): FakeWindow {
  const win: FakeWindow = {
    destroyed: false,
    isDestroyed: () => win.destroyed,
    webContents: { send: vi.fn() },
  };
  return win;
}

import {
  activeSyncs,
  registerSync,
  cancelSync,
  cancelAllSyncs,
  recordSyncOutcome,
  publishSyncProgress,
  broadcastSourcesChanged,
  getActiveSyncProgress,
  type SyncOutcomeInput,
} from "../sync-handlers";
import { createTestDb } from "../../db/__tests__/test-db";
import { insertSource, getSourceById } from "../../db/database";
import type { SyncProgress } from "../../../shared/types";

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
  h.windows = [];
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

describe("recordSyncOutcome (H3)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    insertSource(db, {
      id: "s1",
      provider: "notion",
      name: "Handbook",
      rootExternalId: "root",
      createdAt: "2024-01-01T00:00:00Z",
    });
  });
  afterEach(() => db.close());

  const progress = (errors: string[]): SyncProgress => ({
    sourceId: "s1",
    phase: errors.length > 0 ? "error" : "done",
    current: 10,
    skipped: 0,
    total: 10,
    deleted: 0,
    currentDocTitle: null,
    errors,
  });

  const outcome = (o: Partial<SyncOutcomeInput>): SyncOutcomeInput => ({
    lastProgress: null,
    thrown: undefined,
    ...o,
  });

  it("records a clean sync as ok", () => {
    recordSyncOutcome(db, "s1", outcome({ lastProgress: progress([]) }), false);

    const s = getSourceById(db, "s1")!;
    expect(s.lastSyncStatus).toBe("ok");
    expect(s.lastSyncError).toBeNull();
    expect(s.lastSyncErrorCount).toBe(0);
    expect(s.lastSyncAt).not.toBeNull();
  });

  it("records document-level failures as partial, not error", () => {
    recordSyncOutcome(
      db,
      "s1",
      outcome({ lastProgress: progress(["Bylaws: 429 rate limited"]) }),
      false,
    );

    const s = getSourceById(db, "s1")!;
    // The sync ran and left a usable index behind. That is not the same as
    // never having run at all, and the UI needs to say so differently.
    expect(s.lastSyncStatus).toBe("partial");
    expect(s.lastSyncError).toBe("Bylaws: 429 rate limited");
    expect(s.lastSyncErrorCount).toBe(1);
  });

  it("keeps the message when the connector itself fails", () => {
    // The whole reason this lives in the `finally` and not in `syncSource`:
    // `getConnectorForSource` threw, so `syncSource` never ran and there is no
    // progress object at all. If the message were only ever read out of
    // `lastProgress.errors`, this would store `error` with a null message and
    // the user would be told "something went wrong" and nothing else.
    recordSyncOutcome(
      db,
      "s1",
      outcome({
        thrown: new Error("Notion token not found. Connect Notion first."),
      }),
      false,
    );

    const s = getSourceById(db, "s1")!;
    expect(s.lastSyncStatus).toBe("error");
    expect(s.lastSyncError).toBe(
      "Notion token not found. Connect Notion first.",
    );
    expect(s.lastSyncErrorCount).toBe(1);
  });

  it("puts the thrown error above the per-document ones", () => {
    recordSyncOutcome(
      db,
      "s1",
      outcome({
        lastProgress: progress(["Bylaws: 429"]),
        thrown: new Error("Embedding provider unreachable"),
      }),
      false,
    );

    const s = getSourceById(db, "s1")!;
    expect(s.lastSyncStatus).toBe("error");
    expect(s.lastSyncError).toBe("Embedding provider unreachable\nBylaws: 429");
    expect(s.lastSyncErrorCount).toBe(2);
  });

  it("records an aborted sync as cancelled, whatever else happened", () => {
    recordSyncOutcome(
      db,
      "s1",
      outcome({
        lastProgress: progress(["Bylaws: 429"]),
        thrown: new Error("aborted mid-flight"),
      }),
      true,
    );

    // The user asked for this. Reporting it as an error would be a lie, and a
    // scary one.
    expect(getSourceById(db, "s1")!.lastSyncStatus).toBe("cancelled");
  });

  it("stores at most 5 error lines but counts all of them", () => {
    const errors = Array.from({ length: 12 }, (_, i) => `Doc ${i}: failed`);
    recordSyncOutcome(
      db,
      "s1",
      outcome({ lastProgress: progress(errors) }),
      false,
    );

    const s = getSourceById(db, "s1")!;
    expect(s.lastSyncError!.split("\n")).toHaveLength(5);
    expect(s.lastSyncError).toContain("Doc 0: failed");
    expect(s.lastSyncError).not.toContain("Doc 5: failed");
    // "5 of 12 shown" needs the 12.
    expect(s.lastSyncErrorCount).toBe(12);
  });

  it("does not throw when the source was removed mid-sync", () => {
    db.prepare("DELETE FROM sources WHERE id = ?").run("s1");
    expect(() => recordSyncOutcome(db, "s1", outcome({}), false)).not.toThrow();
  });
});

describe("progress broadcast and hydration (H7)", () => {
  const makeProgress = (o: Partial<SyncProgress> = {}): SyncProgress => ({
    sourceId: "s1",
    phase: "embedding",
    current: 3,
    skipped: 0,
    total: 10,
    deleted: 0,
    currentDocTitle: "Bylaws",
    errors: [],
    ...o,
  });

  it("sends progress to every window, not just the one that started the sync", () => {
    const a = fakeWindow();
    const b = fakeWindow();
    h.windows = [a, b];

    const p = makeProgress();
    publishSyncProgress(p);

    // `sync:start` used to send only to `event.sender`, so a second window
    // watched a sync it could not see.
    expect(a.webContents.send).toHaveBeenCalledWith("sync:progress", p);
    expect(b.webContents.send).toHaveBeenCalledWith("sync:progress", p);
  });

  it("reaches a window that opened after the sync began", () => {
    const first = fakeWindow();
    h.windows = [first];
    publishSyncProgress(makeProgress({ current: 1 }));

    // The scheduler used to resolve `getAllWindows()[0]` once, before the sync,
    // and hold that WebContents for the whole run.
    const late = fakeWindow();
    h.windows = [first, late];
    publishSyncProgress(makeProgress({ current: 2 }));

    expect(late.webContents.send).toHaveBeenCalledTimes(1);
    expect(late.webContents.send).toHaveBeenCalledWith(
      "sync:progress",
      expect.objectContaining({ current: 2 }),
    );
  });

  it("skips destroyed windows", () => {
    const gone = fakeWindow();
    gone.destroyed = true;
    const live = fakeWindow();
    h.windows = [gone, live];

    publishSyncProgress(makeProgress());
    broadcastSourcesChanged();

    expect(gone.webContents.send).not.toHaveBeenCalled();
    expect(live.webContents.send).toHaveBeenCalledTimes(2);
  });

  it("broadcasts sources:changed to every window", () => {
    const a = fakeWindow();
    const b = fakeWindow();
    h.windows = [a, b];

    broadcastSourcesChanged();

    expect(a.webContents.send).toHaveBeenCalledWith(
      "sources:changed",
      undefined,
    );
    expect(b.webContents.send).toHaveBeenCalledWith(
      "sources:changed",
      undefined,
    );
  });

  it("replays the last progress event to a renderer that mounts mid-sync", async () => {
    const sync = fakeSync("s1");
    publishSyncProgress(makeProgress({ current: 7 }));

    const active = getActiveSyncProgress();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ sourceId: "s1", current: 7 });

    sync.release();
    await sync.ran;
  });

  it("reports a sync that has not emitted anything yet", async () => {
    // Registered, but still inside `getConnectorForSource` — a Google token
    // refresh is a network round-trip. Reporting nothing here would let the
    // renderer offer a Sync button whose only possible outcome is the
    // "sync already in progress" error.
    const sync = fakeSync("s1");

    const active = getActiveSyncProgress();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ sourceId: "s1", phase: "fetching" });

    sync.release();
    await sync.ran;
  });

  it("reports nothing once the sync is over", async () => {
    const sync = fakeSync("s1");
    publishSyncProgress(makeProgress({ current: 7 }));
    publishSyncProgress(makeProgress({ phase: "done" }));
    sync.release();
    await sync.ran;

    expect(getActiveSyncProgress()).toEqual([]);
  });

  it("does not resurrect a finished sync from a stale progress entry", async () => {
    // A terminal phase clears the entry, but `activeSyncs` is the authority:
    // even if a non-terminal event were the last one seen — a sync killed
    // between "storing" and "done" — the sync is over and must not be replayed.
    const sync = fakeSync("s1");
    publishSyncProgress(makeProgress({ phase: "storing" }));
    sync.release();
    await sync.ran;

    expect(getActiveSyncProgress()).toEqual([]);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));

import {
  activeSyncs,
  registerSync,
  cancelSync,
  cancelAllSyncs,
  recordSyncOutcome,
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

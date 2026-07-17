import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock("../../telemetry/posthog", () => ({ track: vi.fn() }));

const h = vi.hoisted(() => ({
  /** One resolver per syncSource call, in call order. */
  releases: [] as (() => void)[],
  syncCalls: [] as string[],
  connectorCalls: [] as unknown[],
}));

// A sync that hangs until the test lets it go, so `stop()` can land mid-tick.
vi.mock("../sync-manager", () => ({
  syncSource: vi.fn(async (_db: unknown, sourceId: string) => {
    h.syncCalls.push(sourceId);
    await new Promise<void>((resolve) => {
      h.releases.push(resolve);
    });
  }),
}));

// `getConnectorForSource` now runs from inside `runManagedSync`, a same-module
// call within sync-handlers.ts that `vi.mock` on that module cannot intercept
// (mocking an export doesn't rewrite the module's own internal references to
// it). Faking `loadSecret` instead reaches the same effect one layer down: a
// real `getConnectorForSource` sees a token, builds a real (but
// network-inert — see notion.ts's constructor) `NotionConnector`, and never
// throws "Notion token not found". `db` is recorded here for the same reason
// the old mock recorded it: proving `getConnectorForSource` never sees a
// null database after `stop()`.
vi.mock("../../auth/storage", () => ({
  loadSecret: vi.fn((db: unknown) => {
    h.connectorCalls.push(db);
    return "fake-token";
  }),
}));

import { syncScheduler } from "../scheduler";
import { createTestDb } from "../../db/__tests__/test-db";
import { insertSource, upsertSetting, deleteSource } from "../../db/database";
import { activeSyncs } from "../../ipc/sync-handlers";

const INTERVAL_MS = 1000;

/** Lets pending microtasks run while fake timers are installed. */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

function seed(db: Database.Database, ids: string[]): void {
  ids.forEach((id, i) => {
    insertSource(db, {
      id,
      provider: "notion",
      name: id,
      rootExternalId: `root-${id}`,
      // `getAllSources` orders by created_at DESC, so date them backwards to
      // make the scheduler work through them in the order given here.
      createdAt: `2024-01-0${ids.length - i}T00:00:00Z`,
    });
  });
  upsertSetting(db, "auto_sync_enabled", "true");
  // `start()` reads the raw setting; only `setIntervalMs` clamps to 60s.
  upsertSetting(db, "auto_sync_interval_ms", String(INTERVAL_MS));
}

describe("SyncScheduler state (M6)", () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.useFakeTimers();
    h.releases = [];
    h.syncCalls = [];
    h.connectorCalls = [];
    activeSyncs.clear();
    db = createTestDb();
  });

  afterEach(async () => {
    syncScheduler.stop();
    releaseAll();
    // Let the parked ticks run their `finally` blocks *before* closing the
    // database they write the sync outcome to.
    await settle();
    await settle();
    activeSyncs.clear();
    vi.useRealTimers();
    db.close();
  });

  const releaseAll = (): void => {
    for (const r of h.releases) r();
  };

  it("reports syncing === false the moment it is stopped, not when the tick unwinds", async () => {
    seed(db, ["s1"]);
    syncScheduler.start(db);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await settle();
    expect(syncScheduler.getState().syncing).toBe(true);

    // The tick is parked inside syncSource. `running` used to stay true for the
    // whole unwind window, so `getState()` claimed a sync was in progress after
    // the scheduler had been told to stop.
    syncScheduler.stop();
    expect(syncScheduler.getState().syncing).toBe(false);

    releaseAll();
    await settle();
    expect(syncScheduler.getState().syncing).toBe(false);
  });

  it("runs a tick after a stop/start, instead of silently skipping it", async () => {
    seed(db, ["s1"]);
    syncScheduler.start(db);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await settle();
    expect(h.syncCalls).toEqual(["s1"]);

    // Restart, and let the first tick finish unwinding. The old
    // `running === true` survived the stop, so the next tick hit
    // `if (this.running) return` and no-opped: the scheduler looked alive and
    // did nothing at all.
    syncScheduler.stop();
    syncScheduler.start(db);
    releaseAll();
    await settle();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await settle();

    expect(h.syncCalls).toEqual(["s1", "s1"]);
  });

  it("stops the loop mid-tick instead of syncing the remaining sources", async () => {
    seed(db, ["s1", "s2", "s3"]);
    syncScheduler.start(db);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await settle();
    expect(h.syncCalls).toHaveLength(1);

    syncScheduler.stop();
    releaseAll();
    await settle();

    // The loop breaks rather than working through s2 and s3.
    expect(h.syncCalls).toHaveLength(1);
  });

  it("never hands a null db to getConnectorForSource after stop()", async () => {
    seed(db, ["s1", "s2"]);
    syncScheduler.start(db);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await settle();

    syncScheduler.stop(); // nulls this.db while the tick is awaiting
    releaseAll();
    await settle();

    // `this.db!` used to be re-read on each iteration, so the next source got a
    // null database and a bogus "Auto-sync failed" for what was only ever a
    // clean shutdown.
    expect(h.connectorCalls.length).toBeGreaterThan(0);
    for (const passed of h.connectorCalls) {
      expect(passed).not.toBeNull();
    }
  });

  it("an old tick's unwind does not clobber the live tick's state", async () => {
    // Two sources, so the new tick has something of its own to park on: the old
    // tick still holds s1 in `activeSyncs`, and the new one correctly skips it.
    seed(db, ["s1", "s2"]);
    syncScheduler.start(db);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await settle();
    expect(h.syncCalls).toEqual(["s1"]); // tick A, parked on s1

    syncScheduler.stop();
    syncScheduler.start(db);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await settle();
    expect(h.syncCalls).toEqual(["s1", "s2"]); // tick B, parked on s2
    expect(syncScheduler.getState().syncing).toBe(true);

    // Tick A finally unwinds. Its `finally` belongs to a dead generation: it
    // must not report tick B as finished, and must not null out tick B's abort
    // controller.
    h.releases[0]();
    await settle();

    expect(syncScheduler.getState().syncing).toBe(true);

    // And tick B is still abortable — the proof that its controller survived.
    syncScheduler.stop();
    expect(syncScheduler.getState().syncing).toBe(false);
  });

  it("start() is an idempotent restart, not a second scheduler", async () => {
    seed(db, ["s1"]);
    syncScheduler.start(db);
    syncScheduler.start(db);
    syncScheduler.start(db);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await settle();

    // Three live intervals would have queued three ticks.
    expect(h.syncCalls).toEqual(["s1"]);
  });

  it("skips a source deleted after the tick's snapshot was taken (item 3)", async () => {
    // s1's sync hangs, giving the test a window to delete s2 out from under
    // the tick's `getAllSources` snapshot before the loop ever reaches it.
    seed(db, ["s1", "s2"]);
    syncScheduler.start(db);

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await settle();
    expect(h.syncCalls).toEqual(["s1"]); // parked on s1
    const connectorCallsBeforeDeletion = h.connectorCalls.length;

    deleteSource(db, "s2");

    releaseAll();
    await settle();

    // s2 must never be synced — not a wasted provider fetch, not a
    // `getConnectorForSource`/`loadSecret` call, not started-telemetry for a
    // source that no longer exists.
    expect(h.syncCalls).toEqual(["s1"]);
    expect(h.connectorCalls).toHaveLength(connectorCallsBeforeDeletion);
  });
});

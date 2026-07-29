import type Database from "better-sqlite3";
import {
  getAllSources,
  getSourceById,
  getSetting,
  upsertSetting,
} from "../db/database";
import {
  activeSyncs,
  buildEmbedConfig,
  registerSync,
  runManagedSync,
  AUTO_SYNC_DISABLED,
} from "../ipc/sync-handlers";
import type { SchedulerState } from "../../shared/types";

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * How long after launch an overdue catch-up sync waits before firing. A short
 * grace so the app finishes starting up (windows, and a managed Ollama engine
 * coming online) before the first tick runs.
 */
const STARTUP_SYNC_DELAY_MS = 10_000;

function clampInterval(ms: number): number {
  return Math.max(MIN_INTERVAL_MS, Math.min(ms, MAX_INTERVAL_MS));
}

class SyncScheduler {
  private db: Database.Database | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private startupHandle: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;
  private running = false;
  private enabled = false;
  private intervalMs = DEFAULT_INTERVAL_MS;
  private lastSyncedAt: string | null = null;

  /**
   * Bumped by every `stop()`. A tick captures it on entry, and anything it does
   * afterwards — continuing the loop, writing back state in its `finally` — is
   * conditional on still owning the current generation. Without it, a tick that
   * was told to stop keeps running, and its `finally` clobbers the state of
   * whatever tick started after it.
   */
  private generation = 0;

  start(db: Database.Database): void {
    // Idempotent restart: a second `start()` must not leave the first one's
    // interval, abort controller, or in-flight tick attached.
    this.stop();

    this.db = db;
    this.enabled = getSetting(db, "auto_sync_enabled") === "true";
    // Clamp on load the same way `setIntervalMs` clamps on write — a stored
    // value from an older build, a migration, or a hand-edited DB must not
    // schedule an out-of-range (e.g. sub-minute) tick.
    this.intervalMs = clampInterval(
      parseInt(getSetting(db, "auto_sync_interval_ms") ?? "", 10) ||
        DEFAULT_INTERVAL_MS,
    );
    this.lastSyncedAt = getSetting(db, "auto_sync_last_synced_at") ?? null;

    if (this.enabled) {
      this.scheduleInterval();
      // Catch up shortly after launch when a sync is overdue — never synced, or
      // the app was closed for longer than an interval. Without this the first
      // tick waits a full interval, so short sessions never auto-sync at all.
      // Cleared by `clearInterval()` if the scheduler stops or is reconfigured
      // before it fires; the `running` guard keeps it from overlapping a tick.
      if (this.isSyncOverdue()) {
        this.startupHandle = setTimeout(
          () => void this.tick(),
          STARTUP_SYNC_DELAY_MS,
        );
      }
    }
  }

  private isSyncOverdue(): boolean {
    if (!this.lastSyncedAt) return true;
    const last = Date.parse(this.lastSyncedAt);
    if (Number.isNaN(last)) return true;
    return Date.now() - last >= this.intervalMs;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (!this.db) return;
    this.enabled = enabled;
    upsertSetting(this.db, "auto_sync_enabled", String(enabled));

    if (enabled) {
      this.scheduleInterval();
    } else {
      // Not just descheduling: a tick already running keeps making billable API
      // calls until it is told to stop. Abort it the way `stop()` does, but leave
      // `this.db` in place so the scheduler can be re-enabled later. The
      // `AUTO_SYNC_DISABLED` reason tells the outcome recorder this interruption
      // is not a per-source cancellation, so the in-flight source keeps its prior
      // status instead of flipping to "canceled".
      this.clearInterval();
      this.abortCurrentTick(AUTO_SYNC_DISABLED);
    }
  }

  setIntervalMs(ms: number): void {
    if (!this.db) return;
    const clamped = clampInterval(ms);
    this.intervalMs = clamped;
    upsertSetting(this.db, "auto_sync_interval_ms", String(clamped));

    if (this.enabled) {
      this.clearInterval();
      this.scheduleInterval();
    }
  }

  stop(): void {
    this.clearInterval();
    this.abortCurrentTick();
    this.db = null;
  }

  /**
   * Aborts the in-flight tick (and, via the tick's abort listener, every
   * per-source controller) and retires its generation, without touching the
   * interval or `this.db`. Shared by `stop()` and `setEnabled(false)`.
   *
   * `running` used to stay true for the whole unwind window, which had two
   * consequences: `getState().syncing` lied, and a `start()` inside that window
   * hit `if (this.running) return` and silently skipped its first tick. The
   * scheduler is stopped the moment it is told to stop; the tick that is still
   * unwinding belongs to the previous generation now.
   */
  private abortCurrentTick(reason?: unknown): void {
    this.abortController?.abort(reason);
    this.abortController = null;
    this.running = false;
    this.generation++;
  }

  getState(): SchedulerState {
    return {
      enabled: this.enabled,
      intervalMs: this.intervalMs,
      lastSyncedAt: this.lastSyncedAt,
      syncing: this.running,
    };
  }

  private scheduleInterval(): void {
    this.clearInterval();
    this.intervalHandle = setInterval(() => void this.tick(), this.intervalMs);
  }

  private clearInterval(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    // The startup catch-up shares this teardown so stopping or reconfiguring the
    // scheduler cancels a pending catch-up that has not fired yet.
    if (this.startupHandle) {
      clearTimeout(this.startupHandle);
      this.startupHandle = null;
    }
  }

  private async tick(): Promise<void> {
    // Captured once. `stop()` nulls `this.db` while we are awaiting, and every
    // `this.db!` below would then hand `null` to `getConnectorForSource` and
    // report a bogus "Auto-sync failed" for every remaining source.
    const db = this.db;
    if (this.running || !db) return;
    this.running = true;
    this.abortController = new AbortController();
    const { signal } = this.abortController;
    const gen = this.generation;
    let anySuccess = false;

    try {
      const sources = getAllSources(db);
      const embedConfig = buildEmbedConfig(db);

      for (const source of sources) {
        // `signal.aborted` covers a stop that reached us; `gen` covers a
        // stop-then-start, where a *new* controller has replaced ours and the
        // old signal will never fire again.
        if (signal.aborted || gen !== this.generation) break;
        if (activeSyncs.has(source.id)) continue;
        // The snapshot from `getAllSources` above can go stale mid-tick: a
        // source removed while an earlier source in this same tick was
        // syncing is still in `sources`, and syncing it anyway means a full
        // wasted provider fetch whose per-document writes then fail on a
        // vanished foreign key — swallowed, but not free, and not honest
        // telemetry either.
        if (!getSourceById(db, source.id)) continue;

        const { controller, finish, startedAt } = registerSync(source.id);
        // Bridge the tick's master signal onto this source, propagating the
        // abort *reason* so a "disabled" stop stays distinguishable from a user
        // cancel. Removed as soon as the source finishes, so listeners don't
        // pile up on the tick signal across a many-source run.
        const onTickAbort = (): void => controller.abort(signal.reason);
        signal.addEventListener("abort", onTickAbort, { once: true });

        try {
          const succeeded = await runManagedSync(
            db,
            source,
            embedConfig,
            controller,
            finish,
            startedAt,
            {
              trigger: "auto",
              onError: (err) => {
                console.error(`Auto-sync failed for source ${source.id}:`, err);
              },
            },
          );
          if (succeeded) anySuccess = true;
        } finally {
          signal.removeEventListener("abort", onTickAbort);
        }
      }
    } catch (err) {
      // The per-source path records its own outcome; this catches a failure in
      // the pre-loop setup (`getAllSources`, or `buildEmbedConfig` — which throws
      // when the OS keychain is unavailable) so it cannot escape as an unhandled
      // rejection out of the un-awaited interval/startup callback and repeat.
      console.error("Auto-sync tick failed:", err);
    } finally {
      // A tick from a previous generation owns none of this any more. `stop()`
      // already set `running = false`, and a tick that started after us may now
      // own `abortController` — nulling it here would make the live tick
      // un-abortable. `db` is the one we captured, which `stop()` has since
      // released, so we must not write through it either.
      if (gen === this.generation) {
        if (anySuccess) {
          this.lastSyncedAt = new Date().toISOString();
          upsertSetting(db, "auto_sync_last_synced_at", this.lastSyncedAt);
        }
        this.running = false;
        this.abortController = null;
      }
    }
  }
}

export const syncScheduler = new SyncScheduler();

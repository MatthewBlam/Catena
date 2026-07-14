import type Database from "better-sqlite3";
import { getAllSources, getSetting, upsertSetting } from "../db/database";
import {
  activeSyncs,
  broadcastSourcesChanged,
  buildEmbedConfig,
  getConnectorForSource,
  publishSyncProgress,
  recordSyncOutcome,
  registerSync,
  type SyncOutcomeInput,
} from "../ipc/sync-handlers";
import { syncSource } from "./sync-manager";
import type { SchedulerState } from "../../shared/types";
import { track } from "../telemetry/posthog";

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

class SyncScheduler {
  private db: Database.Database | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
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
    this.intervalMs =
      parseInt(getSetting(db, "auto_sync_interval_ms") ?? "", 10) ||
      DEFAULT_INTERVAL_MS;
    this.lastSyncedAt = getSetting(db, "auto_sync_last_synced_at") ?? null;

    if (this.enabled) {
      this.scheduleInterval();
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (!this.db) return;
    this.enabled = enabled;
    upsertSetting(this.db, "auto_sync_enabled", String(enabled));

    if (enabled) {
      this.scheduleInterval();
    } else {
      this.clearInterval();
    }
  }

  setIntervalMs(ms: number): void {
    if (!this.db) return;
    const clamped = Math.max(60_000, Math.min(ms, 24 * 60 * 60_000));
    this.intervalMs = clamped;
    upsertSetting(this.db, "auto_sync_interval_ms", String(clamped));

    if (this.enabled) {
      this.clearInterval();
      this.scheduleInterval();
    }
  }

  stop(): void {
    this.clearInterval();
    this.abortController?.abort();
    this.abortController = null;
    this.db = null;

    // `running` used to stay true for the whole unwind window, which had two
    // consequences: `getState().syncing` lied, and a `start()` inside that
    // window hit `if (this.running) return` and silently skipped its first
    // tick. The scheduler is stopped the moment it is told to stop; the tick
    // that is still unwinding belongs to the previous generation now.
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
    this.intervalHandle = setInterval(() => this.tick(), this.intervalMs);
  }

  private clearInterval(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
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

        const { controller, finish } = registerSync(source.id);
        signal.addEventListener("abort", () => controller.abort(), {
          once: true,
        });

        const syncStart = Date.now();
        const syncState: SyncOutcomeInput = {
          lastProgress: null,
          thrown: undefined,
        };

        track("commons_sync_started", {
          source_provider: source.provider,
          trigger: "auto",
        });

        try {
          const connector = await getConnectorForSource(db, source);
          await syncSource(
            db,
            source.id,
            source.provider,
            connector,
            embedConfig,
            (progress) => {
              syncState.lastProgress = progress;
              publishSyncProgress(progress);
            },
            controller.signal,
          );
          anySuccess = true;
        } catch (err) {
          syncState.thrown = err;
          console.error(`Auto-sync failed for source ${source.id}:`, err);
        } finally {
          // `finish` resolves the promise `cancelSync` is blocked on, so it has
          // to run even if anything here throws.
          try {
            recordSyncOutcome(
              db,
              source.id,
              syncState,
              controller.signal.aborted,
            );
            track("commons_sync_completed", {
              source_provider: source.provider,
              trigger: "auto",
              duration_ms: Date.now() - syncStart,
              doc_count: syncState.lastProgress?.current ?? 0,
              skipped_count: syncState.lastProgress?.skipped ?? 0,
              error_count: syncState.lastProgress?.errors.length ?? 0,
              phase: syncState.thrown !== undefined ? "error" : "done",
              embedding_provider: embedConfig.provider,
            });
          } catch (err) {
            // Best-effort bookkeeping. On quit the database is closed without
            // waiting for this unwind, and the tick is a floating promise — an
            // epilogue that throws here becomes an unhandled rejection.
            console.error(
              `Failed to record sync outcome for source ${source.id}:`,
              err,
            );
          } finally {
            finish();
            broadcastSourcesChanged();
          }
        }
      }
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

import { BrowserWindow } from "electron";
import type Database from "better-sqlite3";
import { getAllSources, getSetting, upsertSetting } from "../db/database";
import {
  activeSyncs,
  buildEmbedConfig,
  getConnectorForSource,
  recordSyncOutcome,
  registerSync,
  type SyncOutcomeInput,
} from "../ipc/sync-handlers";
import { syncSource } from "./sync-manager";
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

  start(db: Database.Database): void {
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
  }

  getState(): {
    enabled: boolean;
    intervalMs: number;
    lastSyncedAt: string | null;
    syncing: boolean;
  } {
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
    let anySuccess = false;

    try {
      const sources = getAllSources(db);
      const embedConfig = buildEmbedConfig(db);

      for (const source of sources) {
        if (signal.aborted) break;
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
          const sender = BrowserWindow.getAllWindows()[0]?.webContents;
          await syncSource(
            db,
            source.id,
            source.provider,
            connector,
            embedConfig,
            (progress) => {
              syncState.lastProgress = progress;
              try {
                sender?.send("sync:progress", progress);
              } catch {
                // sender destroyed
              }
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
          } finally {
            finish();
          }
        }
      }
    } finally {
      if (anySuccess) {
        this.lastSyncedAt = new Date().toISOString();
        upsertSetting(db, "auto_sync_last_synced_at", this.lastSyncedAt);
      }
      this.running = false;
      this.abortController = null;
    }
  }
}

export const syncScheduler = new SyncScheduler();

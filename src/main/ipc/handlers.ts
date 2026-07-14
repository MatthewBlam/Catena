import { app, ipcMain, shell } from "electron";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { getDb } from "../db/singleton";
import { saveSecret, loadSecret, deleteSecret } from "../auth/storage";
import {
  getSetting,
  upsertSetting,
  getAllSourcesWithCounts,
  insertSource,
  deleteSource,
  getSourceById,
  getSourceByProviderAndRoot,
  getDocumentsBySourceId,
  getStorageStats,
  clearAllData,
  getEmbeddingHealth,
  getChunkCountByModel,
} from "../db/database";
import { search } from "../search/searcher";
import { startNotionOAuth, cancelNotionOAuth } from "../auth/notion-oauth";
import { listNotionItems } from "../connectors/notion";
import {
  startGoogleOAuth,
  cancelGoogleOAuth,
  getAuthenticatedClient,
  refreshIfNeeded,
} from "../auth/google-oauth";
import { listDriveItems } from "../connectors/drive";
import { getEmbeddingModelName } from "../search/embedder";
import type { EmbedConfig } from "../search/embedder";
import type { SourceConfig } from "../../shared/types";
import {
  cancelSync,
  cancelAllSyncs,
  buildEmbedConfig,
  broadcastSourcesChanged,
  getActiveSyncProgress,
} from "./sync-handlers";
import { syncScheduler } from "../sync/scheduler";
import {
  track,
  initTelemetry,
  isTelemetryEnabled,
  setTelemetryEnabled,
} from "../telemetry/posthog";

const ALLOWED_SECRET_KEYS = new Set([
  "cohere_api_key",
  "notion_token",
  "google_tokens",
]);

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * The in-flight search per renderer, so a new query can supersede the one it
 * replaced. Keyed by `event.sender.id` rather than held as a single global: two
 * windows search independently, and one must never cancel the other.
 */
const activeSearches = new Map<number, AbortController>();

export function registerIpcHandlers(): void {
  ipcMain.handle("secrets:save", (_, key: string, value: string) => {
    if (!ALLOWED_SECRET_KEYS.has(key))
      throw new Error(`Unknown secret key: ${key}`);
    saveSecret(getDb(), key, value);
  });

  ipcMain.handle("secrets:load", (_, key: string) => {
    if (!ALLOWED_SECRET_KEYS.has(key))
      throw new Error(`Unknown secret key: ${key}`);
    return loadSecret(getDb(), key);
  });

  ipcMain.handle("secrets:delete", (_, key: string) => {
    if (!ALLOWED_SECRET_KEYS.has(key))
      throw new Error(`Unknown secret key: ${key}`);
    deleteSecret(getDb(), key);
  });

  ipcMain.handle("secrets:has", (_, key: string) => {
    if (!ALLOWED_SECRET_KEYS.has(key))
      throw new Error(`Unknown secret key: ${key}`);
    return loadSecret(getDb(), key) !== null;
  });

  ipcMain.handle("auth:validate-cohere", async (_, apiKey: string) => {
    try {
      const res = await fetch("https://api.cohere.com/v2/embed", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "embed-v4.0",
          texts: ["test"],
          input_type: "search_query",
          embedding_types: ["float"],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      return { valid: res.ok };
    } catch {
      return { valid: false };
    }
  });

  ipcMain.handle("auth:check-ollama", async () => {
    try {
      const res = await fetch("http://localhost:11434/api/tags", {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { available: false, models: [] };
      const data = (await res.json()) as { models?: { name: string }[] };
      return { available: true, models: data.models?.map((m) => m.name) ?? [] };
    } catch {
      return { available: false, models: [] };
    }
  });

  ipcMain.handle("settings:get-embedding-provider", () => {
    return getSetting(getDb(), "embedding_provider") ?? "cohere";
  });

  ipcMain.handle("settings:set-embedding-provider", (_, provider: string) => {
    if (provider !== "cohere" && provider !== "ollama") {
      throw new Error(`Invalid embedding provider: ${provider}`);
    }
    upsertSetting(getDb(), "embedding_provider", provider);
    track("commons_embedding_provider_changed", { provider });
  });

  ipcMain.handle("app:open-external", async (_, url: string) => {
    if (!isSafeUrl(url)) return;
    await shell.openExternal(url);
  });

  ipcMain.handle("auth:notion-oauth-start", async () => {
    const clientId = process.env.NOTION_CLIENT_ID;
    const clientSecret = process.env.NOTION_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error(
        "Notion OAuth credentials not configured. Set NOTION_CLIENT_ID and NOTION_CLIENT_SECRET environment variables.",
      );
    }
    const result = await startNotionOAuth(clientId, clientSecret);
    saveSecret(getDb(), "notion_token", result.accessToken);
    return { workspaceName: result.workspaceName };
  });

  ipcMain.handle("auth:notion-oauth-cancel", () => {
    cancelNotionOAuth();
  });

  ipcMain.handle("notion:list-pages", async () => {
    const token = loadSecret(getDb(), "notion_token");
    if (!token)
      throw new Error("Notion is not connected. Please authenticate first.");
    return listNotionItems(token);
  });

  ipcMain.handle("auth:google-oauth-start", async () => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error(
        "Google OAuth credentials not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables.",
      );
    }
    const result = await startGoogleOAuth(clientId, clientSecret, getDb());
    return { email: result.email };
  });

  ipcMain.handle("auth:google-oauth-cancel", () => {
    cancelGoogleOAuth();
  });

  ipcMain.handle("drive:list-items", async (_, parentId?: string) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error(
        "Google OAuth credentials not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables.",
      );
    }
    const db = getDb();
    const client = getAuthenticatedClient(db, clientId, clientSecret);
    await refreshIfNeeded(client, db);
    return listDriveItems(client, parentId);
  });

  ipcMain.handle("search:query", async (event, query: string) => {
    const senderId = event.sender.id;

    // A new query supersedes the old one. Keyed by sender, not globally, so one
    // window searching does not cancel another's.
    activeSearches.get(senderId)?.abort();
    const controller = new AbortController();
    activeSearches.set(senderId, controller);

    const db = getDb();
    const embedConfig = buildEmbedConfig(db);
    const startMs = Date.now();

    try {
      const response = await search(db, query, embedConfig, {
        signal: controller.signal,
      });
      track("commons_search_executed", {
        result_count: response.results.length,
        rerank_failed: response.rerankFailed,
        query_rewritten: !!response.rewrittenQuery,
        embedding_provider: embedConfig.provider,
        duration_ms: Date.now() - startMs,
      });
      return response;
    } catch (err) {
      // Resolve rather than reject: an Error's `name` does not survive IPC, so a
      // rejecting abort is indistinguishable from a real failure and the renderer
      // would show an error banner for a query the user themselves replaced.
      // No `track` either — a cancelled search never ran, and counting it would
      // post a 0-result search event for every superseded keystroke.
      if (controller.signal.aborted) {
        return { results: [], rerankFailed: false, cancelled: true };
      }
      throw err;
    } finally {
      // Only if we still own the entry. A superseding query has already installed
      // its own controller, and deleting that would leave it uncancellable.
      if (activeSearches.get(senderId) === controller) {
        activeSearches.delete(senderId);
      }
    }
  });

  ipcMain.handle("search:cancel", (event) => {
    activeSearches.get(event.sender.id)?.abort();
  });

  ipcMain.handle("sources:list", () => {
    return getAllSourcesWithCounts(getDb());
  });

  // Lives here, not in sync-handlers, purely to avoid an import cycle:
  // scheduler.ts already imports from sync-handlers.ts, so sync-handlers.ts
  // cannot import the scheduler back. This module already depends on both.
  ipcMain.handle("sync:get-active", () => {
    return {
      active: getActiveSyncProgress(),
      scheduler: syncScheduler.getState(),
    };
  });

  ipcMain.handle("documents:list-by-source", (_, sourceId: string) => {
    return getDocumentsBySourceId(getDb(), sourceId);
  });

  ipcMain.handle("sources:add", (_, config: SourceConfig) => {
    const db = getDb();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const provider = config.provider === "notion" ? "notion" : "google_drive";
    const rootExternalId =
      config.provider === "notion" ? config.rootPageId : config.folderId;
    if (getSourceByProviderAndRoot(db, provider, rootExternalId)) {
      throw new Error("This source is already connected.");
    }

    if (config.provider === "notion") {
      insertSource(db, {
        id,
        provider: "notion",
        name: config.name,
        rootExternalId: config.rootPageId,
        createdAt: now,
      });
    } else {
      insertSource(db, {
        id,
        provider: "google_drive",
        name: config.folderName,
        rootExternalId: config.folderId,
        createdAt: now,
      });
    }

    track("commons_source_added", { source_provider: provider });
    broadcastSourcesChanged();

    // Read it back rather than reconstructing it: the row carries sync-state
    // columns now, and a hand-built object would quietly omit them.
    return getSourceById(db, id);
  });

  ipcMain.handle("sources:remove", async (_, id: string) => {
    const db = getDb();
    const source = getSourceById(db, id);
    // Aborting is cooperative: it asks the sync to stop, it does not stop it.
    // Deleting the source row while the sync is still inserting documents into
    // it hits a dangling foreign key, so wait for the unwind to finish first.
    await cancelSync(id);
    deleteSource(db, id);
    broadcastSourcesChanged();
    if (source) {
      track("commons_source_removed", { source_provider: source.provider });
    }
  });

  ipcMain.handle("app:storage-stats", async () => {
    const db = getDb();
    const stats = getStorageStats(db);
    const dbPath = join(app.getPath("userData"), "commons.db");
    let dbSizeBytes = 0;
    try {
      dbSizeBytes = (await stat(dbPath)).size;
    } catch {
      // file may not exist yet
    }
    return { ...stats, dbSizeBytes };
  });

  ipcMain.handle("app:clear-all-data", async () => {
    track("commons_data_cleared");

    // Order matters. `cancelAllSyncs` only waits for the syncs that are running
    // *right now*, and the scheduler works through its sources one at a time —
    // so a live tick would start the next source's sync while we wait for the
    // current one, and we would wipe the database out from under it. Stopping
    // the scheduler first closes that window: `tick` re-checks its abort signal
    // before each source, with no `await` between the check and registration.
    syncScheduler.stop();
    await cancelAllSyncs();

    const db = getDb();
    clearAllData(db);
    initTelemetry(db);

    // `clearAllData` just wiped the `auto_sync_*` settings; the stopped
    // scheduler is still holding the old values in memory.
    syncScheduler.start(db);

    // Every source is gone. Not in the plan's list, but the renderer's copy of
    // `sources:list` is exactly as stale here as it is after a single removal.
    broadcastSourcesChanged();
  });

  ipcMain.handle("embedding:health", () => {
    const db = getDb();
    const health = getEmbeddingHealth(db);
    const provider = (getSetting(db, "embedding_provider") ?? "cohere") as
      | "cohere"
      | "ollama";
    const embedConfig: EmbedConfig = {
      provider,
      ollamaModel: getSetting(db, "ollama_model") ?? undefined,
    };
    const currentModel = getEmbeddingModelName(embedConfig);

    const matchedCount = health.distinctModels.includes(currentModel)
      ? getChunkCountByModel(db, currentModel)
      : 0;
    const mismatchedChunks = health.totalChunks - matchedCount;

    return {
      provider,
      model: currentModel,
      mismatchedChunks,
      totalChunks: health.totalChunks,
    };
  });

  ipcMain.handle("settings:get-auto-sync", () => {
    return syncScheduler.getState();
  });

  ipcMain.handle(
    "settings:set-auto-sync-enabled",
    async (_, enabled: boolean) => {
      await syncScheduler.setEnabled(enabled);
      track("commons_auto_sync_toggled", { enabled });
    },
  );

  ipcMain.handle("settings:set-auto-sync-interval", (_, ms: number) => {
    syncScheduler.setIntervalMs(ms);
  });

  ipcMain.handle("settings:get-telemetry-enabled", () => {
    return isTelemetryEnabled();
  });

  ipcMain.handle("settings:set-telemetry-enabled", (_, enabled: boolean) => {
    setTelemetryEnabled(getDb(), enabled);
  });
}

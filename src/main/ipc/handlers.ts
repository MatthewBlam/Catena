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
  listRecentSearches,
  getRecentSearchById,
  deleteRecentSearch,
  pruneExpiredRecentSearches,
  saveRecentSearchFromResponse,
  getChunksByIds,
  updateRecentSearchAnswer,
} from "../db/database";
import { search } from "../search/searcher";
import {
  generateAnswer,
  COHERE_ANSWER_MODEL,
  DEFAULT_OLLAMA_CHAT_MODEL,
  type AnswerDoc,
} from "../search/answerer";
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
import type {
  SourceConfig,
  AnswerRequest,
  AnswerCancelReason,
} from "../../shared/types";
import {
  cancelSync,
  cancelAllSyncs,
  buildEmbedConfig,
  broadcastSourcesChanged,
  broadcastRecentsChanged,
  getActiveSyncProgress,
  setClearingAllData,
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

/**
 * One in-flight answer generation: its abort handle plus the timings and shape
 * telemetry needs. The cancel handler reports on a generation it did not start,
 * so what would otherwise be locals of the generate handler live here instead.
 */
interface AnswerRun {
  controller: AbortController;
  startMs: number;
  /** Ms from request to the first streamed token — the *perceived* latency, unlike
   *  the end-to-end duration. Null while nothing has streamed yet. */
  firstTokenMs: number | null;
  /** Characters streamed so far, so a cancel can say how much the user had seen. */
  streamedChars: number;
  /** The chat model actually used, resolved once at request time. */
  model: string;
  provider: string;
  docCount: number;
  retry: boolean;
}

/**
 * The in-flight answer generation per renderer, mirroring `activeSearches`. A new
 * generation (or a search/restore that supersedes one) aborts the prior. Kept
 * separate from `activeSearches` so cancelling an answer never touches a search
 * and vice versa.
 */
const activeAnswers = new Map<number, AnswerRun>();

/** The chat model an answer will be generated with, for the current provider. */
function resolveAnswerModel(
  db: ReturnType<typeof getDb>,
  provider: string,
): string {
  if (provider === "cohere") return COHERE_ANSWER_MODEL;
  return (
    (getSetting(db, "ollama_chat_model") as string) || DEFAULT_OLLAMA_CHAT_MODEL
  );
}

export function registerIpcHandlers(): void {
  ipcMain.handle("secrets:save", (_, key: string, value: string) => {
    if (!ALLOWED_SECRET_KEYS.has(key))
      throw new Error(`Unknown secret key: ${key}`);
    saveSecret(getDb(), key, value);
  });

  // No `secrets:load` channel (H10). A renderer that can ask for a secret's
  // plaintext will eventually be made to; every caller only wanted `secrets:has`.
  // `loadSecret` stays available to main, which genuinely needs the values.

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
    track("catena_embedding_provider_changed", { provider });
  });

  ipcMain.handle("app:open-external", async (_, url: string) => {
    if (!isSafeUrl(url)) return;
    await shell.openExternal(url);
  });

  ipcMain.handle("auth:notion-oauth-start", async () => {
    const clientId = process.env.NOTION_CLIENT_ID;
    // The client *secret* is deliberately not here. It lives in the Worker at
    // NOTION_TOKEN_PROXY_URL, which is the only party that can exchange a code.
    const tokenProxyUrl = process.env.NOTION_TOKEN_PROXY_URL;
    if (!clientId || !tokenProxyUrl) {
      throw new Error(
        "Notion OAuth is not configured. Set NOTION_CLIENT_ID and NOTION_TOKEN_PROXY_URL (see worker/README.md).",
      );
    }
    const result = await startNotionOAuth(clientId, tokenProxyUrl);
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
      track("catena_search_executed", {
        result_count: response.results.length,
        rerank_failed: response.rerankFailed,
        query_rewritten: !!response.rewrittenQuery,
        embedding_provider: embedConfig.provider,
        duration_ms: Date.now() - startMs,
      });
      if (
        !controller.signal.aborted &&
        saveRecentSearchFromResponse(db, query, response)
      ) {
        broadcastRecentsChanged();
      }
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

  ipcMain.handle("answer:generate", async (event, request: AnswerRequest) => {
    const senderId = event.sender.id;

    // A new generation supersedes the old one, per renderer (see activeSearches).
    // No cancellation event for the one it replaced: the app abandoned that work,
    // the user did not (see the `answer:cancel` handler).
    activeAnswers.get(senderId)?.controller.abort();
    const controller = new AbortController();

    const db = getDb();
    const embedConfig = buildEmbedConfig(db);
    const model = resolveAnswerModel(db, embedConfig.provider);
    const startMs = Date.now();
    const run: AnswerRun = {
      controller,
      startMs,
      firstTokenMs: null,
      streamedChars: 0,
      model,
      provider: embedConfig.provider,
      docCount: request.docs.length,
      retry: request.retry === true,
    };
    activeAnswers.set(senderId, run);

    // Fired before the work, not after it, so the funnel has a denominator: every
    // completion event has a matching request, and requests without one are the
    // generations that were stopped, superseded, or lost to a crash.
    track("catena_answer_requested", {
      embedding_provider: run.provider,
      answer_model: run.model,
      doc_count: run.docCount,
      retry: run.retry,
    });

    try {
      // Re-fetch authoritative chunk text + heading by id; titles ride along on
      // the request so we avoid a chunk→document join and a second copy of the
      // full text across the bridge. The heading (the chunk's section name) is
      // load-bearing: it is stripped from the chunk text at ingest, so without it
      // every chunk of one document looks identically titled and the model
      // conflates sections. Preserve the renderer's (score/display) order,
      // dropping any chunk that was removed since the search.
      const chunkIds = request.docs.map((d) => d.chunkId);
      const titleById = new Map(
        request.docs.map((d) => [d.chunkId, d.documentTitle]),
      );
      const chunkById = new Map(
        getChunksByIds(db, chunkIds).map((c) => [c.id, c]),
      );
      const docs: AnswerDoc[] = chunkIds
        .filter((id) => chunkById.has(id))
        .map((id) => {
          const chunk = chunkById.get(id)!;
          return {
            chunkId: id,
            title: titleById.get(id) ?? "",
            heading: chunk.heading,
            text: chunk.text,
          };
        });

      const response = await generateAnswer(request.query, docs, embedConfig, {
        signal: controller.signal,
        // Straight to the requesting renderer, not a broadcast: an answer belongs
        // to one window, and `requestId` is only unique within a renderer. (Sync
        // progress broadcasts because a sync is global; an answer is not.) The
        // window can tear down mid-stream, so guard the send.
        onDelta: (delta) => {
          if (run.firstTokenMs === null)
            run.firstTokenMs = Date.now() - startMs;
          run.streamedChars += delta.length;
          if (!event.sender.isDestroyed()) {
            event.sender.send("answer:delta", {
              requestId: request.requestId,
              delta,
            });
          }
        },
        // Resolved above so telemetry can name the model; the Cohere path has its
        // own constant and ignores this, so only pass it where it means something.
        ollamaChatModel: embedConfig.provider === "ollama" ? model : undefined,
      });

      // Persist only a real, completed answer: never a cancelled one (the user
      // stopped it) or a failed/degraded one (nothing worth restoring).
      if (!response.cancelled && !response.errorKind) {
        updateRecentSearchAnswer(db, request.query, {
          text: response.text,
          citations: response.citations,
        });
      }

      // No event for a cancelled generation — like a superseded search, it never
      // really ran, and `answer:cancel` reports the user-initiated case itself.
      // Never the query or answer text, only shape.
      if (!response.cancelled) {
        track("catena_answer_generated", {
          embedding_provider: run.provider,
          answer_model: run.model,
          duration_ms: Date.now() - startMs,
          // Time to the first streamed token — what the user experiences as the
          // wait. Null when nothing ever streamed (every failure path).
          first_token_ms: run.firstTokenMs,
          answer_chars: response.text.length,
          citation_count: response.citations.length,
          error_kind: response.errorKind ?? null,
          failure_reason: response.failureReason ?? null,
          retry: run.retry,
          // Chunks the renderer asked to ground on vs. what survived the re-fetch.
          // A non-zero drop means results on screen were deleted since the search,
          // so the answer is grounded on less than the user is looking at.
          doc_count: run.docCount,
          docs_dropped: run.docCount - docs.length,
        });
      }

      return response;
    } finally {
      // Only if we still own the entry — a superseding generation has already
      // installed its own run, which must stay cancellable.
      if (activeAnswers.get(senderId) === run) {
        activeAnswers.delete(senderId);
      }
    }
  });

  ipcMain.handle(
    "answer:cancel",
    (event, reason: AnswerCancelReason = "superseded") => {
      const run = activeAnswers.get(event.sender.id);
      if (!run) return;
      run.controller.abort();

      // Only a user pressing Stop is worth an event; the app superseding its own
      // work is not a user action (see AnswerCancelReason). Dropping the entry
      // here also makes this idempotent — a second cancel finds nothing to report.
      if (reason === "user_stop") {
        activeAnswers.delete(event.sender.id);
        track("catena_answer_cancelled", {
          embedding_provider: run.provider,
          answer_model: run.model,
          doc_count: run.docCount,
          retry: run.retry,
          elapsed_ms: Date.now() - run.startMs,
          first_token_ms: run.firstTokenMs,
          streamed_chars: run.streamedChars,
          // Stopped before ever seeing a token vs. mid-answer — one is impatience
          // with the wait, the other a judgement on the answer itself.
          streamed: run.firstTokenMs !== null,
        });
      }
    },
  );

  // A narrow channel rather than a general "track anything" bridge: the renderer
  // can report this one interaction, and cannot invent events or properties.
  // Position is the citation's 1-based rank in the result list — no title, no URL.
  ipcMain.handle("answer:citation-opened", (_, position: number) => {
    if (!Number.isInteger(position) || position < 1) return;
    track("catena_answer_citation_opened", { position });
  });

  ipcMain.handle("recents:list", () => {
    const db = getDb();
    // Lazy prune: the list can never serve expired rows.
    pruneExpiredRecentSearches(db);
    return listRecentSearches(db);
  });

  ipcMain.handle("recents:get", (_, id: string) => {
    if (!id) throw new Error("id is required");
    return getRecentSearchById(getDb(), id);
  });

  ipcMain.handle("recents:delete", (_, id: string) => {
    if (!id) throw new Error("id is required");
    // Only broadcast when a row actually went away, so a delete of an
    // already-gone id doesn't make every window refetch for nothing.
    if (deleteRecentSearch(getDb(), id) > 0) broadcastRecentsChanged();
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

    track("catena_source_added", { source_provider: provider });
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
      track("catena_source_removed", { source_provider: source.provider });
    }
  });

  ipcMain.handle("app:storage-stats", async () => {
    const db = getDb();
    const stats = getStorageStats(db);
    const dbPath = join(app.getPath("userData"), "catena.db");
    let dbSizeBytes = 0;
    try {
      dbSizeBytes = (await stat(dbPath)).size;
    } catch {
      // file may not exist yet
    }
    return { ...stats, dbSizeBytes };
  });

  ipcMain.handle("app:clear-all-data", async () => {
    track("catena_data_cleared");

    // Order matters. `cancelAllSyncs` only waits for the syncs that are running
    // *right now*, and the scheduler works through its sources one at a time —
    // so a live tick would start the next source's sync while we wait for the
    // current one, and we would wipe the database out from under it. Stopping
    // the scheduler first closes that window: `tick` re-checks its abort signal
    // before each source, with no `await` between the check and registration.
    //
    // The flag closes the *other* window: a renderer-dispatched `sync:start`
    // landing during the awaited `cancelAllSyncs` would register a brand-new
    // sync against the DB we are about to wipe. Blocked here, cleared in the
    // `finally` once the scheduler is back up.
    setClearingAllData(true);
    try {
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
      broadcastRecentsChanged();
    } finally {
      setClearingAllData(false);
    }
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
      track("catena_auto_sync_toggled", { enabled });
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

  // Onboarding writes the provider secret the moment a key validates, so
  // presence of a key can't distinguish "finished the wizard" from "quit
  // halfway." This explicit flag is the gate App uses. Cleared on clearAllData
  // (it isn't in PRESERVED_SETTING_KEYS) — but a wipe also drops the secret, so
  // the wizard reappears on the next launch either way.
  ipcMain.handle("settings:get-onboarding-complete", () => {
    return getSetting(getDb(), "onboarding_complete") === "true";
  });

  ipcMain.handle("settings:set-onboarding-complete", () => {
    upsertSetting(getDb(), "onboarding_complete", "true");
  });
}

import { app, ipcMain, shell } from "electron";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { getDb } from "../db/singleton";
import { saveSecret, loadSecret, deleteSecret } from "../auth/storage";
import {
  getSetting,
  upsertSetting,
  deleteSetting,
  getAllSources,
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
import { listNotionItems, checkNotionPageAccess } from "../connectors/notion";
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
  NotionOAuthStarted,
  GoogleOAuthStarted,
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

/**
 * Which Notion workspace the stored token belongs to. Plain settings rather than
 * secrets: a workspace id and name are identifiers, not credentials.
 */
const NOTION_WORKSPACE_ID_KEY = "notion_workspace_id";
const NOTION_WORKSPACE_NAME_KEY = "notion_workspace_name";

/** Which Google account the stored Drive tokens belong to. Not a credential. */
const GOOGLE_ACCOUNT_EMAIL_KEY = "google_account_email";

interface PendingNotionAuth {
  accessToken: string;
  workspaceId: string | null;
  workspaceName: string;
}

/**
 * A freshly obtained Notion token that has *not* been stored, because taking it
 * would point the app at a different workspace than every existing Notion source
 * belongs to. Held here until the renderer resolves the choice, so the working
 * connection survives a re-auth the user did not mean to make.
 *
 * Deliberately in-memory: if the app dies with a switch unresolved, the pending
 * token dies with it and the old one is still stored. Failing closed is correct —
 * the fallback is "nothing changed".
 */
let pendingNotionAuth: PendingNotionAuth | null = null;

/**
 * Notion ids are UUIDs, and the codebase already normalizes them by stripping
 * dashes (see `listNotionItems`). Compare on that basis so a formatting
 * difference can never be mistaken for a different workspace — a false positive
 * here blocks the user from the very flow this feature exists to provide.
 */
function normalizeWorkspaceId(id: string | null): string | null {
  if (!id) return null;
  const normalized = id.replace(/-/g, "").toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/** Stores the token and records the workspace it came from, as one step. */
function commitNotionAuth(
  db: ReturnType<typeof getDb>,
  auth: PendingNotionAuth,
): void {
  saveSecret(db, "notion_token", auth.accessToken);
  if (auth.workspaceId) {
    upsertSetting(db, NOTION_WORKSPACE_ID_KEY, auth.workspaceId);
  } else {
    // Unknown workspace: clear rather than keep the previous id, which describes
    // a token we just replaced and would compare against the wrong thing.
    deleteSetting(db, NOTION_WORKSPACE_ID_KEY);
  }
  upsertSetting(db, NOTION_WORKSPACE_NAME_KEY, auth.workspaceName);
}

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
    const db = getDb();
    deleteSecret(db, key);

    // The recorded workspace describes the token that just went away. Left
    // behind, it would make the next *fresh* connect look like a switch away
    // from a workspace we are no longer connected to at all.
    if (key === "notion_token") {
      pendingNotionAuth = null;
      deleteSetting(db, NOTION_WORKSPACE_ID_KEY);
      deleteSetting(db, NOTION_WORKSPACE_NAME_KEY);
    }
    if (key === "google_tokens") {
      deleteSetting(db, GOOGLE_ACCOUNT_EMAIL_KEY);
    }
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

  // Runs for a first connection *and* for a re-authorization that widens which
  // pages Catena may read — Notion's picker pre-checks what is already shared, so
  // running this again is how a user adds pages they did not tick originally.
  ipcMain.handle(
    "auth:notion-oauth-start",
    async (): Promise<NotionOAuthStarted> => {
      const clientId = process.env.NOTION_CLIENT_ID;
      // The client *secret* is deliberately not here. It lives in the Worker at
      // NOTION_TOKEN_PROXY_URL, which is the only party that can exchange a code.
      const tokenProxyUrl = process.env.NOTION_TOKEN_PROXY_URL;
      if (!clientId || !tokenProxyUrl) {
        throw new Error(
          "Notion OAuth is not configured. Set NOTION_CLIENT_ID and NOTION_TOKEN_PROXY_URL (see worker/README.md).",
        );
      }

      // An earlier flow's withheld token must not outlive the flow that produced
      // it, or a later accept would commit a token the user has moved on from.
      pendingNotionAuth = null;

      const result = await startNotionOAuth(clientId, tokenProxyUrl);
      const db = getDb();
      const auth: PendingNotionAuth = {
        accessToken: result.accessToken,
        workspaceId: result.workspaceId,
        workspaceName: result.workspaceName,
      };

      const previousId = normalizeWorkspaceId(
        getSetting(db, NOTION_WORKSPACE_ID_KEY),
      );
      const nextId = normalizeWorkspaceId(result.workspaceId);
      const notionSourceCount = getAllSources(db).filter(
        (s) => s.provider === "notion",
      ).length;
      // With no token stored there is no working connection to protect — and
      // withholding one there would strand it: `ConnectNotionButton` runs OAuth
      // only in that state and ignores this result, so nothing would ever
      // resolve the switch and the user would end up connected to nothing.
      const alreadyConnected = loadSecret(db, "notion_token") !== null;

      // Interrupt only for a switch that is both provable and costly: an
      // existing connection, both workspaces known, genuinely different, and
      // sources bound to the old one. Every other case — first connect, same
      // workspace, unknown id, nothing to orphan — commits as it always did.
      if (
        alreadyConnected &&
        previousId &&
        nextId &&
        previousId !== nextId &&
        notionSourceCount > 0
      ) {
        pendingNotionAuth = auth;
        return {
          workspaceName: result.workspaceName,
          workspaceSwitch: {
            previousName: getSetting(db, NOTION_WORKSPACE_NAME_KEY) ?? "",
            nextName: result.workspaceName,
            sourceCount: notionSourceCount,
          },
        };
      }

      commitNotionAuth(db, auth);
      return { workspaceName: result.workspaceName };
    },
  );

  // Resolves the choice `auth:notion-oauth-start` deferred. Idempotent: the
  // pending token is dropped either way, so a repeated or late call is a no-op
  // rather than a second chance to commit.
  ipcMain.handle(
    "auth:notion-workspace-switch-resolve",
    (_, accept: boolean) => {
      const pending = pendingNotionAuth;
      pendingNotionAuth = null;
      if (!pending || !accept) return;
      commitNotionAuth(getDb(), pending);
    },
  );

  ipcMain.handle("auth:notion-oauth-cancel", () => {
    cancelNotionOAuth();
  });

  ipcMain.handle("notion:list-pages", async () => {
    const token = loadSecret(getDb(), "notion_token");
    if (!token)
      throw new Error("Notion is not connected. Please authenticate first.");
    return listNotionItems(token);
  });

  // Runs for a first connection *and* for a plain reconnect. Unlike Notion, a
  // reconnect here is non-destructive: the `drive.readonly` scope covers the
  // whole account, so re-authorizing the same account re-grants exactly what was
  // granted before. Only a different account is worth mentioning.
  ipcMain.handle(
    "auth:google-oauth-start",
    async (): Promise<GoogleOAuthStarted> => {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        throw new Error(
          "Google OAuth credentials not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables.",
        );
      }
      const db = getDb();
      const previousEmail = getSetting(db, GOOGLE_ACCOUNT_EMAIL_KEY);

      // `startGoogleOAuth` stores the tokens itself, so there is no withholding
      // step here as there is for Notion — this reports after the fact.
      const result = await startGoogleOAuth(clientId, clientSecret, db);
      upsertSetting(db, GOOGLE_ACCOUNT_EMAIL_KEY, result.email);

      const driveSourceCount = getAllSources(db).filter(
        (s) => s.provider === "google_drive",
      ).length;
      if (
        previousEmail &&
        previousEmail !== result.email &&
        driveSourceCount > 0
      ) {
        return {
          email: result.email,
          accountChanged: { previousEmail, sourceCount: driveSourceCount },
        };
      }
      return { email: result.email };
    },
  );

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

  // Which Notion sources the current token can no longer read. Notion's OAuth
  // picker *replaces* the granted page set rather than adding to it, so a
  // re-authorization that misses a previously-granted page silently strands
  // every source under it — the sources still look healthy here and only fail at
  // the next sync. This turns that into something nameable and recoverable.
  ipcMain.handle("notion:check-source-access", async () => {
    const db = getDb();
    const token = loadSecret(db, "notion_token");
    // No token is a disconnected app, not an orphaned one. Reporting every
    // source as lost here would be a false alarm on top of an obvious state.
    if (!token) return [];

    const notionSources = getAllSources(db).filter(
      (s) => s.provider === "notion",
    );
    if (notionSources.length === 0) return [];

    const accessible = await checkNotionPageAccess(
      token,
      notionSources.map((s) => s.rootExternalId),
    );
    return notionSources
      .filter((s) => !accessible.has(s.rootExternalId))
      .map((s) => ({ id: s.id, name: s.name }));
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

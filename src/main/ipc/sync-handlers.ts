import { ipcMain, BrowserWindow } from "electron";
import { getDb } from "../db/singleton";
import {
  getSourceById,
  updateSourceSyncState,
  type SourceRow,
  type SyncOutcome,
} from "../db/database";
import { loadSecret } from "../auth/storage";
import { getSetting } from "../db/database";
import { syncSource, type Connector } from "../sync/sync-manager";
import { NotionConnector } from "../connectors/notion";
import { DriveConnector } from "../connectors/drive";
import { getAuthenticatedClient, refreshIfNeeded } from "../auth/google-oauth";
import type { EmbedConfig } from "../search/embedder";
import type { SyncProgress } from "../../shared/types";
import { track } from "../telemetry/posthog";

export interface ActiveSync {
  controller: AbortController;
  /**
   * Resolves when the sync's `finally` has finished unwinding — never rejects.
   * Aborting is cooperative, so the abort call itself tells you nothing about
   * whether the sync has stopped touching the database. This does.
   */
  done: Promise<void>;
}

export const activeSyncs = new Map<string, ActiveSync>();

/**
 * How long a caller will wait for an aborted sync to unwind before giving up on
 * it. A sync wedged in a socket read must not wedge the UI with it; past this
 * point we proceed and accept that an in-flight write may fail against a row we
 * are about to delete (`processDocument` records that as a document error).
 */
const CANCEL_TIMEOUT_MS = 15_000;

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function withTimeout(
  promise: Promise<void>,
  ms: number,
  onTimeout: () => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    const winner = await Promise.race([
      promise.then(() => "done" as const),
      timeout,
    ]);
    if (winner === "timeout") onTimeout();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Registers a sync and returns the handle its owner must resolve on unwind.
 * Callers must call `finish()` in a `finally` — it is what `cancelSync` awaits.
 */
export function registerSync(sourceId: string): {
  controller: AbortController;
  finish: () => void;
} {
  const controller = new AbortController();
  const deferred = createDeferred();
  activeSyncs.set(sourceId, { controller, done: deferred.promise });
  return {
    controller,
    finish: () => {
      activeSyncs.delete(sourceId);
      // The end of the sync is what clears the progress entry — not a terminal
      // phase, which a sync that died in `getConnectorForSource` never emits.
      // Keying the cleanup on the phase leaked the entry, and the next sync of
      // this source would then hydrate a mounting renderer with the *previous*
      // run's progress.
      lastProgressBySource.delete(sourceId);
      deferred.resolve();
    },
  };
}

/** Aborts the sync for `sourceId` and waits for it to stop touching the DB. */
export async function cancelSync(sourceId: string): Promise<void> {
  const entry = activeSyncs.get(sourceId);
  if (!entry) return;
  entry.controller.abort();
  await withTimeout(entry.done, CANCEL_TIMEOUT_MS, () => {
    console.warn(
      `Sync for source ${sourceId} did not unwind within ${CANCEL_TIMEOUT_MS}ms; proceeding without it.`,
    );
  });
}

/**
 * Aborts every running sync and waits for all of them to unwind.
 *
 * This only covers the syncs registered *at the moment it is called*. A caller
 * that also needs the scheduler to stop launching new ones must stop the
 * scheduler first — see `app:clear-all-data`.
 */
export async function cancelAllSyncs(): Promise<void> {
  await Promise.all([...activeSyncs.keys()].map((id) => cancelSync(id)));
}

/**
 * The last progress event seen for each running sync, so a renderer that mounts
 * mid-sync can be told what it missed.
 *
 * Cleared only by `finish()` — the end of the sync. A terminal-phase event used
 * to also clear its entry here, as an optimization, but that ran in the same
 * synchronous continuation as `finish()` a few lines later, so it bought
 * nothing observable. And `getActiveSyncProgress` reads through `activeSyncs`,
 * the real authority on whether a sync is running, so nothing here is ever
 * reported after its sync — a terminal entry lingering the extra moment until
 * `finish()` runs is invisible to every reader.
 */
const lastProgressBySource = new Map<string, SyncProgress>();

function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch {
      // Window torn down between the check and the send.
    }
  }
}

/**
 * The one path progress takes to the renderer.
 *
 * It used to take two, and both were wrong: `sync:start` sent only to
 * `event.sender`, so a second window saw nothing; the scheduler resolved
 * `getAllWindows()[0]` *before* starting a sync, so a window opened during a
 * twenty-minute sync saw nothing either — and if that first window had closed,
 * progress went nowhere at all.
 */
export function publishSyncProgress(progress: SyncProgress): void {
  lastProgressBySource.set(progress.sourceId, progress);
  broadcast("sync:progress", progress);
}

/**
 * Tells every window that `sources:list` is stale.
 *
 * This is what actually closes the desync: the renderer refetches the sources —
 * which now carry `lastSyncStatus` and `lastSyncError` — instead of trying to
 * reconstruct state from a progress stream it may never have received. The
 * terminal progress event becomes an optimization, not the source of truth.
 */
export function broadcastSourcesChanged(): void {
  broadcast("sources:changed");
}

/** Progress for every sync running right now, for a renderer that just mounted. */
export function getActiveSyncProgress(): SyncProgress[] {
  return [...activeSyncs.keys()].map(
    (sourceId) =>
      // A sync that is registered but still inside `getConnectorForSource` — a
      // Google token refresh is a network round-trip — has not emitted anything
      // yet. Reporting nothing for it would let the renderer offer a "Sync"
      // button that can only fail with "sync already in progress".
      lastProgressBySource.get(sourceId) ?? {
        sourceId,
        phase: "fetching",
        current: 0,
        skipped: 0,
        total: 0,
        deleted: 0,
        currentDocTitle: null,
        errors: [],
      },
  );
}

/** Enough to diagnose the failure; not enough to turn the column into a log file. */
const MAX_STORED_ERRORS = 5;

/** What a sync's owner knows about how it went. Both call sites accumulate this. */
export interface SyncOutcomeInput {
  lastProgress: SyncProgress | null;
  /** The error that escaped the sync, if one did. */
  thrown: unknown;
}

/**
 * Records how a sync ended, from its *owner's* vantage point.
 *
 * Deliberately not inside `syncSource`: `syncSource` cannot observe a failure in
 * `getConnectorForSource` — an expired Notion token, missing Google credentials —
 * because it never gets called. That is exactly the failure a user most needs to
 * see, and in that case there is no progress object either, so the message has to
 * come from the thrown error.
 */
export function recordSyncOutcome(
  db: ReturnType<typeof getDb>,
  sourceId: string,
  outcome: SyncOutcomeInput,
  aborted: boolean,
): void {
  const thrownMessage =
    outcome.thrown === undefined
      ? null
      : outcome.thrown instanceof Error
        ? outcome.thrown.message
        : String(outcome.thrown);

  // The thrown error goes first: it is the one that explains why the rest is
  // missing. Per-document errors follow.
  const errors = [
    ...(thrownMessage ? [thrownMessage] : []),
    ...(outcome.lastProgress?.errors ?? []),
  ];

  let status: SyncOutcome;
  if (aborted) {
    // The user asked for this. It is not a failure, whatever else happened.
    status = "cancelled";
  } else if (thrownMessage !== null) {
    status = "error";
  } else if (errors.length > 0) {
    status = "partial";
  } else {
    status = "ok";
  }

  updateSourceSyncState(db, sourceId, {
    lastSyncAt: new Date().toISOString(),
    lastSyncStatus: status,
    lastSyncError: errors.slice(0, MAX_STORED_ERRORS).join("\n") || null,
    // The full count, not the truncated one — "3 of 47 failed" needs the 47.
    lastSyncErrorCount: errors.length,
  });
}

export function buildEmbedConfig(db: ReturnType<typeof getDb>): EmbedConfig {
  const provider = (getSetting(db, "embedding_provider") ?? "cohere") as
    | "cohere"
    | "ollama";
  const config: EmbedConfig = { provider };
  if (provider === "cohere") {
    config.apiKey = loadSecret(db, "cohere_api_key") ?? undefined;
  } else {
    config.ollamaModel =
      (getSetting(db, "ollama_model") as string) ?? undefined;
  }
  return config;
}

export async function getConnectorForSource(
  db: ReturnType<typeof getDb>,
  source: { provider: string; rootExternalId: string },
): Promise<Connector> {
  if (source.provider === "notion") {
    const token = loadSecret(db, "notion_token");
    if (!token) {
      throw new Error("Notion token not found. Connect Notion first.");
    }
    return new NotionConnector(token, source.rootExternalId);
  }

  if (source.provider === "google_drive") {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error(
        "Google OAuth credentials not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables.",
      );
    }
    const client = getAuthenticatedClient(db, clientId, clientSecret);
    await refreshIfNeeded(client, db);
    return new DriveConnector(client, source.rootExternalId);
  }

  throw new Error(
    `No connector available for provider: ${source.provider}. Connect a source first.`,
  );
}

export type SyncTrigger = "manual" | "auto";

export interface RunManagedSyncOptions {
  trigger: SyncTrigger;
  /**
   * Called from inside the `catch`, after the error is already stashed into
   * `syncState.thrown` but before the outcome is recorded. The manual path
   * rethrows here — a throw from inside a `catch` still runs the `finally`
   * below before it propagates, so the epilogue completes exactly as it does
   * for a swallowed error, then `sync:start`'s promise rejects. The scheduler
   * logs and returns normally instead, so its tick can move on to the next
   * source.
   */
  onError: (err: unknown) => void;
}

/**
 * One sync attempt plus everything both call sites did around it: acquire the
 * connector, run `syncSource` with a progress callback that stashes into
 * `lastProgressBySource` via `publishSyncProgress`, then — however the attempt
 * ended — record the outcome, fire the completion telemetry, resolve
 * `finish()`, and tell every window `sources:changed`.
 *
 * `controller` and `finish` are the caller's, from its own `registerSync`
 * call, not this function's — the scheduler needs `controller` in hand
 * *before* calling this, to bridge its master abort signal onto it. Wiring
 * that up after this function had already started would miss an abort that
 * lands while still inside `getConnectorForSource`.
 *
 * Returns whether the attempt succeeded (no thrown error). Only the
 * scheduler's `anySuccess` flag needs the answer — a `manual` sync that fails
 * takes the `onError` rethrow instead of a normal return.
 */
export async function runManagedSync(
  db: ReturnType<typeof getDb>,
  source: SourceRow,
  embedConfig: EmbedConfig,
  controller: AbortController,
  finish: () => void,
  { trigger, onError }: RunManagedSyncOptions,
): Promise<boolean> {
  const startMs = Date.now();
  const syncState: SyncOutcomeInput = {
    lastProgress: null,
    thrown: undefined,
  };

  track("commons_sync_started", {
    source_provider: source.provider,
    trigger,
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
  } catch (err) {
    syncState.thrown = err;
    onError(err);
  } finally {
    // `finish` resolves the promise `cancelSync` is blocked on, so it has to
    // run even if anything here throws — otherwise a cancel hangs for 15
    // seconds. And the outcome has to be written before `finish`, or
    // `sources:remove` could delete the row between the two.
    try {
      recordSyncOutcome(db, source.id, syncState, controller.signal.aborted);
      track("commons_sync_completed", {
        source_provider: source.provider,
        trigger,
        duration_ms: Date.now() - startMs,
        doc_count: syncState.lastProgress?.current ?? 0,
        skipped_count: syncState.lastProgress?.skipped ?? 0,
        error_count: syncState.lastProgress?.errors.length ?? 0,
        phase: syncState.thrown !== undefined ? "error" : "done",
        embedding_provider: embedConfig.provider,
      });
    } catch (err) {
      // Best-effort bookkeeping. On quit, `will-quit` closes the database
      // without waiting for the unwind, so this write lands on a closed
      // connection — and an epilogue that throws would replace the sync's
      // real result with an exception about recording it.
      console.error(`Failed to record sync outcome for ${source.id}:`, err);
    } finally {
      finish();
      // The row's sync state just changed, however it ended. Tell every
      // window to refetch rather than trusting them to have followed along.
      broadcastSourcesChanged();
    }
  }

  return syncState.thrown === undefined;
}

export function registerSyncHandlers(): void {
  ipcMain.handle("sync:start", async (_event, sourceId: string) => {
    const db = getDb();
    const source = getSourceById(db, sourceId);
    if (!source) throw new Error(`Source not found: ${sourceId}`);

    if (activeSyncs.has(sourceId)) {
      throw new Error(`Sync already in progress for source: ${sourceId}`);
    }

    // Build the embed config before registering the sync: `buildEmbedConfig`
    // calls `loadSecret`, which throws if the OS keychain is unavailable. If
    // `registerSync` ran first, that throw would leave the source wedged in
    // `activeSyncs` forever — `finish()` is only reachable after this point.
    const embedConfig = buildEmbedConfig(db);
    const { controller, finish } = registerSync(sourceId);

    await runManagedSync(db, source, embedConfig, controller, finish, {
      trigger: "manual",
      onError: (err) => {
        throw err;
      },
    });
  });

  ipcMain.handle("sync:cancel", async (_, sourceId: string) => {
    await cancelSync(sourceId);
  });
}

import { ipcMain, type WebContents } from "electron";
import { getDb } from "../db/singleton";
import { getSourceById } from "../db/database";
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

export function registerSyncHandlers(): void {
  ipcMain.handle("sync:start", async (event, sourceId: string) => {
    const db = getDb();
    const source = getSourceById(db, sourceId);
    if (!source) throw new Error(`Source not found: ${sourceId}`);

    if (activeSyncs.has(sourceId)) {
      throw new Error(`Sync already in progress for source: ${sourceId}`);
    }

    const { controller, finish } = registerSync(sourceId);

    const embedConfig = buildEmbedConfig(db);
    const startMs = Date.now();
    const syncState = {
      lastProgress: null as SyncProgress | null,
      error: false,
    };

    track("commons_sync_started", {
      source_provider: source.provider,
      trigger: "manual",
    });

    try {
      const connector = await getConnectorForSource(db, source);
      const sender: WebContents = event.sender;

      await syncSource(
        db,
        sourceId,
        source.provider,
        connector,
        embedConfig,
        (progress) => {
          syncState.lastProgress = progress;
          try {
            sender.send("sync:progress", progress);
          } catch {
            // sender destroyed between check and send
          }
        },
        controller.signal,
      );
    } catch (err) {
      syncState.error = true;
      throw err;
    } finally {
      // `finish` resolves the promise `cancelSync` is blocked on, so it has to
      // run even if telemetry throws — otherwise a cancel hangs for 15 seconds.
      try {
        track("commons_sync_completed", {
          source_provider: source.provider,
          trigger: "manual",
          duration_ms: Date.now() - startMs,
          doc_count: syncState.lastProgress?.current ?? 0,
          skipped_count: syncState.lastProgress?.skipped ?? 0,
          error_count: syncState.lastProgress?.errors.length ?? 0,
          phase: syncState.error ? "error" : "done",
          embedding_provider: embedConfig.provider,
        });
      } finally {
        finish();
      }
    }
  });

  ipcMain.handle("sync:cancel", async (_, sourceId: string) => {
    await cancelSync(sourceId);
  });
}

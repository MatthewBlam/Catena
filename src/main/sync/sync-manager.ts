import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  getDocumentByExternalId,
  getChunksByDocumentId,
  getDocumentsBySourceId,
  getIncrementalSyncMap,
  insertDocument,
  replaceChunksForDocument,
  updateDocumentSyncStatus,
  deleteDocumentsByIds,
} from "../db/database";
import { chunkText } from "../search/chunker";
import {
  embedDocuments,
  getEmbeddingModelName,
  embeddingToBuffer,
  type EmbedConfig,
} from "../search/embedder";
import type { SyncProgress } from "../../shared/types";

export interface RawDocument {
  externalId: string;
  title: string;
  url: string | null;
  mimeType: string | null;
  modifiedAt: string | null;
  content: string;
}

/**
 * What a connector can say about the walk it just finished.
 *
 * `seenExternalIds` must hold every document the connector *observed*, not every
 * one it yielded — a document skipped as unchanged, oversized, or unparseable
 * demonstrably still exists.
 *
 * `complete` is the licence to delete. It is false the moment any subtree goes
 * unvisited (depth cap, a 403, an abort), because "I did not look there" and
 * "it is not there" are indistinguishable from the seen-set alone.
 */
export interface SyncWalkResult {
  seenExternalIds: Set<string>;
  complete: boolean;
}

export interface Connector {
  fetchDocuments(
    signal?: AbortSignal,
    knownDocs?: Map<string, string>,
  ): AsyncGenerator<RawDocument, SyncWalkResult>;
}

const DOC_CONCURRENCY = 3;

/** Below this many documents, a source is too small for a ratio to mean anything. */
const MASS_DELETE_MIN_DOCS = 10;
const MASS_DELETE_MAX_RATIO = 0.5;

async function drainPool<T, TReturn>(
  gen: AsyncGenerator<T, TReturn>,
  process: (item: T) => Promise<void>,
  concurrency: number,
  onTaskError: (err: unknown) => void,
  signal?: AbortSignal,
): Promise<TReturn | undefined> {
  const active = new Set<Promise<void>>();
  let result: TReturn | undefined;

  try {
    for (;;) {
      if (signal?.aborted) break;

      const next = await gen.next();
      if (next.done) {
        result = next.value;
        break;
      }

      // Every task swallows its own failure. Without this, one rejection would
      // reach `Promise.race` below, throw out of drainPool, and kill the sync —
      // taking the still-running tasks with it as unhandled rejections.
      const task = process(next.value)
        .catch(onTaskError)
        .finally(() => active.delete(task));
      active.add(task);

      if (active.size >= concurrency) {
        await Promise.race(active);
      }
    }
  } finally {
    // `for await` calls this for us when the loop breaks. A manual loop — which
    // we need in order to see the generator's return value — does not, so the
    // connector's cleanup would never run on abort.
    await gen.return(undefined as unknown as TReturn);
    await Promise.all(active);
  }

  return result;
}

export interface ReconcileResult {
  deleted: number;
  /** Non-null when the mass-delete guard refused to act, and why. */
  blockedReason: string | null;
}

/**
 * Removes documents the provider no longer has. Only ever called on a provably
 * complete walk — see `SyncWalkResult.complete`.
 *
 * The guard exists because the failure mode is unrecoverable and the signal is
 * ambiguous: revoking Commons' access to half a workspace looks exactly like
 * deleting half a workspace. We would rather leave stale documents in the index
 * for one more sync than shred a corpus over a permissions change.
 */
export function reconcileDeletedDocuments(
  db: Database.Database,
  sourceId: string,
  seenExternalIds: Set<string>,
): ReconcileResult {
  const docs = getDocumentsBySourceId(db, sourceId);
  const stale = docs.filter((d) => !seenExternalIds.has(d.externalId));
  if (stale.length === 0) return { deleted: 0, blockedReason: null };

  if (
    docs.length >= MASS_DELETE_MIN_DOCS &&
    stale.length / docs.length > MASS_DELETE_MAX_RATIO
  ) {
    const blockedReason =
      `Kept ${stale.length} of ${docs.length} documents that the provider did not return. ` +
      `Removing more than half a source at once usually means access was revoked, not that the ` +
      `documents were deleted. Check your sharing settings; if they really are gone, remove and re-add the source.`;
    console.warn(
      `Reconciliation blocked for source ${sourceId}: ${blockedReason}`,
    );
    return { deleted: 0, blockedReason };
  }

  return {
    deleted: deleteDocumentsByIds(
      db,
      stale.map((d) => d.id),
    ),
    blockedReason: null,
  };
}

export async function syncSource(
  db: Database.Database,
  sourceId: string,
  provider: string,
  connector: Connector,
  embedConfig: EmbedConfig,
  onProgress: (p: SyncProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const errors: string[] = [];
  let lastErrorsSnapshot: string[] = [];
  let current = 0;
  let deleted = 0;
  const modelName = getEmbeddingModelName(embedConfig);

  const knownDocs = getIncrementalSyncMap(db, sourceId, modelName);
  const skipped = knownDocs.size;

  function errorsSnapshot(): string[] {
    if (errors.length !== lastErrorsSnapshot.length) {
      lastErrorsSnapshot = [...errors];
    }
    return lastErrorsSnapshot;
  }

  function emit(
    phase: SyncProgress["phase"],
    currentDocTitle: string | null,
    total = 0,
  ): void {
    onProgress({
      sourceId,
      phase,
      current,
      skipped,
      total,
      deleted,
      currentDocTitle,
      errors: errorsSnapshot(),
    });
  }

  emit("fetching", null);

  async function processDocument(rawDoc: RawDocument): Promise<void> {
    if (signal?.aborted) return;

    current++;
    emit("fetching", rawDoc.title);

    const contentHash = createHash("sha256")
      .update(rawDoc.content)
      .digest("hex");
    const existing = getDocumentByExternalId(db, sourceId, rawDoc.externalId);

    // `syncStatus === "synced"` is belt to the invariant's braces: a document
    // that failed to embed carries a NULL hash and can never match here anyway.
    // The zero-chunk case still counts as a match — a *synced* document with a
    // committed hash and no chunks is a legitimately empty one.
    if (
      existing?.syncStatus === "synced" &&
      existing.contentHash === contentHash
    ) {
      const chunks = getChunksByDocumentId(db, existing.id);
      const modelMatches =
        chunks.length === 0 || chunks[0].embeddingModel === modelName;
      if (modelMatches) return;
    }

    const docId = existing?.id ?? crypto.randomUUID();

    try {
      // Inside the try (M4): a failure here is this document's problem, not the
      // whole sync's. And the hash is NULL — it stays NULL until the chunks it
      // describes are committed in the same transaction, below. Writing it here
      // is what used to make a failed embed permanent: the document kept a hash
      // it had no chunks for, so every later sync saw a match and skipped it.
      insertDocument(db, {
        id: docId,
        sourceId,
        provider,
        externalId: rawDoc.externalId,
        title: rawDoc.title,
        url: rawDoc.url,
        mimeType: rawDoc.mimeType,
        modifiedAt: rawDoc.modifiedAt,
        contentHash: null,
        lastSyncedAt: null,
        syncStatus: "pending",
      });

      emit("chunking", rawDoc.title);
      const textChunks = chunkText(rawDoc.content, rawDoc.title);

      if (textChunks.length === 0) {
        // An empty document is a real document. Commit the hash with zero chunks
        // so the next sync short-circuits instead of re-fetching it forever — and
        // so a document that was emptied upstream has its stale chunks removed.
        replaceChunksForDocument(db, docId, [], "synced", contentHash);
        return;
      }

      emit("embedding", rawDoc.title);
      const embeddings = await embedDocuments(
        textChunks.map((c) => c.text),
        embedConfig,
        signal,
      );

      // A cancelled document is left pending with a NULL hash, so the next sync
      // picks it up again. It is not an error and must not be recorded as one.
      if (signal?.aborted) return;

      // `Array.from` densifies: the embedder builds its results with
      // `new Array(n)`, so a slot it never wrote is a *hole*, and `some`/`every`
      // skip holes. Checking the sparse array directly would find nothing wrong.
      const dense = Array.from(embeddings);
      if (
        dense.length !== textChunks.length ||
        dense.some((e) => !(e instanceof Float32Array))
      ) {
        const usable = dense.filter((e) => e instanceof Float32Array).length;
        throw new Error(
          `Embedder returned ${usable} usable embeddings for ${textChunks.length} chunks`,
        );
      }

      emit("storing", rawDoc.title);
      replaceChunksForDocument(
        db,
        docId,
        textChunks.map((c, i) => ({
          id: crypto.randomUUID(),
          documentId: docId,
          chunkIndex: c.index,
          heading: c.heading,
          text: c.text,
          embedding: embeddingToBuffer(dense[i]),
          embeddingModel: modelName,
          tokenCount: c.tokenCount,
          createdAt: new Date().toISOString(),
        })),
        "synced",
        contentHash,
      );
    } catch (err) {
      // Cancellation is not a document error.
      if (signal?.aborted) return;
      errors.push(
        `${rawDoc.title}: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
      updateDocumentSyncStatus(db, docId, "error");
    }
  }

  const walk = await drainPool(
    connector.fetchDocuments(signal, knownDocs),
    processDocument,
    DOC_CONCURRENCY,
    (err) => {
      if (signal?.aborted) return;
      errors.push(err instanceof Error ? err.message : "Unknown error");
    },
    signal,
  );

  // `walk === undefined` means drainPool bailed out before the generator
  // finished, so the seen-set is a fragment and is not authoritative. Note that
  // per-document *errors* do not block reconciliation: a document that failed to
  // embed was still seen, so it is not a deletion candidate.
  if (walk?.complete && !signal?.aborted) {
    emit("reconciling", null, current);
    const result = reconcileDeletedDocuments(
      db,
      sourceId,
      walk.seenExternalIds,
    );
    deleted = result.deleted;
    if (result.blockedReason) errors.push(result.blockedReason);
  }

  emit(errors.length > 0 ? "error" : "done", null, current);
}

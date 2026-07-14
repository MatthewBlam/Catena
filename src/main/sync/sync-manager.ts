import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  getDocumentByExternalId,
  getChunksByDocumentId,
  getIncrementalSyncMap,
  insertDocument,
  replaceChunksForDocument,
  updateDocumentSyncStatus,
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

export interface Connector {
  fetchDocuments(
    signal?: AbortSignal,
    knownDocs?: Map<string, string>,
  ): AsyncGenerator<RawDocument>;
}

const DOC_CONCURRENCY = 3;

async function drainPool<T>(
  gen: AsyncGenerator<T>,
  process: (item: T) => Promise<void>,
  concurrency: number,
  signal?: AbortSignal,
): Promise<void> {
  const active = new Set<Promise<void>>();

  for await (const item of gen) {
    if (signal?.aborted) break;

    const task = process(item).finally(() => active.delete(task));
    active.add(task);

    if (active.size >= concurrency) {
      await Promise.race(active);
    }
  }

  await Promise.all(active);
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
  const modelName = getEmbeddingModelName(embedConfig);

  const knownDocs = getIncrementalSyncMap(db, sourceId, modelName);
  const skipped = knownDocs.size;

  function errorsSnapshot(): string[] {
    if (errors.length !== lastErrorsSnapshot.length) {
      lastErrorsSnapshot = [...errors];
    }
    return lastErrorsSnapshot;
  }

  onProgress({
    sourceId,
    phase: "fetching",
    current: 0,
    skipped,
    total: 0,
    currentDocTitle: null,
    errors: [],
  });

  async function processDocument(rawDoc: RawDocument): Promise<void> {
    if (signal?.aborted) return;

    current++;
    onProgress({
      sourceId,
      phase: "fetching",
      current,
      skipped,
      total: 0,
      currentDocTitle: rawDoc.title,
      errors: errorsSnapshot(),
    });

    const contentHash = createHash("sha256")
      .update(rawDoc.content)
      .digest("hex");
    const existing = getDocumentByExternalId(db, sourceId, rawDoc.externalId);
    if (existing?.contentHash === contentHash) {
      const chunks = getChunksByDocumentId(db, existing.id);
      const modelMatches =
        chunks.length === 0 || chunks[0].embeddingModel === modelName;
      if (modelMatches) return;
    }

    const docId = existing?.id ?? crypto.randomUUID();
    insertDocument(db, {
      id: docId,
      sourceId,
      provider,
      externalId: rawDoc.externalId,
      title: rawDoc.title,
      url: rawDoc.url,
      mimeType: rawDoc.mimeType,
      modifiedAt: rawDoc.modifiedAt,
      contentHash,
      lastSyncedAt: null,
      syncStatus: "pending",
    });

    try {
      onProgress({
        sourceId,
        phase: "chunking",
        current,
        skipped,
        total: 0,
        currentDocTitle: rawDoc.title,
        errors: errorsSnapshot(),
      });
      const textChunks = chunkText(rawDoc.content, rawDoc.title);

      if (textChunks.length === 0) {
        updateDocumentSyncStatus(db, docId, "synced");
        return;
      }

      onProgress({
        sourceId,
        phase: "embedding",
        current,
        skipped,
        total: 0,
        currentDocTitle: rawDoc.title,
        errors: errorsSnapshot(),
      });
      const embeddings = await embedDocuments(
        textChunks.map((c) => c.text),
        embedConfig,
        signal,
      );

      onProgress({
        sourceId,
        phase: "storing",
        current,
        skipped,
        total: 0,
        currentDocTitle: rawDoc.title,
        errors: errorsSnapshot(),
      });
      replaceChunksForDocument(
        db,
        docId,
        textChunks.map((c, i) => ({
          id: crypto.randomUUID(),
          documentId: docId,
          chunkIndex: c.index,
          heading: c.heading,
          text: c.text,
          embedding: embeddingToBuffer(embeddings[i]),
          embeddingModel: modelName,
          tokenCount: c.tokenCount,
          createdAt: new Date().toISOString(),
        })),
        "synced",
        contentHash,
      );
    } catch (err) {
      errors.push(
        `${rawDoc.title}: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
      updateDocumentSyncStatus(db, docId, "error");
    }
  }

  await drainPool(
    connector.fetchDocuments(signal, knownDocs),
    processDocument,
    DOC_CONCURRENCY,
    signal,
  );

  onProgress({
    sourceId,
    phase: errors.length > 0 ? "error" : "done",
    current,
    skipped,
    total: current,
    currentDocTitle: null,
    errors: errorsSnapshot(),
  });
}

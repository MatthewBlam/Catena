import type Database from "better-sqlite3";

// --- Sources ---

export interface SourceRow {
  id: string;
  provider: string;
  name: string;
  rootExternalId: string;
  createdAt: string;
}

interface SourceDbRow {
  id: string;
  provider: string;
  name: string;
  root_external_id: string;
  created_at: string;
}

export function insertSource(db: Database.Database, source: SourceRow): void {
  db.prepare(
    "INSERT INTO sources (id, provider, name, root_external_id, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(
    source.id,
    source.provider,
    source.name,
    source.rootExternalId,
    source.createdAt,
  );
}

export function getSourceById(
  db: Database.Database,
  id: string,
): SourceRow | null {
  const row = db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as
    | SourceDbRow
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    rootExternalId: row.root_external_id,
    createdAt: row.created_at,
  };
}

export function getAllSources(db: Database.Database): SourceRow[] {
  const rows = db
    .prepare("SELECT * FROM sources ORDER BY created_at DESC")
    .all() as SourceDbRow[];
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    name: row.name,
    rootExternalId: row.root_external_id,
    createdAt: row.created_at,
  }));
}

export function getAllSourcesWithCounts(
  db: Database.Database,
): (SourceRow & { documentCount: number })[] {
  const rows = db
    .prepare(
      `SELECT s.*, COUNT(d.id) AS document_count
       FROM sources s
       LEFT JOIN documents d ON d.source_id = s.id
       GROUP BY s.id
       ORDER BY s.created_at DESC`,
    )
    .all() as (SourceDbRow & { document_count: number })[];
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    name: row.name,
    rootExternalId: row.root_external_id,
    createdAt: row.created_at,
    documentCount: row.document_count,
  }));
}

export function getSourceByProviderAndRoot(
  db: Database.Database,
  provider: string,
  rootExternalId: string,
): SourceRow | null {
  const row = db
    .prepare(
      "SELECT * FROM sources WHERE provider = ? AND root_external_id = ?",
    )
    .get(provider, rootExternalId) as SourceDbRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    rootExternalId: row.root_external_id,
    createdAt: row.created_at,
  };
}

export function deleteSource(db: Database.Database, id: string): void {
  db.prepare("DELETE FROM sources WHERE id = ?").run(id);
}

// --- Documents ---

export interface DocumentRow {
  id: string;
  sourceId: string;
  provider: string;
  externalId: string;
  title: string;
  url: string | null;
  mimeType: string | null;
  modifiedAt: string | null;
  contentHash: string | null;
  lastSyncedAt: string | null;
  syncStatus: string;
}

interface DocumentDbRow {
  id: string;
  source_id: string;
  provider: string;
  external_id: string;
  title: string;
  url: string | null;
  mime_type: string | null;
  modified_at: string | null;
  content_hash: string | null;
  last_synced_at: string | null;
  sync_status: string;
}

function mapDocRow(row: DocumentDbRow): DocumentRow {
  return {
    id: row.id,
    sourceId: row.source_id,
    provider: row.provider,
    externalId: row.external_id,
    title: row.title,
    url: row.url,
    mimeType: row.mime_type,
    modifiedAt: row.modified_at,
    contentHash: row.content_hash,
    lastSyncedAt: row.last_synced_at,
    syncStatus: row.sync_status,
  };
}

export function insertDocument(db: Database.Database, doc: DocumentRow): void {
  db.prepare(
    `INSERT INTO documents (id, source_id, provider, external_id, title, url, mime_type, modified_at, content_hash, last_synced_at, sync_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       source_id = excluded.source_id,
       provider = excluded.provider,
       external_id = excluded.external_id,
       title = excluded.title,
       url = excluded.url,
       mime_type = excluded.mime_type,
       modified_at = excluded.modified_at,
       content_hash = excluded.content_hash,
       last_synced_at = excluded.last_synced_at,
       sync_status = excluded.sync_status`,
  ).run(
    doc.id,
    doc.sourceId,
    doc.provider,
    doc.externalId,
    doc.title,
    doc.url,
    doc.mimeType,
    doc.modifiedAt,
    doc.contentHash,
    doc.lastSyncedAt,
    doc.syncStatus,
  );
}

export function getDocumentById(
  db: Database.Database,
  id: string,
): DocumentRow | null {
  const row = db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as
    | DocumentDbRow
    | undefined;
  if (!row) return null;
  return mapDocRow(row);
}

export function getDocumentsByIds(
  db: Database.Database,
  ids: string[],
): Map<string, DocumentRow> {
  if (ids.length === 0) return new Map();
  const BATCH_SIZE = 500;
  const result = new Map<string, DocumentRow>();
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT * FROM documents WHERE id IN (${placeholders})`)
      .all(...batch) as DocumentDbRow[];
    for (const row of rows) {
      result.set(row.id, mapDocRow(row));
    }
  }
  return result;
}

export function getDocumentsBySourceId(
  db: Database.Database,
  sourceId: string,
): DocumentRow[] {
  const rows = db
    .prepare("SELECT * FROM documents WHERE source_id = ?")
    .all(sourceId) as DocumentDbRow[];
  return rows.map(mapDocRow);
}

export function getDocumentByExternalId(
  db: Database.Database,
  sourceId: string,
  externalId: string,
): DocumentRow | null {
  const row = db
    .prepare("SELECT * FROM documents WHERE source_id = ? AND external_id = ?")
    .get(sourceId, externalId) as DocumentDbRow | undefined;
  if (!row) return null;
  return mapDocRow(row);
}

export function updateDocumentSyncStatus(
  db: Database.Database,
  id: string,
  status: string,
): void {
  db.prepare(
    "UPDATE documents SET sync_status = ?, last_synced_at = ? WHERE id = ?",
  ).run(status, new Date().toISOString(), id);
}

// --- Chunks ---

export interface ChunkRow {
  id: string;
  documentId: string;
  chunkIndex: number;
  heading: string | null;
  text: string;
  embedding: Buffer | null;
  embeddingModel: string | null;
  tokenCount: number | null;
  createdAt: string;
}

interface ChunkDbRow {
  id: string;
  document_id: string;
  chunk_index: number;
  heading: string | null;
  text: string;
  embedding: Buffer | null;
  embedding_model: string | null;
  token_count: number | null;
  created_at: string;
}

function mapChunkRow(row: ChunkDbRow): ChunkRow {
  return {
    id: row.id,
    documentId: row.document_id,
    chunkIndex: row.chunk_index,
    heading: row.heading,
    text: row.text,
    embedding: row.embedding,
    embeddingModel: row.embedding_model,
    tokenCount: row.token_count,
    createdAt: row.created_at,
  };
}

export function upsertChunks(db: Database.Database, chunks: ChunkRow[]): void {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO chunks (id, document_id, chunk_index, heading, text, embedding, embedding_model, token_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const batch = db.transaction((items: ChunkRow[]) => {
    for (const c of items) {
      insert.run(
        c.id,
        c.documentId,
        c.chunkIndex,
        c.heading,
        c.text,
        c.embedding,
        c.embeddingModel,
        c.tokenCount,
        c.createdAt,
      );
    }
  });
  batch(chunks);
}

export function getChunksByDocumentId(
  db: Database.Database,
  documentId: string,
): ChunkRow[] {
  const rows = db
    .prepare("SELECT * FROM chunks WHERE document_id = ? ORDER BY chunk_index")
    .all(documentId) as ChunkDbRow[];
  return rows.map(mapChunkRow);
}

export function getChunksWithEmbeddingsByModel(
  db: Database.Database,
  model: string,
  limit = 10_000,
): ChunkRow[] {
  const rows = db
    .prepare(
      "SELECT * FROM chunks WHERE embedding IS NOT NULL AND embedding_model = ? LIMIT ?",
    )
    .all(model, limit) as ChunkDbRow[];
  return rows.map(mapChunkRow);
}

export function deleteChunksByDocumentId(
  db: Database.Database,
  documentId: string,
): void {
  db.prepare("DELETE FROM chunks WHERE document_id = ?").run(documentId);
}

export function replaceChunksForDocument(
  db: Database.Database,
  docId: string,
  chunks: ChunkRow[],
  syncStatus: string,
): void {
  const replace = db.transaction(() => {
    deleteChunksByDocumentId(db, docId);
    if (chunks.length > 0) {
      upsertChunks(db, chunks);
    }
    updateDocumentSyncStatus(db, docId, syncStatus);
  });
  replace();
}

export function getDocumentCountBySourceId(
  db: Database.Database,
  sourceId: string,
): number {
  const row = db
    .prepare("SELECT COUNT(*) as count FROM documents WHERE source_id = ?")
    .get(sourceId) as { count: number };
  return row.count;
}

export function getIncrementalSyncMap(
  db: Database.Database,
  sourceId: string,
  currentModelName: string,
): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT d.external_id, d.modified_at
       FROM documents d
       WHERE d.source_id = ?
         AND d.modified_at IS NOT NULL
         AND d.content_hash IS NOT NULL
         AND d.sync_status = 'synced'
         AND NOT EXISTS (
           SELECT 1 FROM chunks c
           WHERE c.document_id = d.id
             AND c.embedding_model IS NOT NULL
             AND c.embedding_model != ?
           LIMIT 1
         )`,
    )
    .all(sourceId, currentModelName) as {
    external_id: string;
    modified_at: string;
  }[];

  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.external_id, row.modified_at);
  }
  return map;
}

// --- FTS5 Search ---

export function searchFts(
  db: Database.Database,
  query: string,
  limit: number,
): ChunkRow[] {
  const tokens = query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" OR ");

  if (!tokens) return [];

  try {
    const rows = db
      .prepare(
        `SELECT c.id, c.document_id, c.chunk_index, c.heading, c.text,
                NULL as embedding, c.embedding_model, c.token_count, c.created_at
         FROM chunks_fts fts
         JOIN chunks c ON c.rowid = fts.rowid
         WHERE chunks_fts MATCH ?
         ORDER BY fts.rank
         LIMIT ?`,
      )
      .all(tokens, limit) as ChunkDbRow[];
    return rows.map(mapChunkRow);
  } catch {
    return [];
  }
}

// --- Settings ---

export function upsertSetting(
  db: Database.Database,
  key: string,
  value: string,
): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
    key,
    value,
  );
}

export function getSetting(db: Database.Database, key: string): string | null {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  if (!row) return null;
  return row.value;
}

// --- Storage Stats ---

export interface StorageStatsRow {
  sourceCount: number;
  documentCount: number;
  chunkCount: number;
}

export function getStorageStats(db: Database.Database): StorageStatsRow {
  return db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM sources) AS sourceCount,
        (SELECT COUNT(*) FROM documents) AS documentCount,
        (SELECT COUNT(*) FROM chunks) AS chunkCount`,
    )
    .get() as StorageStatsRow;
}

export function clearAllData(db: Database.Database): void {
  const clear = db.transaction(() => {
    db.exec("DELETE FROM sources"); // cascades to documents → chunks
    db.exec("DELETE FROM settings");
    db.exec("DELETE FROM secrets");
  });
  clear();
}

// --- Embedding Health ---

export interface EmbeddingHealthRow {
  totalChunks: number;
  distinctModels: string[];
}

export function getChunkCountByModel(
  db: Database.Database,
  model: string,
): number {
  return (
    db
      .prepare("SELECT COUNT(*) as c FROM chunks WHERE embedding_model = ?")
      .get(model) as { c: number }
  ).c;
}

export function resetStalePendingDocuments(db: Database.Database): number {
  const result = db
    .prepare(
      "UPDATE documents SET sync_status = 'error' WHERE sync_status = 'pending'",
    )
    .run();
  return result.changes;
}

export function getEmbeddingHealth(db: Database.Database): EmbeddingHealthRow {
  const totalChunks = (
    db
      .prepare("SELECT COUNT(*) as c FROM chunks WHERE embedding IS NOT NULL")
      .get() as { c: number }
  ).c;
  const models = db
    .prepare(
      "SELECT DISTINCT embedding_model FROM chunks WHERE embedding_model IS NOT NULL",
    )
    .all() as { embedding_model: string }[];
  return {
    totalChunks,
    distinctModels: models.map((m) => m.embedding_model),
  };
}

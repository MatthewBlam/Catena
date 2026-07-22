import type Database from "better-sqlite3";
import type {
  SyncOutcome,
  SearchResult,
  SearchResponse,
  RecentSearch,
  RecentSearchDetail,
} from "../../shared/types";

// --- Sources ---

// Defined in shared/types so the renderer can name it too; re-exported here
// because this is where every writer of the column lives.
export type { SyncOutcome };

export interface SourceRow {
  id: string;
  provider: string;
  name: string;
  rootExternalId: string;
  createdAt: string;
  lastSyncAt: string | null;
  lastSyncStatus: SyncOutcome | null;
  lastSyncError: string | null;
  lastSyncErrorCount: number;
}

interface SourceDbRow {
  id: string;
  provider: string;
  name: string;
  root_external_id: string;
  created_at: string;
  last_sync_at: string | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
  last_sync_error_count: number;
}

function mapSourceRow(row: SourceDbRow): SourceRow {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    rootExternalId: row.root_external_id,
    createdAt: row.created_at,
    lastSyncAt: row.last_sync_at,
    lastSyncStatus: (row.last_sync_status as SyncOutcome | null) ?? null,
    lastSyncError: row.last_sync_error,
    lastSyncErrorCount: row.last_sync_error_count,
  };
}

/** A source as the caller creates it. The sync-state columns are written by syncing, not by the caller. */
export type NewSource = Pick<
  SourceRow,
  "id" | "provider" | "name" | "rootExternalId" | "createdAt"
>;

export function insertSource(db: Database.Database, source: NewSource): void {
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
  return row ? mapSourceRow(row) : null;
}

export function getAllSources(db: Database.Database): SourceRow[] {
  const rows = db
    .prepare("SELECT * FROM sources ORDER BY created_at DESC")
    .all() as SourceDbRow[];
  return rows.map(mapSourceRow);
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
    ...mapSourceRow(row),
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
  return row ? mapSourceRow(row) : null;
}

export interface SourceSyncState {
  lastSyncAt: string;
  lastSyncStatus: SyncOutcome;
  lastSyncError: string | null;
  lastSyncErrorCount: number;
}

/** No-ops harmlessly if the source was removed mid-sync. */
export function updateSourceSyncState(
  db: Database.Database,
  sourceId: string,
  state: SourceSyncState,
): void {
  db.prepare(
    `UPDATE sources
     SET last_sync_at = ?, last_sync_status = ?, last_sync_error = ?, last_sync_error_count = ?
     WHERE id = ?`,
  ).run(
    state.lastSyncAt,
    state.lastSyncStatus,
    state.lastSyncError,
    state.lastSyncErrorCount,
    sourceId,
  );
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

/**
 * Moves a document's sync status WITHOUT touching content_hash. This is the
 * error path: a document that failed to embed must not keep a hash, or the next
 * sync sees the hash match and skips it forever.
 */
export function updateDocumentSyncStatus(
  db: Database.Database,
  id: string,
  status: string,
): void {
  db.prepare(
    "UPDATE documents SET sync_status = ?, last_synced_at = ? WHERE id = ?",
  ).run(status, new Date().toISOString(), id);
}

/**
 * Sets status and content_hash together. Only ever call this in the same
 * transaction as the chunk write — see replaceChunksForDocument.
 *
 * Not exported: its only caller is replaceChunksForDocument, below, in the same
 * transaction as the chunk write. Exporting it would hand a caller elsewhere in
 * the codebase a way to write a hash outside that transaction — the exact
 * violation of the content_hash invariant this function's contract depends on
 * not happening.
 */
function updateDocumentSyncState(
  db: Database.Database,
  id: string,
  status: string,
  contentHash: string | null,
): void {
  db.prepare(
    "UPDATE documents SET sync_status = ?, content_hash = ?, last_synced_at = ? WHERE id = ?",
  ).run(status, contentHash, new Date().toISOString(), id);
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

// ON CONFLICT DO UPDATE, not INSERT OR REPLACE. REPLACE deletes the conflicting
// row and inserts a new one, which moves the rowid; the chunks_fts index is
// keyed by rowid, and its delete trigger only fires under REPLACE when
// recursive_triggers is on. Miss that and the stale FTS row survives, pointing
// at a rowid SQLite later hands to an unrelated chunk — that chunk then matches
// terms its text never contained. Neither PRAGMA integrity_check nor FTS
// 'integrity-check' detects it. DO UPDATE edits in place, keeping the rowid and
// firing chunks_fts_au regardless of the pragma.
export function upsertChunks(db: Database.Database, chunks: ChunkRow[]): void {
  const insert = db.prepare(
    `INSERT INTO chunks (id, document_id, chunk_index, heading, text, embedding, embedding_model, token_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       document_id = excluded.document_id,
       chunk_index = excluded.chunk_index,
       heading = excluded.heading,
       text = excluded.text,
       embedding = excluded.embedding,
       embedding_model = excluded.embedding_model,
       token_count = excluded.token_count,
       created_at = excluded.created_at`,
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

/**
 * Full rows for a set of chunk ids — the second half of the vector-scan split:
 * the scan itself only ever touches `id` and `embedding` (see
 * iterateChunksWithEmbeddingsByModel below), so once the top-K survivors are
 * known, this is how their text/heading/document_id come back for rerank and
 * snippets. Batched like deleteDocumentsByIds/getDocumentsByIds — SQLite caps
 * bound parameters well under most corpora, but there is no reason to rely on
 * that ceiling here either.
 *
 * The `IN` clause does not promise result order, and does not owe the caller
 * one: this returns whatever order SQLite hands back. Callers that care about
 * order (e.g. a score-sorted top-K) must re-sort by their own id list.
 */
export function getChunksByIds(
  db: Database.Database,
  ids: string[],
): ChunkRow[] {
  if (ids.length === 0) return [];
  const BATCH_SIZE = 500;
  const result: ChunkRow[] = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT * FROM chunks WHERE id IN (${placeholders})`)
      .all(...batch) as ChunkDbRow[];
    result.push(...rows.map(mapChunkRow));
  }
  return result;
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

/** The columns a cosine scan actually touches — nothing scoring doesn't need. */
export interface ChunkEmbeddingRow {
  id: string;
  embedding: Buffer;
}

interface ChunkEmbeddingDbRow {
  id: string;
  embedding: Buffer;
}

/**
 * Streams chunks one row at a time instead of materializing every embedding
 * Buffer at once. At 1536 dimensions an embedding is ~6 KB, so the array-returning
 * version above costs ~61 MB per search at its 10k cap — and the cap is the only
 * thing keeping that number from growing with the corpus. Callers that only need
 * a top-K should iterate and keep O(K).
 *
 * Selects only `id` and `embedding` — the scan only scores, it never reads
 * `text`/`heading`/`document_id`. Those are wasted work for the ~250k-40 rows
 * that don't survive to the top-K; survivors get their full row afterward via
 * getChunksByIds.
 */
export function* iterateChunksWithEmbeddingsByModel(
  db: Database.Database,
  model: string,
): Generator<ChunkEmbeddingRow> {
  const rows = db
    .prepare(
      "SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL AND embedding_model = ?",
    )
    .iterate(model) as IterableIterator<ChunkEmbeddingDbRow>;
  for (const row of rows) {
    yield { id: row.id, embedding: row.embedding };
  }
}

export function deleteChunksByDocumentId(
  db: Database.Database,
  documentId: string,
): void {
  db.prepare("DELETE FROM chunks WHERE document_id = ?").run(documentId);
}

/**
 * The content_hash invariant, in one place: a document's hash is non-null iff the
 * chunks currently in the database were derived from exactly that content. So the
 * hash is written in the same transaction as the chunks, and `contentHash` is a
 * required parameter — an optional one invites the caller to commit a hash for
 * chunks that never landed, which is how documents used to disappear from search
 * permanently.
 */
export function replaceChunksForDocument(
  db: Database.Database,
  docId: string,
  chunks: ChunkRow[],
  syncStatus: string,
  contentHash: string | null,
): void {
  const replace = db.transaction(() => {
    deleteChunksByDocumentId(db, docId);
    if (chunks.length > 0) {
      upsertChunks(db, chunks);
    }
    updateDocumentSyncState(db, docId, syncStatus, contentHash);
  });
  replace();
}

/** Chunks go via ON DELETE CASCADE, which fires the FTS delete trigger. */
export function deleteDocumentsByIds(
  db: Database.Database,
  ids: string[],
): number {
  if (ids.length === 0) return 0;
  const BATCH_SIZE = 500;
  let deleted = 0;
  const run = db.transaction(() => {
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      deleted += db
        .prepare(`DELETE FROM documents WHERE id IN (${placeholders})`)
        .run(...batch).changes;
    }
  });
  run();
  return deleted;
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

// --- Recent Searches ---

/** How long a saved search survives before pruneExpiredRecentSearches sweeps it. */
const RECENT_SEARCH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Row cap regardless of age — bounds table growth for a user who searches constantly. */
const RECENT_SEARCH_CAP = 50;

/**
 * What a search response contributes to a recent-search row. Deliberately
 * excludes `rerankFailed`/`truncated`: those describe the live run's
 * machinery at the moment it ran, not the results themselves, and a restored
 * view has no "try again" affordance for them beyond re-searching. `rewrittenQuery`
 * survives because it explains what the stored results actually are.
 */
export interface RecentSearchSnapshot {
  results: SearchResult[];
  rewrittenQuery?: string;
}

interface RecentSearchDbRow {
  id: string;
  query: string;
  normalized_query: string;
  response_json: string;
  result_count: number;
  created_at: string;
  updated_at: string;
}

/**
 * Collapses a query to the form two searches are "the same" for recent-search
 * dedup purposes: trims, collapses internal whitespace runs, lowercases.
 * Done in JS rather than SQL `LOWER()` because `LOWER()` only folds ASCII —
 * club names and search terms are not guaranteed to be.
 */
function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Inserts a new recent search, or — if `query` normalizes to one already
 * stored — updates that row's query/snapshot/count/updated_at in place while
 * keeping its original `id` and `created_at`. ON CONFLICT DO UPDATE, not
 * INSERT OR REPLACE: REPLACE would delete and re-insert the row, minting a
 * new id and losing created_at, which breaks "re-upserting rescues an old
 * entry" (the row's identity must survive a refresh).
 *
 * `nowIso` is injectable so tests can control ordering/cap-eviction without
 * relying on real-clock timing.
 */
export function upsertRecentSearch(
  db: Database.Database,
  query: string,
  snapshot: RecentSearchSnapshot,
  nowIso: string = new Date().toISOString(),
): void {
  const normalizedQuery = normalizeQuery(query);
  const responseJson = JSON.stringify(snapshot);
  const resultCount = snapshot.results.length;
  const id = crypto.randomUUID();

  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO recent_searches (id, query, normalized_query, response_json, result_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(normalized_query) DO UPDATE SET
         query = excluded.query,
         response_json = excluded.response_json,
         result_count = excluded.result_count,
         updated_at = excluded.updated_at`,
    ).run(
      id,
      query,
      normalizedQuery,
      responseJson,
      resultCount,
      nowIso,
      nowIso,
    );

    db.prepare(
      `DELETE FROM recent_searches WHERE id NOT IN (
         SELECT id FROM recent_searches ORDER BY updated_at DESC LIMIT ?
       )`,
    ).run(RECENT_SEARCH_CAP);
  });
  run();
}

/** Light rows for the recents list — no response_json, so no snapshot cost for a list nobody expanded. */
export function listRecentSearches(
  db: Database.Database,
  limit?: number,
): RecentSearch[] {
  const rows = db
    .prepare(
      `SELECT id, query, result_count, created_at, updated_at
       FROM recent_searches
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    // LIMIT -1 is SQLite's "no limit"; the 50-row cap bounds the table anyway.
    .all(limit ?? -1) as Pick<
    RecentSearchDbRow,
    "id" | "query" | "result_count" | "created_at" | "updated_at"
  >[];
  return rows.map((row) => ({
    id: row.id,
    query: row.query,
    resultCount: row.result_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/**
 * `null` on a missing id and on hand-corrupted `response_json` alike — the
 * renderer's "this recent search is gone, go search again" path is correct
 * for both, so there is no reason to distinguish them here.
 */
export function getRecentSearchById(
  db: Database.Database,
  id: string,
): RecentSearchDetail | null {
  const row = db
    .prepare("SELECT * FROM recent_searches WHERE id = ?")
    .get(id) as RecentSearchDbRow | undefined;
  if (!row) return null;

  let snapshot: RecentSearchSnapshot;
  try {
    snapshot = JSON.parse(row.response_json) as RecentSearchSnapshot;
  } catch {
    // Self-heal: a row whose snapshot no longer parses can never be restored,
    // so drop it rather than leave a permanently dead sidebar entry the user
    // can only clear by waiting out the 7-day retention. Mirrors how a corrupt
    // secret auto-deletes on read.
    deleteRecentSearch(db, id);
    return null;
  }

  return {
    id: row.id,
    query: row.query,
    resultCount: row.result_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    results: snapshot.results,
    rewrittenQuery: snapshot.rewrittenQuery,
  };
}

export function deleteRecentSearch(db: Database.Database, id: string): void {
  db.prepare("DELETE FROM recent_searches WHERE id = ?").run(id);
}

/**
 * Sweeps rows whose updated_at is older than the retention window. Strict
 * `<`, not `<=`: a row exactly at the cutoff has not yet exceeded its 7 days
 * and must survive. ISO-8601 strings sort chronologically as text, so this
 * compares directly rather than parsing every row back to a Date.
 */
export function pruneExpiredRecentSearches(
  db: Database.Database,
  nowMs: number = Date.now(),
): number {
  const cutoffIso = new Date(nowMs - RECENT_SEARCH_RETENTION_MS).toISOString();
  const result = db
    .prepare("DELETE FROM recent_searches WHERE updated_at < ?")
    .run(cutoffIso);
  return result.changes;
}

/**
 * The seam the search-IPC handler calls after every completed search. Refuses
 * to save a cancelled/superseded response (nothing real to show later) or one
 * with zero results (nothing worth revisiting). Any DB failure is caught and
 * logged rather than thrown: a broken recent-searches write must never fail
 * the search response the user is actually waiting on.
 */
export function saveRecentSearchFromResponse(
  db: Database.Database,
  query: string,
  response: SearchResponse,
): boolean {
  try {
    if (response.cancelled || response.results.length === 0) return false;
    upsertRecentSearch(db, query, {
      results: response.results,
      rewrittenQuery: response.rewrittenQuery,
    });
    return true;
  } catch (err) {
    console.error("Failed to save recent search:", err);
    return false;
  }
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

/**
 * "Clear all data" must not silently re-enable telemetry. The opt-out lives in
 * settings as telemetry_enabled, and posthog.ts reads it as `!== "false"` — so
 * deleting the row flips a user's explicit opt-out back on. device_id is kept for
 * the same reason in reverse: minting a fresh analytics identity on "clear data"
 * is worse for the user than reusing the one they already have.
 */
const PRESERVED_SETTING_KEYS = ["telemetry_enabled", "device_id"] as const;

export function clearAllData(db: Database.Database): void {
  const placeholders = PRESERVED_SETTING_KEYS.map(() => "?").join(",");
  const clear = db.transaction(() => {
    db.exec("DELETE FROM sources"); // cascades to documents → chunks → chunks_fts
    db.prepare(`DELETE FROM settings WHERE key NOT IN (${placeholders})`).run(
      ...PRESERVED_SETTING_KEYS,
    );
    db.exec("DELETE FROM secrets");
    db.exec("DELETE FROM recent_searches");
  });
  clear();
  // Reclaim the freed pages so "Database size" actually drops after a wipe.
  // DELETE only moves pages to the freelist; the file never shrinks without
  // VACUUM, which must run outside the transaction above (it cannot run inside
  // one).
  db.exec("VACUUM");
}

// --- Embedding Health ---

export interface EmbeddingHealthRow {
  totalChunks: number;
  distinctModels: string[];
}

/**
 * Counts chunks that actually carry an embedding for `model`. The missing
 * `embedding IS NOT NULL` used to let un-embedded chunks inflate the count, which
 * skewed embedding:health's mismatchedChunks and would permanently false-positive
 * the truncation banner.
 */
export function getChunkCountByModel(
  db: Database.Database,
  model: string,
): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM chunks WHERE embedding IS NOT NULL AND embedding_model = ?",
      )
      .get(model) as { c: number }
  ).c;
}

/**
 * A 'pending' document at startup means the app died mid-sync, so its hash (if any)
 * describes chunks that were never written. Clear the hash along with the status,
 * or the next sync matches the hash and skips the document forever.
 */
export function resetStalePendingDocuments(db: Database.Database): number {
  const result = db
    .prepare(
      "UPDATE documents SET sync_status = 'error', content_hash = NULL WHERE sync_status = 'pending'",
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

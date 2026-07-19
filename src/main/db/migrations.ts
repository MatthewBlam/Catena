import type Database from "better-sqlite3";
import { rmSync } from "node:fs";

interface Migration {
  version: number;
  statements: string[];
}

/** Exported for tests, which need to build a database pinned at an older version. */
export const migrations: Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        name TEXT NOT NULL,
        root_external_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT,
        mime_type TEXT,
        modified_at TEXT,
        content_hash TEXT,
        last_synced_at TEXT,
        sync_status TEXT NOT NULL DEFAULT 'pending'
      )`,
      `CREATE TABLE chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        heading TEXT,
        text TEXT NOT NULL,
        embedding BLOB,
        embedding_model TEXT,
        token_count INTEGER,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
      `CREATE INDEX idx_documents_source_id ON documents(source_id)`,
      `CREATE INDEX idx_chunks_document_id ON chunks(document_id)`,
      `CREATE UNIQUE INDEX idx_documents_external ON documents(source_id, external_id)`,
    ],
  },
  {
    version: 2,
    statements: [
      `CREATE TABLE secrets (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
      `INSERT OR IGNORE INTO secrets (key, value)
        SELECT key, value FROM settings
        WHERE key IN ('cohere_api_key', 'notion_token', 'google_tokens')`,
      `DELETE FROM settings
        WHERE key IN ('cohere_api_key', 'notion_token', 'google_tokens')`,
    ],
  },
  {
    version: 3,
    statements: [
      `DELETE FROM sources WHERE rowid NOT IN (
        SELECT MIN(rowid) FROM sources GROUP BY provider, root_external_id
      )`,
      `CREATE UNIQUE INDEX idx_sources_provider_root ON sources(provider, root_external_id)`,
    ],
  },
  {
    version: 4,
    statements: [
      `CREATE INDEX idx_chunks_embedding_model ON chunks(embedding_model) WHERE embedding IS NOT NULL`,
    ],
  },
  {
    version: 5,
    statements: [
      // Note (audit Task 7.3): `unicode61` splits on Unicode word boundaries,
      // which do not exist between CJK characters — so keyword (FTS) search does
      // not segment CJK/Japanese/Korean text into terms. Vector search still
      // works there (the chunker now produces bounded CJK chunks), but improving
      // FTS for CJK would need a dedicated tokenizer (e.g. ICU) and is out of
      // scope here.
      `CREATE VIRTUAL TABLE chunks_fts USING fts5(
        text,
        heading,
        content='chunks',
        content_rowid='rowid',
        tokenize='porter unicode61'
      )`,

      `CREATE TRIGGER chunks_fts_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, text, heading)
        VALUES (new.rowid, new.text, new.heading);
      END`,

      `CREATE TRIGGER chunks_fts_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text, heading)
        VALUES ('delete', old.rowid, old.text, old.heading);
      END`,

      `CREATE TRIGGER chunks_fts_au AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text, heading)
        VALUES ('delete', old.rowid, old.text, old.heading);
        INSERT INTO chunks_fts(rowid, text, heading)
        VALUES (new.rowid, new.text, new.heading);
      END`,

      `INSERT INTO chunks_fts(rowid, text, heading)
        SELECT rowid, text, heading FROM chunks`,
    ],
  },
  {
    version: 6,
    statements: [
      // content_hash may only ever describe chunks that are actually in the DB.
      // Older builds committed the hash before the embedding call succeeded, so
      // a doc could carry a hash with zero chunks — and every later sync would
      // see the hash match and skip it forever. Scrub those.
      `UPDATE documents SET content_hash = NULL WHERE sync_status <> 'synced'`,
      // Persist per-source sync outcome so failures survive the panel closing.
      `ALTER TABLE sources ADD COLUMN last_sync_at TEXT`,
      `ALTER TABLE sources ADD COLUMN last_sync_status TEXT`,
      `ALTER TABLE sources ADD COLUMN last_sync_error TEXT`,
      `ALTER TABLE sources ADD COLUMN last_sync_error_count INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    version: 7,
    statements: [
      // A user with an embedding_provider setting completed the provider step
      // on a build that predates the onboarding_complete flag — don't re-onboard them.
      `INSERT INTO settings (key, value)
       SELECT 'onboarding_complete', 'true'
       WHERE EXISTS (SELECT 1 FROM settings WHERE key = 'embedding_provider')
         AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'onboarding_complete')`,
    ],
  },
  {
    version: 8,
    statements: [
      `CREATE TABLE recent_searches (
        id TEXT PRIMARY KEY,
        query TEXT NOT NULL,
        normalized_query TEXT NOT NULL UNIQUE,
        response_json TEXT NOT NULL,
        result_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_recent_searches_updated_at ON recent_searches(updated_at)`,
    ],
  },
];

const LATEST_VERSION = Math.max(...migrations.map((m) => m.version));

/**
 * VACUUM INTO, not copyFileSync: in WAL mode the recent commits live in the
 * -wal file, so copying only the .db yields a backup that is missing them —
 * and can be missing entire tables. VACUUM INTO writes one self-contained,
 * transactionally consistent file.
 */
function backupBeforeMigration(db: Database.Database, dbPath: string): void {
  const backupPath = `${dbPath}.pre-migration.bak`;
  rmSync(backupPath, { force: true }); // VACUUM INTO refuses an existing target
  db.prepare("VACUUM INTO ?").run(backupPath);
}

export function runMigrations(db: Database.Database, dbPath?: string): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const current = db
    .prepare("SELECT MAX(version) as v FROM schema_version")
    .get() as {
    v: number | null;
  };
  const currentVersion = current?.v ?? 0;

  if (currentVersion > LATEST_VERSION) {
    throw new Error(
      `This database was created by a newer version of Commons (schema v${currentVersion}, ` +
        `this build supports v${LATEST_VERSION}). Please update Commons.`,
    );
  }

  const pending = migrations
    .filter((m) => m.version > currentVersion)
    .sort((a, b) => a.version - b.version);
  if (pending.length === 0) return;

  // If we cannot take a backup, we must not run a destructive migration.
  // Failing to start is recoverable; a half-migrated corpus with no backup is not.
  if (dbPath) {
    try {
      backupBeforeMigration(db, dbPath);
    } catch (err) {
      throw new Error(
        `Could not back up the database before upgrading it (${err instanceof Error ? err.message : String(err)}). ` +
          `Free up disk space and reopen Commons. Your data has not been modified.`,
        { cause: err },
      );
    }
  }

  for (const migration of pending) {
    console.log(`Applying migration v${migration.version}...`);
    const apply = db.transaction(() => {
      for (const sql of migration.statements) {
        db.exec(sql);
      }
      db.prepare(
        "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
      ).run(migration.version, new Date().toISOString());
    });
    apply();
  }
}

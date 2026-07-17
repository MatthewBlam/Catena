import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import DatabaseCtor from "better-sqlite3";
import { runMigrations, migrations } from "../migrations";
import { createUnmigratedTestDb } from "./test-db";

const LATEST = Math.max(...migrations.map((m) => m.version));

/** Brings a database to exactly `version`, the way an older build would have left it. */
function migrateTo(db: Database.Database, version: number): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  for (const m of migrations.filter((m) => m.version <= version)) {
    for (const sql of m.statements) db.exec(sql);
    db.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
    ).run(m.version, "2024-01-01T00:00:00Z");
  }
}

function currentVersion(db: Database.Database): number {
  return (
    db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as {
      v: number | null;
    }
  ).v!;
}

describe("runMigrations", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createUnmigratedTestDb();
  });
  afterEach(() => db.close());

  it("applies every migration to a fresh database", () => {
    runMigrations(db);
    expect(currentVersion(db)).toBe(LATEST);

    const applied = (
      db
        .prepare("SELECT version FROM schema_version ORDER BY version")
        .all() as { version: number }[]
    ).map((r) => r.version);
    expect(applied).toEqual(migrations.map((m) => m.version));
  });

  it("is idempotent", () => {
    runMigrations(db);
    runMigrations(db);
    expect(currentVersion(db)).toBe(LATEST);
  });

  it("refuses a database from a newer build of Commons", () => {
    migrateTo(db, LATEST);
    db.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
    ).run(999, "2099-01-01T00:00:00Z");

    expect(() => runMigrations(db)).toThrow(/newer version of Commons/);
  });
});

describe("migration v6", () => {
  let db: Database.Database;

  function seedDoc(
    id: string,
    syncStatus: string,
    contentHash: string | null,
  ): void {
    db.prepare(
      `INSERT INTO documents (id, source_id, provider, external_id, title, content_hash, sync_status)
       VALUES (?, 's1', 'notion', ?, ?, ?, ?)`,
    ).run(id, `ext-${id}`, `Doc ${id}`, contentHash, syncStatus);
  }

  function hashOf(id: string): string | null {
    return (
      db.prepare("SELECT content_hash FROM documents WHERE id = ?").get(id) as {
        content_hash: string | null;
      }
    ).content_hash;
  }

  beforeEach(() => {
    db = createUnmigratedTestDb();
    migrateTo(db, 5);
    db.prepare(
      "INSERT INTO sources (id, provider, name, root_external_id, created_at) VALUES ('s1','notion','S','ext1','2024-01-01T00:00:00Z')",
    ).run();
  });
  afterEach(() => db.close());

  it("scrubs content_hash from documents that never finished syncing", () => {
    seedDoc("d-error", "error", "hash-error");
    seedDoc("d-pending", "pending", "hash-pending");

    runMigrations(db);

    expect(hashOf("d-error")).toBeNull();
    expect(hashOf("d-pending")).toBeNull();
  });

  it("leaves content_hash intact on documents that did sync", () => {
    seedDoc("d-synced", "synced", "hash-synced");

    runMigrations(db);

    expect(hashOf("d-synced")).toBe("hash-synced");
  });

  it("adds the per-source sync-state columns", () => {
    runMigrations(db);

    const cols = (
      db.prepare("PRAGMA table_info(sources)").all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        "last_sync_at",
        "last_sync_status",
        "last_sync_error",
        "last_sync_error_count",
      ]),
    );

    const row = db.prepare("SELECT * FROM sources WHERE id = 's1'").get() as {
      last_sync_at: string | null;
      last_sync_error_count: number;
    };
    expect(row.last_sync_at).toBeNull();
    expect(row.last_sync_error_count).toBe(0);
  });
});

describe("migration v7", () => {
  let db: Database.Database;

  function getSetting(key: string): string | undefined {
    return (
      db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
        | { value: string }
        | undefined
    )?.value;
  }

  afterEach(() => db.close());

  it("backfills onboarding_complete for installs that already configured a provider", () => {
    db = createUnmigratedTestDb();
    migrateTo(db, 6);
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('embedding_provider', 'cohere')",
    ).run();

    runMigrations(db);

    expect(getSetting("onboarding_complete")).toBe("true");
  });

  it("leaves onboarding_complete unset on a fresh install with no provider configured", () => {
    db = createUnmigratedTestDb();

    runMigrations(db);

    expect(getSetting("onboarding_complete")).toBeUndefined();
  });

  it("does not overwrite an existing onboarding_complete value", () => {
    db = createUnmigratedTestDb();
    migrateTo(db, 6);
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('embedding_provider', 'cohere')",
    ).run();
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('onboarding_complete', 'false')",
    ).run();

    runMigrations(db);

    expect(getSetting("onboarding_complete")).toBe("false");
  });
});

describe("pre-migration backup", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "commons-mig-"));
    dbPath = join(dir, "commons.db");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("captures rows still sitting in the WAL", () => {
    const db = new DatabaseCtor(dbPath);
    db.pragma("journal_mode = WAL");
    migrateTo(db, 5);
    db.prepare(
      "INSERT INTO sources (id, provider, name, root_external_id, created_at) VALUES ('s1','notion','Only In WAL','ext1','2024-01-01T00:00:00Z')",
    ).run();

    runMigrations(db, dbPath);
    db.close();

    // A plain copyFileSync of the .db would miss this row entirely — it is
    // still in commons.db-wal at this point.
    const backup = new DatabaseCtor(`${dbPath}.pre-migration.bak`, {
      readonly: true,
    });
    const row = backup
      .prepare("SELECT name FROM sources WHERE id='s1'")
      .get() as { name: string } | undefined;
    backup.close();

    expect(row?.name).toBe("Only In WAL");
  });

  it("overwrites a backup left by a previous upgrade", () => {
    const db = new DatabaseCtor(dbPath);
    db.pragma("journal_mode = WAL");
    migrateTo(db, 5);
    db.prepare(
      "INSERT INTO sources (id, provider, name, root_external_id, created_at) VALUES ('s1','notion','S','ext1','2024-01-01T00:00:00Z')",
    ).run();

    // A stale backup from an earlier upgrade. VACUUM INTO refuses a target that
    // already exists, so this has to be cleared rather than fail the migration.
    writeFileSync(`${dbPath}.pre-migration.bak`, "stale garbage");

    expect(() => runMigrations(db, dbPath)).not.toThrow();
    db.close();

    expect(existsSync(`${dbPath}.pre-migration.bak`)).toBe(true);
    const backup = new DatabaseCtor(`${dbPath}.pre-migration.bak`, {
      readonly: true,
    });
    const count = (
      backup.prepare("SELECT COUNT(*) AS c FROM sources").get() as { c: number }
    ).c;
    backup.close();
    expect(count).toBe(1);
  });

  it("refuses to migrate when the backup cannot be written", () => {
    const db = new DatabaseCtor(dbPath);
    db.pragma("journal_mode = WAL");
    migrateTo(db, 5);

    // An unwritable backup target stands in for a full disk.
    const unwritable = join(dir, "no", "such", "dir", "commons.db");

    expect(() => runMigrations(db, unwritable)).toThrow(/Could not back up/);
    // The destructive migration must not have run.
    expect(currentVersion(db)).toBe(5);
    db.close();
  });
});

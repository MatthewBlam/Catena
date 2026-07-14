import Database from "better-sqlite3";
import { runMigrations } from "../migrations";

/**
 * An open database with the singleton's pragmas but no schema.
 * Only for tests that exercise `runMigrations` itself — everything else wants `createTestDb`.
 */
export function createUnmigratedTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("recursive_triggers = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

/** Mirrors src/main/db/singleton.ts exactly. If you change the pragmas there, change them here. */
export function createTestDb(): Database.Database {
  const db = createUnmigratedTestDb();
  runMigrations(db);
  return db;
}

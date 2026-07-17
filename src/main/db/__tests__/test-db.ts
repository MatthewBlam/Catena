import Database from "better-sqlite3";
import { runMigrations } from "../migrations";
import { applyPragmas } from "../singleton";

/**
 * An open database with the singleton's pragmas but no schema.
 * Only for tests that exercise `runMigrations` itself — everything else wants `createTestDb`.
 */
export function createUnmigratedTestDb(): Database.Database {
  const db = new Database(":memory:");
  applyPragmas(db);
  return db;
}

export function createTestDb(): Database.Database {
  const db = createUnmigratedTestDb();
  runMigrations(db);
  return db;
}

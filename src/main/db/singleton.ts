import Database from "better-sqlite3";
import { app } from "electron";
import { join } from "node:path";
import { renameSync } from "node:fs";
import { runMigrations } from "./migrations";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  const dbPath = join(app.getPath("userData"), "commons.db");

  try {
    _db = new Database(dbPath);
  } catch (err) {
    console.error("Database open failed, attempting corruption recovery:", err);
    const backupPath = `${dbPath}.corrupt.bak`;
    try {
      renameSync(dbPath, backupPath);
    } catch {
      // backup rename failed — file may not exist
    }
    _db = new Database(dbPath);
  }

  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  // Required for REPLACE-induced deletes to fire the chunks_fts delete trigger.
  _db.pragma("recursive_triggers = ON");
  _db.pragma("busy_timeout = 5000");

  runMigrations(_db, dbPath);
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

import Database from "better-sqlite3";
import { app } from "electron";
import { join } from "node:path";
import { existsSync, renameSync } from "node:fs";
import { runMigrations } from "./migrations";

let _db: Database.Database | null = null;

/** The -wal and -shm sidecars are only meaningful next to their own database file. */
const DB_SUFFIXES = ["", "-wal", "-shm"] as const;

/**
 * The four pragmas every handle onto this database must open with — production
 * or test. `recursive_triggers` is required for REPLACE-induced deletes to fire
 * the chunks_fts delete trigger (see upsertChunks in database.ts); the rest are
 * ordinary durability and lock-timeout settings. Exported so test-db.ts can
 * call the same function instead of keeping its own copy of this list in sync
 * by convention.
 */
export function applyPragmas(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("recursive_triggers = ON");
  db.pragma("busy_timeout = 5000");
}

/** Page-level damage that only a real read reveals. See `openAndVerify`. */
class CorruptDatabaseError extends Error {}

/**
 * Is this the database being damaged, or this build being unable to ask?
 *
 * Only the first justifies moving a user's corpus aside. An Electron upgrade
 * shipped with a `better-sqlite3` built for the wrong ABI fails here too — with
 * `ERR_DLOPEN_FAILED`, on a perfectly healthy file — and quarantining that would
 * empty the app for every user on the platform. Same for a permissions failure
 * or a full disk: the file is intact, we simply cannot read it right now, and
 * the honest response is to fail loudly (`index.ts` shows the message and quits)
 * rather than to silently displace data.
 *
 * SQLite reports the two genuine cases as `SQLITE_NOTADB` (the header is not a
 * database at all) and the `SQLITE_CORRUPT*` family (a malformed disk image).
 */
function isCorruption(err: unknown): boolean {
  if (err instanceof CorruptDatabaseError) return true;
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return (
    typeof code === "string" &&
    (code === "SQLITE_NOTADB" || code.startsWith("SQLITE_CORRUPT"))
  );
}

/**
 * Opens the database and proves it is actually readable.
 *
 * `new Database()` does not touch a single page — it succeeds on a file full of
 * garbage and only fails on the first real query. So opening is not evidence of
 * anything; we have to ask. quick_check, not integrity_check: it catches the
 * page-level damage that matters at open time and takes seconds rather than
 * minutes on a large corpus.
 */
function openAndVerify(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  try {
    applyPragmas(db);

    const result = db.pragma("quick_check", { simple: true });
    if (result !== "ok") {
      throw new CorruptDatabaseError(`quick_check reported: ${String(result)}`);
    }
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/**
 * Moves a corrupt database aside, sidecars included. Renaming only the .db would
 * leave a stale -wal to be replayed into the fresh database we create next.
 *
 * Closing the handle usually makes SQLite clean up the sidecars for us, so this
 * loop is mostly for the case it cannot: a -wal/-shm left behind by a process
 * that was killed, sitting next to a .db too damaged to open.
 */
function quarantine(dbPath: string): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const suffix of DB_SUFFIXES) {
    const from = `${dbPath}${suffix}`;
    if (!existsSync(from)) continue;
    renameSync(from, `${dbPath}.corrupt-${stamp}.bak${suffix}`);
  }
}

export function getDb(): Database.Database {
  if (_db) return _db;
  const dbPath = join(app.getPath("userData"), "catena.db");

  let db: Database.Database;
  try {
    db = openAndVerify(dbPath);
  } catch (err) {
    // Anything that is not damage to the file leaves it alone and takes the app
    // down with a real message — see `isCorruption`.
    if (!isCorruption(err)) throw err;
    console.error(
      "Database is corrupt; quarantining and starting fresh:",
      err,
    );
    quarantine(dbPath);
    db = openAndVerify(dbPath);
  }

  // Deliberately outside the catch above. A migration failure — a database from
  // a newer build, or a backup we could not write — means the file is intact and
  // we simply must not touch it. Quarantining on those would destroy a healthy
  // corpus because the user downgraded the app or ran low on disk.
  //
  // The handle still has to go, though: `_db` is never assigned on this path, so
  // `closeDb()` cannot reach it and nothing else ever will. On macOS that is
  // merely untidy — the process is about to die anyway — but on Windows an open
  // handle holds a lock on the file, blocking anything that tries to move or
  // delete it for as long as we are alive.
  try {
    runMigrations(db, dbPath);
  } catch (err) {
    db.close();
    throw err;
  }

  _db = db;
  return _db;
}

/**
 * Rebuilds the FTS index if it has drifted from the chunks table. O(corpus), so
 * this is a Settings action — never run it on boot.
 *
 * The `1` argument is load-bearing. Bare 'integrity-check' only verifies that the
 * index is internally self-consistent, which it happily is when it disagrees with
 * the content table — the exact drift this function exists to repair. Passing 1
 * (via the `rank` column, per the FTS5 API) compares index against content.
 */
export function repairFtsIndex(db: Database.Database): "ok" | "rebuilt" {
  try {
    db.prepare(
      "INSERT INTO chunks_fts(chunks_fts, rank) VALUES('integrity-check', 1)",
    ).run();
    return "ok";
  } catch {
    db.prepare("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')").run();
    return "rebuilt";
  }
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

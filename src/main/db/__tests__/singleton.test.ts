import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const h = vi.hoisted(() => ({ userData: "" }));
vi.mock("electron", () => ({
  app: { getPath: (): string => h.userData },
}));

import { getDb, closeDb, repairFtsIndex } from "../singleton";
import { migrations } from "../migrations";

const LATEST = Math.max(...migrations.map((m) => m.version));

let dbPath: string;

function quarantinedFiles(): string[] {
  return readdirSync(h.userData).filter((f) => f.includes(".corrupt-"));
}

beforeEach(() => {
  h.userData = mkdtempSync(join(tmpdir(), "commons-singleton-"));
  dbPath = join(h.userData, "commons.db");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  closeDb();
  rmSync(h.userData, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("getDb", () => {
  it("creates and migrates a fresh database", () => {
    const db = getDb();
    const version = (
      db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as {
        v: number;
      }
    ).v;
    expect(version).toBe(LATEST);
    expect(quarantinedFiles()).toEqual([]);
  });

  it("sets the pragmas the FTS triggers depend on", () => {
    const db = getDb();
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("recursive_triggers", { simple: true })).toBe(1);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it("returns the same instance on repeated calls", () => {
    expect(getDb()).toBe(getDb());
  });
});

describe("corruption recovery", () => {
  it("quarantines a file that is not a database and starts fresh", () => {
    writeFileSync(dbPath, "this is not a sqlite database");

    const db = getDb();

    // Usable, migrated, empty.
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM sources").get() as { c: number })
        .c,
    ).toBe(0);

    const moved = quarantinedFiles();
    expect(moved).toHaveLength(1);
    expect(readFileSync(join(h.userData, moved[0]), "utf8")).toBe(
      "this is not a sqlite database",
    );
  });

  it("quarantines page-level corruption that opening alone would not reveal", () => {
    const seed = new Database(dbPath);
    seed.pragma("journal_mode = DELETE"); // fold everything into the .db
    seed.exec("CREATE TABLE big (id INTEGER PRIMARY KEY, blob TEXT)");
    const ins = seed.prepare("INSERT INTO big (blob) VALUES (?)");
    for (let i = 0; i < 500; i++) ins.run("x".repeat(200));
    seed.close();

    // Scribble over interior pages, leaving the header intact — so the file
    // still *opens* fine and only a real read finds the damage.
    const bytes = readFileSync(dbPath);
    bytes.fill(0xff, 4096, Math.min(bytes.length, 24576));
    writeFileSync(dbPath, bytes);

    // Precondition: this is the audit's point — opening is not a check.
    const lazily = new Database(dbPath);
    expect(lazily).toBeTruthy();
    lazily.close();

    const db = getDb();

    expect(quarantinedFiles().length).toBeGreaterThan(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM sources").get() as { c: number })
        .c,
    ).toBe(0);
  });

  it("leaves no stale sidecar behind for the fresh database to replay", () => {
    writeFileSync(dbPath, "not a database");
    writeFileSync(`${dbPath}-wal`, "stale wal");
    writeFileSync(`${dbPath}-shm`, "stale shm");

    const db = getDb();

    // The fresh database is in WAL mode, so it has sidecars of its own. What
    // must not survive is the *stale* content sitting next to it.
    for (const suffix of ["-wal", "-shm"]) {
      const live = `${dbPath}${suffix}`;
      if (!existsSync(live)) continue;
      expect(readFileSync(live, "utf8")).not.toContain("stale");
    }

    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM sources").get() as { c: number })
        .c,
    ).toBe(0);
  });

  it("does NOT quarantine a healthy database from a newer build", () => {
    const seed = new Database(dbPath);
    seed.exec(`CREATE TABLE schema_version (
      version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
    seed
      .prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)")
      .run(999, "2099-01-01T00:00:00Z");
    seed.close();

    // Downgrading the app must not cost the user their corpus.
    expect(() => getDb()).toThrow(/newer version of Commons/);
    expect(quarantinedFiles()).toEqual([]);
    expect(existsSync(dbPath)).toBe(true);
  });
});

describe("repairFtsIndex", () => {
  it("reports ok on a consistent index", () => {
    expect(repairFtsIndex(getDb())).toBe("ok");
  });

  it("rebuilds an index that has drifted from the chunks table", () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO sources (id, provider, name, root_external_id, created_at) VALUES ('s1','notion','S','ext1','2024-01-01T00:00:00Z')",
    ).run();
    db.prepare(
      `INSERT INTO documents (id, source_id, provider, external_id, title, sync_status)
       VALUES ('d1','s1','notion','e1','Doc','synced')`,
    ).run();
    db.prepare(
      `INSERT INTO chunks (id, document_id, chunk_index, text, created_at)
       VALUES ('c1','d1',0,'zebra','2024-01-01T00:00:00Z')`,
    ).run();

    // Corrupt the index behind the triggers' back.
    db.prepare("INSERT INTO chunks_fts(chunks_fts) VALUES('delete-all')").run();
    expect(repairFtsIndex(db)).toBe("rebuilt");

    const hit = db
      .prepare(
        "SELECT c.id FROM chunks_fts f JOIN chunks c ON c.rowid = f.rowid WHERE chunks_fts MATCH 'zebra'",
      )
      .get() as { id: string } | undefined;
    expect(hit?.id).toBe("c1");
  });
});

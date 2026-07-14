import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { runMigrations } from "../migrations";
import { createTestDb, createUnmigratedTestDb } from "./test-db";
import {
  insertSource,
  getSourceById,
  getAllSources,
  getAllSourcesWithCounts,
  deleteSource,
  getSourceByProviderAndRoot,
  insertDocument,
  getDocumentsBySourceId,
  getDocumentByExternalId,
  updateDocumentSyncStatus,
  upsertChunks,
  getChunksByDocumentId,
  upsertSetting,
  getSetting,
  getStorageStats,
  clearAllData,
  getEmbeddingHealth,
  getChunkCountByModel,
  replaceChunksForDocument,
  deleteChunksByDocumentId,
  searchFts,
  type ChunkRow,
} from "../database";

describe("migrations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createUnmigratedTestDb();
  });

  afterEach(() => db.close());

  it("creates all tables on fresh database", () => {
    runMigrations(db);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("sources");
    expect(names).toContain("documents");
    expect(names).toContain("chunks");
    expect(names).toContain("settings");
    expect(names).toContain("schema_version");
  });

  it("is idempotent — running twice does not error", () => {
    runMigrations(db);
    runMigrations(db);
  });

  it("creates embedding_model index in migration v4", () => {
    runMigrations(db);
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_chunks_embedding_model'",
      )
      .all() as { name: string }[];
    expect(indexes).toHaveLength(1);
  });

  it("cascades deletes from sources to documents and chunks", () => {
    runMigrations(db);
    insertSource(db, {
      id: "s1",
      provider: "notion",
      name: "Test",
      rootExternalId: "ext1",
      createdAt: new Date().toISOString(),
    });
    insertDocument(db, {
      id: "d1",
      sourceId: "s1",
      provider: "notion",
      externalId: "e1",
      title: "Doc 1",
      url: null,
      mimeType: null,
      modifiedAt: null,
      contentHash: null,
      lastSyncedAt: null,
      syncStatus: "synced",
    });
    upsertChunks(db, [
      {
        id: "c1",
        documentId: "d1",
        chunkIndex: 0,
        heading: null,
        text: "hello",
        embedding: null,
        embeddingModel: null,
        tokenCount: 1,
        createdAt: new Date().toISOString(),
      },
    ]);

    deleteSource(db, "s1");

    expect(getDocumentsBySourceId(db, "s1")).toHaveLength(0);
    expect(getChunksByDocumentId(db, "d1")).toHaveLength(0);
  });
});

describe("sources", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  it("inserts and retrieves a source", () => {
    insertSource(db, {
      id: "s1",
      provider: "notion",
      name: "Test Source",
      rootExternalId: "ext1",
      createdAt: "2024-01-01T00:00:00Z",
    });
    const source = getSourceById(db, "s1");
    expect(source).not.toBeNull();
    expect(source!.name).toBe("Test Source");
    expect(source!.provider).toBe("notion");
  });

  it("lists all sources", () => {
    insertSource(db, {
      id: "s1",
      provider: "notion",
      name: "Source 1",
      rootExternalId: "ext1",
      createdAt: "2024-01-01T00:00:00Z",
    });
    insertSource(db, {
      id: "s2",
      provider: "google_drive",
      name: "Source 2",
      rootExternalId: "ext2",
      createdAt: "2024-01-02T00:00:00Z",
    });
    expect(getAllSources(db)).toHaveLength(2);
  });
});

describe("documents", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
    insertSource(db, {
      id: "s1",
      provider: "notion",
      name: "Test",
      rootExternalId: "ext1",
      createdAt: "2024-01-01T00:00:00Z",
    });
  });
  afterEach(() => db.close());

  it("inserts and retrieves documents by source", () => {
    insertDocument(db, {
      id: "d1",
      sourceId: "s1",
      provider: "notion",
      externalId: "e1",
      title: "Doc 1",
      url: "https://notion.so/doc1",
      mimeType: "text/plain",
      modifiedAt: "2024-01-01T00:00:00Z",
      contentHash: "abc123",
      lastSyncedAt: "2024-01-01T00:00:00Z",
      syncStatus: "synced",
    });
    const docs = getDocumentsBySourceId(db, "s1");
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe("Doc 1");
  });

  it("finds document by external ID", () => {
    insertDocument(db, {
      id: "d1",
      sourceId: "s1",
      provider: "notion",
      externalId: "e1",
      title: "Doc 1",
      url: null,
      mimeType: null,
      modifiedAt: null,
      contentHash: null,
      lastSyncedAt: null,
      syncStatus: "pending",
    });
    const doc = getDocumentByExternalId(db, "s1", "e1");
    expect(doc).not.toBeNull();
    expect(doc!.id).toBe("d1");
  });

  it("updates sync status", () => {
    insertDocument(db, {
      id: "d1",
      sourceId: "s1",
      provider: "notion",
      externalId: "e1",
      title: "Doc 1",
      url: null,
      mimeType: null,
      modifiedAt: null,
      contentHash: null,
      lastSyncedAt: null,
      syncStatus: "pending",
    });
    updateDocumentSyncStatus(db, "d1", "synced");
    const doc = getDocumentByExternalId(db, "s1", "e1");
    expect(doc!.syncStatus).toBe("synced");
  });
});

describe("settings", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  it("round-trips a setting value", () => {
    upsertSetting(db, "embedding_provider", "cohere");
    expect(getSetting(db, "embedding_provider")).toBe("cohere");
  });

  it("upserts existing setting", () => {
    upsertSetting(db, "key", "v1");
    upsertSetting(db, "key", "v2");
    expect(getSetting(db, "key")).toBe("v2");
  });

  it("returns null for missing key", () => {
    expect(getSetting(db, "nonexistent")).toBeNull();
  });
});

function seedFixtures(db: Database.Database): void {
  insertSource(db, {
    id: "s1",
    provider: "notion",
    name: "Source 1",
    rootExternalId: "ext1",
    createdAt: "2024-01-01T00:00:00Z",
  });
  insertDocument(db, {
    id: "d1",
    sourceId: "s1",
    provider: "notion",
    externalId: "e1",
    title: "Doc 1",
    url: null,
    mimeType: null,
    modifiedAt: null,
    contentHash: null,
    lastSyncedAt: null,
    syncStatus: "synced",
  });
  upsertChunks(db, [
    {
      id: "c1",
      documentId: "d1",
      chunkIndex: 0,
      heading: null,
      text: "chunk one",
      embedding: Buffer.alloc(12),
      embeddingModel: "embed-v4.0",
      tokenCount: 2,
      createdAt: "2024-01-01T00:00:00Z",
    },
    {
      id: "c2",
      documentId: "d1",
      chunkIndex: 1,
      heading: null,
      text: "chunk two",
      embedding: Buffer.alloc(12),
      embeddingModel: "nomic-embed-text",
      tokenCount: 2,
      createdAt: "2024-01-01T00:00:00Z",
    },
  ]);
  upsertSetting(db, "embedding_provider", "cohere");
}

describe("getStorageStats", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  it("returns all zeros on empty database", () => {
    const stats = getStorageStats(db);
    expect(stats).toEqual({ sourceCount: 0, documentCount: 0, chunkCount: 0 });
  });

  it("returns correct counts with data", () => {
    seedFixtures(db);
    const stats = getStorageStats(db);
    expect(stats).toEqual({ sourceCount: 1, documentCount: 1, chunkCount: 2 });
  });
});

describe("clearAllData", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  it("removes all data from all tables", () => {
    seedFixtures(db);
    clearAllData(db);
    expect(getStorageStats(db)).toEqual({
      sourceCount: 0,
      documentCount: 0,
      chunkCount: 0,
    });
    expect(getSetting(db, "embedding_provider")).toBeNull();
  });
});

describe("getEmbeddingHealth", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  it("returns zeros with no chunks", () => {
    const health = getEmbeddingHealth(db);
    expect(health.totalChunks).toBe(0);
    expect(health.distinctModels).toEqual([]);
  });

  it("returns correct counts with mixed models", () => {
    seedFixtures(db);
    const health = getEmbeddingHealth(db);
    expect(health.totalChunks).toBe(2);
    expect(health.distinctModels).toHaveLength(2);
    expect(health.distinctModels).toContain("embed-v4.0");
    expect(health.distinctModels).toContain("nomic-embed-text");
  });
});

describe("replaceChunksForDocument", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
    seedFixtures(db);
  });
  afterEach(() => db.close());

  it("atomically replaces chunks and updates sync status", () => {
    const newChunks = [
      {
        id: "c3",
        documentId: "d1",
        chunkIndex: 0,
        heading: "New Heading",
        text: "replaced chunk",
        embedding: Buffer.alloc(12),
        embeddingModel: "embed-v4.0",
        tokenCount: 2,
        createdAt: "2024-01-02T00:00:00Z",
      },
    ];

    replaceChunksForDocument(db, "d1", newChunks, "synced");

    const chunks = getChunksByDocumentId(db, "d1");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].id).toBe("c3");
    expect(chunks[0].text).toBe("replaced chunk");

    const doc = getDocumentByExternalId(db, "s1", "e1");
    expect(doc!.syncStatus).toBe("synced");
  });
});

describe("insertDocument ON CONFLICT preserves chunks", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
    seedFixtures(db);
  });
  afterEach(() => db.close());

  it("updating document metadata does not delete existing chunks", () => {
    const chunksBefore = getChunksByDocumentId(db, "d1");
    expect(chunksBefore).toHaveLength(2);

    insertDocument(db, {
      id: "d1",
      sourceId: "s1",
      provider: "notion",
      externalId: "e1",
      title: "Updated Title",
      url: "https://notion.so/updated",
      mimeType: null,
      modifiedAt: null,
      contentHash: "newhash",
      lastSyncedAt: null,
      syncStatus: "synced",
    });

    const chunksAfter = getChunksByDocumentId(db, "d1");
    expect(chunksAfter).toHaveLength(2);
    expect(chunksAfter[0].id).toBe("c1");
    expect(chunksAfter[1].id).toBe("c2");

    const doc = getDocumentByExternalId(db, "s1", "e1");
    expect(doc!.title).toBe("Updated Title");
    expect(doc!.contentHash).toBe("newhash");
  });
});

describe("getAllSourcesWithCounts", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  it("returns sources with document counts in a single query", () => {
    seedFixtures(db);
    insertSource(db, {
      id: "s2",
      provider: "google_drive",
      name: "Empty Source",
      rootExternalId: "ext2",
      createdAt: "2024-01-02T00:00:00Z",
    });

    const results = getAllSourcesWithCounts(db);
    expect(results).toHaveLength(2);

    const s2 = results.find((s) => s.id === "s2")!;
    expect(s2.documentCount).toBe(0);

    const s1 = results.find((s) => s.id === "s1")!;
    expect(s1.documentCount).toBe(1);
  });
});

describe("getSourceByProviderAndRoot", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
    seedFixtures(db);
  });
  afterEach(() => db.close());

  it("finds existing source by provider and root", () => {
    const source = getSourceByProviderAndRoot(db, "notion", "ext1");
    expect(source).not.toBeNull();
    expect(source!.id).toBe("s1");
    expect(source!.name).toBe("Source 1");
  });

  it("returns null for non-matching provider/root", () => {
    expect(getSourceByProviderAndRoot(db, "notion", "nonexistent")).toBeNull();
    expect(getSourceByProviderAndRoot(db, "google_drive", "ext1")).toBeNull();
  });
});

describe("getChunkCountByModel", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  it("returns 0 for non-matching model", () => {
    seedFixtures(db);
    expect(getChunkCountByModel(db, "unknown-model")).toBe(0);
  });

  it("returns correct count for a specific model", () => {
    seedFixtures(db);
    expect(getChunkCountByModel(db, "embed-v4.0")).toBe(1);
    expect(getChunkCountByModel(db, "nomic-embed-text")).toBe(1);
  });
});

describe("upsertChunks FTS consistency", () => {
  let db: Database.Database;

  function chunk(id: string, text: string): ChunkRow {
    return {
      id,
      documentId: "d1",
      chunkIndex: 0,
      heading: null,
      text,
      embedding: null,
      embeddingModel: null,
      tokenCount: 2,
      createdAt: "2024-01-01T00:00:00Z",
    };
  }

  function rowidOf(id: string): number {
    return (
      db.prepare("SELECT rowid FROM chunks WHERE id = ?").get(id) as {
        rowid: number;
      }
    ).rowid;
  }

  beforeEach(() => {
    db = createTestDb();
    insertSource(db, {
      id: "s1",
      provider: "notion",
      name: "Source 1",
      rootExternalId: "ext1",
      createdAt: "2024-01-01T00:00:00Z",
    });
    insertDocument(db, {
      id: "d1",
      sourceId: "s1",
      provider: "notion",
      externalId: "e1",
      title: "Doc 1",
      url: null,
      mimeType: null,
      modifiedAt: null,
      contentHash: null,
      lastSyncedAt: null,
      syncStatus: "synced",
    });
  });
  afterEach(() => db.close());

  // INSERT OR REPLACE deletes the old row and inserts a new one, moving the
  // rowid. ON CONFLICT DO UPDATE edits in place. The FTS index is keyed by
  // rowid, so stability here is what keeps it in sync.
  it("preserves the chunk rowid when overwriting an existing id", () => {
    upsertChunks(db, [chunk("c1", "zebra original")]);
    const before = rowidOf("c1");

    upsertChunks(db, [chunk("c1", "giraffe replacement")]);

    expect(rowidOf("c1")).toBe(before);
  });

  it("removes the old text from the FTS index on overwrite", () => {
    upsertChunks(db, [chunk("c1", "zebra original")]);
    upsertChunks(db, [chunk("c1", "giraffe replacement")]);

    expect(searchFts(db, "zebra", 10)).toEqual([]);
    expect(searchFts(db, "giraffe", 10).map((c) => c.id)).toEqual(["c1"]);
  });

  // The orphaned FTS row left behind by INSERT OR REPLACE points at a rowid
  // SQLite will hand to an unrelated chunk later, and the stale term then
  // matches that chunk's row — a hit whose text does not contain the query.
  // PRAGMA integrity_check and FTS 'integrity-check' both report "ok".
  it("does not leak stale terms onto a recycled rowid", () => {
    // Belt-and-braces: upsertChunks must hold even if the singleton's
    // recursive_triggers pragma is ever dropped.
    db.pragma("recursive_triggers = OFF");

    upsertChunks(db, [chunk("c1", "zebra original")]);
    upsertChunks(db, [chunk("c1", "giraffe replacement")]);

    // Empty the table so the next insert reuses the low rowid.
    deleteChunksByDocumentId(db, "d1");
    upsertChunks(db, [chunk("c2", "penguin unrelated")]);

    expect(searchFts(db, "zebra", 10)).toEqual([]);
  });
});

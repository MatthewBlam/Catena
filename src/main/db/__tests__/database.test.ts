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
  getDocumentById,
  deleteDocumentsByIds,
  iterateChunksWithEmbeddingsByModel,
  updateSourceSyncState,
  resetStalePendingDocuments,
  upsertRecentSearch,
  listRecentSearches,
  getRecentSearchById,
  deleteRecentSearch,
  pruneExpiredRecentSearches,
  saveRecentSearchFromResponse,
  type ChunkRow,
  type RecentSearchSnapshot,
} from "../database";
import type { SearchResponse, SearchResult } from "../../../shared/types";

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

function makeSnapshot(resultCount: number): RecentSearchSnapshot {
  const results: SearchResult[] = Array.from(
    { length: resultCount },
    (_, i) => ({
      chunkId: `c${i}`,
      documentTitle: `Doc ${i}`,
      snippet: `snippet ${i}`,
      heading: null,
      url: null,
      provider: "notion",
      score: 1,
    }),
  );
  return { results };
}

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

  it("empties recent_searches", () => {
    upsertRecentSearch(db, "club events", makeSnapshot(1));
    clearAllData(db);
    expect(listRecentSearches(db)).toEqual([]);
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

    replaceChunksForDocument(db, "d1", newChunks, "synced", "hash-v2");

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

describe("clearAllData preserves telemetry identity (H4)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  it("keeps the telemetry opt-out and the device id, and drops everything else", () => {
    seedFixtures(db);
    upsertSetting(db, "telemetry_enabled", "false");
    upsertSetting(db, "device_id", "device-abc");

    clearAllData(db);

    // posthog.ts reads this as `!== "false"`, so losing the row silently turns
    // telemetry back on for someone who explicitly turned it off.
    expect(getSetting(db, "telemetry_enabled")).toBe("false");
    expect(getSetting(db, "device_id")).toBe("device-abc");

    expect(getSetting(db, "embedding_provider")).toBeNull();
    expect(getStorageStats(db)).toEqual({
      sourceCount: 0,
      documentCount: 0,
      chunkCount: 0,
    });
  });
});

describe("replaceChunksForDocument content-hash invariant", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
    seedFixtures(db);
  });
  afterEach(() => db.close());

  it("commits the hash in the same transaction as the chunks", () => {
    replaceChunksForDocument(
      db,
      "d1",
      [
        {
          id: "c9",
          documentId: "d1",
          chunkIndex: 0,
          heading: null,
          text: "fresh",
          embedding: Buffer.alloc(12),
          embeddingModel: "embed-v4.0",
          tokenCount: 1,
          createdAt: "2024-01-02T00:00:00Z",
        },
      ],
      "synced",
      "hash-v2",
    );

    expect(getDocumentById(db, "d1")!.contentHash).toBe("hash-v2");
    expect(getChunksByDocumentId(db, "d1").map((c) => c.id)).toEqual(["c9"]);
  });

  it("commits a hash alongside zero chunks for an empty document", () => {
    replaceChunksForDocument(db, "d1", [], "synced", "hash-empty");

    expect(getDocumentById(db, "d1")!.contentHash).toBe("hash-empty");
    expect(getChunksByDocumentId(db, "d1")).toHaveLength(0);
  });

  it("updateDocumentSyncStatus leaves content_hash alone for the error path", () => {
    replaceChunksForDocument(db, "d1", [], "synced", "hash-v2");

    updateDocumentSyncStatus(db, "d1", "error");

    const doc = getDocumentById(db, "d1")!;
    expect(doc.syncStatus).toBe("error");
    expect(doc.contentHash).toBe("hash-v2");
  });
});

describe("resetStalePendingDocuments", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
    seedFixtures(db);
  });
  afterEach(() => db.close());

  it("clears the hash of a document left pending by a crash", () => {
    // A doc interrupted mid-sync: hash written, chunks never landed.
    db.prepare(
      "UPDATE documents SET sync_status = 'pending', content_hash = 'half-written' WHERE id = 'd1'",
    ).run();

    expect(resetStalePendingDocuments(db)).toBe(1);

    const doc = getDocumentById(db, "d1")!;
    expect(doc.syncStatus).toBe("error");
    expect(doc.contentHash).toBeNull();
  });
});

describe("deleteDocumentsByIds", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
    seedFixtures(db);
  });
  afterEach(() => db.close());

  it("cascades to chunks and to the FTS index", () => {
    expect(searchFts(db, "chunk", 10).length).toBeGreaterThan(0);

    expect(deleteDocumentsByIds(db, ["d1"])).toBe(1);

    expect(getDocumentById(db, "d1")).toBeNull();
    expect(getChunksByDocumentId(db, "d1")).toHaveLength(0);
    expect(searchFts(db, "chunk", 10)).toEqual([]);
  });

  it("returns 0 and touches nothing for an empty id list", () => {
    expect(deleteDocumentsByIds(db, [])).toBe(0);
    expect(getStorageStats(db).documentCount).toBe(1);
  });

  it("handles more ids than the 500-per-statement batch", () => {
    const ids: string[] = [];
    for (let i = 0; i < 1200; i++) {
      const id = `bulk-${i}`;
      ids.push(id);
      insertDocument(db, {
        id,
        sourceId: "s1",
        provider: "notion",
        externalId: `bulk-e${i}`,
        title: `Bulk ${i}`,
        url: null,
        mimeType: null,
        modifiedAt: null,
        contentHash: null,
        lastSyncedAt: null,
        syncStatus: "synced",
      });
    }

    expect(deleteDocumentsByIds(db, ids)).toBe(1200);
    expect(getStorageStats(db).documentCount).toBe(1); // d1 survives
  });
});

describe("iterateChunksWithEmbeddingsByModel", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
    seedFixtures(db);
  });
  afterEach(() => db.close());

  it("streams only the chunks embedded with the given model", () => {
    const ids = [...iterateChunksWithEmbeddingsByModel(db, "embed-v4.0")].map(
      (c) => c.id,
    );
    expect(ids).toEqual(["c1"]);
  });

  it("skips chunks that have no embedding", () => {
    upsertChunks(db, [
      {
        id: "c-noembed",
        documentId: "d1",
        chunkIndex: 5,
        heading: null,
        text: "not embedded",
        embedding: null,
        embeddingModel: "embed-v4.0",
        tokenCount: 1,
        createdAt: "2024-01-01T00:00:00Z",
      },
    ]);

    const ids = [...iterateChunksWithEmbeddingsByModel(db, "embed-v4.0")].map(
      (c) => c.id,
    );
    expect(ids).toEqual(["c1"]);
  });

  it("can be abandoned partway without exhausting the statement", () => {
    for (const chunk of iterateChunksWithEmbeddingsByModel(db, "embed-v4.0")) {
      expect(chunk.id).toBe("c1");
      break;
    }
    // The db must still be usable — a leaked iterator would hold the statement open.
    expect(getStorageStats(db).chunkCount).toBe(2);
  });
});

describe("getChunkCountByModel", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
    seedFixtures(db);
  });
  afterEach(() => db.close());

  it("does not count chunks that carry the model name but no embedding", () => {
    upsertChunks(db, [
      {
        id: "c-noembed",
        documentId: "d1",
        chunkIndex: 5,
        heading: null,
        text: "not embedded",
        embedding: null,
        embeddingModel: "embed-v4.0",
        tokenCount: 1,
        createdAt: "2024-01-01T00:00:00Z",
      },
    ]);

    expect(getChunkCountByModel(db, "embed-v4.0")).toBe(1);
  });
});

describe("updateSourceSyncState (H3)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
    seedFixtures(db);
  });
  afterEach(() => db.close());

  it("defaults to no recorded sync", () => {
    const source = getSourceById(db, "s1")!;
    expect(source.lastSyncAt).toBeNull();
    expect(source.lastSyncStatus).toBeNull();
    expect(source.lastSyncError).toBeNull();
    expect(source.lastSyncErrorCount).toBe(0);
  });

  it("round-trips through getAllSourcesWithCounts", () => {
    updateSourceSyncState(db, "s1", {
      lastSyncAt: "2024-02-01T00:00:00Z",
      lastSyncStatus: "partial",
      lastSyncError: "Cohere rate limit",
      lastSyncErrorCount: 3,
    });

    const source = getAllSourcesWithCounts(db).find((s) => s.id === "s1")!;
    expect(source.lastSyncAt).toBe("2024-02-01T00:00:00Z");
    expect(source.lastSyncStatus).toBe("partial");
    expect(source.lastSyncError).toBe("Cohere rate limit");
    expect(source.lastSyncErrorCount).toBe(3);
    expect(source.documentCount).toBe(1);
  });

  it("no-ops when the source was removed mid-sync", () => {
    deleteSource(db, "s1");
    expect(() =>
      updateSourceSyncState(db, "s1", {
        lastSyncAt: "2024-02-01T00:00:00Z",
        lastSyncStatus: "ok",
        lastSyncError: null,
        lastSyncErrorCount: 0,
      }),
    ).not.toThrow();
  });
});

describe("recent searches", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  it("re-upsert with a differently-cased/spaced query updates the same row, keeping id/created_at", () => {
    upsertRecentSearch(
      db,
      "  Foo  BAR ",
      makeSnapshot(1),
      "2024-01-01T00:00:00.000Z",
    );
    const original = listRecentSearches(db)[0];

    upsertRecentSearch(
      db,
      "foo bar",
      makeSnapshot(3),
      "2024-01-02T00:00:00.000Z",
    );

    const list = listRecentSearches(db);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(original.id);
    expect(list[0].createdAt).toBe(original.createdAt);
    expect(list[0].resultCount).toBe(3);
    expect(list[0].updatedAt).toBe("2024-01-02T00:00:00.000Z");

    const detail = getRecentSearchById(db, original.id);
    expect(detail?.createdAt).toBe(original.createdAt);
  });

  it("distinct queries create distinct entries, newest first", () => {
    upsertRecentSearch(
      db,
      "alpha",
      makeSnapshot(1),
      "2024-01-01T00:00:00.000Z",
    );
    upsertRecentSearch(db, "beta", makeSnapshot(1), "2024-01-02T00:00:00.000Z");
    upsertRecentSearch(
      db,
      "gamma",
      makeSnapshot(1),
      "2024-01-03T00:00:00.000Z",
    );

    expect(listRecentSearches(db).map((r) => r.query)).toEqual([
      "gamma",
      "beta",
      "alpha",
    ]);
  });

  it("returns every stored row when no limit is given", () => {
    for (let i = 0; i < 12; i++) {
      upsertRecentSearch(
        db,
        `query-${i}`,
        makeSnapshot(1),
        new Date(Date.UTC(2024, 0, 1, 0, 0, i)).toISOString(),
      );
    }

    expect(listRecentSearches(db)).toHaveLength(12);
  });

  it("caps at 50 rows, evicting the oldest on the 51st distinct query", () => {
    for (let i = 0; i < 51; i++) {
      upsertRecentSearch(
        db,
        `query-${i}`,
        makeSnapshot(1),
        new Date(Date.UTC(2024, 0, 1, 0, 0, i)).toISOString(),
      );
    }

    const list = listRecentSearches(db, 100);
    expect(list).toHaveLength(50);
    const queries = list.map((r) => r.query);
    expect(queries).not.toContain("query-0");
    expect(queries).toContain("query-1");
    expect(queries).toContain("query-50");
  });

  it("prune boundary: kept exactly at the 7-day cutoff, deleted 1ms past it; returns the deleted count", () => {
    const nowMs = Date.parse("2024-01-08T00:00:00.000Z");
    const cutoffIso = new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString();

    upsertRecentSearch(db, "kept", makeSnapshot(1), cutoffIso);
    upsertRecentSearch(
      db,
      "expired",
      makeSnapshot(1),
      new Date(Date.parse(cutoffIso) - 1).toISOString(),
    );

    const deletedCount = pruneExpiredRecentSearches(db, nowMs);

    expect(deletedCount).toBe(1);
    expect(listRecentSearches(db).map((r) => r.query)).toEqual(["kept"]);
  });

  it("re-upserting an old entry rescues it from a later prune", () => {
    const nowMs = Date.parse("2024-01-08T00:00:00.000Z");
    upsertRecentSearch(
      db,
      "stale",
      makeSnapshot(1),
      "2024-01-01T00:00:00.000Z",
    );

    // Bring it forward, inside the retention window, before the prune runs.
    upsertRecentSearch(
      db,
      "stale",
      makeSnapshot(2),
      "2024-01-07T12:00:00.000Z",
    );

    const deletedCount = pruneExpiredRecentSearches(db, nowMs);
    expect(deletedCount).toBe(0);
    expect(listRecentSearches(db)).toHaveLength(1);
  });

  it("getRecentSearchById round-trips, and returns null for a missing id or corrupt JSON", () => {
    upsertRecentSearch(
      db,
      "roundtrip",
      makeSnapshot(2),
      "2024-01-01T00:00:00.000Z",
    );
    const row = listRecentSearches(db)[0];

    const detail = getRecentSearchById(db, row.id);
    expect(detail).not.toBeNull();
    expect(detail?.query).toBe("roundtrip");
    expect(detail?.results).toHaveLength(2);

    expect(getRecentSearchById(db, "does-not-exist")).toBeNull();

    db.prepare("UPDATE recent_searches SET response_json = ? WHERE id = ?").run(
      "{not valid json",
      row.id,
    );
    expect(getRecentSearchById(db, row.id)).toBeNull();
  });

  it("deleteRecentSearch removes exactly the targeted row", () => {
    upsertRecentSearch(db, "one", makeSnapshot(1), "2024-01-01T00:00:00.000Z");
    upsertRecentSearch(db, "two", makeSnapshot(1), "2024-01-02T00:00:00.000Z");
    const [keep, remove] = listRecentSearches(db);

    deleteRecentSearch(db, remove.id);

    const remaining = listRecentSearches(db);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(keep.id);
  });

  it("saveRecentSearchFromResponse saves on results, refuses empty/cancelled, and returns false (not throw) on DB failure", () => {
    const okResponse: SearchResponse = {
      results: makeSnapshot(1).results,
      rerankFailed: false,
    };
    expect(saveRecentSearchFromResponse(db, "hello", okResponse)).toBe(true);
    expect(listRecentSearches(db)).toHaveLength(1);

    const emptyResponse: SearchResponse = { results: [], rerankFailed: false };
    expect(saveRecentSearchFromResponse(db, "empty", emptyResponse)).toBe(
      false,
    );

    const cancelledResponse: SearchResponse = {
      results: makeSnapshot(1).results,
      rerankFailed: false,
      cancelled: true,
    };
    expect(
      saveRecentSearchFromResponse(db, "cancelled", cancelledResponse),
    ).toBe(false);
    expect(listRecentSearches(db)).toHaveLength(1);

    db.exec("DROP TABLE recent_searches");
    expect(saveRecentSearchFromResponse(db, "boom", okResponse)).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../../db/__tests__/test-db";
import {
  insertSource,
  getDocumentsBySourceId,
  getChunksByDocumentId,
  getDocumentByExternalId,
  getIncrementalSyncMap,
} from "../../db/database";
import { syncSource, type Connector, type RawDocument } from "../sync-manager";
import type { EmbedConfig } from "../../search/embedder";
import type { SyncProgress } from "../../../shared/types";

vi.mock("../../search/embedder", () => ({
  embedDocuments: vi.fn(async (texts: string[]) =>
    texts.map(() => new Float32Array([0.1, 0.2, 0.3])),
  ),
  getEmbeddingModelName: vi.fn(() => "embed-v4.0"),
  embeddingToBuffer: vi.fn((emb: Float32Array) =>
    Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength),
  ),
}));

function makeConnector(docs: RawDocument[]): Connector {
  return {
    async *fetchDocuments(
      _signal?: AbortSignal,
      _knownDocs?: Map<string, string>,
    ) {
      for (const doc of docs) {
        yield doc;
      }
    },
  };
}

const testConfig: EmbedConfig = { provider: "cohere", apiKey: "test-key" };

describe("syncSource", () => {
  let db: Database.Database;

  beforeEach(async () => {
    const embedder = await import("../../search/embedder");
    (embedder.embedDocuments as ReturnType<typeof vi.fn>).mockImplementation(
      async (texts: string[]) =>
        texts.map(() => new Float32Array([0.1, 0.2, 0.3])),
    );
    (
      embedder.getEmbeddingModelName as ReturnType<typeof vi.fn>
    ).mockReturnValue("embed-v4.0");
    (embedder.embeddingToBuffer as ReturnType<typeof vi.fn>).mockImplementation(
      (emb: Float32Array) =>
        Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength),
    );

    db = createTestDb();

    insertSource(db, {
      id: "src-1",
      provider: "notion",
      name: "Test Source",
      rootExternalId: "ext-root",
      createdAt: new Date().toISOString(),
    });
  });

  afterEach(() => db.close());

  it("syncs documents and creates chunks with embeddings", async () => {
    const connector = makeConnector([
      {
        externalId: "doc-ext-1",
        title: "Test Doc",
        url: "https://example.com",
        mimeType: "text/plain",
        modifiedAt: null,
        content:
          "# Intro\nHello world content here.\n## Details\nMore details.",
      },
    ]);

    const progress: SyncProgress[] = [];
    await syncSource(db, "src-1", "notion", connector, testConfig, (p) =>
      progress.push(p),
    );

    const docs = getDocumentsBySourceId(db, "src-1");
    expect(docs).toHaveLength(1);
    expect(docs[0].syncStatus).toBe("synced");
    expect(docs[0].contentHash).toBeTruthy();

    const chunks = getChunksByDocumentId(db, docs[0].id);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].embedding).toBeTruthy();
    expect(chunks[0].embeddingModel).toBe("embed-v4.0");

    expect(progress.length).toBeGreaterThan(0);
    expect(progress.some((p) => p.phase === "chunking")).toBe(true);
    expect(progress.some((p) => p.phase === "embedding")).toBe(true);
    expect(progress.some((p) => p.phase === "storing")).toBe(true);
  });

  it("skips unchanged documents via content hash", async () => {
    const content = "# Section\nSome content here.";
    const connector1 = makeConnector([
      {
        externalId: "doc-ext-1",
        title: "Doc",
        url: null,
        mimeType: null,
        modifiedAt: null,
        content,
      },
    ]);

    await syncSource(db, "src-1", "notion", connector1, testConfig, () => {});

    const { embedDocuments } = await import("../../search/embedder");
    (embedDocuments as ReturnType<typeof vi.fn>).mockClear();

    const connector2 = makeConnector([
      {
        externalId: "doc-ext-1",
        title: "Doc",
        url: null,
        mimeType: null,
        modifiedAt: null,
        content,
      },
    ]);

    await syncSource(db, "src-1", "notion", connector2, testConfig, () => {});

    expect(embedDocuments).not.toHaveBeenCalled();
  });

  it("re-processes documents when content changes", async () => {
    const connector1 = makeConnector([
      {
        externalId: "doc-ext-1",
        title: "Doc",
        url: null,
        mimeType: null,
        modifiedAt: null,
        content: "Version 1",
      },
    ]);
    await syncSource(db, "src-1", "notion", connector1, testConfig, () => {});

    const connector2 = makeConnector([
      {
        externalId: "doc-ext-1",
        title: "Doc",
        url: null,
        mimeType: null,
        modifiedAt: null,
        content: "Version 2 with changes",
      },
    ]);

    const { embedDocuments } = await import("../../search/embedder");
    (embedDocuments as ReturnType<typeof vi.fn>).mockClear();

    await syncSource(db, "src-1", "notion", connector2, testConfig, () => {});

    expect(embedDocuments).toHaveBeenCalled();
    const doc = getDocumentByExternalId(db, "src-1", "doc-ext-1");
    expect(doc?.syncStatus).toBe("synced");
  });

  it("handles embedding errors per document without aborting", async () => {
    const { embedDocuments } = await import("../../search/embedder");
    let callCount = 0;
    (embedDocuments as ReturnType<typeof vi.fn>).mockImplementation(
      async (texts: string[]) => {
        callCount++;
        if (callCount === 1) throw new Error("Cohere rate limit");
        return texts.map(() => new Float32Array([0.1, 0.2, 0.3]));
      },
    );

    const connector = makeConnector([
      {
        externalId: "doc-1",
        title: "Failing Doc",
        url: null,
        mimeType: null,
        modifiedAt: null,
        content: "# Heading\nContent that will fail embedding.",
      },
      {
        externalId: "doc-2",
        title: "Succeeding Doc",
        url: null,
        mimeType: null,
        modifiedAt: null,
        content: "# Heading\nContent that will succeed.",
      },
    ]);

    const progress: SyncProgress[] = [];
    await syncSource(db, "src-1", "notion", connector, testConfig, (p) =>
      progress.push(p),
    );

    const doc1 = getDocumentByExternalId(db, "src-1", "doc-1");
    expect(doc1?.syncStatus).toBe("error");

    const doc2 = getDocumentByExternalId(db, "src-1", "doc-2");
    expect(doc2?.syncStatus).toBe("synced");

    const lastProgress = progress[progress.length - 1];
    expect(lastProgress.errors).toHaveLength(1);
    expect(lastProgress.errors[0]).toContain("Failing Doc");
  });

  it("stops processing when abort signal fires", async () => {
    const controller = new AbortController();
    let yielded = 0;

    const connector: Connector = {
      async *fetchDocuments() {
        for (let i = 0; i < 10; i++) {
          yielded++;
          yield {
            externalId: `doc-${i}`,
            title: `Doc ${i}`,
            url: null,
            mimeType: null,
            modifiedAt: null,
            content: `# Section\nContent for doc ${i}.`,
          };
          if (yielded === 2) controller.abort();
        }
      },
    };

    await syncSource(
      db,
      "src-1",
      "notion",
      connector,
      testConfig,
      () => {},
      controller.signal,
    );

    const docs = getDocumentsBySourceId(db, "src-1");
    expect(docs.length).toBeLessThan(10);
  });

  it("handles documents with empty content", async () => {
    const connector = makeConnector([
      {
        externalId: "doc-empty",
        title: "Empty Doc",
        url: null,
        mimeType: null,
        modifiedAt: null,
        content: "   ",
      },
    ]);

    await syncSource(db, "src-1", "notion", connector, testConfig, () => {});

    const doc = getDocumentByExternalId(db, "src-1", "doc-empty");
    expect(doc?.syncStatus).toBe("synced");

    const chunks = getChunksByDocumentId(db, doc!.id);
    expect(chunks).toHaveLength(0);
  });

  it("emits done phase after successful sync", async () => {
    const connector = makeConnector([
      {
        externalId: "doc-1",
        title: "Doc",
        url: null,
        mimeType: null,
        modifiedAt: null,
        content: "# Heading\nSome content.",
      },
    ]);

    const progress: SyncProgress[] = [];
    await syncSource(db, "src-1", "notion", connector, testConfig, (p) =>
      progress.push(p),
    );

    const last = progress[progress.length - 1];
    expect(last.phase).toBe("done");
    expect(last.total).toBe(last.current);
    expect(last.errors).toHaveLength(0);
  });

  it("emits error phase when some documents fail", async () => {
    const { embedDocuments } = await import("../../search/embedder");
    (embedDocuments as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("API error"),
    );

    const connector = makeConnector([
      {
        externalId: "doc-fail",
        title: "Failing",
        url: null,
        mimeType: null,
        modifiedAt: null,
        content: "# Heading\nContent.",
      },
    ]);

    const progress: SyncProgress[] = [];
    await syncSource(db, "src-1", "notion", connector, testConfig, (p) =>
      progress.push(p),
    );

    const last = progress[progress.length - 1];
    expect(last.phase).toBe("error");
    expect(last.errors.length).toBeGreaterThan(0);
  });

  it("re-embeds when embedding model changes even if content unchanged", async () => {
    const content = "# Section\nSome content here.";
    const connector1 = makeConnector([
      {
        externalId: "doc-ext-1",
        title: "Doc",
        url: null,
        mimeType: null,
        modifiedAt: null,
        content,
      },
    ]);

    await syncSource(db, "src-1", "notion", connector1, testConfig, () => {});

    const { embedDocuments, getEmbeddingModelName } =
      await import("../../search/embedder");
    (embedDocuments as ReturnType<typeof vi.fn>).mockClear();
    (getEmbeddingModelName as ReturnType<typeof vi.fn>).mockReturnValue(
      "new-model-v2",
    );

    const connector2 = makeConnector([
      {
        externalId: "doc-ext-1",
        title: "Doc",
        url: null,
        mimeType: null,
        modifiedAt: null,
        content,
      },
    ]);

    await syncSource(db, "src-1", "notion", connector2, testConfig, () => {});

    expect(embedDocuments).toHaveBeenCalled();

    const doc = getDocumentByExternalId(db, "src-1", "doc-ext-1");
    const chunks = getChunksByDocumentId(db, doc!.id);
    expect(chunks[0].embeddingModel).toBe("new-model-v2");
  });

  it("syncs multiple documents", async () => {
    const connector = makeConnector([
      {
        externalId: "doc-a",
        title: "Doc A",
        url: null,
        mimeType: null,
        modifiedAt: null,
        content: "# Alpha\nFirst document content.",
      },
      {
        externalId: "doc-b",
        title: "Doc B",
        url: null,
        mimeType: null,
        modifiedAt: null,
        content: "# Beta\nSecond document content.",
      },
      {
        externalId: "doc-c",
        title: "Doc C",
        url: null,
        mimeType: null,
        modifiedAt: null,
        content: "# Gamma\nThird document content.",
      },
    ]);

    await syncSource(db, "src-1", "notion", connector, testConfig, () => {});

    const docs = getDocumentsBySourceId(db, "src-1");
    expect(docs).toHaveLength(3);
    expect(docs.every((d) => d.syncStatus === "synced")).toBe(true);
  });

  it("skips documents via incremental sync when modifiedAt matches", async () => {
    const connector1 = makeConnector([
      {
        externalId: "doc-ext-1",
        title: "Doc",
        url: null,
        mimeType: null,
        modifiedAt: "2026-01-01T00:00:00Z",
        content: "# Section\nSome content here.",
      },
    ]);

    await syncSource(db, "src-1", "notion", connector1, testConfig, () => {});

    const syncMap = getIncrementalSyncMap(db, "src-1", "embed-v4.0");
    expect(syncMap.get("doc-ext-1")).toBe("2026-01-01T00:00:00Z");

    const { embedDocuments } = await import("../../search/embedder");
    (embedDocuments as ReturnType<typeof vi.fn>).mockClear();

    const connector2 = makeConnector([
      {
        externalId: "doc-ext-1",
        title: "Doc",
        url: null,
        mimeType: null,
        modifiedAt: "2026-01-01T00:00:00Z",
        content: "# Section\nSome content here.",
      },
    ]);

    await syncSource(db, "src-1", "notion", connector2, testConfig, () => {});
    expect(embedDocuments).not.toHaveBeenCalled();
  });

  it("re-processes documents when modifiedAt differs", async () => {
    const connector1 = makeConnector([
      {
        externalId: "doc-ext-1",
        title: "Doc",
        url: null,
        mimeType: null,
        modifiedAt: "2026-01-01T00:00:00Z",
        content: "# Section\nOriginal content.",
      },
    ]);

    await syncSource(db, "src-1", "notion", connector1, testConfig, () => {});

    const { embedDocuments } = await import("../../search/embedder");
    (embedDocuments as ReturnType<typeof vi.fn>).mockClear();

    const connector2 = makeConnector([
      {
        externalId: "doc-ext-1",
        title: "Doc",
        url: null,
        mimeType: null,
        modifiedAt: "2026-01-02T00:00:00Z",
        content: "# Section\nUpdated content.",
      },
    ]);

    await syncSource(db, "src-1", "notion", connector2, testConfig, () => {});
    expect(embedDocuments).toHaveBeenCalled();
  });

  it("reports skipped count in progress events", async () => {
    const connector1 = makeConnector([
      {
        externalId: "doc-1",
        title: "Doc 1",
        url: null,
        mimeType: null,
        modifiedAt: "2026-01-01T00:00:00Z",
        content: "# Heading\nContent one.",
      },
      {
        externalId: "doc-2",
        title: "Doc 2",
        url: null,
        mimeType: null,
        modifiedAt: "2026-01-01T00:00:00Z",
        content: "# Heading\nContent two.",
      },
    ]);

    await syncSource(db, "src-1", "notion", connector1, testConfig, () => {});

    const progress: SyncProgress[] = [];
    const connector2 = makeConnector([
      {
        externalId: "doc-3",
        title: "Doc 3",
        url: null,
        mimeType: null,
        modifiedAt: null,
        content: "# Heading\nNew content.",
      },
    ]);

    await syncSource(db, "src-1", "notion", connector2, testConfig, (p) =>
      progress.push(p),
    );

    const last = progress[progress.length - 1];
    expect(last.skipped).toBe(2);
  });

  it("incremental sync map excludes docs with wrong embedding model", async () => {
    const connector = makeConnector([
      {
        externalId: "doc-ext-1",
        title: "Doc",
        url: null,
        mimeType: null,
        modifiedAt: "2026-01-01T00:00:00Z",
        content: "# Section\nSome content here.",
      },
    ]);

    await syncSource(db, "src-1", "notion", connector, testConfig, () => {});

    const mapWithCurrentModel = getIncrementalSyncMap(
      db,
      "src-1",
      "embed-v4.0",
    );
    expect(mapWithCurrentModel.has("doc-ext-1")).toBe(true);

    const mapWithNewModel = getIncrementalSyncMap(db, "src-1", "new-model-v2");
    expect(mapWithNewModel.has("doc-ext-1")).toBe(false);
  });

  it("processes documents concurrently", async () => {
    const { embedDocuments } = await import("../../search/embedder");
    const callTimestamps: number[] = [];
    (embedDocuments as ReturnType<typeof vi.fn>).mockImplementation(
      async (texts: string[]) => {
        callTimestamps.push(Date.now());
        await new Promise((r) => setTimeout(r, 50));
        return texts.map(() => new Float32Array([0.1, 0.2, 0.3]));
      },
    );

    const connector = makeConnector(
      Array.from({ length: 6 }, (_, i) => ({
        externalId: `doc-${i}`,
        title: `Doc ${i}`,
        url: null,
        mimeType: null,
        modifiedAt: null,
        content: `# Heading ${i}\nContent for document ${i}.`,
      })),
    );

    await syncSource(db, "src-1", "notion", connector, testConfig, () => {});

    const docs = getDocumentsBySourceId(db, "src-1");
    expect(docs).toHaveLength(6);
    expect(docs.every((d) => d.syncStatus === "synced")).toBe(true);

    // With concurrency=3, some embed calls should overlap in time
    if (callTimestamps.length >= 3) {
      const firstThreeSpread = callTimestamps[2] - callTimestamps[0];
      expect(firstThreeSpread).toBeLessThan(50);
    }
  });
});

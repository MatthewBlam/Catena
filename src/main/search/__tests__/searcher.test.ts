import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../../db/__tests__/test-db";
import { insertSource, insertDocument, upsertChunks } from "../../db/database";
import { embeddingToBuffer } from "../embedder";
import { cosineSimilarity, search } from "../searcher";
import type { EmbedConfig } from "../embedder";

function makeEmbedding(values: number[]): Buffer {
  return embeddingToBuffer(new Float32Array(values));
}

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const a = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it("returns -1 for opposite vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });

  it("handles high-dimensional vectors", () => {
    const dim = 1536;
    const a = new Float32Array(dim);
    const b = new Float32Array(dim);
    for (let i = 0; i < dim; i++) {
      a[i] = i / dim;
      b[i] = i / dim;
    }
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 4);
  });

  it("is symmetric", () => {
    const a = new Float32Array([0.3, 0.7, 0.1]);
    const b = new Float32Array([0.8, 0.2, 0.5]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 5);
  });
});

describe("search", () => {
  let db: Database.Database;
  const embedConfig: EmbedConfig = { provider: "cohere", apiKey: "test-key" };

  beforeEach(() => {
    db = createTestDb();

    insertSource(db, {
      id: "s1",
      provider: "notion",
      name: "Test Source",
      rootExternalId: "ext1",
      createdAt: "2024-01-01T00:00:00Z",
    });
    insertDocument(db, {
      id: "d1",
      sourceId: "s1",
      provider: "notion",
      externalId: "e1",
      title: "Meeting Notes",
      url: "https://notion.so/meeting",
      mimeType: "text/plain",
      modifiedAt: null,
      contentHash: null,
      lastSyncedAt: null,
      syncStatus: "synced",
    });
    insertDocument(db, {
      id: "d2",
      sourceId: "s1",
      provider: "notion",
      externalId: "e2",
      title: "Project Plan",
      url: "https://notion.so/plan",
      mimeType: "text/plain",
      modifiedAt: null,
      contentHash: null,
      lastSyncedAt: null,
      syncStatus: "synced",
    });

    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    db.close();
    vi.unstubAllGlobals();
  });

  it("returns empty results when no chunks have embeddings", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: { float: [[0.1, 0.2, 0.3]] } }),
    } as Response);

    const response = await search(db, "test query", embedConfig);
    expect(response.results).toEqual([]);
  });

  it("ranks results by cosine similarity", async () => {
    upsertChunks(db, [
      {
        id: "c1",
        documentId: "d1",
        chunkIndex: 0,
        heading: "Action Items",
        text: "Complete the design review",
        embedding: makeEmbedding([0.9, 0.1, 0.0]),
        embeddingModel: "embed-v4.0",
        tokenCount: 5,
        createdAt: "2024-01-01T00:00:00Z",
      },
      {
        id: "c2",
        documentId: "d2",
        chunkIndex: 0,
        heading: null,
        text: "Timeline for Q2 deliverables",
        embedding: makeEmbedding([0.1, 0.9, 0.0]),
        embeddingModel: "embed-v4.0",
        tokenCount: 5,
        createdAt: "2024-01-01T00:00:00Z",
      },
    ]);

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: { float: [[1, 0, 0]] } }),
    } as Response);

    const { results } = await search(db, "design review", embedConfig);
    expect(results).toHaveLength(2);
    expect(results[0].documentTitle).toBe("Meeting Notes");
    expect(results[0].snippet).toBe("Complete the design review");
    expect(results[0].heading).toBe("Action Items");
    expect(results[0].url).toBe("https://notion.so/meeting");
    expect(results[0].provider).toBe("notion");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("reranks when embedConfig.apiKey is provided", async () => {
    upsertChunks(db, [
      {
        id: "c1",
        documentId: "d1",
        chunkIndex: 0,
        heading: null,
        text: "First chunk",
        embedding: makeEmbedding([0.5, 0.5, 0.0]),
        embeddingModel: "embed-v4.0",
        tokenCount: 2,
        createdAt: "2024-01-01T00:00:00Z",
      },
      {
        id: "c2",
        documentId: "d2",
        chunkIndex: 0,
        heading: null,
        text: "Second chunk",
        embedding: makeEmbedding([0.4, 0.6, 0.0]),
        embeddingModel: "embed-v4.0",
        tokenCount: 2,
        createdAt: "2024-01-01T00:00:00Z",
      },
    ]);

    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: { float: [[1, 0, 0]] } }),
    } as Response);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [
          { index: 1, relevance_score: 0.95 },
          { index: 0, relevance_score: 0.8 },
        ],
      }),
    } as Response);

    const { results } = await search(db, "query", embedConfig);
    expect(results).toHaveLength(2);
    expect(results[0].documentTitle).toBe("Project Plan");
    expect(results[0].score).toBe(0.95);
    expect(results[1].documentTitle).toBe("Meeting Notes");
    expect(results[1].score).toBe(0.8);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[1][0]).toBe("https://api.cohere.com/v2/rerank");
  });

  it("skips reranking when no apiKey in embedConfig", async () => {
    upsertChunks(db, [
      {
        id: "c1",
        documentId: "d1",
        chunkIndex: 0,
        heading: null,
        text: "A chunk",
        embedding: makeEmbedding([1, 0, 0]),
        embeddingModel: "nomic-embed-text",
        tokenCount: 2,
        createdAt: "2024-01-01T00:00:00Z",
      },
    ]);

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [[1, 0, 0]] }),
    } as Response);

    const ollamaConfig: EmbedConfig = { provider: "ollama" };
    const { results } = await search(db, "query", ollamaConfig);
    expect(results).toHaveLength(1);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("limits results to 8", async () => {
    const chunks = Array.from({ length: 15 }, (_, i) => ({
      id: `c${i}`,
      documentId: "d1",
      chunkIndex: i,
      heading: null,
      text: `Chunk ${i}`,
      embedding: makeEmbedding([(i + 1) / 15, 1 - (i + 1) / 15, 0.1]),
      embeddingModel: "embed-v4.0",
      tokenCount: 2,
      createdAt: "2024-01-01T00:00:00Z",
    }));
    upsertChunks(db, chunks);

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: { float: [[1, 0, 0]] } }),
    } as Response);

    const { results } = await search(db, "query", embedConfig);
    expect(results).toHaveLength(8);
  });

  it("returns correct SearchResult shape", async () => {
    upsertChunks(db, [
      {
        id: "c1",
        documentId: "d1",
        chunkIndex: 0,
        heading: "Summary",
        text: "The quarterly review went well",
        embedding: makeEmbedding([1, 0, 0]),
        embeddingModel: "embed-v4.0",
        tokenCount: 6,
        createdAt: "2024-01-01T00:00:00Z",
      },
    ]);

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: { float: [[1, 0, 0]] } }),
    } as Response);

    const { results } = await search(db, "review", embedConfig);
    expect(results[0]).toEqual({
      chunkId: "c1",
      documentTitle: "Meeting Notes",
      snippet: "The quarterly review went well",
      heading: "Summary",
      url: "https://notion.so/meeting",
      provider: "notion",
      score: expect.any(Number),
    });
  });

  it("handles chunks from multiple documents", async () => {
    upsertChunks(db, [
      {
        id: "c1",
        documentId: "d1",
        chunkIndex: 0,
        heading: null,
        text: "From doc 1",
        embedding: makeEmbedding([0.8, 0.2, 0.0]),
        embeddingModel: "embed-v4.0",
        tokenCount: 3,
        createdAt: "2024-01-01T00:00:00Z",
      },
      {
        id: "c2",
        documentId: "d2",
        chunkIndex: 0,
        heading: null,
        text: "From doc 2",
        embedding: makeEmbedding([0.7, 0.3, 0.0]),
        embeddingModel: "embed-v4.0",
        tokenCount: 3,
        createdAt: "2024-01-01T00:00:00Z",
      },
    ]);

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: { float: [[1, 0, 0]] } }),
    } as Response);

    const { results } = await search(db, "query", embedConfig);
    expect(results).toHaveLength(2);
    const titles = results.map((r) => r.documentTitle);
    expect(titles).toContain("Meeting Notes");
    expect(titles).toContain("Project Plan");
  });

  it("finds a chunk beyond the 10,000th (H6)", async () => {
    // The old scan was `SELECT ... LIMIT 10000` with no ORDER BY, so it saw the
    // first 10k chunks by rowid and nothing else. The needle goes in last, which
    // puts it exactly one row past that cap: on `main` it is unreachable by
    // search, no matter how well it matches.
    const filler = Array.from({ length: 10_000 }, (_, i) => ({
      id: `filler-${i}`,
      documentId: "d1",
      chunkIndex: i,
      heading: null,
      text: `filler passage ${i}`,
      embedding: makeEmbedding([0, 1, 0]),
      embeddingModel: "nomic-embed-text",
      tokenCount: 3,
      createdAt: "2024-01-01T00:00:00Z",
    }));
    upsertChunks(db, filler);
    upsertChunks(db, [
      {
        id: "needle",
        documentId: "d2",
        chunkIndex: 0,
        heading: null,
        text: "the buried passage",
        embedding: makeEmbedding([1, 0, 0]),
        embeddingModel: "nomic-embed-text",
        tokenCount: 3,
        createdAt: "2024-01-01T00:00:00Z",
      },
    ]);

    // Ollama config: no rerank, so the vector scan is the only thing under test.
    // "zzqqxx" appears in no chunk, so FTS cannot rescue the needle either — the
    // one and only path to it is a scan that reaches past row 10,000.
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [[1, 0, 0]] }),
    } as Response);

    const { results } = await search(db, "zzqqxx", { provider: "ollama" });

    expect(results[0]?.chunkId).toBe("needle");
  });

  it("reports truncation when the scan stops short of the corpus", async () => {
    upsertChunks(
      db,
      Array.from({ length: 3 }, (_, i) => ({
        id: `c${i}`,
        documentId: "d1",
        chunkIndex: i,
        heading: null,
        text: `chunk ${i}`,
        embedding: makeEmbedding([1, 0, 0]),
        embeddingModel: "nomic-embed-text",
        tokenCount: 2,
        createdAt: "2024-01-01T00:00:00Z",
      })),
    );

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [[1, 0, 0]] }),
    } as Response);

    const response = await search(
      db,
      "zzqqxx",
      { provider: "ollama" },
      { maxScan: 2 },
    );

    // Truncating in silence is the actual bug: it is indistinguishable from the
    // document not being there at all.
    expect(response.truncated).toEqual({ scanned: 2, total: 3 });
  });

  it("does not report truncation when the bound is exactly the corpus size", async () => {
    upsertChunks(
      db,
      Array.from({ length: 2 }, (_, i) => ({
        id: `c${i}`,
        documentId: "d1",
        chunkIndex: i,
        heading: null,
        text: `chunk ${i}`,
        embedding: makeEmbedding([1, 0, 0]),
        embeddingModel: "nomic-embed-text",
        tokenCount: 2,
        createdAt: "2024-01-01T00:00:00Z",
      })),
    );

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [[1, 0, 0]] }),
    } as Response);

    const response = await search(
      db,
      "zzqqxx",
      { provider: "ollama" },
      { maxScan: 2 },
    );

    // Stopping *at* the last row saw everything. Warning here would train the
    // user to ignore the banner.
    expect(response.truncated).toBeUndefined();
  });

  it("falls back to cosine order and sets rerankFailed when rerank errors", async () => {
    upsertChunks(db, [
      {
        id: "c1",
        documentId: "d1",
        chunkIndex: 0,
        heading: null,
        text: "First chunk",
        embedding: makeEmbedding([0.9, 0.1, 0.0]),
        embeddingModel: "embed-v4.0",
        tokenCount: 2,
        createdAt: "2024-01-01T00:00:00Z",
      },
      {
        id: "c2",
        documentId: "d2",
        chunkIndex: 0,
        heading: null,
        text: "Second chunk",
        embedding: makeEmbedding([0.1, 0.9, 0.0]),
        embeddingModel: "embed-v4.0",
        tokenCount: 2,
        createdAt: "2024-01-01T00:00:00Z",
      },
    ]);

    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: { float: [[1, 0, 0]] } }),
    } as Response);
    mockFetch.mockRejectedValueOnce(new Error("Rerank service down"));

    const response = await search(db, "query", embedConfig);
    expect(response.rerankFailed).toBe(true);
    expect(response.results).toHaveLength(2);
    expect(response.results[0].documentTitle).toBe("Meeting Notes");
    expect(response.results[0].score).toBeGreaterThan(
      response.results[1].score,
    );
  });
});

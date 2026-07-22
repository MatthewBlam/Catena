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
    // No-rerank (RRF) scores are rescaled relative to the top hit, so the best
    // match reads as 1.0 (100%) rather than the raw RRF magnitude (~0.03) that
    // made every Ollama result render as "≤3% match".
    expect(results[0].score).toBeCloseTo(1, 5);
    expect(results[1].score).toBeLessThan(1);
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

  it("survivors carry correct text after the id-refetch (guards the join)", async () => {
    // The scan now only carries {id, score}; full rows (text, heading) come back
    // afterward via getChunksByIds, keyed by id. `SELECT ... WHERE id IN (...)`
    // returns rows in the database's own order (id-index order here), not the
    // order the ids were passed in — so ids are chosen to sort alphabetically
    // in the exact *reverse* of their intended cosine-score rank. A join that
    // trusted query-result order (e.g. zipping survivor rows against the
    // score-sorted top-K by position) would pair each score with the wrong
    // chunk's text; this only stays green if the join is keyed by id.
    upsertChunks(db, [
      {
        id: "chunk-a", // worst match, but would sort FIRST from the IN query
        documentId: "d1",
        chunkIndex: 0,
        heading: null,
        text: "passage for chunk-a",
        embedding: makeEmbedding([0.1, 0.9, 0.0]),
        embeddingModel: "nomic-embed-text",
        tokenCount: 3,
        createdAt: "2024-01-01T00:00:00Z",
      },
      {
        id: "chunk-b",
        documentId: "d1",
        chunkIndex: 1,
        heading: null,
        text: "passage for chunk-b",
        embedding: makeEmbedding([0.5, 0.5, 0.0]),
        embeddingModel: "nomic-embed-text",
        tokenCount: 3,
        createdAt: "2024-01-01T00:00:00Z",
      },
      {
        id: "chunk-c",
        documentId: "d1",
        chunkIndex: 2,
        heading: null,
        text: "passage for chunk-c",
        embedding: makeEmbedding([0.7, 0.3, 0.0]),
        embeddingModel: "nomic-embed-text",
        tokenCount: 3,
        createdAt: "2024-01-01T00:00:00Z",
      },
      {
        id: "chunk-d",
        documentId: "d1",
        chunkIndex: 3,
        heading: null,
        text: "passage for chunk-d",
        embedding: makeEmbedding([0.9, 0.1, 0.0]),
        embeddingModel: "nomic-embed-text",
        tokenCount: 3,
        createdAt: "2024-01-01T00:00:00Z",
      },
      {
        id: "chunk-e", // best match, but would sort LAST from the IN query
        documentId: "d1",
        chunkIndex: 4,
        heading: null,
        text: "passage for chunk-e",
        embedding: makeEmbedding([1, 0, 0]),
        embeddingModel: "nomic-embed-text",
        tokenCount: 3,
        createdAt: "2024-01-01T00:00:00Z",
      },
    ]);

    // Ollama config: no rerank, so the scan → id-refetch join is the only thing
    // that can reorder or mis-pair results. "zzqqxx" matches no chunk, so FTS
    // contributes nothing either.
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [[1, 0, 0]] }),
    } as Response);

    const { results } = await search(db, "zzqqxx", { provider: "ollama" });

    expect(results.map((r) => r.chunkId)).toEqual([
      "chunk-e",
      "chunk-d",
      "chunk-c",
      "chunk-b",
      "chunk-a",
    ]);
    for (const r of results) {
      expect(r.snippet).toBe(`passage for ${r.chunkId}`);
    }
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

describe("search cancellation (M15)", () => {
  let db: Database.Database;
  const embedConfig: EmbedConfig = { provider: "cohere", apiKey: "test-key" };

  /** Rejects with what an aborted `fetch` rejects with. */
  const abortError = (): DOMException =>
    new DOMException("The operation was aborted.", "AbortError");

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
    upsertChunks(db, [
      {
        id: "c1",
        documentId: "d1",
        chunkIndex: 0,
        heading: null,
        text: "A chunk",
        embedding: makeEmbedding([1, 0, 0]),
        embeddingModel: "embed-v4.0",
        tokenCount: 2,
        createdAt: "2024-01-01T00:00:00Z",
      },
    ]);
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    db.close();
    vi.unstubAllGlobals();
  });

  it("rejects when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      search(db, "query", embedConfig, { signal: controller.signal }),
    ).rejects.toThrow();

    // Not one network call for a search that was dead on arrival.
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("stops at the checkpoint when aborted during the query embed", async () => {
    const controller = new AbortController();

    // What a real aborted fetch does: reject. Both in-flight requests see it.
    vi.mocked(fetch).mockImplementation(async () => {
      controller.abort();
      throw abortError();
    });

    await expect(
      search(db, "query", embedConfig, { signal: controller.signal }),
    ).rejects.toThrow();
  });

  it("does not leave the embedding promise unhandled when it bails at a checkpoint", async () => {
    // The rewrite resolves, the embed rejects. `search` awaits the *rewrite*
    // first, so the abort checkpoint after it throws while the embed promise is
    // still in flight — and that promise is now guaranteed to reject. Without a
    // handler attached at creation, this is an unhandledRejection in main, which
    // is a process-level event no try/catch here can see.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const controller = new AbortController();
      vi.mocked(fetch).mockImplementation(async () => {
        controller.abort();
        throw abortError();
      });

      await expect(
        // 4+ words and a question word, so the rewrite path actually runs.
        search(db, "what is the design review", embedConfig, {
          signal: controller.signal,
        }),
      ).rejects.toThrow();

      // Let the microtask queue drain — unhandledRejection fires a tick later.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("rethrows an abort during rerank instead of degrading to rerankFailed", async () => {
    const controller = new AbortController();
    const mockFetch = vi.mocked(fetch);

    // The embed succeeds; the rerank is aborted mid-flight.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: { float: [[1, 0, 0]] } }),
    } as Response);
    mockFetch.mockImplementationOnce(async () => {
      controller.abort();
      throw abortError();
    });

    // Reporting `rerankFailed` here would hand back results for a query the user
    // already replaced, under a warning about a fault that never happened.
    await expect(
      search(db, "query", embedConfig, { signal: controller.signal }),
    ).rejects.toThrow();
  });

  it("still degrades to rerankFailed when the rerank fails for real", async () => {
    const controller = new AbortController();
    const mockFetch = vi.mocked(fetch);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: { float: [[1, 0, 0]] } }),
    } as Response);
    mockFetch.mockRejectedValueOnce(new Error("Rerank service down"));

    // The signal is live and un-aborted — the guard must key on *our* signal, not
    // on the error, or the rerank's own 15s timeout would start throwing too.
    const response = await search(db, "query", embedConfig, {
      signal: controller.signal,
    });
    expect(response.rerankFailed).toBe(true);
    expect(response.results).toHaveLength(1);
  });

  it("leaves the connection writable after an aborted search", async () => {
    upsertChunks(
      db,
      Array.from({ length: 1200 }, (_, i) => ({
        id: `big-${i}`,
        documentId: "d1",
        chunkIndex: i + 1,
        heading: null,
        text: `chunk ${i}`,
        embedding: makeEmbedding([1, 0, 0]),
        embeddingModel: "embed-v4.0",
        tokenCount: 2,
        createdAt: "2024-01-01T00:00:00Z",
      })),
    );

    const controller = new AbortController();
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: { float: [[1, 0, 0]] } }),
    } as Response);

    const promise = search(db, "query", embedConfig, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toThrow();

    // better-sqlite3 marks the whole connection busy while an iterator is open and
    // rejects every write on it. So a chunk write landing cleanly is the proof
    // that the scan's iterator was closed on the way out — if `for…of` ever stops
    // calling .return() on the generator, syncing breaks, not searching, and this
    // is the test that says so.
    expect(() =>
      upsertChunks(db, [
        {
          id: "after",
          documentId: "d1",
          chunkIndex: 9999,
          heading: null,
          text: "written after the aborted search",
          embedding: makeEmbedding([0, 1, 0]),
          embeddingModel: "embed-v4.0",
          tokenCount: 4,
          createdAt: "2024-01-01T00:00:00Z",
        },
      ]),
    ).not.toThrow();
  });

  it("leaves the connection writable after the scan stops at its bound", async () => {
    upsertChunks(
      db,
      Array.from({ length: 20 }, (_, i) => ({
        id: `b-${i}`,
        documentId: "d1",
        chunkIndex: i + 1,
        heading: null,
        text: `chunk ${i}`,
        embedding: makeEmbedding([1, 0, 0]),
        embeddingModel: "embed-v4.0",
        tokenCount: 2,
        createdAt: "2024-01-01T00:00:00Z",
      })),
    );

    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: { float: [[1, 0, 0]] } }),
    } as Response);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [{ index: 0, relevance_score: 0.9 }] }),
    } as Response);

    // `break` is the other abrupt exit from the for…of, and the other way to
    // abandon an iterator: hitting maxScan with rows still unread.
    await search(db, "query", embedConfig, { maxScan: 5 });

    expect(() =>
      upsertChunks(db, [
        {
          id: "after-bound",
          documentId: "d1",
          chunkIndex: 9999,
          heading: null,
          text: "written after a truncated scan",
          embedding: makeEmbedding([0, 1, 0]),
          embeddingModel: "embed-v4.0",
          tokenCount: 4,
          createdAt: "2024-01-01T00:00:00Z",
        },
      ]),
    ).not.toThrow();
  });
});

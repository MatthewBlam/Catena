import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rerank } from "../reranker";

describe("rerank", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns reranked results mapped to candidate IDs", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [
          { index: 1, relevance_score: 0.95 },
          { index: 0, relevance_score: 0.8 },
        ],
      }),
    } as Response);

    const candidates = [
      { id: "a", text: "first doc" },
      { id: "b", text: "second doc" },
    ];
    const results = await rerank("query", candidates, "api-key");
    expect(results).toEqual([
      { id: "b", score: 0.95 },
      { id: "a", score: 0.8 },
    ]);
  });

  it("sends correct request to Cohere API", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [] }),
    } as Response);

    await rerank("search query", [{ id: "a", text: "doc text" }], "my-key", 5);

    const call = vi.mocked(fetch).mock.calls[0];
    expect(call[0]).toBe("https://api.cohere.com/v2/rerank");
    const opts = call[1] as RequestInit;
    expect((opts.headers as Record<string, string>).Authorization).toBe(
      "Bearer my-key",
    );
    const body = JSON.parse(opts.body as string);
    expect(body.query).toBe("search query");
    expect(body.documents).toEqual(["doc text"]);
    expect(body.top_n).toBe(5);
    expect(body.model).toBe("rerank-v3.5");
  });

  it("defaults topN to 8", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [] }),
    } as Response);

    await rerank("query", [{ id: "a", text: "doc" }], "key");

    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.top_n).toBe(8);
  });

  it("throws on API error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    } as Response);

    await expect(
      rerank("query", [{ id: "a", text: "doc" }], "bad-key"),
    ).rejects.toThrow("Cohere rerank failed: 401 Unauthorized");
  });

  it("passes AbortSignal.timeout to fetch", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [] }),
    } as Response);

    await rerank("query", [{ id: "a", text: "doc" }], "key");

    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeDefined();
  });

  it("throws on missing results array", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    } as Response);

    await expect(
      rerank("query", [{ id: "a", text: "doc" }], "key"),
    ).rejects.toThrow(
      "Cohere rerank returned invalid response: missing results array",
    );
  });

  it("throws when results is not an array", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: "not-an-array" }),
    } as Response);

    await expect(
      rerank("query", [{ id: "a", text: "doc" }], "key"),
    ).rejects.toThrow(
      "Cohere rerank returned invalid response: missing results array",
    );
  });

  it("filters out results with out-of-bounds index", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [
          { index: 0, relevance_score: 0.9 },
          { index: 5, relevance_score: 0.8 },
          { index: -1, relevance_score: 0.7 },
        ],
      }),
    } as Response);

    const candidates = [
      { id: "a", text: "first doc" },
      { id: "b", text: "second doc" },
    ];
    const results = await rerank("query", candidates, "key");
    expect(results).toEqual([{ id: "a", score: 0.9 }]);
  });
});

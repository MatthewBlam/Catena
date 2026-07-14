import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  embedDocuments,
  embedQuery,
  getEmbeddingModelName,
  embeddingToBuffer,
  bufferToEmbedding,
} from "../embedder";
import type { EmbedConfig } from "../embedder";

describe("embeddingToBuffer / bufferToEmbedding", () => {
  it("round-trips Float32Array through Buffer", () => {
    const original = new Float32Array([1.5, -2.3, 0.0, 42.1]);
    const buf = embeddingToBuffer(original);
    const recovered = bufferToEmbedding(buf);
    expect(recovered.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(recovered[i]).toBeCloseTo(original[i], 5);
    }
  });

  it("preserves high-dimensional embeddings", () => {
    const dims = 1536;
    const original = new Float32Array(dims);
    for (let i = 0; i < dims; i++) original[i] = (i / dims) * 2 - 1;
    const buf = embeddingToBuffer(original);
    expect(buf.byteLength).toBe(dims * 4);
    const recovered = bufferToEmbedding(buf);
    expect(recovered.length).toBe(dims);
    for (let i = 0; i < dims; i++) {
      expect(recovered[i]).toBeCloseTo(original[i], 5);
    }
  });
});

describe("getEmbeddingModelName", () => {
  it("returns embed-v4.0 for cohere", () => {
    expect(getEmbeddingModelName({ provider: "cohere" })).toBe("embed-v4.0");
  });

  it("returns default ollama model", () => {
    expect(getEmbeddingModelName({ provider: "ollama" })).toBe(
      "nomic-embed-text",
    );
  });

  it("returns custom ollama model when specified", () => {
    expect(
      getEmbeddingModelName({
        provider: "ollama",
        ollamaModel: "mxbai-embed-large",
      }),
    ).toBe("mxbai-embed-large");
  });
});

describe("embedDocuments", () => {
  const cohereConfig: EmbedConfig = { provider: "cohere", apiKey: "test-key" };
  const ollamaConfig: EmbedConfig = { provider: "ollama" };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns empty array for empty input", async () => {
    const result = await embedDocuments([], cohereConfig);
    expect(result).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("calls Cohere API with search_document inputType", async () => {
    const mockEmbedding = Array(1536).fill(0.1);
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: { float: [mockEmbedding] } }),
    } as Response);

    const result = await embedDocuments(["hello world"], cohereConfig);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(Float32Array);
    expect(result[0].length).toBe(1536);

    const call = vi.mocked(fetch).mock.calls[0];
    expect(call[0]).toBe("https://api.cohere.com/v2/embed");
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.input_type).toBe("search_document");
    expect(body.model).toBe("embed-v4.0");
    expect(body.texts).toEqual(["hello world"]);
  });

  it("batches Cohere calls at 96 texts", async () => {
    const mockEmbedding = Array(4).fill(0.1);
    const mockFetch = vi.mocked(fetch);
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          embeddings: { float: Array(96).fill(mockEmbedding) },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          embeddings: { float: Array(96).fill(mockEmbedding) },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          embeddings: { float: Array(8).fill(mockEmbedding) },
        }),
      } as Response);

    const texts = Array(200).fill("text");
    const result = await embedDocuments(texts, cohereConfig);

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result).toHaveLength(200);

    const firstBody = JSON.parse(
      (mockFetch.mock.calls[0][1] as RequestInit).body as string,
    );
    const secondBody = JSON.parse(
      (mockFetch.mock.calls[1][1] as RequestInit).body as string,
    );
    const thirdBody = JSON.parse(
      (mockFetch.mock.calls[2][1] as RequestInit).body as string,
    );
    expect(firstBody.texts).toHaveLength(96);
    expect(secondBody.texts).toHaveLength(96);
    expect(thirdBody.texts).toHaveLength(8);
  });

  it("calls Ollama API with correct model", async () => {
    const mockEmbedding = Array(768).fill(0.5);
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [mockEmbedding] }),
    } as Response);

    const result = await embedDocuments(["hello"], ollamaConfig);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(Float32Array);
    expect(result[0].length).toBe(768);

    const call = vi.mocked(fetch).mock.calls[0];
    expect(call[0]).toBe("http://localhost:11434/api/embed");
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.model).toBe("nomic-embed-text");
  });

  it("uses custom Ollama model when specified", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [Array(1024).fill(0)] }),
    } as Response);

    await embedDocuments(["hello"], {
      provider: "ollama",
      ollamaModel: "mxbai-embed-large",
    });

    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.model).toBe("mxbai-embed-large");
  });

  it("throws when Cohere provider has no API key", async () => {
    await expect(
      embedDocuments(["text"], { provider: "cohere" }),
    ).rejects.toThrow("Cohere API key required");
  });

  it("throws on Cohere API error (non-retryable)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
    } as Response);

    await expect(embedDocuments(["text"], cohereConfig)).rejects.toThrow(
      "Cohere embed failed: 401 Unauthorized",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 and succeeds", async () => {
    const mockEmbedding = Array(4).fill(0.1);
    const mockFetch = vi.mocked(fetch);
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embeddings: { float: [mockEmbedding] } }),
      } as Response);

    const result = await embedDocuments(["text"], cohereConfig);
    expect(result).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 5xx and succeeds", async () => {
    const mockEmbedding = Array(4).fill(0.1);
    const mockFetch = vi.mocked(fetch);
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embeddings: { float: [mockEmbedding] } }),
      } as Response);

    const result = await embedDocuments(["text"], cohereConfig);
    expect(result).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("gives up after max retries on persistent 429", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
    } as Response);

    await expect(embedDocuments(["text"], cohereConfig)).rejects.toThrow(
      "Cohere embed failed: 429 Too Many Requests",
    );
    expect(mockFetch).toHaveBeenCalledTimes(4);
  }, 15_000);

  it("passes AbortSignal.timeout to Cohere fetch", async () => {
    const mockEmbedding = Array(4).fill(0.1);
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: { float: [mockEmbedding] } }),
    } as Response);

    await embedDocuments(["text"], cohereConfig);

    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeDefined();
  });

  it("passes AbortSignal.timeout to Ollama fetch", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [Array(768).fill(0)] }),
    } as Response);

    await embedDocuments(["text"], ollamaConfig);

    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeDefined();
  });

  it("throws on Ollama API error", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    } as Response);

    await expect(embedDocuments(["text"], ollamaConfig)).rejects.toThrow(
      "Ollama embed failed: 500 Internal Server Error",
    );
    expect(fetch).toHaveBeenCalledTimes(4);
  }, 15_000);
});

describe("embedQuery", () => {
  const cohereConfig: EmbedConfig = { provider: "cohere", apiKey: "test-key" };
  const ollamaConfig: EmbedConfig = { provider: "ollama" };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls Cohere API with search_query inputType", async () => {
    const mockEmbedding = Array(1536).fill(0.1);
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: { float: [mockEmbedding] } }),
    } as Response);

    const result = await embedQuery("search text", cohereConfig);
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(1536);

    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.input_type).toBe("search_query");
    expect(body.texts).toEqual(["search text"]);
  });

  it("returns a single Float32Array for Ollama", async () => {
    const mockEmbedding = Array(768).fill(0.5);
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ embeddings: [mockEmbedding] }),
    } as Response);

    const result = await embedQuery("search text", ollamaConfig);
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(768);
  });
});

describe("abort handling", () => {
  const cohereConfig: EmbedConfig = { provider: "cohere", apiKey: "test-key" };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * 384 texts is 4 Cohere batches at a concurrency of 3, so the fourth batch
   * starts only after one of the first three has already resolved. Aborting once
   * the third request is in flight is therefore the exact race that used to
   * matter: nothing rejects — the in-flight batches all succeed — and batch four
   * simply declines to run, leaving its 96 slots `undefined`.
   */
  function abortOnThirdRequest(controller: AbortController): void {
    let calls = 0;
    vi.mocked(fetch).mockImplementation(async () => {
      calls++;
      if (calls === 3) controller.abort();
      return {
        ok: true,
        json: async () => ({
          embeddings: { float: Array(96).fill(Array(4).fill(0.1)) },
        }),
      } as Response;
    });
  }

  it("rejects instead of resolving with holes when aborted mid-batch", async () => {
    const controller = new AbortController();
    abortOnThirdRequest(controller);

    await expect(
      embedDocuments(Array(384).fill("text"), cohereConfig, controller.signal),
    ).rejects.toThrow();
  });

  it("never resolves an array containing a hole", async () => {
    const controller = new AbortController();
    abortOnThirdRequest(controller);

    const embeddings = await embedDocuments(
      Array(384).fill("text"),
      cohereConfig,
      controller.signal,
    ).catch(() => null);

    // Rejecting is the correct outcome. What must never happen is resolving with
    // gaps — `embeddingToBuffer(undefined)` is a TypeError the sync manager would
    // misattribute to the document.
    if (embeddings !== null) {
      // `Array.from` is load-bearing: the results array is built with
      // `new Array(n)`, so an unwritten slot is a *hole*, not an `undefined`
      // value — and `every`/`some`/`forEach` skip holes entirely. Asserting on
      // the sparse array directly would pass even when every slot is missing.
      const dense = Array.from(embeddings);
      expect(dense).toHaveLength(384);
      expect(dense.every((e) => e instanceof Float32Array)).toBe(true);
    }
  });
});

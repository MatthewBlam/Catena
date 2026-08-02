import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  deleteModel,
  isEmbeddingModel,
  listModels,
  pullModel,
} from "../models";

/** Builds a `ReadableStream<Uint8Array>` that emits each string chunk then closes. */
function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const s of chunks) c.enqueue(new TextEncoder().encode(s));
      c.close();
    },
  });
}

describe("isEmbeddingModel", () => {
  it("matches embed / nomic / mxbai substrings", () => {
    expect(isEmbeddingModel("nomic-embed-text")).toBe(true);
    expect(isEmbeddingModel("nomic-foo")).toBe(true);
    expect(isEmbeddingModel("mxbai-embed-large")).toBe(true);
    expect(isEmbeddingModel("some-embedder")).toBe(true);
  });

  it("does not match a chat model", () => {
    expect(isEmbeddingModel("llama3")).toBe(false);
  });
});

describe("listModels", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the model names on a successful response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: "a" }, { name: "b" }] }),
    } as Response);

    expect(await listModels()).toEqual(["a", "b"]);
  });

  it("returns [] on a non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false } as Response);
    expect(await listModels()).toEqual([]);
  });

  it("returns [] when fetch throws (engine unreachable)", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await listModels()).toEqual([]);
  });
});

describe("pullModel", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("streams NDJSON progress and resolves on success reaching 100%", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: streamFrom([
        '{"status":"pulling manifest"}\n',
        '{"status":"pulling d1","digest":"d1","total":100,"completed":50}\n',
        '{"status":"pulling d1","digest":"d1","total":100,"completed":100}\n',
        '{"status":"success"}\n',
      ]),
    } as Response);

    const onProgress = vi.fn();
    await expect(
      pullModel("nomic-embed-text", onProgress),
    ).resolves.toBeUndefined();

    const percents = onProgress.mock.calls
      .map(([p]) => p.percent)
      .filter((p) => typeof p === "number");
    expect(Math.max(...percents)).toBe(100);
    // The mid-stream 50% report should have been surfaced too.
    expect(percents).toContain(50);
  });

  it("rejects when the stream carries an error line", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: streamFrom([
        '{"status":"pulling manifest"}\n',
        '{"error":"boom"}\n',
      ]),
    } as Response);

    await expect(pullModel("bad-model", vi.fn())).rejects.toThrow(/boom/);
  });

  it("rejects when the stream ends without a success line", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: streamFrom([
        '{"status":"pulling d1","digest":"d1","total":100,"completed":40}\n',
      ]),
    } as Response);

    await expect(pullModel("cut-short", vi.fn())).rejects.toThrow(
      /ended before completing/,
    );
  });

  it("throws on a non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      body: null,
    } as unknown as Response);

    await expect(pullModel("m", vi.fn())).rejects.toThrow(/HTTP 500/);
  });
});

describe("deleteModel", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("issues a DELETE to /api/delete with the model in the body", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
    } as Response);

    await expect(deleteModel("nomic-embed-text")).resolves.toBeUndefined();

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain("/api/delete");
    expect(init?.method).toBe("DELETE");
    expect(JSON.parse(init?.body as string)).toEqual({
      model: "nomic-embed-text",
    });
  });

  it("treats a 404 as success (model already gone)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
    } as Response);

    await expect(deleteModel("missing")).resolves.toBeUndefined();
  });

  it("throws on a real server error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as Response);

    await expect(deleteModel("m")).rejects.toThrow(/HTTP 500/);
  });
});

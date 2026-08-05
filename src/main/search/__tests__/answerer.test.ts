import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateAnswer, type AnswerDoc } from "../answerer";
import type { EmbedConfig } from "../embedder";

const DOCS: AnswerDoc[] = [
  { chunkId: "c0", title: "Doc Zero", heading: null, text: "Zero body." },
  {
    chunkId: "c1",
    title: "Doc One",
    heading: "Penguins",
    text: "Emperor penguins are the tallest.",
  },
];

const COHERE: EmbedConfig = { provider: "cohere", apiKey: "test-key" };
const OLLAMA: EmbedConfig = {
  provider: "ollama",
  ollamaModel: "nomic-embed-text",
};

/** A streaming-body Response built from raw string chunks (as the network delivers them). */
function streamResponse(chunks: string[], ok = true): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return { ok, body, status: ok ? 200 : 500, statusText: "" } as Response;
}

function jsonResponse(data: unknown, ok = true): Response {
  return {
    ok,
    json: async () => data,
    status: ok ? 200 : 500,
    statusText: "",
  } as Response;
}

/** Wraps a Cohere SSE event as the raw stream frames it. */
function sse(type: string, delta: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, delta })}\n\n`;
}

const noop = (): void => {};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("generateAnswer — Cohere", () => {
  it("accumulates content deltas and maps citations back to chunkIds", async () => {
    const raw =
      sse("content-delta", {
        message: { content: { text: "Emperor penguins " } },
      }) +
      sse("content-delta", {
        message: { content: { text: "are the tallest." } },
      }) +
      sse("citation-start", {
        message: {
          citations: {
            start: 0,
            end: 16,
            text: "Emperor penguins",
            sources: [{ id: "doc:1", type: "document" }],
          },
        },
      }) +
      "data: [DONE]\n\n";
    // Split mid-line to exercise the line-buffering across network chunks.
    const mid = Math.floor(raw.length / 2);
    fetchMock.mockResolvedValueOnce(
      streamResponse([raw.slice(0, mid), raw.slice(mid)]),
    );

    const deltas: string[] = [];
    const res = await generateAnswer("How tall are penguins?", DOCS, COHERE, {
      onDelta: (t) => deltas.push(t),
    });

    expect(res.error).toBeUndefined();
    expect(res.cancelled).toBeUndefined();
    expect(res.text).toBe("Emperor penguins are the tallest.");
    expect(deltas.join("")).toBe("Emperor penguins are the tallest.");
    expect(res.citations).toEqual([{ start: 0, end: 16, chunkId: "c1" }]);
  });

  it("emits one citation per cited source, resolving each by document position", async () => {
    const raw =
      sse("content-delta", { message: { content: { text: "Both agree." } } }) +
      sse("citation-start", {
        message: {
          citations: {
            start: 0,
            end: 4,
            sources: [{ id: "doc:0" }, { id: "doc:1" }],
          },
        },
      }) +
      "data: [DONE]\n\n";
    fetchMock.mockResolvedValueOnce(streamResponse([raw]));

    const res = await generateAnswer("q", DOCS, COHERE, { onDelta: noop });
    expect(res.citations).toEqual([
      { start: 0, end: 4, chunkId: "c0" },
      { start: 0, end: 4, chunkId: "c1" },
    ]);
  });

  it("drops citations whose source index is out of range", async () => {
    const raw =
      sse("content-delta", { message: { content: { text: "Answer text." } } }) +
      sse("citation-start", {
        message: {
          citations: { start: 0, end: 6, sources: [{ id: "doc:9" }] },
        },
      }) +
      "data: [DONE]\n\n";
    fetchMock.mockResolvedValueOnce(streamResponse([raw]));

    const res = await generateAnswer("q", DOCS, COHERE, { onDelta: noop });
    expect(res.text).toBe("Answer text.");
    expect(res.citations).toEqual([]);
  });

  it("ignores a malformed SSE data line without aborting the stream", async () => {
    const raw =
      sse("content-delta", { message: { content: { text: "Good " } } }) +
      "data: {not json}\n\n" +
      sse("content-delta", { message: { content: { text: "parts." } } }) +
      "data: [DONE]\n\n";
    fetchMock.mockResolvedValueOnce(streamResponse([raw]));

    const res = await generateAnswer("q", DOCS, COHERE, { onDelta: noop });
    expect(res.text).toBe("Good parts.");
  });

  it("returns a failed sentinel on a non-ok response, never throwing", async () => {
    fetchMock.mockResolvedValueOnce(streamResponse([""], false));
    const res = await generateAnswer("q", DOCS, COHERE, { onDelta: noop });
    expect(res.errorKind).toBe("failed");
    expect(res.error).toBeTruthy();
    expect(res.text).toBe("");
  });

  it("surfaces a status-specific reason instead of the generic message", async () => {
    // A rate-limited chat response should read as such, not "try again".
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      body: null,
      text: async () => "rate limit exceeded",
    } as Response);
    const res = await generateAnswer("q", DOCS, COHERE, { onDelta: noop });
    expect(res.errorKind).toBe("failed");
    expect(res.error).toMatch(/429/);
    expect(res.error).toMatch(/rate-limit/i);
  });

  it("names the model on a 404 so a missing/unavailable model is obvious", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
      body: null,
      text: async () => "model not found",
    } as Response);
    const res = await generateAnswer("q", DOCS, COHERE, { onDelta: noop });
    expect(res.error).toMatch(/404/);
    expect(res.error).toMatch(/command-r-08-2024/);
  });

  it("treats an empty answer as a soft failure", async () => {
    fetchMock.mockResolvedValueOnce(streamResponse(["data: [DONE]\n\n"]));
    const res = await generateAnswer("q", DOCS, COHERE, { onDelta: noop });
    expect(res.errorKind).toBe("failed");
    expect(res.error).toMatch(/No answer/i);
  });

  it("returns failed when the Cohere provider has no API key", async () => {
    const res = await generateAnswer(
      "q",
      DOCS,
      { provider: "cohere" },
      { onDelta: noop },
    );
    expect(res.errorKind).toBe("failed");
    expect(res.failureReason).toBe("no_api_key");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("generateAnswer — failure reasons", () => {
  // Every one of these renders as the same "failed" banner; only the reason
  // tells a bad key apart from a rate limit or a retired model after the fact.
  it.each([
    [401, "unauthorized"],
    [403, "unauthorized"],
    [429, "rate_limited"],
    [404, "model_not_found"],
    [500, "provider_error"],
  ])("maps HTTP %i to %s", async (status, reason) => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status,
      statusText: "",
      body: null,
      text: async () => "",
    } as Response);
    const res = await generateAnswer("q", DOCS, COHERE, { onDelta: noop });
    expect(res.failureReason).toBe(reason);
  });

  it("distinguishes an empty answer from a provider failure", async () => {
    fetchMock.mockResolvedValueOnce(streamResponse(["data: [DONE]\n\n"]));
    const res = await generateAnswer("q", DOCS, COHERE, { onDelta: noop });
    expect(res.failureReason).toBe("empty_answer");
  });

  it("reports having had nothing to ground on", async () => {
    const res = await generateAnswer("q", [], COHERE, { onDelta: noop });
    expect(res.failureReason).toBe("no_docs");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a missing Ollama chat model as a setup gap, not a failure", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: "nomic-embed-text" }] }),
    } as Response);
    const res = await generateAnswer(
      "q",
      DOCS,
      { provider: "ollama" },
      { onDelta: noop },
    );
    expect(res.errorKind).toBe("no_model");
    expect(res.failureReason).toBe("no_chat_model");
  });

  it("carries no reason on success", async () => {
    fetchMock.mockResolvedValueOnce(
      streamResponse([
        sse("content-delta", { message: { content: { text: "Fine." } } }),
      ]),
    );
    const res = await generateAnswer("q", DOCS, COHERE, { onDelta: noop });
    expect(res.failureReason).toBeUndefined();
  });
});

describe("generateAnswer — Ollama", () => {
  it("streams NDJSON content with no citations when a chat model is installed", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/api/tags")) {
        return Promise.resolve(
          jsonResponse({ models: [{ name: "llama3.2:latest" }] }),
        );
      }
      return Promise.resolve(
        streamResponse([
          JSON.stringify({ message: { content: "The " }, done: false }) + "\n",
          JSON.stringify({ message: { content: "answer." }, done: false }) +
            "\n",
          JSON.stringify({ message: { content: "" }, done: true }) + "\n",
        ]),
      );
    });

    const deltas: string[] = [];
    const res = await generateAnswer("q", DOCS, OLLAMA, {
      onDelta: (t) => deltas.push(t),
      ollamaChatModel: "llama3.2",
    });
    expect(res.text).toBe("The answer.");
    expect(deltas.join("")).toBe("The answer.");
    expect(res.citations).toEqual([]);
    expect(res.errorKind).toBeUndefined();
  });

  it("prompts Ollama with the question and titled sources, and never numbers them [n]", async () => {
    let chatBody: { messages: { role: string; content: string }[] } | undefined;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/api/tags")) {
        return Promise.resolve(
          jsonResponse({ models: [{ name: "llama3.2:latest" }] }),
        );
      }
      chatBody = JSON.parse(init!.body as string);
      return Promise.resolve(
        streamResponse([
          JSON.stringify({ message: { content: "ok" }, done: true }) + "\n",
        ]),
      );
    });

    await generateAnswer("who was on ecoslo", DOCS, OLLAMA, {
      onDelta: noop,
      ollamaChatModel: "llama3.2",
    });

    const userMsg = chatBody!.messages.find((m) => m.role === "user")!.content;
    expect(userMsg).toContain("who was on ecoslo");
    expect(userMsg).toContain("Doc One"); // a source title
    // The section heading is labelled so the model can tell same-document
    // chunks apart (the fix for cross-section confabulation).
    expect(userMsg).toContain("Penguins");
    // Regression guard: sources must not be numbered [1]/[2] — a small model
    // echoes those back as fake citation markers into an answer that has none.
    expect(userMsg).not.toMatch(/\[\d+\]/);
  });

  it("returns a no_model degraded result when the chat model is absent", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ models: [{ name: "nomic-embed-text:latest" }] }),
    );
    const res = await generateAnswer("q", DOCS, OLLAMA, {
      onDelta: noop,
      ollamaChatModel: "llama3.2",
    });
    expect(res.errorKind).toBe("no_model");
    expect(res.error).toMatch(/ollama pull llama3\.2/);
    // Only the tags check ran — never the chat endpoint.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("defaults to llama3.2 when no chat model is configured", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ models: [] }));
    const res = await generateAnswer("q", DOCS, OLLAMA, { onDelta: noop });
    expect(res.errorKind).toBe("no_model");
    expect(res.error).toMatch(/llama3\.2/);
  });
});

describe("generateAnswer — Elaborate", () => {
  /** Resolves once the provider has been called, with the request body it got. */
  function captureCohereBody(): () => {
    messages: { role: string; content: string }[];
  } {
    let body: { messages: { role: string; content: string }[] } | undefined;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      body = JSON.parse(init!.body as string);
      return Promise.resolve(
        streamResponse([
          sse("content-delta", { message: { content: { text: "ok" } } }),
        ]),
      );
    });
    return () => body!;
  }

  function captureOllamaBody(): () => {
    messages: { role: string; content: string }[];
  } {
    let body: { messages: { role: string; content: string }[] } | undefined;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/api/tags")) {
        return Promise.resolve(
          jsonResponse({ models: [{ name: "llama3.2:latest" }] }),
        );
      }
      body = JSON.parse(init!.body as string);
      return Promise.resolve(
        streamResponse([
          JSON.stringify({ message: { content: "ok" }, done: true }) + "\n",
        ]),
      );
    });
    return () => body!;
  }

  const roleContent = (
    body: { messages: { role: string; content: string }[] },
    role: string,
  ): string => body.messages.find((m) => m.role === role)!.content;

  it("replaces the concision instruction rather than appending to it (Cohere)", async () => {
    const body = captureCohereBody();

    await generateAnswer("q", DOCS, COHERE, { onDelta: noop, elaborate: true });

    const system = roleContent(body(), "system");
    expect(system).toContain("Elaborate fully");
    // "Be concise" and "elaborate fully" are contradictory orders. Leaving both
    // in leaves the model to pick one, which is not a feature.
    expect(system).not.toContain("Be concise");
  });

  it("leaves the question itself untouched", async () => {
    const body = captureCohereBody();

    await generateAnswer("when are dues due", DOCS, COHERE, {
      onDelta: noop,
      elaborate: true,
    });

    // The instruction belongs in the system prompt: the query keys the
    // recent-search row this answer is saved against and is echoed back in the
    // UI, so appending to it would corrupt both.
    expect(roleContent(body(), "user")).toBe("when are dues due");
  });

  it("keeps the default prompt concise when the box is unchecked", async () => {
    const body = captureCohereBody();

    await generateAnswer("q", DOCS, COHERE, { onDelta: noop });

    const system = roleContent(body(), "system");
    expect(system).toContain("Be concise");
    expect(system).not.toContain("Elaborate fully");
  });

  it("elaborates both messages on the Ollama path", async () => {
    const body = captureOllamaBody();

    await generateAnswer("q", DOCS, OLLAMA, {
      onDelta: noop,
      ollamaChatModel: "llama3.2",
      elaborate: true,
    });

    expect(roleContent(body(), "system")).toContain("Elaborate fully");
    // Ollama gets its own manual-RAG instruction on top of the system prompt,
    // and it tells the model to be direct — so it has to move too, or the two
    // halves of the same request disagree.
    const user = roleContent(body(), "user");
    expect(user).not.toContain("Give a direct, specific answer");
    expect(user).toContain("thorough");
    expect(user).toContain("# Question\nq");
  });

  it("keeps the Ollama instruction direct when the box is unchecked", async () => {
    const body = captureOllamaBody();

    await generateAnswer("q", DOCS, OLLAMA, {
      onDelta: noop,
      ollamaChatModel: "llama3.2",
    });

    expect(roleContent(body(), "user")).toContain(
      "Give a direct, specific answer",
    );
    expect(roleContent(body(), "system")).not.toContain("Elaborate fully");
  });
});

describe("generateAnswer — cancellation", () => {
  it("resolves cancelled (not thrown) when the caller's signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    // The combined signal is already aborted, so the mock rejects like fetch does.
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        return Promise.reject(new DOMException("Aborted", "AbortError"));
      }
      return Promise.resolve(streamResponse(["data: [DONE]\n\n"]));
    });

    const res = await generateAnswer("q", DOCS, COHERE, {
      onDelta: noop,
      signal: controller.signal,
    });
    expect(res.cancelled).toBe(true);
    expect(res.errorKind).toBeUndefined();
  });

  it("returns failed when there are no documents to answer from", async () => {
    const res = await generateAnswer("q", [], COHERE, { onDelta: noop });
    expect(res.errorKind).toBe("failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

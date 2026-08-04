import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rewriteQuery } from "../query-rewriter";

/** 4+ words and a question word, so the rewrite path actually runs. */
const QUERY = "What are all the important dates and deadlines?";

function cohereReply(text: string): Response {
  return {
    ok: true,
    json: async () => ({ message: { content: [{ text }] } }),
  } as Response;
}

function ollamaReply(response: string): Response {
  return {
    ok: true,
    json: async () => ({ response }),
  } as Response;
}

describe("rewriteQuery", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the model's rewrite when it is a short keyword phrase", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      cohereReply("important dates deadlines schedule"),
    );

    const result = await rewriteQuery(QUERY, {
      provider: "cohere",
      apiKey: "k",
    });

    expect(result).toBe("important dates deadlines schedule");
  });

  it("sends the request to Cohere with the Command R model and a system prompt", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(cohereReply("important dates"));

    await rewriteQuery(QUERY, { provider: "cohere", apiKey: "my-key" });

    const call = vi.mocked(fetch).mock.calls[0];
    expect(call[0]).toBe("https://api.cohere.com/v2/chat");
    const opts = call[1] as RequestInit;
    expect((opts.headers as Record<string, string>).Authorization).toBe(
      "Bearer my-key",
    );
    const body = JSON.parse(opts.body as string);
    // Command R7B was too weak to follow "output ONLY the query" and answered
    // conversationally instead; this pins the rewrite to the same snapshot the
    // answerer uses. The prose of the prompt is deliberately not asserted — only
    // that a system turn is sent at all — so wording stays free to change.
    expect(body.model).toBe("command-r-08-2024");
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1]).toEqual({ role: "user", content: QUERY });
  });

  it("falls back to the raw query when the model answers conversationally", async () => {
    // Verbatim from a real command-r7b-12-2024 response: instead of rewriting,
    // the model asked the user to narrow the question down. Accepting this fed
    // ~57 OR'd stopword terms into FTS and rendered it as the "searched as" label.
    vi.mocked(fetch).mockResolvedValueOnce(
      cohereReply(
        "I can help you with that!\n" +
          "Could you please specify the context or the area you're interested in? " +
          "For example, are you looking for important dates and deadlines related " +
          "to a specific event, a particular industry, or a personal matter?\n" +
          "Providing more details will help me give you the most accurate and " +
          "relevant information.",
      ),
    );

    const result = await rewriteQuery(QUERY, {
      provider: "cohere",
      apiKey: "k",
    });

    expect(result).toBe(QUERY);
  });

  it("falls back to the raw query when the rewrite spans multiple lines", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      cohereReply("Sure, here you go:\nimportant dates deadlines"),
    );

    const result = await rewriteQuery(QUERY, {
      provider: "cohere",
      apiKey: "k",
    });

    expect(result).toBe(QUERY);
  });

  it("falls back to the raw query when the rewrite is longer than the original", async () => {
    // A "rewrite" that grew has not condensed anything, whatever it says.
    vi.mocked(fetch).mockResolvedValueOnce(
      cohereReply(
        "what are all of the important dates and deadlines that apply here",
      ),
    );

    const result = await rewriteQuery(QUERY, {
      provider: "cohere",
      apiKey: "k",
    });

    expect(result).toBe(QUERY);
  });

  it("rejects a non-compliant Ollama rewrite the same way", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      ollamaReply(
        "Sure! I'd be happy to help you find the important dates and " +
          "deadlines you are looking for, but could you tell me a bit more " +
          "about which ones you mean?",
      ),
    );

    const result = await rewriteQuery(QUERY, {
      provider: "ollama",
      ollamaModel: "llama3.2:1b",
    });

    expect(result).toBe(QUERY);
  });

  it("skips the rewrite entirely for short or non-question queries", async () => {
    expect(
      await rewriteQuery("dues", { provider: "cohere", apiKey: "k" }),
    ).toBe("dues");
    expect(
      await rewriteQuery("budget spreadsheet link", {
        provider: "cohere",
        apiKey: "k",
      }),
    ).toBe("budget spreadsheet link");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("falls back to the raw query when Cohere rejects the request", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      text: async () => "rate limited",
    } as Response);

    const result = await rewriteQuery(QUERY, {
      provider: "cohere",
      apiKey: "k",
    });

    expect(result).toBe(QUERY);
  });
});

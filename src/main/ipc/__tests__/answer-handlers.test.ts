import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AnswerResponse } from "../../../shared/types";

// handlers.ts pulls in the whole main process; stub every collaborator so only
// the answer channels — their telemetry, timings and cancellation — are exercised.
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: vi.fn(() => "/tmp") },
  shell: { openExternal: vi.fn() },
}));
vi.mock("../../db/singleton", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("../../db/database", () => ({
  getSetting: vi.fn(() => null),
  upsertSetting: vi.fn(),
  getChunksByIds: vi.fn(() => []),
  updateRecentSearchAnswer: vi.fn(),
  getAllSourcesWithCounts: vi.fn(),
  insertSource: vi.fn(),
  deleteSource: vi.fn(),
  getSourceById: vi.fn(),
  getSourceByProviderAndRoot: vi.fn(),
  getDocumentsBySourceId: vi.fn(),
  getStorageStats: vi.fn(),
  clearAllData: vi.fn(),
  getEmbeddingHealth: vi.fn(),
  getChunkCountByModel: vi.fn(),
  listRecentSearches: vi.fn(),
  getRecentSearchById: vi.fn(),
  deleteRecentSearch: vi.fn(),
  pruneExpiredRecentSearches: vi.fn(),
  saveRecentSearchFromResponse: vi.fn(),
}));
vi.mock("../../auth/storage", () => ({
  saveSecret: vi.fn(),
  loadSecret: vi.fn(),
  deleteSecret: vi.fn(),
}));
vi.mock("../../search/searcher", () => ({ search: vi.fn() }));
vi.mock("../../search/answerer", async () => ({
  generateAnswer: vi.fn(),
  COHERE_ANSWER_MODEL: "command-r-08-2024",
  DEFAULT_OLLAMA_CHAT_MODEL: "llama3.2",
}));
vi.mock("../../auth/notion-oauth", () => ({
  startNotionOAuth: vi.fn(),
  cancelNotionOAuth: vi.fn(),
}));
vi.mock("../../connectors/notion", () => ({ listNotionItems: vi.fn() }));
vi.mock("../../auth/google-oauth", () => ({
  startGoogleOAuth: vi.fn(),
  cancelGoogleOAuth: vi.fn(),
  getAuthenticatedClient: vi.fn(),
  refreshIfNeeded: vi.fn(),
}));
vi.mock("../../connectors/drive", () => ({ listDriveItems: vi.fn() }));
vi.mock("../../search/embedder", () => ({ getEmbeddingModelName: vi.fn() }));
vi.mock("../sync-handlers", () => ({
  cancelSync: vi.fn(),
  cancelAllSyncs: vi.fn(),
  buildEmbedConfig: vi.fn(() => ({ provider: "cohere", apiKey: "k" })),
  broadcastSourcesChanged: vi.fn(),
  broadcastRecentsChanged: vi.fn(),
  getActiveSyncProgress: vi.fn(),
  setClearingAllData: vi.fn(),
}));
vi.mock("../../sync/scheduler", () => ({
  syncScheduler: { getState: vi.fn(), start: vi.fn(), stop: vi.fn() },
}));
vi.mock("../../telemetry/posthog", () => ({
  track: vi.fn(),
  initTelemetry: vi.fn(),
  isTelemetryEnabled: vi.fn(),
  setTelemetryEnabled: vi.fn(),
}));

import { ipcMain } from "electron";
import { registerIpcHandlers } from "../handlers";
import { track } from "../../telemetry/posthog";
import { generateAnswer } from "../../search/answerer";
import { getChunksByIds, getSetting } from "../../db/database";
import { buildEmbedConfig } from "../sync-handlers";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function handlerFor(channel: string): Handler {
  const call = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.find(
    ([c]) => c === channel,
  );
  if (!call) throw new Error(`no handler registered for ${channel}`);
  return call[1] as Handler;
}

/** A renderer, identified the way the handlers key their per-window state. */
const SENDER = { sender: { id: 1, isDestroyed: () => false, send: vi.fn() } };

/** The properties of the first `track` call for `event`. */
function props(event: string): Record<string, unknown> {
  const call = (track as ReturnType<typeof vi.fn>).mock.calls.find(
    ([name]) => name === event,
  );
  if (!call) throw new Error(`${event} was never tracked`);
  return (call[1] ?? {}) as Record<string, unknown>;
}

function tracked(event: string): boolean {
  return (track as ReturnType<typeof vi.fn>).mock.calls.some(
    ([name]) => name === event,
  );
}

function request(overrides: Record<string, unknown> = {}): unknown {
  return {
    query: "when are dues due",
    requestId: 1,
    docs: [
      { chunkId: "c1", documentTitle: "Bylaws" },
      { chunkId: "c2", documentTitle: "Handbook" },
    ],
    ...overrides,
  };
}

const mockedGenerate = generateAnswer as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  (buildEmbedConfig as ReturnType<typeof vi.fn>).mockReturnValue({
    provider: "cohere",
    apiKey: "k",
  });
  // Both requested chunks still exist unless a test says otherwise.
  (getChunksByIds as ReturnType<typeof vi.fn>).mockReturnValue([
    { id: "c1", heading: null, text: "dues text" },
    { id: "c2", heading: "Fees", text: "more text" },
  ]);
  mockedGenerate.mockResolvedValue({
    text: "Dues are due in March.",
    citations: [{ start: 0, end: 4, chunkId: "c1" }],
  } satisfies AnswerResponse);
  registerIpcHandlers();
});

describe("answer:generate telemetry", () => {
  it("tracks the request before the work, giving the funnel a denominator", async () => {
    // A generation that never settles: the request event must already be out.
    mockedGenerate.mockReturnValue(new Promise(() => {}));
    void handlerFor("answer:generate")(SENDER, request({ retry: true }));

    expect(props("catena_answer_requested")).toEqual({
      embedding_provider: "cohere",
      answer_model: "command-r-08-2024",
      doc_count: 2,
      retry: true,
    });
    expect(tracked("catena_answer_generated")).toBe(false);
  });

  it("reports the model, retry flag and doc accounting on completion", async () => {
    await handlerFor("answer:generate")(SENDER, request());

    expect(props("catena_answer_generated")).toMatchObject({
      embedding_provider: "cohere",
      answer_model: "command-r-08-2024",
      answer_chars: "Dues are due in March.".length,
      citation_count: 1,
      error_kind: null,
      failure_reason: null,
      retry: false,
      doc_count: 2,
      docs_dropped: 0,
    });
  });

  it("counts chunks that vanished between the search and the generation", async () => {
    (getChunksByIds as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "c1", heading: null, text: "dues text" },
    ]);
    await handlerFor("answer:generate")(SENDER, request());

    expect(props("catena_answer_generated")).toMatchObject({
      doc_count: 2,
      docs_dropped: 1,
    });
  });

  it("carries the failure reason through, so failures are distinguishable", async () => {
    mockedGenerate.mockResolvedValue({
      text: "",
      citations: [],
      errorKind: "failed",
      error: "rate limited",
      failureReason: "rate_limited",
    } satisfies AnswerResponse);

    await handlerFor("answer:generate")(SENDER, request());

    expect(props("catena_answer_generated")).toMatchObject({
      error_kind: "failed",
      failure_reason: "rate_limited",
      first_token_ms: null,
    });
  });

  it("measures time to first token, not just total duration", async () => {
    mockedGenerate.mockImplementation(
      async (
        _q: unknown,
        _d: unknown,
        _c: unknown,
        opts: { onDelta: (t: string) => void },
      ) => {
        opts.onDelta("Dues ");
        opts.onDelta("are due.");
        return { text: "Dues are due.", citations: [] };
      },
    );

    await handlerFor("answer:generate")(SENDER, request());

    const p = props("catena_answer_generated");
    expect(p.first_token_ms).toEqual(expect.any(Number));
    expect(p.duration_ms).toEqual(expect.any(Number));
  });

  it("names the Ollama chat model actually in use", async () => {
    (buildEmbedConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      provider: "ollama",
    });
    (getSetting as ReturnType<typeof vi.fn>).mockReturnValue("qwen2.5:3b");

    await handlerFor("answer:generate")(SENDER, request());

    expect(props("catena_answer_generated")).toMatchObject({
      embedding_provider: "ollama",
      answer_model: "qwen2.5:3b",
    });
    // And it is the model handed to the generator, not just the one reported.
    expect(mockedGenerate).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ ollamaChatModel: "qwen2.5:3b" }),
    );
  });

  it("emits nothing on completion for a generation that was cancelled", async () => {
    mockedGenerate.mockResolvedValue({
      text: "",
      citations: [],
      cancelled: true,
    } satisfies AnswerResponse);

    await handlerFor("answer:generate")(SENDER, request());

    expect(tracked("catena_answer_requested")).toBe(true);
    expect(tracked("catena_answer_generated")).toBe(false);
  });
});

describe("answer:cancel", () => {
  it("tracks a user stop with what had streamed, and aborts the generation", async () => {
    let seenSignal: AbortSignal | undefined;
    mockedGenerate.mockImplementation(
      async (
        _q: unknown,
        _d: unknown,
        _c: unknown,
        opts: { onDelta: (t: string) => void; signal: AbortSignal },
      ) => {
        seenSignal = opts.signal;
        opts.onDelta("Partial");
        return new Promise(() => {}) as Promise<AnswerResponse>;
      },
    );
    void handlerFor("answer:generate")(SENDER, request());
    await Promise.resolve(); // let the handler reach generateAnswer

    handlerFor("answer:cancel")(SENDER, "user_stop");

    expect(seenSignal?.aborted).toBe(true);
    expect(props("catena_answer_cancelled")).toMatchObject({
      embedding_provider: "cohere",
      answer_model: "command-r-08-2024",
      doc_count: 2,
      retry: false,
      streamed_chars: "Partial".length,
      streamed: true,
    });
  });

  it("does not count an app-initiated supersede as an abandonment", async () => {
    mockedGenerate.mockReturnValue(new Promise(() => {}));
    void handlerFor("answer:generate")(SENDER, request());
    await Promise.resolve();

    handlerFor("answer:cancel")(SENDER); // no reason — a new search or a restore

    expect(tracked("catena_answer_cancelled")).toBe(false);
  });

  it("reports a stop only once, however many times it is asked", async () => {
    mockedGenerate.mockReturnValue(new Promise(() => {}));
    void handlerFor("answer:generate")(SENDER, request());
    await Promise.resolve();

    handlerFor("answer:cancel")(SENDER, "user_stop");
    handlerFor("answer:cancel")(SENDER, "user_stop");

    const calls = (track as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([name]) => name === "catena_answer_cancelled",
    );
    expect(calls).toHaveLength(1);
  });

  it("is inert when there is nothing in flight", () => {
    expect(() =>
      handlerFor("answer:cancel")(SENDER, "user_stop"),
    ).not.toThrow();
    expect(tracked("catena_answer_cancelled")).toBe(false);
  });
});

describe("answer:citation-opened", () => {
  it("tracks the citation's rank", () => {
    handlerFor("answer:citation-opened")(SENDER, 3);
    expect(props("catena_answer_citation_opened")).toEqual({ position: 3 });
  });

  it("ignores a position that is not a real rank", () => {
    handlerFor("answer:citation-opened")(SENDER, 0);
    handlerFor("answer:citation-opened")(SENDER, -1);
    handlerFor("answer:citation-opened")(SENDER, 1.5);
    handlerFor("answer:citation-opened")(SENDER, "3");
    expect(tracked("catena_answer_citation_opened")).toBe(false);
  });
});

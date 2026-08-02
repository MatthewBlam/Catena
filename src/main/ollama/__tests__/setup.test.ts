import { describe, it, expect, beforeEach, vi } from "vitest";
import type { OllamaProgress } from "../../../shared/types";

// Never touch the engine, the model registry, or the native sqlite binding.
vi.mock("../runtime", () => ({
  ensureEngine: vi.fn(async (onP: (p: OllamaProgress) => void) => {
    onP({ phase: "checking" });
  }),
  isEngineUp: vi.fn(async () => true),
  managedBinaryExists: vi.fn(() => false),
}));

vi.mock("../models", () => ({
  listModels: vi.fn(async () => [] as string[]),
  hasModel: vi.fn(async () => false),
  pullModel: vi.fn(
    async (
      _m: string,
      onP: (p: { message: string; percent: number }) => void,
    ) => {
      onP({ message: "x", percent: 100 });
    },
  ),
  isEmbeddingModel: (n: string) => n.includes("embed"),
}));

// The db collaborators must never load `better-sqlite3`.
vi.mock("../../db/singleton", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("../../db/database", () => ({
  upsertSetting: vi.fn(),
  getSetting: vi.fn(() => null),
}));

import { runSetup, pullChatModel, getStatusDetail } from "../setup";
import { EMBED_MODEL, CHAT_MODEL } from "../platform";
import { ensureEngine, isEngineUp } from "../runtime";
import { listModels, hasModel, pullModel } from "../models";
import { getDb } from "../../db/singleton";
import { upsertSetting, getSetting } from "../../db/database";

beforeEach(() => {
  vi.clearAllMocks();
  // Restore default resolutions cleared by clearAllMocks.
  vi.mocked(ensureEngine).mockImplementation(async (onP) => {
    onP({ phase: "checking" });
  });
  vi.mocked(isEngineUp).mockResolvedValue(true);
  vi.mocked(listModels).mockResolvedValue([]);
  vi.mocked(pullModel).mockImplementation(async (_m, onP) => {
    onP({ message: "x", percent: 100 });
  });
  vi.mocked(getDb).mockReturnValue({} as never);
  vi.mocked(getSetting).mockReturnValue(null);
});

describe("runSetup", () => {
  it("pulls the embedding model when it is absent, persists settings, and reports ready", async () => {
    vi.mocked(hasModel).mockResolvedValue(false);

    const events: OllamaProgress[] = [];
    await runSetup((p) => events.push(p));

    expect(pullModel).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pullModel).mock.calls[0][0]).toBe(EMBED_MODEL);

    expect(upsertSetting).toHaveBeenCalledWith(
      expect.anything(),
      "embedding_provider",
      "ollama",
    );
    expect(upsertSetting).toHaveBeenCalledWith(
      expect.anything(),
      "ollama_model",
      "nomic-embed-text",
    );
    expect(events.at(-1)).toEqual({ phase: "ready" });
  });

  it("skips the pull when the embedding model is already installed but still persists and reports ready", async () => {
    vi.mocked(hasModel).mockResolvedValue(true);

    const events: OllamaProgress[] = [];
    await runSetup((p) => events.push(p));

    expect(pullModel).not.toHaveBeenCalled();
    expect(upsertSetting).toHaveBeenCalledWith(
      expect.anything(),
      "embedding_provider",
      "ollama",
    );
    expect(upsertSetting).toHaveBeenCalledWith(
      expect.anything(),
      "ollama_model",
      "nomic-embed-text",
    );
    expect(events.at(-1)).toEqual({ phase: "ready" });
  });
});

describe("pullChatModel", () => {
  it("pulls the chat model and persists ollama_chat_model", async () => {
    const events: OllamaProgress[] = [];
    await pullChatModel((p) => events.push(p));

    expect(pullModel).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pullModel).mock.calls[0][0]).toBe(CHAT_MODEL);
    expect(upsertSetting).toHaveBeenCalledWith(
      expect.anything(),
      "ollama_chat_model",
      CHAT_MODEL,
    );
    expect(events.at(-1)).toEqual({ phase: "ready" });
  });
});

describe("getStatusDetail", () => {
  it("reports setupInProgress and reflects engineUp / models", async () => {
    vi.mocked(isEngineUp).mockResolvedValue(true);
    vi.mocked(listModels).mockResolvedValue(["nomic-embed-text", "llama3.2"]);

    const detail = await getStatusDetail(true);

    expect(detail.setupInProgress).toBe(true);
    expect(detail.engineUp).toBe(true);
    expect(detail.models).toEqual(["nomic-embed-text", "llama3.2"]);
    expect(detail.embeddingModels).toEqual(["nomic-embed-text"]);
    expect(detail.embeddingReady).toBe(true);
    expect(detail.chatReady).toBe(true);
  });

  it("returns no models when the engine is down", async () => {
    vi.mocked(isEngineUp).mockResolvedValue(false);

    const detail = await getStatusDetail(false);

    expect(detail.engineUp).toBe(false);
    expect(detail.models).toEqual([]);
    expect(detail.embeddingReady).toBe(false);
    expect(detail.chatReady).toBe(false);
    expect(detail.setupInProgress).toBe(false);
    expect(listModels).not.toHaveBeenCalled();
  });
});

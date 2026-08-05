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

vi.mock("../pulled-models", () => ({
  recordPulledModel: vi.fn(),
  ensurePulledModelsRecord: vi.fn(),
}));

import { runSetup, pullChatModel, getStatusDetail } from "../setup";
import { EMBED_MODEL, CHAT_MODEL } from "../platform";
import { ensureEngine, isEngineUp } from "../runtime";
import { listModels, hasModel, pullModel } from "../models";
import { getDb } from "../../db/singleton";
import { upsertSetting, getSetting } from "../../db/database";
import { recordPulledModel, ensurePulledModelsRecord } from "../pulled-models";

beforeEach(() => {
  vi.clearAllMocks();
  // Restore default resolutions cleared by clearAllMocks.
  vi.mocked(ensureEngine).mockImplementation(async (onP) => {
    onP({ phase: "checking" });
  });
  vi.mocked(isEngineUp).mockResolvedValue(true);
  vi.mocked(listModels).mockResolvedValue([]);
  // Pinned here like the rest: `mockResolvedValue` survives `clearAllMocks`, so
  // without a default every test inherits whatever the previous one set.
  vi.mocked(hasModel).mockResolvedValue(false);
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

describe("model provenance and duplicate pulls", () => {
  it("records the embedding model when setup actually pulls it", async () => {
    vi.mocked(hasModel).mockResolvedValue(false);

    await runSetup(vi.fn());

    expect(pullModel).toHaveBeenCalled();
    expect(recordPulledModel).toHaveBeenCalledWith(
      expect.anything(),
      EMBED_MODEL,
    );
  });

  it("does not claim a model that was already installed", async () => {
    // Reused, not downloaded — so uninstall must never delete it.
    vi.mocked(hasModel).mockResolvedValue(true);

    await runSetup(vi.fn());

    expect(pullModel).not.toHaveBeenCalled();
    expect(recordPulledModel).not.toHaveBeenCalled();
  });

  it("skips the chat pull when the model is already installed", async () => {
    // Ollama would not re-download the blobs, but it still needs the network for
    // the manifest — so an offline user with llama3.2 present used to fail here.
    vi.mocked(hasModel).mockResolvedValue(true);

    await pullChatModel(vi.fn());

    expect(pullModel).not.toHaveBeenCalled();
    expect(recordPulledModel).not.toHaveBeenCalled();
    // Still persisted, so answers use it.
    expect(upsertSetting).toHaveBeenCalledWith(
      expect.anything(),
      "ollama_chat_model",
      CHAT_MODEL,
    );
  });

  it("records the chat model when it does pull it", async () => {
    vi.mocked(hasModel).mockResolvedValue(false);

    await pullChatModel(vi.fn());

    expect(pullModel).toHaveBeenCalled();
    expect(recordPulledModel).toHaveBeenCalledWith(
      expect.anything(),
      CHAT_MODEL,
    );
  });
});

describe("provenance is established even when nothing is pulled", () => {
  it("opens a record on setup so 'we pulled nothing' is not mistaken for 'untracked'", async () => {
    // The bug this pins: with both models already installed, setup pulled
    // nothing and therefore wrote no record — and uninstall read that absence as
    // "legacy install, delete the defaults", destroying the user's own models.
    vi.mocked(hasModel).mockResolvedValue(true);

    await runSetup(vi.fn());

    expect(recordPulledModel).not.toHaveBeenCalled();
    expect(ensurePulledModelsRecord).toHaveBeenCalled();
  });

  it("opens a record on the chat pull path too", async () => {
    vi.mocked(hasModel).mockResolvedValue(true);

    await pullChatModel(vi.fn());

    expect(ensurePulledModelsRecord).toHaveBeenCalled();
  });
});

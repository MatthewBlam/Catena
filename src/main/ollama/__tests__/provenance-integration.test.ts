import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Setup and uninstall agree about provenance — exercised together, against the
 * real `pulled-models` module and a real settings store.
 *
 * The bug this exists to prevent shipped once: each half was correct under its
 * own mocks (setup "records only what it pulls", uninstall "deletes only what
 * was recorded"), but the handoff between them was not. With every model already
 * installed, setup recorded nothing, and uninstall read that absence as a legacy
 * install and deleted the user's own models. Only a test spanning both catches
 * that, which is why this file mocks the engine and the registry but never
 * `pulled-models`.
 */

let settings: Record<string, string>;

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/catena-test" } }));

vi.mock("../../db/singleton", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("../../db/database", () => ({
  getSetting: vi.fn((_db: unknown, key: string) => settings[key] ?? null),
  upsertSetting: vi.fn((_db: unknown, key: string, value: string) => {
    settings[key] = value;
  }),
  deleteSetting: vi.fn((_db: unknown, key: string) => {
    delete settings[key];
  }),
}));

vi.mock("../runtime", () => ({
  ensureEngine: vi.fn(async () => {}),
  isEngineUp: vi.fn(async () => true),
  managedBinaryExists: vi.fn(() => true),
  stopEngine: vi.fn(),
}));

vi.mock("../models", () => ({
  hasModel: vi.fn(async () => false),
  pullModel: vi.fn(async () => {}),
  deleteModel: vi.fn(async () => {}),
  listModels: vi.fn(async () => []),
  isEmbeddingModel: (n: string) => n.includes("embed"),
}));

vi.mock("node:fs/promises", () => ({ rm: vi.fn(async () => {}) }));

import { runSetup, pullChatModel } from "../setup";
import { uninstallOllama } from "../uninstall";
import { EMBED_MODEL, CHAT_MODEL } from "../platform";
import { hasModel, deleteModel } from "../models";

beforeEach(() => {
  settings = {};
  vi.clearAllMocks();
  vi.mocked(hasModel).mockResolvedValue(false);
});

describe("setup → uninstall provenance handoff", () => {
  it("spares models the user installed themselves, after setup alone", async () => {
    // The exact reported sequence, and deliberately WITHOUT `pullChatModel`:
    // install Ollama and both models by hand, run onboarding, hit Uninstall.
    // Onboarding never pulls a chat model, so `runSetup` is the only path that
    // runs — and it alone must establish the record.
    vi.mocked(hasModel).mockResolvedValue(true);
    await runSetup(vi.fn());

    await uninstallOllama();

    expect(deleteModel).not.toHaveBeenCalled();
  });

  it("spares them after the optional chat pull too", async () => {
    vi.mocked(hasModel).mockResolvedValue(true);
    await runSetup(vi.fn());
    await pullChatModel(vi.fn());

    await uninstallOllama();

    expect(deleteModel).not.toHaveBeenCalled();
  });

  it("removes models it pulled itself", async () => {
    vi.mocked(hasModel).mockResolvedValue(false);
    await runSetup(vi.fn());
    await pullChatModel(vi.fn());

    await uninstallOllama();

    expect(deleteModel).toHaveBeenCalledWith(EMBED_MODEL, undefined);
    expect(deleteModel).toHaveBeenCalledWith(CHAT_MODEL, undefined);
  });

  it("removes only its own half of a mixed store", async () => {
    // User already had the embedding model; Catena pulls only the chat model.
    vi.mocked(hasModel).mockImplementation(
      async (m: string) => m === EMBED_MODEL,
    );
    await runSetup(vi.fn());
    await pullChatModel(vi.fn());

    await uninstallOllama();

    expect(deleteModel).toHaveBeenCalledWith(CHAT_MODEL, undefined);
    expect(deleteModel).not.toHaveBeenCalledWith(EMBED_MODEL, undefined);
  });

  it("still clears the defaults for an install that never ran the new setup", async () => {
    // No record at all: genuinely a pre-provenance install, where deleting the
    // two defaults is the only behaviour that does not orphan the model store.
    await uninstallOllama();

    expect(deleteModel).toHaveBeenCalledWith(EMBED_MODEL, undefined);
    expect(deleteModel).toHaveBeenCalledWith(CHAT_MODEL, undefined);
  });

  it("leaves a reinstall able to claim models again", async () => {
    vi.mocked(hasModel).mockResolvedValue(false);
    await runSetup(vi.fn());
    await uninstallOllama();
    vi.mocked(deleteModel).mockClear();

    // Second run, this time everything is already present.
    vi.mocked(hasModel).mockResolvedValue(true);
    await runSetup(vi.fn());
    await uninstallOllama();

    expect(deleteModel).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";

// `ollamaDir()` reads Electron's userData path; give it a stable fake.
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/commons-test" },
}));

// Never touch the engine, the model registry, the filesystem, or native sqlite.
vi.mock("../runtime", () => ({
  ensureEngine: vi.fn(async () => {}),
  isEngineUp: vi.fn(async () => true),
  managedBinaryExists: vi.fn(() => true),
  stopEngine: vi.fn(),
}));

vi.mock("../models", () => ({
  deleteModel: vi.fn(async () => {}),
}));

vi.mock("node:fs/promises", () => ({ rm: vi.fn(async () => {}) }));

vi.mock("../../db/singleton", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("../../db/database", () => ({ deleteSetting: vi.fn() }));

import { uninstallOllama } from "../uninstall";
import { EMBED_MODEL, CHAT_MODEL, ollamaDir } from "../platform";
import {
  ensureEngine,
  isEngineUp,
  managedBinaryExists,
  stopEngine,
} from "../runtime";
import { deleteModel } from "../models";
import { rm } from "node:fs/promises";
import { deleteSetting } from "../../db/database";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isEngineUp).mockResolvedValue(true);
  vi.mocked(managedBinaryExists).mockReturnValue(true);
  vi.mocked(deleteModel).mockResolvedValue(undefined);
  vi.mocked(ensureEngine).mockResolvedValue(undefined);
});

describe("uninstallOllama", () => {
  it("deletes both models, stops the engine, removes the dir, and clears settings", async () => {
    await uninstallOllama();

    expect(deleteModel).toHaveBeenCalledWith(EMBED_MODEL, undefined);
    expect(deleteModel).toHaveBeenCalledWith(CHAT_MODEL, undefined);
    expect(stopEngine).toHaveBeenCalledTimes(1);
    expect(rm).toHaveBeenCalledWith(ollamaDir(), {
      recursive: true,
      force: true,
    });
    expect(deleteSetting).toHaveBeenCalledWith(
      expect.anything(),
      "ollama_model",
    );
    expect(deleteSetting).toHaveBeenCalledWith(
      expect.anything(),
      "ollama_chat_model",
    );
  });

  it("starts our managed binary when the engine is down so models can be deleted", async () => {
    // Down at first, then up after ensureEngine runs.
    vi.mocked(isEngineUp).mockResolvedValueOnce(false).mockResolvedValue(true);

    await uninstallOllama();

    expect(ensureEngine).toHaveBeenCalledTimes(1);
    expect(deleteModel).toHaveBeenCalledTimes(2);
  });

  it("skips model deletion when the engine is unreachable and no binary is present", async () => {
    vi.mocked(isEngineUp).mockResolvedValue(false);
    vi.mocked(managedBinaryExists).mockReturnValue(false);

    await uninstallOllama();

    expect(ensureEngine).not.toHaveBeenCalled();
    expect(deleteModel).not.toHaveBeenCalled();
    // Disk + settings cleanup still happens.
    expect(rm).toHaveBeenCalledTimes(1);
    expect(deleteSetting).toHaveBeenCalledTimes(2);
  });

  it("still removes the binary and settings when a model delete fails", async () => {
    vi.mocked(deleteModel).mockRejectedValue(new Error("boom"));

    await expect(uninstallOllama()).resolves.toBeUndefined();

    expect(stopEngine).toHaveBeenCalledTimes(1);
    expect(rm).toHaveBeenCalledTimes(1);
    expect(deleteSetting).toHaveBeenCalledTimes(2);
  });

  it("continues to disk cleanup when starting the engine fails", async () => {
    vi.mocked(isEngineUp).mockResolvedValue(false);
    vi.mocked(managedBinaryExists).mockReturnValue(true);
    vi.mocked(ensureEngine).mockRejectedValue(new Error("no start"));

    await expect(uninstallOllama()).resolves.toBeUndefined();

    expect(deleteModel).not.toHaveBeenCalled();
    expect(rm).toHaveBeenCalledTimes(1);
    expect(deleteSetting).toHaveBeenCalledTimes(2);
  });
});

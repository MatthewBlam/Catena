import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({ windows: [] as unknown[] }));
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => h.windows },
}));

// Never touch the real setup module (which reaches Ollama) or the native db.
vi.mock("../../ollama/setup", () => ({
  runSetup: vi.fn(),
  pullChatModel: vi.fn(),
  getStatusDetail: vi.fn(async (setupInProgress: boolean) => ({
    engineUp: true,
    models: [],
    embeddingModels: [],
    embeddingReady: false,
    chatReady: false,
    setupInProgress,
  })),
}));
vi.mock("../../ollama/uninstall", () => ({ uninstallOllama: vi.fn() }));
vi.mock("../../db/singleton", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("../../db/database", () => ({ upsertSetting: vi.fn() }));
vi.mock("../../telemetry/posthog", () => ({ track: vi.fn() }));

import { ipcMain } from "electron";
import { registerOllamaHandlers } from "../ollama-handlers";
import { runSetup, getStatusDetail } from "../../ollama/setup";
import { uninstallOllama } from "../../ollama/uninstall";
import { track } from "../../telemetry/posthog";
import { getDb } from "../../db/singleton";
import { upsertSetting } from "../../db/database";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function handlerFor(channel: string): Handler {
  const call = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.find(
    ([c]) => c === channel,
  );
  if (!call) throw new Error(`no handler registered for ${channel}`);
  return call[1] as Handler;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.windows = [];
  registerOllamaHandlers();
});

describe("ollama:status", () => {
  it("reports setupInProgress:false with no active operation", async () => {
    const status = await handlerFor("ollama:status")({});
    expect(getStatusDetail).toHaveBeenCalledWith(false);
    expect(status).toMatchObject({
      engineUp: true,
      models: [],
      setupInProgress: false,
    });
  });
});

describe("settings:set-ollama-model", () => {
  it("persists a valid model", () => {
    handlerFor("settings:set-ollama-model")({}, "nomic-embed-text");
    expect(upsertSetting).toHaveBeenCalledWith(
      getDb(),
      "ollama_model",
      "nomic-embed-text",
    );
  });

  it("throws on an empty model", () => {
    expect(() => handlerFor("settings:set-ollama-model")({}, "")).toThrow(
      /Invalid Ollama model/,
    );
    expect(upsertSetting).not.toHaveBeenCalled();
  });
});

describe("settings:set-ollama-chat-model", () => {
  it("persists a valid chat model", () => {
    handlerFor("settings:set-ollama-chat-model")({}, "llama3.2");
    expect(upsertSetting).toHaveBeenCalledWith(
      getDb(),
      "ollama_chat_model",
      "llama3.2",
    );
  });

  it("throws on an empty chat model", () => {
    expect(() => handlerFor("settings:set-ollama-chat-model")({}, "")).toThrow(
      /Invalid Ollama chat model/,
    );
    expect(upsertSetting).not.toHaveBeenCalled();
  });
});

describe("single-flight setup", () => {
  it("rejects a second setup while one is in flight and reports it in status", async () => {
    // A setup that stays pending keeps the single-flight guard held. Kept
    // controllable so we can release it and not leak the guard into later tests.
    let releaseSetup!: () => void;
    (runSetup as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<void>((r) => {
        releaseSetup = r;
      }),
    );

    const setup = handlerFor("ollama:setup");
    const first = setup({}); // in flight — deliberately not awaited
    // Keep the floating rejection from becoming an unhandled rejection later.
    void Promise.resolve(first).catch(() => {});

    await expect(setup({})).rejects.toThrow(/already in progress/i);

    // While that setup is in flight, status must surface it.
    const status = await handlerFor("ollama:status")({});
    expect(getStatusDetail).toHaveBeenLastCalledWith(true);
    expect(status).toMatchObject({ setupInProgress: true });

    // Release the in-flight op so the guard is clear for the next test.
    releaseSetup();
    await first;
  });
});

describe("ollama:cancel-setup", () => {
  it("does not throw when there is nothing to cancel", () => {
    expect(() => handlerFor("ollama:cancel-setup")({})).not.toThrow();
  });
});

describe("ollama:uninstall", () => {
  it("runs the uninstall and emits start/complete telemetry", async () => {
    (uninstallOllama as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await handlerFor("ollama:uninstall")({});

    expect(uninstallOllama).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(
      "catena_ollama_uninstall_started",
      expect.anything(),
    );
    expect(track).toHaveBeenCalledWith(
      "catena_ollama_uninstall_completed",
      expect.anything(),
    );
  });

  it("is rejected while a setup is already in flight", async () => {
    let releaseSetup!: () => void;
    (runSetup as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<void>((r) => {
        releaseSetup = r;
      }),
    );
    const first = handlerFor("ollama:setup")({});
    void Promise.resolve(first).catch(() => {});

    await expect(handlerFor("ollama:uninstall")({})).rejects.toThrow(
      /already in progress/i,
    );
    expect(uninstallOllama).not.toHaveBeenCalled();

    // Release so the guard doesn't leak into the next test.
    releaseSetup();
    await first;
  });

  it("releases the guard so a later setup can run", async () => {
    (uninstallOllama as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (runSetup as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await handlerFor("ollama:uninstall")({});
    await expect(handlerFor("ollama:setup")({})).resolves.toBeUndefined();
  });
});

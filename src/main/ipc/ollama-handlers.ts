import { ipcMain, BrowserWindow } from "electron";
import type { OllamaProgress } from "../../shared/types";
import { getDb } from "../db/singleton";
import { upsertSetting } from "../db/database";
import { track } from "../telemetry/posthog";
import { runSetup, pullChatModel, getStatusDetail } from "../ollama/setup";
import { uninstallOllama } from "../ollama/uninstall";

/**
 * The in-flight managed operation (initial setup OR the optional chat pull).
 * A single controller enforces single-flight: only one download/pull runs at a
 * time, and `ollama:cancel-setup` aborts whichever it is.
 */
let activeOp: AbortController | null = null;

/** Fan-out to every window, mirroring `sync-handlers.ts`'s `broadcast`. A
 * progress stream is not tied to the requesting window — any open window that
 * shows setup state should see it. */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch {
      // Window torn down between the check and the send.
    }
  }
}

function publishOllamaProgress(p: OllamaProgress): void {
  broadcast("ollama:progress", p);
}

/**
 * Runs `work` under the single-flight guard, streaming its progress. Publishes
 * an `error` phase for a genuine failure (not a user cancel) before rejecting,
 * so a window that only watches the progress stream still learns it failed.
 */
async function runManaged(
  work: (
    onProgress: (p: OllamaProgress) => void,
    signal: AbortSignal,
  ) => Promise<void>,
  label: string,
): Promise<void> {
  if (activeOp) {
    throw new Error("An Ollama setup is already in progress.");
  }
  const controller = new AbortController();
  activeOp = controller;
  track("catena_ollama_setup_started", { platform: process.platform, label });
  try {
    await work(publishOllamaProgress, controller.signal);
    track("catena_ollama_setup_completed", {
      platform: process.platform,
      label,
    });
  } catch (err) {
    if (!controller.signal.aborted) {
      publishOllamaProgress({
        phase: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    throw err;
  } finally {
    if (activeOp === controller) activeOp = null;
  }
}

export function registerOllamaHandlers(): void {
  ipcMain.handle("ollama:setup", () => runManaged(runSetup, "setup"));

  ipcMain.handle("ollama:pull-chat-model", () =>
    runManaged(pullChatModel, "chat-model"),
  );

  ipcMain.handle("ollama:cancel-setup", () => {
    activeOp?.abort();
  });

  // Complete teardown of the managed engine + Catena-pulled models. Shares the
  // single-flight guard so it can't race an in-flight download/pull.
  ipcMain.handle("ollama:uninstall", async () => {
    if (activeOp) {
      throw new Error("An Ollama operation is already in progress.");
    }
    const controller = new AbortController();
    activeOp = controller;
    track("catena_ollama_uninstall_started", { platform: process.platform });
    try {
      await uninstallOllama(controller.signal);
      track("catena_ollama_uninstall_completed", {
        platform: process.platform,
      });
    } finally {
      if (activeOp === controller) activeOp = null;
    }
  });

  ipcMain.handle("ollama:status", () => getStatusDetail(activeOp !== null));

  // The `ollama_model` / `ollama_chat_model` settings had no setter anywhere, so
  // the app was pinned to hardcoded defaults. These mirror
  // `settings:set-embedding-provider`.
  ipcMain.handle("settings:set-ollama-model", (_, model: string) => {
    if (!model || typeof model !== "string") {
      throw new Error(`Invalid Ollama model: ${model}`);
    }
    upsertSetting(getDb(), "ollama_model", model);
    track("catena_ollama_model_changed", { kind: "embedding" });
  });

  ipcMain.handle("settings:set-ollama-chat-model", (_, model: string) => {
    if (!model || typeof model !== "string") {
      throw new Error(`Invalid Ollama chat model: ${model}`);
    }
    upsertSetting(getDb(), "ollama_chat_model", model);
    track("catena_ollama_model_changed", { kind: "chat" });
  });
}

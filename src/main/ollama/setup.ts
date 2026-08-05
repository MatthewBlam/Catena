import type { OllamaProgress, OllamaStatusDetail } from "../../shared/types";
import { getDb } from "../db/singleton";
import { upsertSetting, getSetting } from "../db/database";
import { EMBED_MODEL, CHAT_MODEL } from "./platform";
import { ensureEngine, isEngineUp, managedBinaryExists } from "./runtime";
import { listModels, hasModel, pullModel, isEmbeddingModel } from "./models";
import { recordPulledModel, ensurePulledModelsRecord } from "./pulled-models";

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Setup aborted");
}

/** Maps a model pull's progress onto the shared `OllamaProgress` shape. */
function pullReporter(
  model: string,
  onProgress: (p: OllamaProgress) => void,
): (p: {
  message: string;
  bytesCompleted?: number;
  bytesTotal?: number;
  percent?: number;
}) => void {
  return (p) =>
    onProgress({
      phase: "pulling-model",
      model,
      message: p.message,
      bytesCompleted: p.bytesCompleted,
      bytesTotal: p.bytesTotal,
      percent: p.percent,
    });
}

/**
 * The full local-provider bootstrap: ensure the engine is running (download +
 * extract + serve if needed), pull the embedding model if it isn't installed,
 * then persist the provider + model so search uses Ollama. Emits one
 * `OllamaProgress` stream; `phase: "ready"` is the terminal success.
 */
export async function runSetup(
  onProgress: (p: OllamaProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  await ensureEngine(onProgress, signal);
  throwIfAborted(signal);

  const db = getDb();
  // Before the pull decision, not after: if every model turns out to be present
  // we pull nothing, and an absent record would then read as "legacy install" —
  // which uninstall answers by deleting the defaults, i.e. the user's own models.
  ensurePulledModelsRecord(db);

  if (!(await hasModel(EMBED_MODEL, signal))) {
    onProgress({ phase: "pulling-model", model: EMBED_MODEL, percent: 0 });
    await pullModel(EMBED_MODEL, pullReporter(EMBED_MODEL, onProgress), signal);
    // Only what we actually downloaded — the model store is shared, so a model
    // that was already there belongs to the user and uninstall must not take it.
    recordPulledModel(db, EMBED_MODEL);
  }

  upsertSetting(db, "embedding_provider", "ollama");
  upsertSetting(db, "ollama_model", EMBED_MODEL);
  onProgress({ phase: "ready" });
}

/**
 * Downloads the chat model grounded answers need (optional, on-demand). Ensures
 * the engine first so it works even if setup hasn't run this session, then
 * persists `ollama_chat_model`.
 */
export async function pullChatModel(
  onProgress: (p: OllamaProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  await ensureEngine(onProgress, signal);
  throwIfAborted(signal);

  const db = getDb();
  ensurePulledModelsRecord(db);

  // Guarded like `runSetup`. Ollama would not re-download existing blobs, but it
  // still fetches the manifest — so without this, a user who already has the
  // model fails here with no network instead of succeeding instantly.
  if (!(await hasModel(CHAT_MODEL, signal))) {
    onProgress({ phase: "pulling-model", model: CHAT_MODEL, percent: 0 });
    await pullModel(CHAT_MODEL, pullReporter(CHAT_MODEL, onProgress), signal);
    recordPulledModel(db, CHAT_MODEL);
  }

  upsertSetting(db, "ollama_chat_model", CHAT_MODEL);
  onProgress({ phase: "ready" });
}

/** Detailed readiness for the setup UI. `setupInProgress` comes from the IPC
 * layer that owns the single-flight guard. */
export async function getStatusDetail(
  setupInProgress: boolean,
): Promise<OllamaStatusDetail> {
  const engineUp = await isEngineUp();
  const models = engineUp ? await listModels() : [];
  const embeddingModels = models.filter(isEmbeddingModel);
  const chatModel = getSetting(getDb(), "ollama_chat_model") ?? CHAT_MODEL;
  const chatReady = models.some(
    (m) => m === chatModel || m.startsWith(`${chatModel}:`),
  );
  return {
    engineUp,
    models,
    embeddingModels,
    embeddingReady: embeddingModels.length > 0,
    chatReady,
    setupInProgress,
    managedBinaryPresent: managedBinaryExists(),
  };
}

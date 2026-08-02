import { rm } from "node:fs/promises";
import { getDb } from "../db/singleton";
import { deleteSetting } from "../db/database";
import { EMBED_MODEL, CHAT_MODEL, ollamaDir } from "./platform";
import {
  ensureEngine,
  isEngineUp,
  managedBinaryExists,
  stopEngine,
} from "./runtime";
import { deleteModel } from "./models";

/**
 * Completely undoes what Commons installed for the local provider: removes the
 * Commons-pulled models, the downloaded engine binary, and the model settings.
 * Deliberately conservative about anything we don't own —
 *   - `stopEngine()` kills the child only if we spawned it, so a reused
 *     system/manual Ollama keeps running;
 *   - only the managed binary directory (`<userData>/ollama`) is deleted, never
 *     a user's own install (which lives elsewhere);
 *   - only the two Commons-default models are removed, never the user's others.
 *
 * Every step is best-effort so a single failure (e.g. the engine already gone)
 * still leaves the rest torn down rather than stranding a half-uninstall.
 */
export async function uninstallOllama(signal?: AbortSignal): Promise<void> {
  // Model deletion needs a reachable engine. If ours is on disk but not running,
  // start it (no download — the binary is present) purely so we can delete the
  // models through the API. Tolerate a failure and press on to the disk cleanup.
  if (!(await isEngineUp(signal)) && managedBinaryExists()) {
    try {
      await ensureEngine(() => {}, signal);
    } catch {
      // Couldn't start it — the models just stay in the shared store; the
      // binary and settings are still removed below.
    }
  }

  if (await isEngineUp(signal)) {
    for (const model of [EMBED_MODEL, CHAT_MODEL]) {
      try {
        await deleteModel(model, signal);
      } catch {
        // Best-effort: a model we can't remove shouldn't block the uninstall.
      }
    }
  }

  // Stop our engine (no-op for a reused one) before deleting its binary, so we
  // never yank the executable out from under a running child.
  stopEngine();

  await rm(ollamaDir(), { recursive: true, force: true });

  const db = getDb();
  deleteSetting(db, "ollama_model");
  deleteSetting(db, "ollama_chat_model");
}

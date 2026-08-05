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
import { readPulledModels, clearPulledModels } from "./pulled-models";

/**
 * Completely undoes what Catena installed for the local provider: removes the
 * Catena-pulled models, the downloaded engine binary, and the model settings.
 * Deliberately conservative about anything we don't own —
 *   - `stopEngine()` kills the child only if we spawned it, so a reused
 *     system/manual Ollama keeps running;
 *   - only the managed binary directory (`<userData>/ollama`) is deleted, never
 *     a user's own install (which lives elsewhere);
 *   - only models Catena actually pulled are removed. Ollama's model store is
 *     shared with a user's own install, so the two Catena defaults may well be
 *     models they pulled themselves and we simply reused; deleting those would
 *     destroy data we never created.
 *
 * Every step is best-effort so a single failure (e.g. the engine already gone)
 * still leaves the rest torn down rather than stranding a half-uninstall.
 */
export async function uninstallOllama(signal?: AbortSignal): Promise<void> {
  const db = getDb();
  // `null` means this install predates provenance tracking, so we genuinely do
  // not know what we pulled. Falling back to the two defaults is what the
  // previous version did — the only option that neither regresses those users
  // into a permanently orphaned model store nor invents a provenance claim.
  const pulled = readPulledModels(db) ?? [EMBED_MODEL, CHAT_MODEL];

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

  if (pulled.length > 0 && (await isEngineUp(signal))) {
    for (const model of pulled) {
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

  deleteSetting(db, "ollama_model");
  deleteSetting(db, "ollama_chat_model");
  clearPulledModels(db);
}

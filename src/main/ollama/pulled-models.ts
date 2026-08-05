import type Database from "better-sqlite3";
import { getSetting, upsertSetting, deleteSetting } from "../db/database";

const PULLED_MODELS_KEY = "ollama_pulled_models";

/**
 * Which models Catena downloaded itself.
 *
 * Ollama keeps its models in one shared store (`~/.ollama/models`) that our
 * managed engine and a user's own Ollama both read — which is what stops us ever
 * re-downloading a model someone already has, and is also why uninstall cannot
 * simply delete the two Catena defaults: they may be models the user pulled
 * themselves long before installing Catena, that we merely found and reused.
 *
 * So we record what we actually pulled, and uninstall removes only that.
 *
 * `null` (no record at all) is deliberately distinct from `[]` (we pulled
 * nothing): the former means this install predates provenance tracking and its
 * provenance is genuinely unknown, which uninstall handles as its own case.
 *
 * That distinction only holds because `ensurePulledModelsRecord` opens the
 * record during setup regardless of whether anything was pulled. Without it,
 * "setup ran and found every model already installed" also produced no record —
 * and uninstall, reading that as a legacy install, deleted the very models the
 * user had installed themselves.
 */
export function readPulledModels(db: Database.Database): string[] | null {
  const raw = getSetting(db, PULLED_MODELS_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((m): m is string => typeof m === "string");
  } catch {
    // A corrupt value is not a licence to guess. Fall back to "unknown".
    return null;
  }
}

/**
 * Declares that this install tracks provenance, without claiming any model.
 *
 * Must be called by every path that could pull — the record's *existence* is
 * what lets uninstall tell "we pulled nothing" apart from "we have no idea".
 * A no-op when a record already exists, so it can never drop a real claim.
 */
export function ensurePulledModelsRecord(db: Database.Database): void {
  if (readPulledModels(db) === null) {
    upsertSetting(db, PULLED_MODELS_KEY, JSON.stringify([]));
  }
}

/** Notes that Catena pulled `model` itself. Idempotent. */
export function recordPulledModel(db: Database.Database, model: string): void {
  const existing = readPulledModels(db) ?? [];
  if (existing.includes(model)) return;
  upsertSetting(db, PULLED_MODELS_KEY, JSON.stringify([...existing, model]));
}

/** Drops the record entirely, returning provenance to "unknown". */
export function clearPulledModels(db: Database.Database): void {
  deleteSetting(db, PULLED_MODELS_KEY);
}

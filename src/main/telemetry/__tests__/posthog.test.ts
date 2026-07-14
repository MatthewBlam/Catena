import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../../db/__tests__/test-db";
import { upsertSetting, getSetting } from "../../db/database";

const capture = vi.fn();
const shutdown = vi.fn();

// A class, not `vi.fn(() => …)` — posthog.ts calls `new PostHog(...)`, and an
// arrow function is not constructable.
vi.mock("posthog-node", () => ({
  PostHog: class {
    capture = capture;
    shutdown = shutdown;
  },
}));

/**
 * `API_KEY` is captured at module scope from `process.env`, so the key's presence
 * has to be decided before the import. Hence a fresh module per test rather than a
 * top-level import.
 */
async function loadTelemetry(
  apiKey: string | undefined,
): Promise<typeof import("../posthog")> {
  vi.resetModules();
  if (apiKey === undefined) vi.stubEnv("POSTHOG_API_KEY", "");
  else vi.stubEnv("POSTHOG_API_KEY", apiKey);
  return import("../posthog");
}

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  capture.mockClear();
  shutdown.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
});

describe("telemetry opt-out (C3)", () => {
  it("defaults to enabled when the user has expressed no preference", async () => {
    const t = await loadTelemetry("phc_test");
    t.initTelemetry(db);
    expect(t.isTelemetryEnabled()).toBe(true);
  });

  it("reports the persisted opt-out after a restart", async () => {
    upsertSetting(db, "telemetry_enabled", "false");

    const t = await loadTelemetry("phc_test");
    t.initTelemetry(db);

    expect(t.isTelemetryEnabled()).toBe(false);
  });

  it("reports the persisted opt-out even with no PostHog key configured", async () => {
    // The regression. `initTelemetry` used to return early on `!API_KEY` *before*
    // reading the setting, leaving `enabled` at its hardcoded `true` — so the
    // Settings toggle rendered "on" for a user who had turned it off, forever.
    upsertSetting(db, "telemetry_enabled", "false");

    const t = await loadTelemetry(undefined);
    t.initTelemetry(db);

    expect(t.isTelemetryEnabled()).toBe(false);
  });

  it("sends nothing once the user opts out", async () => {
    const t = await loadTelemetry("phc_test");
    t.initTelemetry(db);

    t.track("commons_search_executed", { result_count: 1 });
    expect(capture).toHaveBeenCalledTimes(1);

    t.setTelemetryEnabled(db, false);
    t.track("commons_search_executed", { result_count: 2 });

    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("persists the opt-out so it survives the process", async () => {
    const t = await loadTelemetry("phc_test");
    t.initTelemetry(db);
    t.setTelemetryEnabled(db, false);

    expect(getSetting(db, "telemetry_enabled")).toBe("false");

    // A fresh process against the same database.
    const t2 = await loadTelemetry("phc_test");
    t2.initTelemetry(db);
    expect(t2.isTelemetryEnabled()).toBe(false);
  });

  it("resumes sending when the user opts back in", async () => {
    upsertSetting(db, "telemetry_enabled", "false");
    const t = await loadTelemetry("phc_test");
    t.initTelemetry(db);

    t.track("commons_app_opened");
    expect(capture).not.toHaveBeenCalled();

    t.setTelemetryEnabled(db, true);
    t.track("commons_app_opened");

    expect(capture).toHaveBeenCalledTimes(1);
  });
});

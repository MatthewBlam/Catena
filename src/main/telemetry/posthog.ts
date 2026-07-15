import { randomUUID } from "node:crypto";
import { PostHog } from "posthog-node";
import type Database from "better-sqlite3";
import { getSetting, upsertSetting } from "../db/database";

const API_KEY = process.env.POSTHOG_API_KEY;

let client: PostHog | null = null;
let distinctId: string | null = null;
let enabled = true;

export function initTelemetry(db: Database.Database): void {
  // Read the user's choice *before* the API-key guard. `enabled` is what the
  // Settings toggle renders, so leaving it at its `true` default whenever
  // POSTHOG_API_KEY is unset would show "on" to someone who turned it off, and
  // keep showing it across every restart. A toggle that misreports its own state
  // is worse than no toggle — and an accurate opt-out is the whole of C3.
  enabled = getSetting(db, "telemetry_enabled") !== "false";

  if (!API_KEY) return;

  let deviceId = getSetting(db, "device_id");
  if (!deviceId) {
    deviceId = randomUUID();
    upsertSetting(db, "device_id", deviceId);
  }
  distinctId = deviceId;

  if (!client) {
    client = new PostHog(API_KEY, {
      host: "https://us.i.posthog.com",
      flushAt: 10,
      flushInterval: 30_000,
    });
  }
}

export function track(
  event: string,
  properties?: Record<string, unknown>,
): void {
  if (!client || !distinctId || !enabled) return;
  client.capture({ distinctId, event, properties });
}

export function setTelemetryEnabled(
  db: Database.Database,
  value: boolean,
): void {
  enabled = value;
  upsertSetting(db, "telemetry_enabled", String(value));
}

export function isTelemetryEnabled(): boolean {
  return enabled;
}

export function shutdownTelemetry(): Promise<void> {
  // Return the flush promise so a caller on `will-quit` can await the buffered
  // events actually leaving before the process dies. Bounded internally (2s) so
  // a dead network cannot hang shutdown; the caller caps the total wait too.
  const pending = client?.shutdown(2000);
  client = null;
  return Promise.resolve(pending);
}

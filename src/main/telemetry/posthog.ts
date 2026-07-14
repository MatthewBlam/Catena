import { randomUUID } from "node:crypto";
import { PostHog } from "posthog-node";
import type Database from "better-sqlite3";
import { getSetting, upsertSetting } from "../db/database";

const API_KEY = process.env.POSTHOG_API_KEY;

let client: PostHog | null = null;
let distinctId: string | null = null;
let enabled = true;

export function initTelemetry(db: Database.Database): void {
  if (!API_KEY) return;

  let deviceId = getSetting(db, "device_id");
  if (!deviceId) {
    deviceId = randomUUID();
    upsertSetting(db, "device_id", deviceId);
  }
  distinctId = deviceId;

  enabled = getSetting(db, "telemetry_enabled") !== "false";

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

export function shutdownTelemetry(): void {
  client?.shutdown();
  client = null;
}

import { describe, it, expect, beforeEach, vi } from "vitest";

let settings: Record<string, string>;

vi.mock("../../db/database", () => ({
  getSetting: vi.fn((_db: unknown, key: string) => settings[key] ?? null),
  upsertSetting: vi.fn((_db: unknown, key: string, value: string) => {
    settings[key] = value;
  }),
  deleteSetting: vi.fn((_db: unknown, key: string) => {
    delete settings[key];
  }),
}));

import {
  readPulledModels,
  recordPulledModel,
  clearPulledModels,
  ensurePulledModelsRecord,
} from "../pulled-models";

const db = {} as never;

beforeEach(() => {
  settings = {};
  vi.clearAllMocks();
});

describe("pulled-model provenance", () => {
  it("reports null before anything has been recorded", () => {
    // Distinct from `[]`: "we have no idea what Catena pulled" is not the same
    // claim as "Catena pulled nothing", and uninstall treats them differently.
    expect(readPulledModels(db)).toBeNull();
  });

  it("records models and reads them back in order", () => {
    recordPulledModel(db, "nomic-embed-text");
    recordPulledModel(db, "llama3.2");

    expect(readPulledModels(db)).toEqual(["nomic-embed-text", "llama3.2"]);
  });

  it("does not record the same model twice", () => {
    recordPulledModel(db, "llama3.2");
    recordPulledModel(db, "llama3.2");

    expect(readPulledModels(db)).toEqual(["llama3.2"]);
  });

  it("distinguishes an empty record from no record", () => {
    recordPulledModel(db, "llama3.2");
    clearPulledModels(db);

    // Cleared means "gone", back to unknown — uninstall must not then think it
    // has an authoritative empty list.
    expect(readPulledModels(db)).toBeNull();
  });

  it("treats a corrupt value as no record rather than throwing", () => {
    settings.ollama_pulled_models = "{not json";
    expect(readPulledModels(db)).toBeNull();
  });

  it("ignores non-string entries in a hand-edited list", () => {
    settings.ollama_pulled_models = JSON.stringify(["llama3.2", 7, null]);
    expect(readPulledModels(db)).toEqual(["llama3.2"]);
  });

  it("treats a non-array JSON value as no record", () => {
    settings.ollama_pulled_models = JSON.stringify({ llama: true });
    expect(readPulledModels(db)).toBeNull();
  });
});

describe("ensurePulledModelsRecord", () => {
  it("turns 'no record' into an authoritative empty list", () => {
    ensurePulledModelsRecord(db);

    // The whole point: absence must mean "predates tracking", never "tracked and
    // pulled nothing" — the two demand opposite uninstall behaviour.
    expect(readPulledModels(db)).toEqual([]);
  });

  it("never disturbs a record that already exists", () => {
    recordPulledModel(db, "llama3.2");

    ensurePulledModelsRecord(db);

    expect(readPulledModels(db)).toEqual(["llama3.2"]);
  });
});

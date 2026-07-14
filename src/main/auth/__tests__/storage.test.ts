import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../../db/__tests__/test-db";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(`enc:${text}`),
    decryptString: (buf: Buffer) => buf.toString().replace("enc:", ""),
  },
}));

import { saveSecret, loadSecret, deleteSecret } from "../storage";

describe("SecureStorage", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => db.close());

  it("round-trips a secret", () => {
    saveSecret(db, "test_key", "my-secret");
    const result = loadSecret(db, "test_key");
    expect(result).toBe("my-secret");
  });

  it("returns null for missing key", () => {
    const result = loadSecret(db, "nonexistent");
    expect(result).toBeNull();
  });

  it("deletes a secret", () => {
    saveSecret(db, "test_key", "my-secret");
    deleteSecret(db, "test_key");
    const result = loadSecret(db, "test_key");
    expect(result).toBeNull();
  });

  it("overwrites existing secret", () => {
    saveSecret(db, "test_key", "v1");
    saveSecret(db, "test_key", "v2");
    const result = loadSecret(db, "test_key");
    expect(result).toBe("v2");
  });
});

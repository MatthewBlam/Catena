import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";

// Shared handles the mock factories (hoisted above the imports) reach into.
const h = vi.hoisted(() => ({
  requestHandler: null as
    | null
    | ((req: unknown, res: unknown) => unknown | Promise<unknown>),
  listen: vi.fn((_port: unknown, _host: unknown, cb?: () => void) => cb?.()),
  close: vi.fn(),
  on: vi.fn(),
  openExternal: vi.fn(),
  getToken: vi.fn(),
  saveSecret: vi.fn(),
}));

vi.mock("node:http", () => ({
  default: {
    createServer: (handler: (req: unknown, res: unknown) => unknown) => {
      h.requestHandler = handler;
      return { listen: h.listen, close: h.close, on: h.on };
    },
  },
}));

vi.mock("electron", () => ({
  shell: { openExternal: h.openExternal },
}));

vi.mock("@googleapis/drive", () => ({
  auth: {
    OAuth2: class {
      generateAuthUrl(opts: { state: string }): string {
        return `https://accounts.google.com/o/oauth2/auth?state=${opts.state}`;
      }
      getToken(...args: unknown[]): unknown {
        return h.getToken(...args);
      }
      setCredentials(): void {
        // no-op: the token client is not exercised after credentials are set
      }
    },
  },
}));

vi.mock("../storage", () => ({
  saveSecret: h.saveSecret,
  loadSecret: vi.fn(),
  deleteSecret: vi.fn(),
}));

import { startGoogleOAuth, cancelGoogleOAuth } from "../google-oauth";

const fakeDb = {} as unknown as Database.Database;

/** Reads the state param out of the authorize URL handed to shell.openExternal. */
function stateFromLastAuthUrl(): string {
  const authUrl = h.openExternal.mock.calls.at(-1)?.[0] as string;
  return new URL(authUrl).searchParams.get("state")!;
}

describe("startGoogleOAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.requestHandler = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists the tokens even when the userinfo lookup fails", async () => {
    const tokens = { access_token: "at", refresh_token: "rt" };
    h.getToken.mockResolvedValue({ tokens });
    // userinfo returns a 500 — the grant must survive it.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error("not JSON")),
      }),
    );

    const promise = startGoogleOAuth("client-id", "client-secret", fakeDb);

    const state = stateFromLastAuthUrl();
    const res = { writeHead: vi.fn(), end: vi.fn() };
    await h.requestHandler!({ url: `/callback?code=abc&state=${state}` }, res);

    const result = await promise;
    expect(result).toEqual({ email: "Unknown" });
    // Persisted *before* / independent of the userinfo failure.
    expect(h.saveSecret).toHaveBeenCalledWith(
      fakeDb,
      "google_tokens",
      JSON.stringify(tokens),
    );
  });

  it("uses the fetched email when userinfo succeeds", async () => {
    const tokens = { access_token: "at", refresh_token: "rt" };
    h.getToken.mockResolvedValue({ tokens });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ email: "user@example.com" }),
      }),
    );

    const promise = startGoogleOAuth("client-id", "client-secret", fakeDb);
    const state = stateFromLastAuthUrl();
    await h.requestHandler!(
      { url: `/callback?code=abc&state=${state}` },
      { writeHead: vi.fn(), end: vi.fn() },
    );

    expect(await promise).toEqual({ email: "user@example.com" });
    expect(h.saveSecret).toHaveBeenCalled();
  });

  it("rejects the first pending flow when a second flow starts", async () => {
    const first = startGoogleOAuth("client-id", "client-secret", fakeDb);
    const firstRejects = expect(first).rejects.toThrow(/superseded/i);

    const second = startGoogleOAuth("client-id", "client-secret", fakeDb);
    // We only care that the first settled; keep the second from becoming an
    // unhandled rejection, then cancel it to prove cancel still works.
    second.catch(() => {});

    await firstRejects;

    cancelGoogleOAuth();
    await expect(second).rejects.toThrow(/canceled/i);
  });
});

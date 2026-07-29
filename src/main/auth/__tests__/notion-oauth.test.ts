import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared handles the mock factories (hoisted above the imports) reach into.
const h = vi.hoisted(() => ({
  requestHandler: null as
    | null
    | ((req: unknown, res: unknown) => unknown | Promise<unknown>),
  listen: vi.fn((_port: unknown, _host: unknown, cb?: () => void) => cb?.()),
  close: vi.fn(),
  on: vi.fn(),
  openExternal: vi.fn(),
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

import { startNotionOAuth, cancelNotionOAuth } from "../notion-oauth";

describe("startNotionOAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.requestHandler = null;
  });

  it("rejects the first pending flow when a second flow starts", async () => {
    const first = startNotionOAuth("client-id", "https://proxy.example/token");
    const firstRejects = expect(first).rejects.toThrow(/superseded/i);

    const second = startNotionOAuth("client-id", "https://proxy.example/token");
    // Keep the second from becoming an unhandled rejection, then cancel it to
    // prove cancel still settles with its own reason.
    second.catch(() => {});

    await firstRejects;

    cancelNotionOAuth();
    await expect(second).rejects.toThrow(/canceled/i);
  });
});

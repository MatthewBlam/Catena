import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker, { type Env } from "../index";

const ENV: Env = {
  NOTION_CLIENT_ID: "client-id",
  NOTION_CLIENT_SECRET: "client-secret",
};

const URL_BASE = "https://commons-notion-auth.example.workers.dev";

function post(body: unknown, path = "/notion/token"): Request {
  return new Request(`${URL_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** The last request the Worker made to Notion, parsed. */
async function lastNotionCall(fetchMock: ReturnType<typeof vi.fn>): Promise<{
  url: string;
  authorization: string;
  body: Record<string, unknown>;
}> {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  const headers = init.headers as Record<string, string>;
  return {
    url,
    authorization: headers.Authorization,
    body: JSON.parse(init.body as string),
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ access_token: "secret_token" }), {
        status: 200,
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /notion/token", () => {
  it("attaches the client secret server-side and returns Notion's body", async () => {
    const res = await worker.fetch(
      post({ code: "auth-code", code_verifier: "verifier" }),
      ENV,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ access_token: "secret_token" });

    const call = await lastNotionCall(fetchMock);
    expect(call.url).toBe("https://api.notion.com/v1/oauth/token");
    // The whole point: the app never holds this, the Worker does.
    expect(call.authorization).toBe(`Basic ${btoa("client-id:client-secret")}`);
    expect(call.body).toEqual({
      grant_type: "authorization_code",
      code: "auth-code",
      redirect_uri: "http://localhost:21337/callback",
      code_verifier: "verifier",
    });
  });

  it("pins redirect_uri and ignores a caller-supplied one", async () => {
    // Without the pin this endpoint is a token-exchange oracle: hand it a code
    // and it staples our secret to whatever destination the caller names.
    await worker.fetch(
      post({
        code: "auth-code",
        code_verifier: "verifier",
        redirect_uri: "https://attacker.example/steal",
      }),
      ENV,
    );

    const call = await lastNotionCall(fetchMock);
    expect(call.body.redirect_uri).toBe("http://localhost:21337/callback");
  });

  it("passes a Notion failure through with its status and body intact", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    );

    const res = await worker.fetch(
      post({ code: "stale-code", code_verifier: "verifier" }),
      ENV,
    );

    // Swallowing this would leave the user with "connection failed" and no reason.
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalid_grant" });
  });

  it("rejects a missing code without calling Notion", async () => {
    const res = await worker.fetch(post({ code_verifier: "verifier" }), ENV);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "missing_code" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a missing code_verifier without calling Notion", async () => {
    const res = await worker.fetch(post({ code: "auth-code" }), ENV);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "missing_code_verifier",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-string code (a JSON object is not a credential)", async () => {
    const res = await worker.fetch(
      post({ code: { evil: true }, code_verifier: "verifier" }),
      ENV,
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const res = await worker.fetch(post("{not json"), ENV);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalid_json" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails loudly when its own secrets are unset", async () => {
    // Forwarding an unauthenticated request would surface as a baffling 401.
    const res = await worker.fetch(
      post({ code: "auth-code", code_verifier: "verifier" }),
      { NOTION_CLIENT_ID: "", NOTION_CLIENT_SECRET: "" },
    );
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: "server_not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("routing", () => {
  it("404s any other path", async () => {
    const res = await worker.fetch(post({}, "/anything-else"), ENV);
    expect(res.status).toBe(404);
  });

  it("405s a GET — this endpoint is not browsable", async () => {
    const res = await worker.fetch(
      new Request(`${URL_BASE}/notion/token`, { method: "GET" }),
      ENV,
    );
    expect(res.status).toBe(405);
  });
});

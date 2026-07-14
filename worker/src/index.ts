/**
 * Notion token exchange proxy.
 *
 * Notion has no public-client mode. Its token endpoint demands HTTP Basic auth
 * built from the integration's client secret, and there is no PKCE-only variant
 * that omits it — so PKCE alone cannot save a desktop app here, the way it can
 * for a Google Desktop client. A secret shipped in an Electron bundle is not a
 * secret; `strings` on the asar recovers it. The exchange therefore has to happen
 * somewhere the secret can actually stay one. That is all this Worker is.
 *
 * It is deliberately *not* a general-purpose proxy:
 *
 *  - The redirect URI is pinned here rather than taken from the caller. Accepting
 *    it as input would turn this endpoint into a token-exchange oracle — hand it a
 *    code and it attaches our secret to whatever destination you name.
 *  - No CORS headers, on purpose. Electron's main process is not a browser and is
 *    not subject to CORS, so it needs none; adding `Access-Control-Allow-Origin`
 *    would do nothing for us and would open the endpoint to any web page.
 */

const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";

/**
 * Must match REDIRECT_URI in src/main/auth/notion-oauth.ts *and* the redirect URI
 * registered in the Notion console. Notion validates it against the one the
 * authorize request used; a mismatch here fails every exchange.
 */
const REDIRECT_URI = "http://localhost:21337/callback";

export interface Env {
  NOTION_CLIENT_ID: string;
  NOTION_CLIENT_SECRET: string;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== "/notion/token") {
      return json({ error: "not_found" }, 404);
    }
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }
    if (!env.NOTION_CLIENT_ID || !env.NOTION_CLIENT_SECRET) {
      // Fail loudly rather than forwarding an unauthenticated request and letting
      // Notion return a confusing 401.
      return json({ error: "server_not_configured" }, 500);
    }

    let body: { code?: unknown; code_verifier?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    const code = body.code;
    const codeVerifier = body.code_verifier;
    if (typeof code !== "string" || code === "") {
      return json({ error: "missing_code" }, 400);
    }
    if (typeof codeVerifier !== "string" || codeVerifier === "") {
      return json({ error: "missing_code_verifier" }, 400);
    }

    const basic = btoa(`${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`);

    const notionRes = await fetch(NOTION_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: codeVerifier,
      }),
    });

    // Pass status and body through untouched. The client parses Notion's exact
    // response shape, and on failure it surfaces Notion's own error text — which
    // is the only thing that tells a user *why* the connection failed.
    return new Response(notionRes.body, {
      status: notionRes.status,
      headers: { "Content-Type": "application/json" },
    });
  },
};

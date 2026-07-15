import http from "node:http";
import crypto from "node:crypto";
import { shell } from "electron";

const REDIRECT_PORT = 21337;
/**
 * Also pinned in `worker/src/index.ts` and registered in the Notion console.
 * All three must agree — Notion validates the value the token exchange sends
 * against the one the authorize request used.
 */
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
const NOTION_AUTH_URL = "https://api.notion.com/v1/oauth/authorize";

export interface NotionOAuthResult {
  accessToken: string;
  workspaceName: string;
}

let activeServer: http.Server | null = null;
let activeReject: ((err: Error) => void) | null = null;
let activeFlowId: string | null = null;
let activeTimeout: ReturnType<typeof setTimeout> | null = null;

function cleanupActiveOAuth(): void {
  if (activeServer) {
    activeServer.close();
    activeServer = null;
  }
  // A completed flow left this 5-minute timer armed, holding a handle (and
  // keeping the event loop alive) for five minutes after every success.
  if (activeTimeout) {
    clearTimeout(activeTimeout);
    activeTimeout = null;
  }
  activeReject = null;
  activeFlowId = null;
}

export function cancelNotionOAuth(): void {
  const reject = activeReject;
  cleanupActiveOAuth();
  reject?.(new Error("OAuth canceled"));
}

/**
 * @param clientId Not confidential — it is in the authorize URL the user's browser
 *   loads, and shipping it is expected.
 * @param tokenProxyUrl The Cloudflare Worker in `worker/`. Notion's token endpoint
 *   requires Basic auth from the client *secret* and has no public-client mode, so
 *   the exchange cannot happen here: a secret in an Electron bundle is not a secret.
 *   See `worker/README.md`.
 */
export async function startNotionOAuth(
  clientId: string,
  tokenProxyUrl: string,
): Promise<NotionOAuthResult> {
  cleanupActiveOAuth();

  const state = crypto.randomBytes(16).toString("hex");
  const flowId = crypto.randomUUID();
  activeFlowId = flowId;

  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  const authUrl = `${NOTION_AUTH_URL}?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&owner=user&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256`;

  return new Promise((resolve, reject) => {
    let settled = false;

    function safeResolve(value: NotionOAuthResult): void {
      if (settled) return;
      settled = true;
      cleanupActiveOAuth();
      resolve(value);
    }

    function safeReject(err: unknown): void {
      if (settled) return;
      settled = true;
      cleanupActiveOAuth();
      reject(err);
    }

    activeReject = (err) => safeReject(err);

    const server = http.createServer(async (req, res) => {
      if (settled) {
        res.writeHead(200);
        res.end();
        return;
      }

      try {
        const url = new URL(req.url!, `http://localhost:${REDIRECT_PORT}`);

        if (url.pathname !== "/callback") {
          res.writeHead(404);
          res.end();
          return;
        }

        const returnedState = url.searchParams.get("state");
        if (returnedState !== state) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            "<h1>Authorization failed.</h1><p>Invalid state parameter. You can close this tab.</p>",
          );
          safeReject(new Error("OAuth state mismatch — possible CSRF attack"));
          return;
        }

        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error || !code) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            "<h1>Authorization failed.</h1><p>You can close this tab.</p>",
          );
          safeReject(new Error(error ?? "No authorization code received"));
          return;
        }

        // No Authorization header and no redirect_uri: the Worker supplies the
        // first from its own secret and pins the second. Everything we send here
        // is either public (the code, single-use and already bound to our
        // client_id) or ours to prove (the PKCE verifier).
        const tokenRes = await fetch(tokenProxyUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code,
            code_verifier: codeVerifier,
          }),
        });

        if (!tokenRes.ok) {
          const body = await tokenRes.text();
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            "<h1>Token exchange failed.</h1><p>You can close this tab.</p>",
          );
          safeReject(
            new Error(`Token exchange failed: ${tokenRes.status} ${body}`),
          );
          return;
        }

        const data = (await tokenRes.json()) as {
          access_token?: string;
          workspace_name?: string;
        };

        if (!data.access_token) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            "<h1>Authorization failed.</h1><p>No access token received. You can close this tab.</p>",
          );
          safeReject(new Error("Notion OAuth response missing access_token"));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<h1>Connected to Notion!</h1><p>You can close this tab and return to Commons.</p>",
        );

        safeResolve({
          accessToken: data.access_token,
          workspaceName: data.workspace_name ?? "",
        });
      } catch (err) {
        res.writeHead(500);
        res.end();
        safeReject(err);
      }
    });

    activeServer = server;

    server.on("error", (err) => {
      safeReject(
        new Error(
          `Failed to start OAuth server on port ${REDIRECT_PORT}: ${err.message}`,
        ),
      );
    });

    server.listen(REDIRECT_PORT, "127.0.0.1", () => {
      shell.openExternal(authUrl);
    });

    activeTimeout = setTimeout(() => {
      if (activeFlowId === flowId) {
        safeReject(new Error("OAuth timed out after 5 minutes"));
      }
    }, 300_000);
  });
}

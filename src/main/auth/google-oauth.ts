import http from "node:http";
import crypto from "node:crypto";
import { shell } from "electron";
import { auth as googleAuth } from "@googleapis/drive";
import type Database from "better-sqlite3";
import { saveSecret, loadSecret, deleteSecret } from "./storage";

const REDIRECT_PORT = 21338;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

export type GoogleOAuth2Client = InstanceType<typeof googleAuth.OAuth2>;

export interface GoogleOAuthResult {
  email: string;
}

let activeServer: http.Server | null = null;
let activeReject: ((err: Error) => void) | null = null;
let activeFlowId: string | null = null;

function cleanupActiveOAuth(): void {
  if (activeServer) {
    activeServer.close();
    activeServer = null;
  }
  activeReject = null;
  activeFlowId = null;
}

export function cancelGoogleOAuth(): void {
  const reject = activeReject;
  cleanupActiveOAuth();
  reject?.(new Error("OAuth canceled"));
}

export async function startGoogleOAuth(
  clientId: string,
  clientSecret: string,
  db: Database.Database,
): Promise<GoogleOAuthResult> {
  cleanupActiveOAuth();

  const state = crypto.randomBytes(16).toString("hex");
  const flowId = crypto.randomUUID();
  activeFlowId = flowId;

  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  const client = new googleAuth.OAuth2(clientId, clientSecret, REDIRECT_URI);
  const baseAuthUrl = client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
    state,
  });
  const authUrl = `${baseAuthUrl}&code_challenge=${codeChallenge}&code_challenge_method=S256`;

  return new Promise((resolve, reject) => {
    let settled = false;

    function safeResolve(value: GoogleOAuthResult): void {
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

        const { tokens } = await client.getToken({ code, codeVerifier });
        client.setCredentials(tokens);

        const infoRes = await fetch(
          "https://www.googleapis.com/oauth2/v2/userinfo",
          {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
          },
        );
        const userInfo = (await infoRes.json()) as { email?: string };
        const email = userInfo.email ?? "Unknown";

        saveSecret(db, "google_tokens", JSON.stringify(tokens));

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<h1>Connected to Google Drive!</h1><p>You can close this tab and return to Commons.</p>",
        );

        safeResolve({ email });
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

    setTimeout(() => {
      if (activeFlowId === flowId) {
        safeReject(new Error("OAuth timed out after 5 minutes"));
      }
    }, 300_000);
  });
}

export function getAuthenticatedClient(
  db: Database.Database,
  clientId: string,
  clientSecret: string,
): GoogleOAuth2Client {
  const tokensJson = loadSecret(db, "google_tokens");
  if (!tokensJson) throw new Error("Not authenticated with Google Drive");

  const tokens = JSON.parse(tokensJson) as {
    access_token?: string;
    refresh_token?: string;
    expiry_date?: number;
  };

  const client = new googleAuth.OAuth2(clientId, clientSecret, REDIRECT_URI);
  client.setCredentials(tokens);

  return client;
}

export async function refreshIfNeeded(
  client: GoogleOAuth2Client,
  db: Database.Database,
): Promise<void> {
  const creds = client.credentials;
  if (creds.expiry_date && Date.now() > creds.expiry_date - 300_000) {
    try {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
      saveSecret(db, "google_tokens", JSON.stringify(credentials));
    } catch (err) {
      const status =
        err instanceof Object && "status" in err
          ? (err as { status: number }).status
          : 0;
      if (status === 400 || status === 401) {
        deleteSecret(db, "google_tokens");
        throw new Error(
          "Google session expired — please re-authenticate in Settings.",
        );
      }
      throw err;
    }
  }
}

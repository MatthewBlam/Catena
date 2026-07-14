# commons-notion-auth

A single-endpoint Cloudflare Worker that performs the Notion OAuth token
exchange on Commons' behalf.

## Why this exists

Notion's token endpoint requires HTTP Basic auth built from the integration's
client secret, and offers no public-client / PKCE-only mode that omits it. A
desktop app cannot hold a secret — anything in the bundle is recoverable with
`strings` — so the exchange happens here instead. Commons keeps the PKCE flow and
the `client_id` (neither is confidential); only the secret moves.

Google needs no equivalent: a Google **Desktop app** client's secret is
explicitly designated non-confidential, so PKCE alone is the sanctioned pattern
there and the app talks to Google directly.

## Deploy

```sh
cd worker
pnpm dlx wrangler login
pnpm dlx wrangler secret put NOTION_CLIENT_ID
pnpm dlx wrangler secret put NOTION_CLIENT_SECRET
pnpm dlx wrangler deploy
```

Then put the deployed URL's **origin** in the app's `.env`:

```
NOTION_TOKEN_PROXY_URL=https://commons-notion-auth.<your-subdomain>.workers.dev/notion/token
```

The app reads it at build time via the `define` block in
`electron.vite.config.ts`, so a change requires a rebuild.

## API

`POST /notion/token`

```json
{ "code": "…", "code_verifier": "…" }
```

Notion's response is returned verbatim, status and body untouched. The
`redirect_uri` is **not** a parameter — it is pinned in `src/index.ts` and must
stay in sync with `REDIRECT_URI` in `src/main/auth/notion-oauth.ts` and the
redirect URI registered in the Notion console.

## Rotating the secret

The secret was in every Commons build produced before this Worker existed, so it
must be treated as public. Rotate it in the Notion console, then
`wrangler secret put NOTION_CLIENT_SECRET` again. No app rebuild is needed — the
app never sees it.

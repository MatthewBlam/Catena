# Commons

Search your club's docs — a local-first RAG desktop app for student
organizations. Connect Notion pages and Google Drive files, and Commons indexes
them on your machine so you can search across everything in one place, by meaning
or by keyword.

Built with Electron, React, and `better-sqlite3`. Your documents, embeddings,
and search index never leave your computer; the only things that touch the
network are the embedding provider you choose and the OAuth flows for the sources
you connect.

## How it works

- **Sources** — Notion (via OAuth) and Google Drive (via OAuth). Each connected
  page/folder is a _source_; syncing a source fetches its documents, chunks
  them, embeds the chunks, and writes everything to a local SQLite database.
- **Embeddings** — pick one provider at onboarding:
  - **Cohere** (cloud, higher quality, free tier) — needs an API key.
  - **Ollama** (fully local, no key) — needs Ollama running with an embedding
    model pulled (e.g. `nomic-embed-text`, `mxbai-embed-large`).
- **Search** — hybrid: vector similarity over the embeddings plus SQLite FTS5
  keyword search, with optional Cohere reranking. Everything runs in the Electron
  main process; the renderer never makes network calls (all data crosses the
  context bridge over IPC).

## Prerequisites

- **Node.js** 20+ and **pnpm** (`packageManager` pins the exact pnpm version).
- **macOS or Windows** (the two supported/packaged targets).
- For local embeddings: **[Ollama](https://ollama.com)** installed and running.
- For cloud embeddings: a **[Cohere](https://dashboard.cohere.com/api-keys)** API
  key (entered in-app, stored in the OS keychain — never in `.env`).

## Setup

```sh
git clone https://github.com/MatthewBlam/commons-app.git
cd commons-app
pnpm install          # postinstall rebuilds better-sqlite3 for Electron
cp .env.example .env  # then fill in the values below
pnpm dev
```

### Environment variables (`.env`)

These are inlined into the **main-process bundle at build time** (see the
`define` block in `electron.vite.config.ts`), so **everything here is readable by
anyone who has the app**. Nothing genuinely confidential may live in `.env`.

| Key                      | What it is                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `NOTION_CLIENT_ID`       | Your Notion integration's client id (public). Register `http://localhost:21337/callback` as its redirect URI.                   |
| `NOTION_TOKEN_PROXY_URL` | The full endpoint URL of the Cloudflare Worker that performs the Notion token exchange (see below).                             |
| `GOOGLE_CLIENT_ID`       | Google OAuth client id. The client **must** be registered as a **Desktop app** client (see below).                              |
| `GOOGLE_CLIENT_SECRET`   | The Google **Desktop** client secret. Google designates this non-confidential — PKCE secures the flow — so shipping it is safe. |
| `POSTHOG_API_KEY`        | PostHog project key (write-only, safe to ship). Optional; telemetry is off when unset, and users can opt out in Settings.       |

The Cohere API key, Notion token, and Google tokens are **not** here — they are
entered in the app at runtime and stored in the OS keychain via a secrets table,
never inlined and never sent to the renderer (the app checks _existence_ with
`hasSecret`, and there is deliberately no channel that returns a plaintext key).

### The Notion token-exchange Worker

Notion's token endpoint requires HTTP Basic auth built from the integration's
**client secret** and has no PKCE-only public-client mode. A desktop app cannot
hold a secret (anything in the bundle is recoverable with `strings`), so the
exchange happens in a tiny Cloudflare Worker instead — Commons keeps only the
PKCE flow and the public `client_id`.

Deploy it from [`worker/`](worker/README.md):

```sh
cd worker
pnpm dlx wrangler login
pnpm dlx wrangler secret put NOTION_CLIENT_ID
pnpm dlx wrangler secret put NOTION_CLIENT_SECRET
pnpm dlx wrangler deploy
```

Then paste the deployed endpoint URL into `NOTION_TOKEN_PROXY_URL`.

### Google must be a "Desktop app" client

Register the Google OAuth client as a **Desktop app** client in the Google Cloud
console — **not** a Web client. Google explicitly designates a Desktop client's
secret as non-confidential (PKCE is what secures the flow), which is the only
reason it is safe to inline `GOOGLE_CLIENT_SECRET`. Re-register it as a "Web"
client and that line becomes a real credential leak.

## Development

```sh
pnpm dev         # electron-vite dev server with HMR
pnpm typecheck   # tsc across main / web / worker
pnpm lint        # eslint (prettier runs through it)
pnpm format      # prettier --write .
```

## Testing and the `better-sqlite3` rebuild dance

`better-sqlite3` is a native module, and its compiled binary is **ABI-specific**:
it must be built against Node's ABI to run under Vitest (plain Node), but against
Electron's ABI to run in the app. The scripts handle the round-trip for you:

```sh
pnpm test        # rebuilds better-sqlite3 for Node, runs vitest, then
                 # `posttest` rebuilds it back for Electron
```

- `pnpm test` → `pnpm rebuild better-sqlite3 && vitest run`
- `posttest` → rebuilds better-sqlite3 back for Electron (`electron-rebuild`)
- `postinstall` → rebuilds for Electron after every install

If you ever see an `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION` mismatch, the
binary is built for the wrong runtime — run `pnpm test` (which resets it to Node)
or `pnpm exec electron-rebuild -w better-sqlite3` (to reset it to Electron).

The Cloudflare Worker has its own tests; the root `vitest` picks them up from
`worker/**/__tests__` because that Worker holds the one genuinely confidential
credential (the Notion client secret) and must be tested.

## Building and packaging

```sh
pnpm build       # typecheck + lint + test + electron-vite build
pnpm make        # build, then electron-forge make (installers)
pnpm make:mac    # macOS only
pnpm make:win    # Windows only
```

macOS builds are signed ad-hoc with a trimmed hardened-runtime entitlements set
(`build/entitlements.mac.plist`).

## Security notes

- The renderer runs with `contextIsolation`, `sandbox`, and no `nodeIntegration`;
  its CSP sets `connect-src 'none'` because it makes no network calls at all.
- Secrets (Cohere key, Notion/Google tokens) live in a local secrets table and
  are never exposed to the renderer in plaintext.
- **Dev-only dependency advisories:** `pnpm audit` reports issues in `tar`, `tmp`,
  and `esbuild`. These are **transitive dev dependencies** of `electron-forge`,
  `@electron/rebuild`, and `vite` — build/packaging tooling only. **`pnpm audit
--prod` is clean**, so nothing vulnerable ships in the app. They cannot be
  patched with a simple version bump: the vulnerable copies are pinned by
  `@electron/node-gyp` and `cacache` to old majors, and pnpm's `blockExoticSubdeps`
  policy trips on `@electron/node-gyp`'s git resolution. The real fix is a bump of
  `electron-forge`/`@electron/rebuild` once a release ships patched transitives —
  verify any such bump with a full `pnpm make`.

## License

MIT — see [LICENSE](LICENSE).

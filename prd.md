# Catena — PRD & Implementation Plan

## Context

Student organizations scatter their knowledge across Notion workspaces and Google Drive folders — onboarding guides, project specs, meeting notes, policies. When a new member asks "how do I get reimbursed?" or "what does a tech lead do?", the answer exists somewhere but nobody knows where. Catena solves this by letting organizations connect their docs, index them locally, and search across everything in one place.

Catena is a local-first Electron desktop app. No hosted backend. Users bring their own Cohere API key for search quality (embeddings + reranking) or fall back to free local embeddings via Ollama. The MVP focuses on **finding the right documents** — search-results-only, no LLM answer generation yet.

---

## Product Requirements

### One-Line Pitch

> Catena is a local-first desktop app that lets student organizations connect their Notion and Google Drive docs, then search across all their scattered knowledge.

### Target Users

Any student organization officer or member who needs to find information across their organization's docs. Not school-specific.

### Core User Flow

```
Install app → Paste Cohere API key (or choose Ollama) → Connect Notion and/or Google Drive
→ Select docs to index → Sync → Ask questions → See relevant source snippets with links
```

### MVP Feature Set

1. **API Key Setup** — Paste Cohere API key, stored securely via Electron safeStorage. Or choose local-only mode (Ollama embeddings).
2. **Notion Connector** — OAuth (public integration) as primary flow + paste internal integration token as fallback. User selects which pages/databases to share.
3. **Google Drive Connector** — OAuth via loopback redirect. User pastes a Drive folder URL to select which folder to index. `drive.file` scope.
4. **Document Sync** — Manual "Sync now" button. Fetches metadata, checks content hashes, skips unchanged docs. Extracts text from pages, Google Docs, PDF, DOCX, TXT, Markdown.
5. **Chunking & Embedding** — Split docs by headings + size limits. Embed chunks via Cohere Embed v4 (or Ollama embeddings as fallback). Cache embeddings locally.
6. **Search** — Embed user query → brute-force cosine similarity over local chunks → Cohere Rerank v4.0-pro on top ~40 candidates → show top 5-8 results with source snippets and "Open source" links.
7. **Chat-style UI** — Question input, search results with source attribution, example questions for empty state.

### Explicitly Out of MVP Scope

- LLM answer generation (Ollama/Cohere Command) — fast follow
- Real-time or background sync
- sqlite-vec (not production-ready as of June 2026)
- Slack, Gmail, or other integrations
- Multi-user admin, permission mirroring
- Editing Notion or Drive docs from the app
- Linux support
- Auto-updates

### Privacy Promise

> Your organization docs are indexed locally on your computer. We do not host your data. Search queries and selected snippets are sent to Cohere for embedding and reranking (unless you use local-only mode with Ollama).

---

## Technical Architecture

### Stack

| Layer          | Choice                               | Notes                                                                                                           |
| -------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Framework      | Electron v42+ via electron-vite 5.x  | Scaffolded with `npm create electron-vite@latest`                                                               |
| Frontend       | React + Tailwind CSS v4 + Coss UI    | Copy-paste components built on Base UI primitives. Install via `pnpm dlx shadcn@latest add @coss/ui`            |
| Local DB       | better-sqlite3 v12.10+               | Native module, needs @electron/rebuild                                                                          |
| Vector search  | Brute-force cosine similarity in JS  | Over embeddings stored as BLOBs in SQLite                                                                       |
| Embeddings     | Cohere Embed v4 (1536 dims) / Ollama | cohere-ai SDK v8.x (pin exact version)                                                                          |
| Reranking      | Cohere Rerank v4.0-pro               | Skipped in Ollama-only mode                                                                                     |
| Secure storage | Electron safeStorage (async API)     | Replaces deprecated keytar                                                                                      |
| Notion         | @notionhq/client v5.22+              | OAuth + paste-token fallback                                                                                    |
| Google Drive   | googleapis + google-auth-library     | Loopback OAuth, drive.file scope                                                                                |
| PDF parsing    | pdf-parse v2.4+                      |                                                                                                                 |
| DOCX parsing   | mammoth v1.12+                       |                                                                                                                 |
| Packaging      | electron-forge                       | Official Electron packager. auto-unpack-natives plugin handles better-sqlite3. DMG (macOS) + Squirrel (Windows) |
| Distribution   | GitHub Releases                      | Manual download                                                                                                 |

### Project Structure

```
catena-app/
├── electron.vite.config.ts
├── package.json
├── src/
│   ├── main/                    # Electron main process
│   │   ├── index.ts             # App entry, window management
│   │   ├── ipc/                 # IPC handlers (sync, search, auth)
│   │   ├── db/                  # SQLite schema, queries
│   │   ├── connectors/
│   │   │   ├── notion.ts        # Notion API fetching + text extraction
│   │   │   └── drive.ts         # Google Drive API fetching + file parsing
│   │   ├── search/
│   │   │   ├── chunker.ts       # Text chunking logic
│   │   │   ├── embedder.ts      # Cohere/Ollama embedding
│   │   │   ├── reranker.ts      # Cohere Rerank
│   │   │   └── searcher.ts      # Query embedding + cosine sim + rerank
│   │   ├── auth/
│   │   │   ├── notion-oauth.ts  # Notion OAuth flow
│   │   │   ├── google-oauth.ts  # Google OAuth loopback flow
│   │   │   └── storage.ts       # safeStorage wrapper for keys/tokens
│   │   └── sync/
│   │       └── sync-manager.ts  # Orchestrates fetch → extract → chunk → embed
│   ├── preload/
│   │   └── index.ts             # Context bridge exposing IPC to renderer
│   └── renderer/                # React app
│       ├── App.tsx
│       ├── components/
│       │   ├── ui/              # Coss UI components (copy-paste, Base UI primitives)
│       │   ├── setup/           # Onboarding wizard screens
│       │   ├── sources/         # Source management (connect, list)
│       │   ├── sync/            # Sync status + trigger
│       │   └── search/          # Search input + results
│       ├── hooks/
│       ├── lib/
│       └── pages/
├── resources/                   # App icons, static assets
└── build/                       # electron-forge config
```

### Database Schema

```sql
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,       -- 'notion' | 'google_drive'
  name TEXT NOT NULL,
  root_external_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  mime_type TEXT,
  modified_at TEXT,
  content_hash TEXT,
  last_synced_at TEXT
);

CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  chunk_index INTEGER NOT NULL,
  heading TEXT,
  text TEXT NOT NULL,
  embedding BLOB,              -- Float32Array as Buffer (1536 dims for Cohere, varies for Ollama)
  token_count INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

### Key Technical Decisions

**Cosine similarity in JS (not sqlite-vec):** sqlite-vec is pre-v1 with ABI compatibility issues. For a typical organization doc set (~1,000-5,000 chunks), brute-force cosine similarity over Float32Arrays in the main process is fast enough (<50ms). Revisit when/if chunk counts grow past 50k.

**Electron safeStorage (not keytar):** keytar is deprecated since 2022. safeStorage is built into Electron, uses OS-level encryption (Keychain on macOS, DPAPI on Windows), and requires no native dependencies. Use the async API (`encryptStringAsync`/`decryptStringAsync`).

**Cohere SDK pinning:** The cohere-ai npm package is beta (v8.x). Pin to an exact version in package.json to avoid surprise breaking changes.

**Notion API version:** Target 2025-09-03 (SDK default). The 2026 versions changed pagination cursor format and rate limit headers — adopt only when needed.

**Google Drive scope:** `drive.file` (non-sensitive) — no app verification required. Users paste a folder URL; the app extracts the folder ID and lists files via the API.

---

## Implementation Milestones

### Milestone 1: App Shell + Local Storage (Week 1)

**Goal:** Electron app boots, SQLite works, settings can be saved securely.

- [ ] Scaffold project with `npm create electron-vite@latest` (React + TypeScript)
- [ ] Install and configure Tailwind CSS v4 + Coss UI (`pnpm dlx shadcn@latest add @coss/style` for full theme, or `@coss/ui` for components only). Set up CSS variables for theming (neutral color system, dark mode via `.dark` class). Configure fonts (Inter for `--font-sans`/`--font-heading`, monospace for `--font-mono`) via CSS imports (not next/font since this is Electron, not Next.js)
- [ ] Set up better-sqlite3 with @electron/rebuild in postinstall
- [ ] Create SQLite schema (sources, documents, chunks, settings tables)
- [ ] Build safeStorage wrapper (encrypt/decrypt API keys and OAuth tokens)
- [ ] Build welcome screen + Cohere API key setup screen
- [ ] Validate Cohere key by calling the embed endpoint with a test string
- [ ] Configure electron-forge with auto-unpack-natives plugin for macOS (DMG) + Windows (Squirrel)

**Verify:** App launches on macOS and Windows. Can paste and securely store a Cohere key. SQLite DB is created in app data directory.

### Milestone 2: Retrieval Pipeline (Week 2)

**Goal:** Given manually inserted sample documents, the full search pipeline works.

- [ ] Build text chunker (split by headings, max ~500 tokens per chunk)
- [ ] Build Cohere Embed v4 integration (embed chunks + queries, 1536 dimensions)
- [ ] Build Ollama embed fallback (detect Ollama at localhost:11434, use `nomic-embed-text` or similar)
- [ ] Store embeddings as BLOBs in SQLite chunks table
- [ ] Build cosine similarity search over stored embeddings
- [ ] Build Cohere Rerank v4.0-pro integration (rerank top ~40 candidates, return top 5-8)
- [ ] Build search results UI (question input, ranked results with snippets + source links)
- [ ] Add example questions empty state
- [ ] Seed DB with 5-10 sample organization docs for testing

**Verify:** Can ask a question and get relevant ranked results from sample docs. Rerank meaningfully improves result order vs. raw cosine similarity.

### Milestone 3: Notion Connector (Week 3)

**Goal:** Connect a real Notion workspace and index selected pages.

- [ ] Build paste-token flow (user pastes internal integration token)
- [ ] Build Notion OAuth flow (register public integration, loopback redirect in Electron)
- [ ] Fetch selected page and recursively walk child blocks
- [ ] Convert Notion blocks to plain text (paragraphs, headings, bullets, toggles, callouts, tables)
- [ ] Handle Notion databases — fetch database pages and their properties/content
- [ ] Build document metadata extraction (title, URL, modified time)
- [ ] Integrate with sync manager: fetch → extract → chunk → embed → store
- [ ] Handle rate limits (3 req/sec, exponential backoff on 429)
- [ ] Handle pagination (cursor-based, 50 items per page default)
- [ ] Build source management UI (list connected sources, disconnect)

**Verify:** Connect a real Notion workspace with organization docs. Sync completes without errors. Can search across Notion content and open source links in browser.

### Milestone 4: Google Drive Connector (Week 4)

**Goal:** Connect Google Drive and index files from a selected folder.

- [ ] Build Google OAuth loopback flow (system browser, random port, drive.file scope)
- [ ] Build "paste folder URL" UI — extract folder ID from Drive URL
- [ ] Recursively list files in selected folder via Drive API
- [ ] Export Google Docs as plain text
- [ ] Parse PDFs with pdf-parse
- [ ] Parse DOCX with mammoth
- [ ] Read TXT and Markdown directly
- [ ] Build content hash comparison (skip unchanged files)
- [ ] Integrate with sync manager
- [ ] Add Drive source to source management UI

**Verify:** Paste a real Google Drive folder URL. Sync downloads and indexes Google Docs, PDFs, DOCX files. Can search across Drive content alongside Notion content.

### Milestone 5: Polish + Ship (Week 5)

**Goal:** App is ready for other people to use.

- [ ] Sync progress UI (progress bar, file count, error display)
- [ ] Error handling for common failures (invalid API key, expired OAuth, rate limits, network errors)
- [ ] Empty states and loading states for all screens
- [ ] Onboarding wizard flow (key setup → connect sources → sync → search)
- [ ] Settings screen (change API key, answer mode toggle, clear data)
- [ ] App icon and branding ("Catena")
- [ ] Test on a clean macOS machine and a clean Windows machine
- [ ] Build and upload DMG + EXE to GitHub Releases
- [ ] Write minimal README with setup instructions

**Verify:** A friend can download the app, set it up from scratch, connect their organization's Notion and Drive, sync, and search — without your help.

---

## Cohere Cost Estimate

For a typical organization with ~100 docs, ~1,000 chunks:

| Operation                    | Tokens             | Cost    |
| ---------------------------- | ------------------ | ------- |
| Initial embed (1,000 chunks) | ~200K tokens       | ~$0.024 |
| Per query (embed + rerank)   | ~500 + ~20K tokens | ~$0.04  |
| 100 queries/month            |                    | ~$4.00  |

Trial key (1,000 calls/month) works for testing. Production key recommended for real use — pay-as-you-go, pennies per month for a typical organization.

---

## Post-MVP Roadmap

1. **Ollama answer generation** — "Generate answer from these sources" button using local LLM
2. **Background/scheduled sync** — daily auto-sync with notifications
3. **sqlite-vec** — when it reaches v1, switch from brute-force for better perf at scale
4. **More connectors** — Slack, Confluence, Google Sheets
5. **Linux support**
6. **Auto-updates** via electron-updater
7. **Cohere Command** as optional cloud answer generation

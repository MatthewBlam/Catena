# Commons — Progress Summary & Code Walkthrough

This document covers every file in the codebase, what it does, and how each piece of code works. Use it as a reference to understand the full architecture.

---

## Architecture Overview

Commons is an Electron desktop app. Electron apps have three process types that each run in their own context:

1. **Main process** (`src/main/`) — Runs in Node.js. Has full OS access: filesystem, native modules (SQLite), network requests, encryption. This is the "backend."
2. **Preload** (`src/preload/`) — A bridge script. Runs before the renderer loads, with access to Electron's sandboxed module set (`contextBridge`, `ipcRenderer`). Its job is to safely expose specific main-process functions to the renderer via `contextBridge`. Only our typed `api` object is exposed — no `electronAPI`, no `process.env`, no general-purpose Electron access.
3. **Renderer** (`src/renderer/`) — Runs in a sandboxed, context-isolated Chromium browser window. This is the React UI. It has NO direct access to Node.js APIs — it can only call functions that the preload explicitly exposed on `window.api`.

Communication between renderer and main goes through **IPC** (Inter-Process Communication):

- Renderer calls `window.api.someMethod()` (defined in preload)
- Preload translates that into `ipcRenderer.invoke('channel-name', args)`
- Main process has a handler registered via `ipcMain.handle('channel-name', handler)`
- The handler's return value travels back as the resolved Promise

---

## Build & Config Files

### `electron.vite.config.ts`

```ts
import { resolve } from "path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  main: {
    build: {
      outDir: "dist/main",
      rollupOptions: {
        external: ["better-sqlite3"],
      },
    },
  },
  preload: {
    build: {
      outDir: "dist/preload",
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    build: { outDir: "dist/renderer" },
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
      },
    },
    plugins: [react(), tailwindcss()],
  },
});
```

`electron-vite` is a build tool that wraps Vite specifically for Electron. It builds three separate bundles. Output goes to `dist/` (not `out/`) so that electron-forge can use `out/` for its packaging output:

- **`main: { build: { outDir: 'dist/main' } }`** — Builds `src/main/index.ts` into `dist/main/index.js`. `better-sqlite3` is explicitly externalized so Vite doesn't try to bundle the native module.
- **`preload`** — Builds `src/preload/index.ts` into `dist/preload/index.js`. The `format: "cjs"` and `entryFileNames: "[name].js"` overrides are critical: Electron's sandboxed preload loader requires CJS format with a `.js` extension. Without these, `"type": "module"` in package.json causes Vite to output `.mjs` (ESM), which the sandbox rejects — the preload silently fails to load and `window.api` is undefined.
- **`renderer: { ... }`** — Builds the React app. This is where the interesting config lives:
  - `resolve.alias` — Lets you write `import { Button } from '@renderer/components/ui/button'` instead of long relative paths like `../../../components/ui/button`. The `@renderer` alias maps to `src/renderer/src/`.
  - `plugins: [react(), tailwindcss()]` — `react()` enables JSX/TSX compilation. `tailwindcss()` is the Tailwind CSS v4 Vite plugin — it processes your CSS, scans your source files for class names, and generates only the CSS you actually use.

### `vitest.config.ts`

```ts
export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: {
      "@renderer": resolve("src/renderer/src"),
    },
  },
});
```

Vitest is the test runner (like Jest, but built for Vite). `include` tells it where to find test files — any `.test.ts` or `.test.tsx` file inside a `__tests__` folder anywhere under `src/`. The alias matches the one in electron.vite.config.ts so imports resolve correctly in tests too. Renderer tests use `// @vitest-environment jsdom` inline directives to run in a DOM environment (vitest v4 removed the config-level `environmentMatchGlobs` option).

### `tsconfig.web.json`

```json
{
  "extends": "@electron-toolkit/tsconfig/tsconfig.web.json",
  "include": [
    "src/renderer/src/env.d.ts",
    "src/renderer/src/**/*",
    "src/renderer/src/**/*.tsx",
    "src/preload/*.d.ts",
    "src/shared/**/*"
  ],
  "compilerOptions": {
    "composite": true,
    "jsx": "react-jsx",
    "paths": {
      "@renderer/*": ["./src/renderer/src/*"]
    }
  }
}
```

The renderer's TypeScript config. `src/shared/**/*` is included so renderer components can import types like `SearchResult` from `src/shared/types.ts`. Notable: `baseUrl` has been removed from both this file and the root `tsconfig.json` because it's deprecated in TypeScript 6+ and will stop functioning in TypeScript 7. The `paths` entries use explicit `./` relative paths instead, which work without `baseUrl` in modern TypeScript (paths resolve relative to the tsconfig file's location).

### `components.json`

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "base-nova",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/renderer/src/index.css",
    "baseColor": "neutral",
    "cssVariables": true
  },
  "iconLibrary": "lucide",
  "aliases": { ... },
  "registries": {
    "@coss": "https://coss.com/ui/r/{name}.json"
  }
}
```

This is the config file for the `shadcn` CLI tool. When you run `pnpm dlx shadcn@latest add @coss/button`, the CLI reads this file to know:

- **`style: "base-nova"`** — Use Base UI (from MUI) as the headless component library, not Radix.
- **`rsc: false`** — We're NOT using React Server Components (Electron is client-only).
- **`tailwind.css`** — Where the main CSS file lives (so it can inject theme variables).
- **`aliases`** — How to rewrite import paths in the generated component code (e.g., `@renderer/components/ui`).
- **`registries.@coss`** — The Coss UI component registry URL. When you `add @coss/button`, it fetches from `https://coss.com/ui/r/button.json`.

---

## Main Process Files

### `src/main/index.ts` — App Entry Point

```ts
import { app, shell, BrowserWindow } from "electron";
import { join } from "path";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import started from "electron-squirrel-startup";
import icon from "../../resources/icon.png?asset";
import { registerIpcHandlers } from "./ipc/handlers";
import { closeDb } from "./db/singleton";

if (started) app.quit();
```

**Imports breakdown:**

- `app` — The Electron application lifecycle manager. Controls when the app starts, quits, etc.
- `shell` — OS-level operations like opening URLs in the default browser.
- `BrowserWindow` — Creates and manages browser windows (each is a Chromium instance).
- `electronApp`, `optimizer`, `is` — Utilities from electron-toolkit: `is.dev` checks if running in dev mode, `optimizer` adds dev shortcuts (like Cmd+R to reload).
- `started` — From `electron-squirrel-startup`. On Windows, Squirrel fires lifecycle events during install/update/uninstall. This import handles those events and returns `true` if the app should quit (e.g., during installation). On macOS it's a no-op that returns `false`.
- `icon` — The `?asset` suffix is an electron-vite feature that resolves the file path at build time.
- `registerIpcHandlers` — Our IPC setup function (from Task 2).
- `closeDb` — Closes the SQLite connection cleanly on app quit (prevents WAL corruption).

```ts
function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    show: false,
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
```

Creates a browser window. Key options:

- **`show: false`** — Don't show the window immediately. We show it later in `ready-to-show` to avoid a white flash while the page loads.
- **`preload`** — Path to the preload script. `__dirname` is the directory of the built main process file (`dist/main/`), so `../preload/index.js` resolves to `dist/preload/index.js`.
- **`contextIsolation: true`** — (default, made explicit) The preload and renderer run in separate JavaScript contexts. The renderer cannot access preload globals directly — only what's exposed via `contextBridge`.
- **`nodeIntegration: false`** — (default, made explicit) The renderer cannot `require()` or `import` Node.js modules.
- **`sandbox: true`** — Enables Chromium's sandbox for the renderer. The preload still gets access to `contextBridge`, `ipcRenderer`, `webFrame`, and `webUtils` via Electron's sandboxed module system. This works because electron-vite bundles the preload script, resolving the `electron` import at build time against Electron's sandbox-safe module loader.
- **`backgroundThrottling: false`** — Prevents Chromium from throttling timers/network when the window loses focus. Important for sync operations that run while the user switches to another app.

```ts
mainWindow.on("ready-to-show", () => {
  mainWindow.show();
});
```

Once the HTML/CSS/JS has loaded and the page is ready to render, show the window.

```ts
mainWindow.webContents.setWindowOpenHandler((details) => {
  try {
    const parsed = new URL(details.url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      shell.openExternal(details.url);
    }
  } catch {
    /* invalid URL, ignore */
  }
  return { action: "deny" };
});
```

When something tries to open a new window (like clicking an `<a target="_blank">` link), instead of opening a new Electron window, open it in the user's default browser. `{ action: 'deny' }` prevents the new Electron window from being created.

The URL is validated before passing to `shell.openExternal` — only `http:` and `https:` protocols are allowed. This prevents a compromised renderer from opening dangerous URLs like `file:///etc/passwd` or `javascript:` URIs.

```ts
if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
  mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
} else {
  mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
}
```

In development, load from the Vite dev server (hot module replacement, fast refresh). In production, load the built HTML file directly from disk.

```ts
app.whenReady().then(() => {
  electronApp.setAppUserModelId("com.commons.app");
  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });
  registerIpcHandlers();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
```

`app.whenReady()` resolves when Electron has finished initializing. Then:

1. Set the app ID (used by Windows for taskbar grouping).
2. Watch for keyboard shortcuts in dev mode (F12 for devtools, Cmd+R for reload).
3. **`registerIpcHandlers()`** — Register all our IPC channel handlers BEFORE creating the window. This ensures the handlers are ready before the renderer tries to call them.
4. **`createWindow()`** — Create and show the main window.
5. The `activate` handler is a macOS convention: clicking the dock icon when no windows are open should create a new window.

```ts
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  closeDb();
});
```

On Windows/Linux, closing all windows quits the app. On macOS, apps traditionally stay running in the dock even with no windows open.

The `will-quit` handler closes the SQLite database connection before the process exits. Without this, the WAL (Write-Ahead Log) file may not be checkpointed back into the main database, risking data loss if the OS terminates the process before the WAL is flushed.

---

### `src/main/db/singleton.ts` — Database Singleton

```ts
import Database from "better-sqlite3";
import { app } from "electron";
import { join } from "node:path";
import { runMigrations } from "./migrations";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  const dbPath = join(app.getPath("userData"), "commons.db");
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  runMigrations(_db);
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
```

This is the **singleton pattern** — ensures only one database connection exists for the entire app lifetime.

- **`_db`** — Module-level variable. Starts as `null`. Once `getDb()` is called, it holds the connection.
- **`app.getPath('userData')`** — Returns the OS-specific user data directory (e.g., `~/Library/Application Support/commons-app` on macOS). This is where Electron apps are supposed to store persistent data.
- **`new Database(dbPath)`** — Opens (or creates) a SQLite database file at that path using `better-sqlite3`, a synchronous native SQLite binding for Node.js.
- **`pragma('journal_mode = WAL')`** — Enables Write-Ahead Logging. Default SQLite uses a rollback journal which locks the entire database during writes. WAL allows concurrent reads during writes — much better for an app where the UI might query while a sync is inserting data.
- **`pragma('foreign_keys = ON')`** — SQLite has foreign key support but it's disabled by default. This turns it on so `ON DELETE CASCADE` actually works (deleting a source cascades to its documents and chunks).
- **`runMigrations(_db)`** — Creates/updates the schema tables. Only runs once per connection.

---

### `src/main/db/migrations.ts` — Schema Migrations

```ts
interface Migration {
  version: number;
  statements: string[];
}

const migrations: Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE sources ( ... )`,
      `CREATE TABLE documents ( ... )`,
      `CREATE TABLE chunks ( ... )`,
      `CREATE TABLE settings ( ... )`,
      `CREATE INDEX ...`,
    ],
  },
];
```

Each migration has a version number and a list of SQL statements. There are currently three versions:

- **Version 1** — The initial schema (5 tables + indexes).
- **Version 2** — Creates a `secrets` table and migrates encrypted secret keys (`cohere_api_key`, `notion_token`, `google_tokens`) out of the `settings` table into `secrets`. This separates plaintext settings from encrypted secrets.
- **Version 3** — Deduplicates any existing sources with the same `(provider, root_external_id)` pair, then creates a unique index `idx_sources_provider_root` to prevent future duplicates.

**The six tables:**

1. **`sources`** — A connected data source (e.g., a Notion workspace, a Google Drive folder). `root_external_id` is the Notion page ID or Drive folder ID. Has a unique constraint on `(provider, root_external_id)` to prevent duplicates.
2. **`documents`** — Individual docs fetched from a source. `external_id` is the ID from the provider (Notion page ID, Drive file ID). `content_hash` is a SHA-256 of the content — used to skip re-processing unchanged docs during sync. `sync_status` tracks whether the doc has been successfully processed.
3. **`chunks`** — Pieces of a document after splitting. Each chunk has `text` (the actual content), an optional `heading` (the section heading it came from), an `embedding` (a BLOB storing the vector as raw bytes), and `embedding_model` (which model generated the embedding — used to filter chunks by model during search).
4. **`settings`** — Key-value store for app configuration (embedding provider choice, Ollama model preference, etc.). Plaintext only — no secrets.
5. **`secrets`** — Key-value store for encrypted secrets (API keys stored as base64-encoded encrypted blobs via `safeStorage`). Separated from settings for security.
6. **Indexes** — `idx_documents_source_id` speeds up "get all docs for a source." `idx_chunks_document_id` speeds up "get all chunks for a doc." `idx_documents_external` enforces uniqueness — you can't have two documents with the same external ID in the same source. `idx_sources_provider_root` prevents duplicate sources.

**Foreign keys with CASCADE:**

- `documents.source_id REFERENCES sources(id) ON DELETE CASCADE` — When you delete a source, all its documents are automatically deleted.
- `chunks.document_id REFERENCES documents(id) ON DELETE CASCADE` — When a document is deleted (directly or via cascade), all its chunks are automatically deleted.

```ts
export function runMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const current = db
    .prepare("SELECT MAX(version) as v FROM schema_version")
    .get();
  const currentVersion = current?.v ?? 0;

  const pending = migrations.filter((m) => m.version > currentVersion);
  if (pending.length === 0) return;

  const applyAll = db.transaction(() => {
    for (const migration of pending) {
      for (const sql of migration.statements) {
        db.exec(sql);
      }
      db.prepare(
        "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
      ).run(migration.version, new Date().toISOString());
    }
  });
  applyAll();
}
```

How it works:

1. Create the `schema_version` table if it doesn't exist (`IF NOT EXISTS` makes this safe to call repeatedly).
2. Check the highest applied version number.
3. Filter migrations to only those with a higher version number.
4. Wrap all pending migrations in a **transaction** — if any statement fails, ALL changes are rolled back and the database stays in its previous valid state. No half-applied migrations.
5. After each migration's statements execute, record the version number so it won't run again.

---

### `src/main/db/database.ts` — Query Helpers

This file contains all the functions that read/write data. Each function takes a `db` parameter instead of using the singleton directly — this makes them testable (tests pass an in-memory database).

**The two-interface pattern:**

Every entity (sources, documents, chunks) has TWO TypeScript interfaces:

- **`SourceRow`** — The application-level interface with camelCase fields (`rootExternalId`, `createdAt`).
- **`SourceDbRow`** — The database-level interface with snake_case fields (`root_external_id`, `created_at`) matching the actual SQL column names.

SQLite returns rows with the exact column names from the query, so we need the `DbRow` type to correctly type `db.prepare(...).get()` results. The helper functions translate between the two.

**Key functions:**

```ts
export function insertSource(db: Database.Database, source: SourceRow): void {
  db.prepare("INSERT INTO sources (...) VALUES (?, ?, ?, ?, ?)").run(
    source.id,
    source.provider,
    source.name,
    source.rootExternalId,
    source.createdAt,
  );
}
```

`db.prepare(sql)` compiles the SQL statement. `.run(args)` executes it with the given positional parameters. The `?` placeholders are filled in order by the arguments to `.run()`. This is a **parameterized query** — it prevents SQL injection because the values are never interpolated into the SQL string.

```ts
export function insertDocument(db: Database.Database, doc: DocumentRow): void {
  db.prepare(
    `INSERT OR REPLACE INTO documents (...) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(...)
}
```

`INSERT OR REPLACE` means: if a row with the same primary key already exists, delete it and insert the new one. This makes it an upsert (insert-or-update) operation.

```ts
export function upsertChunks(db: Database.Database, chunks: ChunkRow[]): void {
  const insert = db.prepare(`INSERT OR REPLACE INTO chunks (...) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const batch = db.transaction((items: ChunkRow[]) => {
    for (const c of items) {
      insert.run(...)
    }
  })
  batch(chunks)
}
```

This is a **batched transaction**. Instead of inserting chunks one at a time (each with its own transaction overhead), we:

1. Prepare the statement once (compiled SQL is reused).
2. Wrap all inserts in a single transaction via `db.transaction()`.
3. Call `batch(chunks)` to execute.

This is dramatically faster — inserting 100 chunks in one transaction takes ~1ms vs. ~100ms with individual transactions.

```ts
export function getChunksWithEmbeddings(db: Database.Database): ChunkRow[] {
  const rows = db
    .prepare("SELECT * FROM chunks WHERE embedding IS NOT NULL")
    .all();
  return rows.map(mapChunkRow);
}

export function getChunksWithEmbeddingsByModel(
  db: Database.Database, model: string, limit = 10_000
): ChunkRow[] {
  // Filters by embedding_model to avoid dimension mismatches after provider switches
  ...
}
```

`getChunksWithEmbeddings` loads all chunks with embeddings (used for health checks). `getChunksWithEmbeddingsByModel` is used by the search engine — it filters to only chunks matching the current embedding model (e.g. `embed-v4.0` for Cohere, `nomic-embed-text` for Ollama), preventing dimension mismatch errors when comparing vectors after a provider switch. The `limit` parameter (default 10k) guards against loading too many chunks into memory for brute-force search.

```ts
export function getDocumentById(
  db: Database.Database,
  id: string,
): DocumentRow | null;
```

Looks up a single document by its primary key. Added in Task 5 — the searcher needs to join chunk results with document metadata (title, url, provider) to build `SearchResult` objects.

```ts
export function upsertSetting(
  db: Database.Database,
  key: string,
  value: string,
): void {
  db.prepare("INSERT OR REPLACE INTO secrets (key, value) VALUES (?, ?)").run(
    key,
    value,
  );
}

export function getSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM secrets WHERE key = ?").get(key);
  if (!row) return null;
  return row.value;
}
```

Simple key-value storage. Used for app configuration (embedding provider, Ollama model preference). Secrets are stored separately in the `secrets` table — see `storage.ts` below.

---

### `src/main/auth/storage.ts` — Secure Storage

```ts
import { safeStorage } from "electron";
import type Database from "better-sqlite3";

export function saveSecret(
  db: Database.Database,
  key: string,
  plaintext: string,
): void {
  const encrypted = safeStorage.encryptString(plaintext);
  db.prepare("INSERT OR REPLACE INTO secrets (key, value) VALUES (?, ?)").run(
    key,
    encrypted.toString("base64"),
  );
}
```

**`safeStorage`** is Electron's built-in encryption API. It uses the OS keychain to encrypt/decrypt:

- macOS: uses the Keychain
- Windows: uses DPAPI (Data Protection API)

`encryptString(plaintext)` returns a `Buffer` of encrypted bytes. We convert that to a base64 string so it can be stored as text in the SQLite `secrets` table (which has a TEXT column). Secrets are stored separately from plaintext settings for security.

```ts
export function loadSecret(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM secrets WHERE key = ?").get(key);
  if (!row) return null;
  const buf = Buffer.from(row.value, "base64");
  return safeStorage.decryptString(buf);
}
```

Reverse of save: read the base64 string from the `secrets` table, convert back to a Buffer, decrypt it.

```ts
export function deleteSecret(db: Database.Database, key: string): void {
  db.prepare("DELETE FROM secrets WHERE key = ?").run(key);
}
```

---

### `src/main/ipc/handlers.ts` — IPC Channel Handlers

```ts
const ALLOWED_SECRET_KEYS = new Set([
  "cohere_api_key",
  "notion_token",
  "google_tokens",
]);

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}
```

**`ALLOWED_SECRET_KEYS`** — An allowlist of secret key names that can be read/written through IPC. Without this, a compromised renderer could read or overwrite arbitrary settings table entries by passing any key string.

**`isSafeUrl`** — Validates that a URL uses `http:` or `https:` protocol before passing it to `shell.openExternal`. Blocks `file://`, `javascript:`, and other dangerous schemes.

```ts
export function registerIpcHandlers(): void {
  const db = getDb()
```

Called once during app startup. Gets the database connection (creating it and running migrations if this is the first call).

```ts
ipcMain.handle("secrets:save", (_, key: string, value: string) => {
  if (!ALLOWED_SECRET_KEYS.has(key))
    throw new Error(`Unknown secret key: ${key}`);
  saveSecret(db, key, value);
});

ipcMain.handle("secrets:load", (_, key: string) => {
  if (!ALLOWED_SECRET_KEYS.has(key))
    throw new Error(`Unknown secret key: ${key}`);
  return loadSecret(db, key);
});
```

```ts
ipcMain.handle("search:query", async (_, query: string) => {
  const provider = (getSetting(db, "embedding_provider") ?? "cohere") as
    | "cohere"
    | "ollama";
  const cohereApiKey = loadSecret(db, "cohere_api_key");
  const embedConfig: EmbedConfig = {
    provider,
    apiKey: cohereApiKey ?? undefined,
  };
  return search(db, query, embedConfig, cohereApiKey ?? undefined);
});
```

The search handler loads the embedding config from settings and secrets, then delegates to `search()` from `searcher.ts`. The Cohere API key is passed both in `embedConfig` (for query embedding) and as a separate `cohereApiKey` param (for reranking). When the provider is Ollama and no Cohere key is stored, reranking is skipped and cosine similarity alone ranks results.

`ipcMain.handle(channel, handler)` registers a handler for a named channel. The first argument `_` is the `IpcMainInvokeEvent` (we don't use it). The remaining arguments are whatever the renderer passed.

The return value of the handler is sent back to the renderer as the resolved value of the `ipcRenderer.invoke()` Promise.

Both secret handlers validate the key against the allowlist before proceeding. If the key isn't in the set, the handler throws, which rejects the Promise on the renderer side.

```ts
ipcMain.handle("auth:validate-cohere", async (_, apiKey: string) => {
  try {
    const res = await fetch("https://api.cohere.com/v2/embed", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "embed-v4.0",
        texts: ["test"],
        input_type: "search_query",
        embedding_types: ["float"],
      }),
    });
    return { valid: res.ok };
  } catch {
    return { valid: false };
  }
});
```

Validates a Cohere API key by making a real embed request with the minimum possible input (a single word `"test"`). If the response is `2xx` (`res.ok === true`), the key is valid. If the request fails (network error, invalid key returns 401), it returns `{ valid: false }`. The `catch` handles network errors (e.g., no internet).

```ts
ipcMain.handle("auth:check-ollama", async () => {
  try {
    const res = await fetch("http://localhost:11434/api/tags");
    if (!res.ok) return { available: false, models: [] };
    const data = (await res.json()) as { models?: { name: string }[] };
    return { available: true, models: data.models?.map((m) => m.name) ?? [] };
  } catch {
    return { available: false, models: [] };
  }
});
```

Ollama runs a local HTTP server on port 11434. The `/api/tags` endpoint lists all installed models. If the fetch fails (Ollama not running), `catch` returns unavailable.

```ts
ipcMain.handle("settings:get-embedding-provider", () => {
  return getSetting(db, "embedding_provider") ?? "cohere";
});
```

Returns the stored embedding provider, defaulting to `'cohere'` if none is set.

```ts
ipcMain.handle("app:open-external", async (_, url: string) => {
  if (!isSafeUrl(url)) return;
  await shell.openExternal(url);
});
```

Opens a URL in the user's default browser, but only after validating it's an `http:` or `https:` URL. This is why you can't just use `<a href="...">` in an Electron app — you need to explicitly call `shell.openExternal` or links will try to navigate inside the Electron window.

---

### `src/shared/types.ts` — Domain Types

```ts
export interface Source {
  id: string;
  provider: "notion" | "google_drive";
  name: string;
  rootExternalId: string;
  createdAt: string;
}
```

The `provider` field is a **union type** — it can only be `'notion'` or `'google_drive'`. This gives you compile-time safety: TypeScript will error if you try to pass `'dropbox'`.

```ts
export interface SyncProgress {
  sourceId: string;
  phase: "fetching" | "extracting" | "chunking" | "embedding" | "storing";
  current: number;
  total: number;
  currentDocTitle: string | null;
  errors: string[];
}
```

This is the shape of progress updates sent from main to renderer during a sync. The `phase` union type represents the pipeline stages a document goes through: fetch from provider → extract text → split into chunks → generate embeddings → store in database.

```ts
export type SourceConfig =
  | { provider: "notion"; rootPageId: string; name: string }
  | { provider: "google_drive"; folderId: string; folderName: string };
```

A **discriminated union** — TypeScript can narrow the type based on the `provider` field. If `config.provider === 'notion'`, TypeScript knows `config.rootPageId` exists. If `config.provider === 'google_drive'`, it knows `config.folderId` exists.

---

## Preload Files

### `src/preload/index.ts` — Context Bridge

```ts
import { contextBridge, ipcRenderer } from "electron";

const api = {
  saveSecret: (key: string, value: string): Promise<void> =>
    ipcRenderer.invoke("secrets:save", key, value),
  loadSecret: (key: string): Promise<string | null> =>
    ipcRenderer.invoke("secrets:load", key),
  validateCohereKey: (key: string): Promise<{ valid: boolean }> =>
    ipcRenderer.invoke("auth:validate-cohere", key),
  checkOllama: (): Promise<{ available: boolean; models: string[] }> =>
    ipcRenderer.invoke("auth:check-ollama"),
  getEmbeddingProvider: (): Promise<string> =>
    ipcRenderer.invoke("settings:get-embedding-provider"),
  setEmbeddingProvider: (provider: string): Promise<void> =>
    ipcRenderer.invoke("settings:set-embedding-provider", provider),
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke("app:open-external", url),
  search: (query: string): Promise<SearchResult[]> =>
    ipcRenderer.invoke("search:query", query),
};

contextBridge.exposeInMainWorld("api", api);
```

Each method wraps `ipcRenderer.invoke(channel, ...args)`, which sends a message to the main process and returns a Promise that resolves with the handler's return value.

Only the typed `api` object is exposed — we intentionally do NOT expose `electronAPI` from `@electron-toolkit/preload`. That object includes `process.env` (a copy of all environment variables), which would leak build-time secrets like `NOTION_CLIENT_SECRET` and `GOOGLE_CLIENT_SECRET` to the renderer. Since the renderer never uses `window.electron`, removing it is a pure security win with no functional cost.

**`contextBridge.exposeInMainWorld('api', api)`** — This is the critical security boundary. It makes the `api` object available as `window.api` in the renderer, but in a way that:

1. Only the specific functions we define are exposed (not arbitrary Node.js access).
2. The renderer can't modify or replace the exposed functions.
3. Objects are cloned when crossing the bridge (no shared references).

The `contextIsolated` conditional check from electron-toolkit's boilerplate has been removed — with `contextIsolation: true` set explicitly in the window config, context isolation is always active, so the conditional is unnecessary.

### `src/preload/index.d.ts` — Type Declarations

```ts
export {};

interface CommonsAPI {
  saveSecret(key: string, value: string): Promise<void>;
  loadSecret(key: string): Promise<string | null>;
  validateCohereKey(key: string): Promise<{ valid: boolean }>;
  checkOllama(): Promise<{ available: boolean; models: string[] }>;
  getEmbeddingProvider(): Promise<string>;
  setEmbeddingProvider(provider: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  search(query: string): Promise<import("../shared/types").SearchResult[]>;
}

declare global {
  interface Window {
    api: CommonsAPI;
  }
}
```

This `.d.ts` file tells TypeScript what `window.api` looks like. Without it, `window.api.loadSecret(...)` would be a type error because TypeScript doesn't know that property exists on `Window`. The `declare global` block extends the built-in `Window` interface.

The `export {}` at the top is required — without it, TypeScript treats the file as a script (not a module), and `declare global` only works inside a module. The `ElectronAPI` type from `@electron-toolkit/preload` has been removed since we no longer expose `window.electron`.

---

## Renderer Files

### `src/renderer/index.html`

```html
<body class="relative">
  <div id="root" class="isolate relative flex min-h-svh flex-col"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
```

- **`class="relative"` on body** — Establishes a positioning context.
- **`class="isolate"` on root div** — Creates a new **stacking context**. This is a Coss UI requirement — it ensures portaled components (dropdowns, modals) layer correctly above the main content.
- **`min-h-svh`** — `svh` = small viewport height. Makes the root div fill the full window height.
- **`<script type="module">`** — Loads the React app as an ES module.

The `Content-Security-Policy` meta tag restricts what the page can load:

- `script-src 'self'` — Only scripts from the app itself (no CDN scripts, no inline `<script>` tags).
- `style-src 'self' 'unsafe-inline'` — Styles from the app + inline styles (Tailwind needs this).
- `connect-src 'self' https://api.cohere.com http://localhost:11434` — Network requests only to these origins.
- `font-src 'self'` — Fonts must be bundled (no Google Fonts CDN).

### `src/renderer/src/main.tsx` — React Entry Point

```tsx
import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- **`import './index.css'`** — Imports the CSS file so Vite processes it (Tailwind, fonts, theme variables).
- **`createRoot(...)`** — React 18+ API for rendering. Gets the `#root` div from index.html.
- **`StrictMode`** — Development helper that double-renders components to catch side effects. Has no effect in production builds.
- **`!`** — TypeScript non-null assertion. We know `getElementById('root')` won't return null because we control the HTML.

### `src/renderer/src/index.css` — Coss Theme

This is a big file with three sections:

**Section 1: Imports and custom variant**

```css
@import "tailwindcss";
@import "@fontsource-variable/inter";
@import "@fontsource-variable/geist-mono";

@custom-variant dark (&:where(.dark, .dark *));
```

- `@import 'tailwindcss'` — Tailwind v4 syntax. This single import replaces the old `@tailwind base; @tailwind components; @tailwind utilities;`.
- Font imports load the variable font files (Inter for body text, Geist Mono for code). Variable fonts contain all weights in a single file — smaller than loading multiple weight-specific files.
- `@custom-variant dark` — Defines how `dark:` prefix works in Tailwind classes. The selector `&:where(.dark, .dark *)` means: apply when the element itself has class `dark`, OR when any ancestor has class `dark`. Using `:where()` keeps specificity at 0 so styles are easily overridable.

**Section 2: CSS custom properties (`:root` and `.dark`)**

```css
:root {
  --radius: 0.625rem;
  --background: var(--color-white);
  --foreground: var(--color-neutral-800);
  --primary: var(--color-neutral-800);
  --primary-foreground: var(--color-neutral-50);
  --secondary: --alpha(var(--color-black) / 4%);
  --muted-foreground: color-mix(
    in srgb,
    var(--color-neutral-500) 90%,
    var(--color-black)
  );
  --border: --alpha(var(--color-black) / 8%);
  /* ... more tokens ... */
}
```

These are **semantic design tokens**. Instead of hardcoding `#1f2937` everywhere, components use `bg-primary` which resolves to `var(--primary)` which resolves to `var(--color-neutral-800)` (a dark gray).

Key concepts:

- `var(--color-neutral-800)` — References Tailwind v4's built-in color palette. These are predefined by Tailwind.
- `--alpha(var(--color-black) / 4%)` — Coss's alpha function. Creates a semi-transparent version of a color (black at 4% opacity).
- `color-mix(in srgb, var(--color-neutral-500) 90%, var(--color-black))` — CSS color mixing. Blends 90% of neutral-500 with 10% of black.
- The `--foreground` suffix convention: `--primary` is the background color, `--primary-foreground` is the text color to use on top of it.

The `.dark` block overrides these same properties with dark-mode values. Light mode uses dark text on light backgrounds; dark mode inverts this.

**Section 3: `@theme inline` block**

```css
@theme inline {
  --font-sans: "Inter", ui-sans-serif, system-ui, ...;
  --color-background: var(--background);
  --color-primary: var(--primary);
  --radius-sm: calc(var(--radius) - 4px);
  --radius-lg: var(--radius);
  /* ... */
}
```

`@theme inline` is a Tailwind v4 feature. It registers CSS variables as **Tailwind theme values**. This is what makes `bg-primary`, `text-muted-foreground`, `rounded-lg` etc. work in Tailwind classes:

- `--color-background: var(--background)` → enables `bg-background` class
- `--color-primary: var(--primary)` → enables `bg-primary`, `text-primary` classes
- `--radius-lg: var(--radius)` → enables `rounded-lg` class
- `--font-sans` → enables `font-sans` class

Without this block, Tailwind wouldn't know these custom properties exist and the utility classes wouldn't be generated.

**Section 4: Base layer**

```css
@layer base {
  * {
    @apply border-border;
  }
  body {
    @apply bg-background text-foreground font-sans antialiased;
  }
}
```

`@layer base` sets default styles at the lowest specificity layer:

- Every element defaults to `border-color: var(--border)` — so when you add `border` to an element, it uses the theme border color automatically.
- The body gets the background color, text color, font, and anti-aliased text rendering.

---

### `src/renderer/src/App.tsx` — Root Component

```tsx
function App(): React.JSX.Element {
  const [ready, setReady] = useState<boolean | null>(null)

  useEffect(() => {
    let ignore = false

    window.api.getEmbeddingProvider().then(async (provider) => {
      if (ignore) return
      if (provider === 'ollama') {
        setReady(true)
        return
      }
      const key = await window.api.loadSecret('cohere_api_key')
      if (!ignore) setReady(key !== null)
    })

    return () => { ignore = true }
  }, [])
```

`ready` has three states:

- `null` — Still checking (show nothing)
- `false` — Not set up (show SetupPage)
- `true` — Ready (show main app)

`useEffect` with `[]` dependency array runs once on mount. The async check logic lives inside a `.then()` callback rather than a standalone function to avoid the React lint rule against calling setState synchronously within an effect body. The `ignore` flag is a cleanup pattern from the React docs — it prevents setting state on an unmounted component if the user navigates away before the IPC calls resolve.

Check logic:

1. Get the stored embedding provider (defaults to `'cohere'` if unset).
2. If it's `'ollama'`, no API key needed — we're ready.
3. If it's `'cohere'`, check if we have a stored API key. Ready only if a key exists.

```tsx
if (ready === null) return <div />;
```

Blank div while checking — prevents a flash of the wrong UI.

```tsx
if (!ready) {
  return (
    <OnboardingWizard
      onComplete={() => {
        setReady(true);
        setPage("search");
      }}
    />
  );
}
```

Show the onboarding wizard if not configured. When setup completes, `onComplete` sets `ready` to `true` and switches to the search page.

The main app uses a **CSS display hiding** pattern instead of conditional rendering:

```tsx
<div style={{ display: page === "search" ? undefined : "none" }}>
  <SearchPage />
</div>
<div style={{ display: page === "sources" ? undefined : "none" }}>
  <SourcesPage />
</div>
<div style={{ display: page === "settings" ? undefined : "none" }}>
  <SettingsPage onProviderReset={() => { checkReady(); }} />
</div>
```

All three pages are always mounted — only the active one is visible. This preserves page state (search query, results, scroll position) when navigating between tabs. The previous approach used conditional `&&` rendering (`{page === "search" && <SearchPage />}`), which unmounted components on tab switch and lost all state.

---

### `src/renderer/src/components/setup/ApiKeyForm.tsx`

```tsx
const [apiKey, setApiKey] = useState("");
const [status, setStatus] = useState<
  "idle" | "validating" | "valid" | "invalid"
>("idle");
```

Four-state state machine for the validation flow.

```tsx
async function handleValidate(): Promise<void> {
  if (!apiKey.trim()) return;
  setStatus("validating");
  try {
    const result = await window.api.validateCohereKey(apiKey.trim());
    if (result.valid) {
      await window.api.saveSecret("cohere_api_key", apiKey.trim());
      await window.api.setEmbeddingProvider("cohere");
      setStatus("valid");
      onSuccess();
    } else {
      setStatus("invalid");
    }
  } catch {
    setStatus("invalid");
  }
}
```

The validation flow:

1. Guard against empty input.
2. Set status to `'validating'` (shows loading spinner on button).
3. Call the main process to validate the key (makes a real API request to Cohere).
4. If valid: store the encrypted key, set the provider, call `onSuccess()` (which navigates to the main app).
5. If invalid: show error message.

The button uses `loading={status === 'validating'}` which is the Coss Button's built-in loading state — it shows a spinner overlay and makes the text transparent.

The input clears the error state when you type (`if (status === 'invalid') setStatus('idle')`), and submits on Enter.

---

### `src/renderer/src/components/setup/OllamaOption.tsx`

```tsx
useEffect(() => {
  let ignore = false;
  window.api.checkOllama().then((result) => {
    if (ignore) return;
    if (result.available) {
      setStatus("available");
      setModels(result.models);
    } else {
      setStatus("unavailable");
    }
  });
  return () => {
    ignore = true;
  };
}, []);
```

Checks Ollama availability on mount using the same `ignore` flag cleanup pattern as `App.tsx`. The inline `.then()` avoids calling a standalone async function from the effect body. The `ignore` flag prevents stale state updates if the component unmounts before the IPC call resolves.

The separate `checkOllama` function is kept for the Retry button `onClick` handlers — those are user-initiated and don't need cleanup.

```tsx
const embeddingModels = models.filter(
  (m) => m.includes("embed") || m.includes("nomic") || m.includes("mxbai"),
);
```

Filters the model list to only show embedding models. Ollama model names include the model type in their name (e.g., `nomic-embed-text`, `mxbai-embed-large`). General-purpose models (like `llama3`) are filtered out since they can't be used for embeddings.

---

### `src/renderer/src/pages/SearchPage.tsx` — Search Screen

The main app screen after setup. Manages search state and composes three sub-components.

```tsx
const [query, setQuery] = useState("");
const [results, setResults] = useState<SearchResult[] | null>(null);
const [loading, setLoading] = useState(false);
const [error, setError] = useState<string | null>(null);
```

`results` is `null` initially (show empty state with example questions), `[]` after a search with no matches (show "no results" message), or populated with results.

```tsx
const handleSearch = useCallback(
  async (searchQuery?: string) => {
    const q = (searchQuery ?? query).trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    try {
      const searchResults = await window.api.search(q);
      setResults(searchResults);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Search failed. Try again.",
      );
      setResults(null);
    } finally {
      setLoading(false);
    }
  },
  [query],
);
```

The optional `searchQuery` parameter allows `EmptyState` chips to pass a question directly (setting `query` state and searching in one call) without waiting for a re-render.

During `loading`, three skeleton cards are shown (animated `bg-muted animate-pulse` divs mimicking the result card layout).

### `src/renderer/src/components/search/SearchInput.tsx`

Text input with a search icon (or spinner when loading) absolutely positioned inside. Submits on Enter when the query is non-empty and not loading.

The icon overlays the Input component's inner `<input>` element. Since the Coss `Input` wraps the actual `<input>` in a `<span>`, left padding is applied via `[&_[data-slot=input]]:pl-8` — a Tailwind arbitrary variant that targets the inner input by its `data-slot` attribute.

### `src/renderer/src/components/search/ResultCard.tsx`

Displays a single search result. Shows:

- **Document title** (truncated) and optional **heading** (the section within the doc)
- **Provider badge** — "Notion" or "Google Drive" in a `bg-secondary` pill
- **Snippet** — First 200 characters of the chunk text
- **Match score** — Displayed as a percentage (e.g., "87% match")
- **"Open source" button** — Calls `window.api.openExternal(url)` to open the original doc in the browser. Only shown when `result.url` is present.

### `src/renderer/src/components/search/EmptyState.tsx`

Shown when no search has been performed yet (`results === null`). Displays a 2×2 grid of example question chips ("How do I get reimbursed?", "What does a tech lead do?", etc.). Clicking a chip fills the search input and submits the query.

---

### `src/renderer/src/lib/utils.ts`

```ts
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

The `cn()` utility is used everywhere for class names. It combines two libraries:

- **`clsx`** — Conditionally joins class names. Handles strings, arrays, objects: `clsx('a', false && 'b', { c: true })` → `'a c'`.
- **`twMerge`** — Intelligently merges Tailwind classes. Without it, `cn('px-4', 'px-2')` would produce `'px-4 px-2'` (both applied, CSS order decides the winner). With `twMerge`, it produces `'px-2'` (later class wins, earlier is removed).

---

## UI Component Files

### `src/renderer/src/components/ui/button.tsx`

This is a Coss UI component — significantly more complex than a basic button.

**`buttonVariants` (cva):**

`buttonVariants` is NOT exported — it's internal to the file. Exporting non-component values (like a `cva` call) from a component file breaks React Fast Refresh, which requires files to export only components.

`cva` (class-variance-authority) is a function that maps variant props to Tailwind class strings. Instead of writing `if (variant === 'destructive') className += '...'`, you declare a configuration object.

The base classes (first argument) apply to ALL buttons:

- `relative inline-flex` — Inline flex layout with relative positioning.
- `cursor-pointer` — Hand cursor.
- `rounded-lg border` — Rounded corners with a border.
- `before:pointer-events-none before:absolute before:inset-0` — A pseudo-element overlay for subtle shadow effects.
- `focus-visible:ring-2 focus-visible:ring-ring` — Focus ring for keyboard navigation.
- `disabled:pointer-events-none disabled:opacity-64` — Disabled state.
- `data-loading:select-none data-loading:text-transparent` — When loading, text becomes transparent (the spinner sits on top).

The `variant` options define the visual style:

- **`default`** — Dark background, light text, inset shadow for depth, box shadow.
- **`outline`** — Border + transparent background, hover fills lightly.
- **`ghost`** — No border, no background, just text. Hover adds subtle fill.
- **`destructive`** — Red background for dangerous actions.

**`useRender` pattern:**

```tsx
return useRender({
  defaultTagName: "button",
  props: mergeProps<"button">(defaultProps, props),
  render,
});
```

`useRender` is from Base UI. It's a headless UI primitive that lets the button render as any element via the `render` prop. For example, `<Button render={<a href="..." />}>` renders as a link but with button styling. `mergeProps` deeply merges the default props with user-provided props (combining event handlers, merging class names, etc.).

### `src/renderer/src/components/ui/card.tsx`

Similar pattern to Button. The card is split into many sub-components (CardHeader, CardTitle, CardContent, CardFooter, etc.) that compose together. Each uses `useRender` for flexible rendering.

Note at the bottom: `export { CardPanel as CardContent }` — `CardContent` is an alias for `CardPanel`. This is for backward compatibility with the standard shadcn API.

### `src/renderer/src/components/ui/input.tsx`

The Input wraps Base UI's `InputPrimitive` in a styled `<span>`. The outer span handles the border, shadow, focus ring, and error states. The inner input is unstyled except for sizing and placeholder color. `InputPrimitive` is imported but NOT re-exported — it's only used internally on line 37. Re-exporting non-component values from a component file would break React Fast Refresh (same reason `buttonVariants` isn't exported from button.tsx).

### `src/renderer/src/components/ui/spinner.tsx`

```tsx
export function Spinner({ className, ...props }: ...): React.ReactElement {
  return <Loader2Icon className={cn('animate-spin', className)} role="status" ... />
}
```

Simple wrapper around Lucide's `Loader2Icon` with a spin animation. `role="status"` makes it accessible to screen readers.

---

### `src/main/search/chunker.ts` — Text Chunker

A pure-logic module that splits document text into chunks for embedding. No external dependencies.

```ts
export interface ChunkData {
  index: number;
  heading: string | null;
  text: string;
  tokenCount: number;
}

const MAX_TOKENS = 400;
const OVERLAP_TOKENS = 50;
```

**`ChunkData`** is a lightweight intermediate type. The sync manager (Task 7) maps these into `ChunkRow` objects with IDs, document IDs, embeddings, and timestamps for database storage.

**Token estimation:**

```ts
export function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(Boolean);
  return Math.ceil(words.length / 0.75);
}
```

Rough approximation: ~0.75 words per token (English text averages ~1.3 tokens per word). Good enough for chunking decisions — exact token counts aren't needed because the embedding model handles variable-length input.

**Splitting strategy — three levels:**

1. **`splitOnHeadings(text)`** — Primary strategy. Scans line by line for markdown heading patterns (`# `, `## `, `### `, etc. via `/^(#{1,6})\s+(.+)$/`). Each heading starts a new section. Content before the first heading becomes a section with `heading: null`.

2. **`splitOnParagraphs(text)`** — Fallback for documents with no headings. Splits on double newlines (`\n\n+`), joins everything into a single section with `heading: null`. This preserves paragraph structure while keeping the output format consistent.

3. **`splitAtSentences(text)`** — Used inside `splitOversizedSection` for sections that exceed `MAX_TOKENS`. Splits on sentence boundaries (`. `, `? `, `! `) using a lookbehind regex: `/(?<=[.!?])\s+/`.

**Oversized section handling:**

```ts
function splitOversizedSection(
  text: string,
  heading: string | null,
  startIndex: number,
): ChunkData[];
```

When a section exceeds 400 tokens, it's split at sentence boundaries. The key feature is **overlap**: after emitting a chunk, the last ~50 tokens of sentences are carried forward to the start of the next chunk. This provides context continuity for the embedding model — without overlap, a sentence referencing "the above process" would lose its referent.

The overlap is built by walking backward through the current chunk's sentences until ~50 tokens are accumulated. These sentences become the starting content of the next chunk.

**Main function:**

```ts
export function chunkText(text: string, _title: string): ChunkData[];
```

`_title` is unused in the current implementation but part of the planned API signature — the sync manager (Task 7) passes the document title, which could be used for context enrichment later. The underscore prefix satisfies ESLint's `no-unused-vars` rule.

Flow: detect headings → choose splitting strategy → for each section, either emit directly (≤400 tokens) or split at sentences with overlap → assign sequential indices across all chunks.

---

### `src/main/search/embedder.ts` — Embedding Service

Converts text into vector embeddings via either Cohere's API or a local Ollama instance. Uses raw `fetch` for both — no SDK dependency.

```ts
export interface EmbedConfig {
  provider: "cohere" | "ollama";
  apiKey?: string;
  ollamaModel?: string;
}
```

All config is passed via `EmbedConfig`. This keeps the embedder a pure module with no database or storage coupling — the caller (sync manager) reads the API key from secure storage and the Ollama model from settings, then passes them in.

**Cohere path:**

```ts
async function embedWithCohere(
  texts: string[],
  inputType: "search_document" | "search_query",
  apiKey: string,
): Promise<Float32Array[]>;
```

Calls `POST https://api.cohere.com/v2/embed` with `model: "embed-v4.0"`. Batches at 96 texts (Cohere's per-request limit). The `input_type` parameter tells Cohere whether the text is a document being indexed (`search_document`) or a user query (`search_query`) — the model generates slightly different embeddings for each to improve retrieval accuracy.

Returns `Float32Array[]` — each embedding is 1536 dimensions (Cohere embed-v4.0 default).

**Ollama path:**

```ts
async function embedWithOllama(
  texts: string[],
  model: string,
): Promise<Float32Array[]>;
```

Calls `POST http://localhost:11434/api/embed`. Model defaults to `nomic-embed-text` if not specified in config. Ollama runs locally — no API key needed.

**Public API:**

- **`embedDocuments(texts, config)`** — Embeds document chunks with `input_type: "search_document"`. Returns empty array for empty input without making API calls.
- **`embedQuery(text, config)`** — Embeds a search query with `input_type: "search_query"`. Returns a single `Float32Array`.
- **`getEmbeddingModelName(config)`** — Returns `"embed-v4.0"` for Cohere, `config.ollamaModel ?? "nomic-embed-text"` for Ollama. Stored alongside each chunk in the database for mismatch detection.

**Buffer conversion for SQLite storage:**

```ts
export function embeddingToBuffer(embedding: Float32Array): Buffer;
export function bufferToEmbedding(buf: Buffer): Float32Array;
```

SQLite stores embeddings as BLOBs. `Float32Array` (in-memory representation, 4 bytes per dimension) is converted to/from `Buffer` for storage. A 1536-dimension embedding = 6144 bytes = ~6KB per chunk.

`embeddingToBuffer` creates a view over the same `ArrayBuffer` (no copy). This is safe because SQLite's `better-sqlite3` copies the data when inserting, and the `Float32Array` is typically garbage-collected after the embedding function returns.

---

### `src/main/search/reranker.ts` — Cohere Rerank Wrapper

Raw `fetch` to `POST https://api.cohere.com/v2/rerank` with model `rerank-v3.5`. Takes a query, a list of candidate `{ id, text }` objects, an API key, and optional `topN` (default 8). Returns `{ id, score }[]` mapped from Cohere's `relevance_score` response. Sends documents as plain text strings (not objects). The `top_n` param tells Cohere to return only the top N results, reducing response size.

### `src/main/search/searcher.ts` — Search Orchestration

Exports `cosineSimilarity(a, b)` (pure function, no worker thread) and `search(db, query, embedConfig, cohereApiKey?)`.

`cosineSimilarity` includes a dimension assertion — throws if `a.length !== b.length`, catching embedding dimension mismatches (e.g. comparing Cohere 1024-dim vectors with Ollama 768-dim vectors) with a clear error instead of silent garbage scores.

Search pipeline:

1. Embed query via `embedQuery(query, embedConfig)` → `Float32Array`
2. Determine current model via `getEmbeddingModelName(embedConfig)`
3. Load chunks matching the current model from DB via `getChunksWithEmbeddingsByModel(db, model)` — filters by `embedding_model` column, capped at 10k chunks. Logs a warning if chunk count exceeds 5000.
4. Convert each chunk's `Buffer` embedding to `Float32Array` via `bufferToEmbedding()`
5. Compute cosine similarity between query and every chunk, sort descending, take top 40
6. If `cohereApiKey` provided: rerank top 40 via `rerank()` → take top 8
7. If no Cohere key: take top 8 from cosine similarity directly
8. Look up document metadata for each result via `getDocumentById(db, chunk.documentId)`
9. Map to `SearchResult[]` (documentTitle, snippet, heading, url, provider, score)

Constants: `COSINE_TOP_K = 40`, `RESULT_LIMIT = 8`.

---

## Test Files

### `src/main/db/__tests__/database.test.ts` — 11 Tests

Each `describe` block creates a fresh in-memory database in `beforeEach` and closes it in `afterEach`. In-memory databases (`:memory:`) are fast and isolated — each test gets a clean database.

Key tests:

- **Cascade deletes** — Inserts a source → document → chunk chain, deletes the source, verifies documents and chunks are gone.
- **Idempotent migrations** — Runs `runMigrations` twice to prove it doesn't error on an already-migrated database.
- **Upsert settings** — Writes a key twice and verifies the second value wins.

### `src/main/search/__tests__/chunker.test.ts` — 15 Tests

Tests for the text chunker. All tests use the pure functions directly — no mocking needed.

Key tests:

- **Heading splitting** — Verifies text is split on `#` through `######` headings, each section gets the correct heading text.
- **Preamble handling** — Content before the first heading becomes a chunk with `heading: null`.
- **Oversized section splitting** — 200 repeated sentences exceed the 400-token limit. Verifies the section is split into multiple chunks with overlap (end of chunk N appears at start of chunk N+1).
- **Token limit enforcement** — Each chunk's `tokenCount` stays under 450 (400 + tolerance from sentence boundaries).
- **Empty/whitespace input** — Returns `[]` for empty strings and whitespace-only strings.
- **No-headings fallback** — Documents without headings still produce chunks (via paragraph splitting).
- **Sequential indices** — Indices are sequential across all chunks, including across oversized splits.
- **Empty section skipping** — Heading-only sections (no body text) are excluded from output.

### `src/main/search/__tests__/embedder.test.ts` — 15 Tests

Tests for the embedding service. Uses `vi.stubGlobal('fetch', vi.fn())` to mock the global `fetch` function — no real API calls are made.

Key tests:

- **Buffer round-trip** — `Float32Array → embeddingToBuffer → bufferToEmbedding → Float32Array` preserves values. Tests both small (4-dim) and large (1536-dim) arrays.
- **Model name resolution** — `getEmbeddingModelName` returns `"embed-v4.0"` for Cohere, `"nomic-embed-text"` for Ollama (default), and custom model names when specified.
- **Cohere input type** — `embedDocuments` sends `input_type: "search_document"`, `embedQuery` sends `input_type: "search_query"`.
- **Batch splitting** — 200 texts result in 3 fetch calls (96 + 96 + 8). Verifies each batch has the correct number of texts.
- **Ollama model** — Default model is `nomic-embed-text`, custom model is passed through.
- **Empty input** — Returns `[]` without making API calls.
- **Error handling** — Throws descriptive errors for missing API key, Cohere API errors (401), and Ollama API errors (500).

### `src/main/search/__tests__/reranker.test.ts` — 4 Tests

Tests for the Cohere reranker. Uses `vi.stubGlobal('fetch', vi.fn())`.

Key tests:

- **Result mapping** — Verifies reranked results are mapped to the correct candidate IDs using Cohere's `index` field.
- **Request shape** — Verifies correct URL, Authorization header, model (`rerank-v3.5`), `top_n`, query, and documents payload.
- **Default topN** — Verifies `top_n` defaults to 8 when not specified.
- **API error** — Throws descriptive error for non-OK responses (401 Unauthorized).

### `src/main/search/__tests__/searcher.test.ts` — 12 Tests

Tests for cosine similarity and the full search pipeline. Cosine similarity tests use pure math. Search pipeline tests use a real in-memory SQLite database with seeded sources, documents, and chunks.

Key tests:

- **Cosine similarity** (5 tests) — Identical vectors → 1, orthogonal → 0, opposite → -1, high-dimensional (1536-dim), symmetry.
- **Empty database** — Returns empty results when no chunks have embeddings.
- **Ranking** — Verifies results are ordered by cosine similarity score, correct `SearchResult` fields populated from chunk + document metadata.
- **Reranking** — With `cohereApiKey`, reranker reverses ordering. Verifies two fetch calls (embed + rerank).
- **Skip reranking** — Without `cohereApiKey` (Ollama config), only one fetch call (embed). No rerank.
- **Result limit** — 15 chunks → only 8 results returned.
- **SearchResult shape** — Exact `toEqual` check on all fields.
- **Multi-document** — Results span multiple documents correctly.

### `src/main/auth/__tests__/storage.test.ts` — 4 Tests

```ts
vi.mock("electron", () => ({
  safeStorage: {
    encryptString: (text: string) => Buffer.from(`enc:${text}`),
    decryptString: (buf: Buffer) => buf.toString().replace("enc:", ""),
  },
}));
```

`vi.mock` replaces the `electron` module with a fake. Since tests run in Node.js (not Electron), `safeStorage` doesn't exist. The mock simulates encryption by prepending `enc:` — this is enough to test the round-trip logic without real encryption.

---

## Renderer Security Model

The renderer process is locked down with four layers:

1. **`sandbox: true`** — The renderer runs in Chromium's sandbox. The preload script cannot `require()` arbitrary Node.js modules. It only has access to Electron's sandboxed module set: `contextBridge`, `ipcRenderer`, `webFrame`, `webUtils`. This works because electron-vite bundles the preload, resolving the `electron` import at build time.

2. **`contextIsolation: true`** — The preload and renderer run in separate JavaScript contexts. The renderer cannot access preload globals or prototype-pollute its way into Node.js access. Communication is only through `contextBridge`.

3. **`nodeIntegration: false`** — The renderer cannot `require('fs')`, `import('child_process')`, or use any Node.js API directly.

4. **Minimal API surface** — Only the typed `CommonsAPI` object is exposed on `window.api`. We do NOT expose `electronAPI` from `@electron-toolkit/preload`, which would leak `process.env` (containing build-time secrets like `NOTION_CLIENT_SECRET`, `GOOGLE_CLIENT_SECRET`) and general-purpose `ipcRenderer` access to the renderer.

Additionally, `backgroundThrottling: false` prevents Chromium from throttling the window when it loses focus, which matters for long-running sync operations.

The Content Security Policy in `index.html` provides a fifth layer, restricting `script-src`, `connect-src`, and `font-src` to known origins.

---

## Native Module Fix

`better-sqlite3` includes a compiled C++ addon (`better_sqlite3.node`). Native addons are compiled against a specific Node.js version's ABI (Application Binary Interface), identified by `NODE_MODULE_VERSION`:

- System Node.js 24 = MODULE_VERSION 137
- Electron 39's embedded Node.js = MODULE_VERSION 140

When you `pnpm install`, the addon compiles for your system Node. But Electron uses its own Node.js with a different version. Loading a 137-compiled addon into a 140 runtime crashes.

The original scaffold had `"postinstall": "electron-rebuild"`, which recompiled better-sqlite3 for Electron's ABI after every `pnpm install`. This broke Vitest, which runs under system Node — the Electron-compiled addon would crash in system Node.

**Current strategy:** The `postinstall` hook rebuilds for Electron ABI after install. Then:

- `pnpm test` runs `pnpm rebuild better-sqlite3 &&` before Vitest, recompiling for system Node.
- `pnpm posttest` runs `electron-rebuild -w better-sqlite3` to rebuild for Electron ABI after tests complete, so `pnpm dev` works immediately after `pnpm test`.
- Packaging scripts (`make`, `make:mac`, `make:win`) use electron-forge, which runs `@electron/rebuild` automatically via `rebuildConfig` in `forge.config.ts`.

This means the addon is always compiled for the right runtime before use. The `posttest` hook ensures seamless switching between `pnpm test` and `pnpm dev`.

---

## Expected Behavior

When you run `pnpm run dev`:

1. Electron window opens
2. App checks if an embedding provider is configured (it won't be on first run)
3. **Setup screen appears** — "Welcome to Commons" card with two options:
   - **"Use Cohere API"** — leads to a password input where you paste a Cohere API key, hit "Validate & Save", it makes a real API call to verify the key, and on success stores the encrypted key and moves to the search page
   - **"Use Ollama (Local)"** — checks if Ollama is running on localhost:11434, shows available embedding models if found, or install instructions if not
4. After choosing a provider, the **Search page** appears:
   - Header: "Commons" title with "Search your club's docs" subtitle
   - Search input with a search icon, Enter to submit
   - **Empty state**: 2×2 grid of example question chips ("How do I get reimbursed?", etc.) — clicking one fills and submits the search
   - **Loading state**: 3 skeleton cards with pulsing animation
   - **Results**: Cards showing document title, heading, text snippet, provider badge, match percentage, and "Open source" link
   - **No results**: "No results found. Try a different question or sync more docs."
5. On subsequent launches, the app skips setup and goes straight to the search page (key is persisted in SQLite)

---

## Test State

118 tests pass (11 database + 4 storage + 15 chunker + 15 embedder + 4 reranker + 12 searcher + 54 sync/connector + 3 SearchInput). Typecheck, lint, and build all clean.

---

## Audit Fixes (Post-Task 2)

A codebase audit (`docs/audit-2026-07-03.md`) found 17 issues across security, architecture, build, and best practices. 15 were fixed, 1 was a no-op, 1 was deferred:

**Security fixes:**

1. **`openExternal` URL validation** — Both `setWindowOpenHandler` (in `index.ts`) and the `app:open-external` IPC handler (in `handlers.ts`) now validate URLs before passing to `shell.openExternal`. Only `http:` and `https:` protocols are allowed. Prevents a compromised renderer from opening `file://`, `javascript:`, or other dangerous schemes.

2. **IPC secret key allowlist** — `secrets:save` and `secrets:load` handlers now validate the key against `ALLOWED_SECRET_KEYS` (`cohere_api_key`, `notion_token`, `google_tokens`). Without this, a compromised renderer could read or write arbitrary settings table entries.

3. **Removed `InputPrimitive` re-export** — Was leaking a Base UI internal to external consumers and could break React Fast Refresh.

**Architecture fixes:**

4. **Close database on quit** — Added `app.on('will-quit', () => closeDb())` to ensure the SQLite WAL is checkpointed before exit.

5. **OllamaOption effect cleanup** — Replaced bare `checkOllama()` call in `useEffect` with the `ignore` flag pattern (matching `App.tsx`) to prevent stale state updates on unmount.

6. **ABI mismatch fix** — Removed `postinstall: electron-rebuild` (broke Vitest). Moved `electron-rebuild` to `dev` and `start` scripts so the addon is compiled for the right runtime before each use.

7. **Async safeStorage** — Deferred. Electron 39's TypeScript types don't expose `encryptStringAsync`/`decryptStringAsync`, and the sync variants are fast OS keychain calls with no blocking concern.

**Config cleanup:**

8. **electron-builder.yml** (now deleted, replaced by `forge.config.ts`) — Originally fixed `appId` to `com.commons.app`, `productName` to `Commons`, `executableName` to `commons`. Removed Linux targets (macOS + Windows only for MVP). Removed placeholder `publish` section.

9. **tsconfig.json** — Removed `baseUrl: "."`, switched paths to `["./src/renderer/src/*"]` (relative paths work without `baseUrl` in modern TypeScript).

10. **pnpm-workspace.yaml** — Removed `sharp: set this to true or false` placeholder.

11. **`.node-version`** — Created with value `22` to pin the Node.js version.

12. **react/react-dom** — Moved from `devDependencies` to `dependencies` (they're runtime deps, not dev-only).

13. **Implementation plan doc** — Updated tech stack line (now says `electron-forge` after migration).

14. **Removed `build:linux` script** — No Linux target for MVP.

15. **Ran `pnpm format`** — Fixed all Prettier violations.

**Skipped:**

- Issue 12 (ChunkRow `Buffer` vs `Uint8Array`) — No-op, `Buffer extends Uint8Array`.
- Issue 17 (Install `cohere-ai` SDK) — Decided against. Raw `fetch` is used instead (see Task 4 deviations).

---

## Audit Fixes Phase 2 (Post-Task 11)

A second pass addressed the 16 remaining findings from the original 32-finding audit. Organized into 4 phases.

### Phase 1 — Foundational

**M12: Consolidated `SourceWithCount` type**
`type SourceWithCount = Source & { documentCount: number }` was defined identically in `SourcesPage.tsx`, `SourceList.tsx`, and `OnboardingWizard.tsx`. Moved to `src/shared/types.ts` as a single export, all three files now import from there.

**M1: Separated secrets from settings table**
Encrypted secrets (`cohere_api_key`, `notion_token`, `google_tokens`) were stored alongside plaintext settings in the `settings` table. Added migration v2 that creates a `secrets` table, moves existing secret rows over, and deletes them from `settings`. Updated `src/main/auth/storage.ts` — all three functions (`saveSecret`, `loadSecret`, `deleteSecret`) now query the `secrets` table. Updated `clearAllData()` in `database.ts` to also delete from `secrets`.

**H5: Embedding dimension mismatch detection**
After switching embedding providers (e.g. Cohere → Ollama), `cosineSimilarity` would silently compare vectors of different dimensions (1024 vs 768), producing garbage scores. Fixed with two changes:

1. Added `getChunksWithEmbeddingsByModel(db, model, limit?)` in `database.ts` — filters chunks to only those matching the current embedding model via `AND embedding_model = ?`.
2. Added a dimension assertion at the top of `cosineSimilarity`: throws an explicit error if `a.length !== b.length`.
3. Updated `search()` in `searcher.ts` to use model-filtered query with `getEmbeddingModelName(embedConfig)`.

### Phase 2 — Backend

**H3: Size guard on brute-force search**
All matching embeddings were loaded into memory. Added a `LIMIT 10000` parameter to `getChunksWithEmbeddingsByModel` and a `console.warn` when chunk count exceeds 5000 to flag when the corpus is getting large for brute-force search.

**M7: Duplicate source prevention**
The same Notion page or Drive folder could be added multiple times. Added migration v3 that deduplicates existing rows and creates `CREATE UNIQUE INDEX idx_sources_provider_root ON sources(provider, root_external_id)`. Also added a pre-insert check in the `sources:add` IPC handler that queries for an existing `(provider, root_external_id)` pair and throws `"This source is already connected."` if found.

**M10: Drive API rate limiting**
`DriveConnector` had no throttling or retry logic, unlike `NotionConnector`. Added `throttle()` (100ms interval, matching Google's ~12k req/100s quota) and `rateLimited()` (exponential backoff retry on 429) methods to `DriveConnector`, mirroring the existing pattern in `NotionConnector`. All 6 `this.drive.*` API call sites are now wrapped in `this.rateLimited()`.

### Phase 3 — Frontend

**L5: Extracted `providerLabel()` to shared util**
The same function was duplicated in `ResultCard.tsx` and `SourceList.tsx`. Created `src/renderer/src/lib/format.ts` with the extracted function, both files now import from there.

**H6: Error handling gaps**
Three components had uncaught or silently-swallowed async errors:

- `OllamaOption.tsx` — Added `error` state, `.catch()` to the useEffect, try/catch to `checkOllama()` and `handleSelect()`, renders `ErrorBanner` when error is set.
- `SourceList.tsx` — Added `error` state and a `catch` block to `handleRemove` (previously had try/finally but no catch), renders `ErrorBanner` above the source list.
- `OnboardingWizard.tsx` — Added `sourceError` state, replaced `.catch(() => {})` with `.catch(() => setSourceError(...))`, renders `ErrorBanner` in the sources step.

**M5: Page state preservation**
Pages unmounted on tab switch due to conditional `&&` rendering (`{page === "search" && <SearchPage />}`). Search query, results, and scroll position were lost when navigating away and back. Replaced with CSS `display: none` hiding — all three pages are always mounted, only the active one is visible.

**L1: Accessibility basics**

- Added `lang="en"` to `<html>` tag in `index.html`
- Added `role="alert"` to `ErrorBanner`'s outer div
- Added `aria-label="Search your documents"` to `SearchInput`'s Input
- Added `htmlFor`/`id` pairing to both label+input groups in `DriveFolderInput`
- Added `role="alert"` to `DriveFolderInput`'s error paragraph

**L2: Deleted dead code**
Deleted `src/renderer/src/pages/SetupPage.tsx` (93 lines). It was never imported anywhere, superseded by `OnboardingWizard`.

**L6: Removed `"use client"` directives**
Removed `"use client";` from `button.tsx`, `card.tsx`, and `input.tsx`. This is a Next.js/RSC directive with no effect in Electron (which is client-only).

**SourcesPage dedup fix**
`SourcesPage.tsx` had duplicated fetch logic — a `loadSources` callback AND an identical inline fetch in `useEffect`. Replaced the inline fetch with `loadSources()` called via `useEffect(() => { loadSources(); }, [loadSources])`.

### Phase 4 — Build/Config/Tests

**C3: Native module ABI conflict fix**
After `pnpm test`, `better-sqlite3` was rebuilt for Node ABI, breaking subsequent `pnpm dev`. Added `"posttest": "electron-rebuild -w better-sqlite3"` to `package.json` so the module is automatically rebuilt for Electron ABI after tests complete.

**H7: macOS notarization config**
Added conditional `osxNotarize` to `forge.config.ts`, gated on `process.env.APPLE_ID`. When the env vars are set (CI/release builds), notarization runs automatically. When unset (local dev), it's skipped.

**M9: Removed camera/mic entitlements**
Removed `NSCameraUsageDescription` and `NSMicrophoneUsageDescription` from `forge.config.ts` `extendInfo`. The app doesn't use the camera or microphone — these were boilerplate from the scaffold.

**L7: Fixed vitest include pattern**
Changed `["src/**/__tests__/**/*.test.ts"]` to `["src/**/__tests__/**/*.test.{ts,tsx}"]` so `.test.tsx` files are picked up.

**H8: Test infrastructure for renderer**
Installed `jsdom`, `@testing-library/react`, and `@testing-library/jest-dom`. Created `src/renderer/src/components/search/__tests__/SearchInput.test.tsx` with 3 tests: renders with aria-label, calls `onSubmit` on Enter, does not submit when loading. Uses `// @vitest-environment jsdom` inline directive (vitest v4 removed `environmentMatchGlobs`).

---

## Implementation Plan

**Plan file:** `docs/superpowers/plans/2026-06-25-commons-implementation.md`

### Task 1: Project Scaffold + Database Layer — COMPLETE

- [x] Step 1: Scaffold electron-vite project
- [x] Step 2: Install core dependencies (better-sqlite3, @electron/rebuild)
- [x] Step 3: Configure Tailwind CSS v4 (@tailwindcss/vite plugin)
- [x] Step 4: Install Coss UI (Base UI variant, @coss registry)
- [x] Step 5: Set Content Security Policy (script-src, connect-src, font-src)
- [x] Step 6: Write shared types (Source, Document, Chunk, SearchResult, SyncProgress, etc.)
- [x] Step 7: Write failing tests for database and migrations
- [x] Step 8: Implement migrations (schema_version tracking, transactional apply)
- [x] Step 9: Implement database query helpers (insertSource, insertDocument, upsertChunks, upsertSetting, etc.)
- [x] Step 10: Run tests, verify pass
- [x] Step 11: Verify app launches
- [x] Step 12: Commit

### Task 2: Secure Storage + API Key Setup UI — COMPLETE

- [x] Step 1: Write failing test for secure storage
- [x] Step 2: Implement secure storage (safeStorage encrypt/decrypt, base64 round-trip via settings table)
- [x] Step 3: Set up IPC handlers and preload bridge (secrets, auth, settings, app channels)
- [x] Step 4: Build API key setup UI (SetupPage, ApiKeyForm, OllamaOption)
- [x] Step 5: Run tests, verify app boots to setup screen
- [x] Step 6: Commit

**Post-task hardening (done after Task 2):**

- [x] Switched to fully secure renderer: `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`
- [x] Removed `electronAPI` from preload (was leaking `process.env` to renderer)
- [x] Simplified preload to unconditional `contextBridge.exposeInMainWorld('api', api)`

### Task 3: Text Chunker — COMPLETE

- [x] Step 1: Write failing tests (15 test cases)
- [x] Step 2: Implement chunker (heading-aware splitting, sentence-boundary fallback, ~50-token overlap)
- [x] Step 3: Run tests, verify pass
- [ ] Step 4: Commit

Also added `argsIgnorePattern: "^_"` and `varsIgnorePattern: "^_"` to ESLint config for underscore-prefixed unused params convention.

### Task 4: Embedding Service — COMPLETE

- [x] Step 1: Write failing tests (mock fetch, batch splitting at 96, Float32Array ↔ Buffer round-trip, Ollama HTTP)
- [x] Step 2: Implement embedder (raw fetch, EmbedConfig object, Cohere + Ollama)
- [x] Step 3: Run tests, verify pass
- [ ] Step 4: Manual test with real Cohere key
- [ ] Step 5: Commit

**Plan deviations (decided with user):**

1. **Raw `fetch` instead of `cohere-ai` SDK** — The API surface is two endpoints (embed + rerank). Raw fetch avoids a dependency, matches the existing `auth:validate-cohere` handler, and a generic retry utility (needed for Notion/Drive anyway) is better than SDK-specific retry.
2. **`EmbedConfig` object instead of flat parameters** — Keeps the signature stable as config grows. Caller reads API key from secure storage and Ollama model from settings, passes them in.
3. **`nomic-embed-text` as hardcoded default** — Overridable via `config.ollamaModel`. Sync manager reads user preference from settings and passes it in.

### Task 5: Search Engine (Cosine Similarity + Rerank) — COMPLETE

- [x] Step 1: Add `getDocumentById()` to database.ts
- [x] Step 2: Write failing tests (cosine similarity, reranker mock, full pipeline with seeded DB)
- [x] Step 3: Implement reranker
- [x] Step 4: Implement searcher orchestration (cosine similarity inline, no worker)
- [x] Step 5: Add IPC handler + preload bridge (`search:query` channel, `search()` on `CommonsAPI`)
- [x] Step 6: Run tests, verify pass
- [ ] Step 7: Commit

**Plan deviations (decided with user):**

1. **No worker thread** — Cosine similarity runs inline in `searcher.ts` instead of a separate `search.worker.ts`. For ~2,000 chunks × 1536 dimensions, cosine similarity takes ~10-15ms on the main thread — a worker adds electron-vite bundling complexity and message serialization overhead for negligible gain at this scale.
2. **`rerank-v3.5` instead of `rerank-v4.0-pro`** — Updated to current Cohere rerank model name.
3. **`search(db, query, embedConfig, cohereApiKey?)` signature** — Plan said `search(query)`. Actual needs: database instance, EmbedConfig for query embedding, and optional separate Cohere API key for reranking (you might use Ollama for embeddings but still have a Cohere key for reranking).
4. **Added `getDocumentById()` to database.ts** — Missing from original plan. Searcher needs to join chunk results with document metadata (title, url, provider).
5. **Added preload bridge** — Not in original Task 5 plan. Added `search(query)` to preload API and `CommonsAPI` type so Task 6 (Search UI) can call it via `window.api.search(query)`.

### Task 6: Search UI — COMPLETE

- [x] Step 1: Build EmptyState component (example question chips in 2×2 grid)
- [x] Step 2: Build ResultCard component (title, heading, snippet, provider badge, score, open-source link)
- [x] Step 3: Build SearchInput component (search icon, Enter to submit, spinner during loading)
- [x] Step 4: Build SearchPage (composes above, manages state, skeleton loading cards, error/empty states)
- [x] Step 5: Wire into App.tsx (replaced placeholder Card with SearchPage)
- [ ] Step 6: Seed test data and manually verify
- [ ] Step 7: Commit

**Additional changes:**

- Added `src/shared/**/*` to `tsconfig.web.json` `include` — renderer components import `SearchResult` from `src/shared/types.ts`, which wasn't in the tsconfig's file list.
- Updated `electron.vite.config.ts` preload config — added `format: "cjs"` and `entryFileNames: "[name].js"` to force CJS output with `.js` extension. Electron's sandboxed preload loader rejects `.mjs` (ESM) files, which is what Vite outputs by default when `"type": "module"` is in package.json.

### Task 7: Sync Manager — NOT STARTED

- [ ] Step 1: Write failing tests (mock connector, content hash skip, error recovery)
- [ ] Step 2: Implement sync manager
- [ ] Step 3: Wire IPC handlers
- [ ] Step 4: Run tests, verify pass
- [ ] Step 5: Commit

### Task 8: Notion Connector — NOT STARTED

- [ ] Step 1: Write failing tests (block-to-text, pagination, rate limit retry, depth guard)
- [ ] Step 2: Implement `blocksToText` conversion
- [ ] Step 3: Implement `NotionConnector` with recursive walking
- [ ] Step 4: Implement OAuth flow and paste-token flow
- [ ] Step 5: Wire IPC handlers
- [ ] Step 6: Run tests, verify pass
- [ ] Step 7: Manual test with real Notion workspace
- [ ] Step 8: Commit

### Task 9: Google Drive Connector — NOT STARTED

- [ ] Step 1: Write failing tests (folder URL parsing, mock googleapis, content extraction, token refresh)
- [ ] Step 2: Implement `extractFolderIdFromUrl`
- [ ] Step 3: Implement `DriveConnector` with recursive folder walking
- [ ] Step 4: Implement Google OAuth flow with token refresh
- [ ] Step 5: Wire IPC handlers
- [ ] Step 6: Run tests, verify pass
- [ ] Step 7: Manual test with real Google Drive
- [ ] Step 8: Commit

### Task 10: Source Management UI — NOT STARTED

- [ ] Step 1: Build SourceList component
- [ ] Step 2: Build ConnectNotionButton + NotionPicker
- [ ] Step 3: Build ConnectDriveButton + DriveFolderInput
- [ ] Step 4: Build SyncPanel with progress tracking
- [ ] Step 5: Build SourcesPage
- [ ] Step 6: Add navigation to App.tsx (sidebar with Search / Sources / Settings)
- [ ] Step 7: Manual end-to-end test
- [ ] Step 8: Commit

### Task 11: Polish + Error Handling — NOT STARTED

- [ ] Step 1: Build SettingsPage
- [ ] Step 2: Build ErrorBanner component
- [ ] Step 3: Implement embedding health check
- [ ] Step 4: Add graceful degradation for Cohere unavailability
- [ ] Step 5: Build OnboardingWizard
- [ ] Step 6: Add loading/empty states to all pages
- [ ] Step 7: Full manual walkthrough
- [ ] Step 8: Commit

### Task 12: Packaging + Distribution — NOT STARTED

- [ ] Step 1: Install electron-forge and makers
- [ ] Step 2: Create forge.config.ts
- [ ] Step 3: Create app icons
- [ ] Step 4: Build on macOS, verify DMG
- [ ] Step 5: Build on Windows (or note as TODO)
- [ ] Step 6: Upload to GitHub Releases
- [ ] Step 7: Write minimal README
- [ ] Step 8: Commit

---

## Lint & Type Cleanup (Post-Task 2)

Four issues fixed after Tasks 1-2 were complete:

1. **`tsconfig.web.json` — Removed deprecated `baseUrl`**. TypeScript 6 deprecated `baseUrl` (will be removed in TS 7). Removed it and switched `paths` entries to use `./` relative paths, which resolve relative to the tsconfig file location without needing `baseUrl`.

2. **`src/shared/types.ts` — Changed `Chunk.embedding` from `Buffer` to `Uint8Array`**. `Buffer` is a Node.js type unavailable in the renderer's browser context. Since this types file is shared across both processes, `Uint8Array` is the correct cross-environment type. `Buffer` extends `Uint8Array`, so main-process code passing `Buffer` values still satisfies the type.

3. **`src/renderer/src/App.tsx` — Restructured setup check effect**. Fixed two issues: (a) `checkSetup` was referenced before its declaration, and (b) calling a setState function directly in an effect body triggers a React lint warning about cascading renders. Replaced with inline `.then()` callback pattern and added an `ignore` cleanup flag to prevent stale state updates on unmount.

4. **`src/renderer/src/components/ui/button.tsx` — Removed `export` from `buttonVariants`**. React Fast Refresh requires files to export only components. `buttonVariants` (a `cva` call) is not a component, and exporting it alongside `Button` broke Fast Refresh. Since nothing outside the file imports it, removing `export` was the fix.

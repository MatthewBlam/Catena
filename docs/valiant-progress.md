# Code Audit Remediation Progress

Tracking progress on the 10-phase remediation plan from the [static analysis audit](https://claude.ai/code/artifact/b7fcfc88-df12-40a2-86ef-e2c47a1c051e).

Plan: `/Users/mattyb/.claude/plans/you-are-a-senior-valiant-candle.md`

## Phase 1: Critical Infrastructure & Lifecycle — COMPLETE

All 6 sub-tasks completed. 126 tests passing, TypeScript clean.

### 1a. Fix activeSyncs leak (CRITICAL) — DONE

- **File:** `src/main/ipc/sync-handlers.ts`
- Restructured try block to wrap `getConnectorForSource()`. `activeSyncs.set()` now runs only after connector creation succeeds, preventing orphaned entries when connector throws.

### 1b. Database singleton hardening — DONE

- **File:** `src/main/db/singleton.ts`
- Added corruption recovery: if `new Database()` throws, renames DB to `.corrupt.bak` and creates fresh.
- Added `busy_timeout = 5000` pragma to prevent SQLITE_BUSY errors.
- Added pre-migration backup: copies DB to `.pre-migration.bak` before running migrations.

### 1c. App lifecycle safety — DONE

- **File:** `src/main/index.ts`
- Added `.catch()` to `app.whenReady()` — logs error and quits on fatal init failure.
- Moved `window:start-drag`, `window:dragging`, `window:stop-drag` IPC handlers inside `app.whenReady()` — `screen` module requires app ready state.
- Added `cancelAllSyncs()` call before `closeDb()` in `will-quit` handler.

### 1d. Stale DB reference — DONE

- **Files:** `src/main/ipc/handlers.ts`, `src/main/ipc/sync-handlers.ts`
- Changed from `const db = getDb()` captured once at registration time to calling `getDb()` inside each handler, ensuring handlers always use the current DB instance.

### 1e. Transactional chunk replacement — DONE

- **Files:** `src/main/db/database.ts`, `src/main/sync/sync-manager.ts`
- Added `replaceChunksForDocument(db, docId, chunks, syncStatus)` that wraps `deleteChunksByDocumentId` + `upsertChunks` + `updateDocumentSyncStatus` in a single `db.transaction()`.
- Updated `sync-manager.ts` to use the new transactional function instead of separate operations.
- Added test verifying atomic replacement.

### 1f. Migration atomicity — DONE

- **File:** `src/main/db/migrations.ts`
- Changed from one big transaction wrapping all migrations to per-migration transactions. A failure in migration N no longer rolls back successfully applied migration N-1.
- Added per-migration console logging.

## Phase 2: API Timeouts & Network Resilience — COMPLETE

All 3 sub-tasks completed. 135 tests passing, TypeScript clean.

### 2a. Add timeouts to all external fetch calls — DONE

- **Files:** `src/main/search/embedder.ts`, `src/main/search/reranker.ts`, `src/main/ipc/handlers.ts`
- Cohere embed: `AbortSignal.timeout(30_000)`
- Ollama embed: `AbortSignal.timeout(120_000)`
- Cohere rerank: `AbortSignal.timeout(15_000)`
- Validate-cohere and check-ollama handlers: `AbortSignal.timeout(10_000)`

### 2b. Retry logic for Cohere embedder — DONE

- **File:** `src/main/search/embedder.ts`
- Added `fetchWithRetry()` helper with configurable timeout, max retries, and exponential backoff.
- Retries on 429 (rate limit) and 5xx (server error) — 3 retries with 1s/2s/4s backoff.
- Non-retryable errors (401, 403, etc.) fail immediately.

### 2c. Validate reranker response shape — DONE

- **File:** `src/main/search/reranker.ts`
- Added guard: throws if `data.results` is missing or not an array.
- Filters out results with out-of-bounds `r.index` before accessing `candidates[r.index]`.
- Added tests for missing results, non-array results, and out-of-bounds index filtering.

## Phase 3: Sync & Connector Robustness — COMPLETE

All 4 sub-tasks completed. 143 tests passing, TypeScript clean.

### 3a. Drive connector resilience — DONE

- **File:** `src/main/connectors/drive.ts`
- Wrapped `extractContent()` in try/catch inside both `walkFolder` and `walkSharedWithMe` generators — logs warning and skips corrupt/inaccessible files instead of aborting the entire sync.
- Added `MAX_DEPTH = 20` and depth parameter to `walkFolder`; tracks visited folder IDs via `Set<string>` to detect cycles.
- Cached `pdf-parse` and `mammoth` dynamic imports in module-level variables to avoid per-file import overhead.
- Added tests: corrupt file skipping, depth limit, cycle detection.

### 3b. Notion connector resilience — DONE

- **File:** `src/main/connectors/notion.ts`
- Replaced bare `catch {}` in `walkDatabase` with typed error check: skips on 403/404 permission errors (logs warning), rethrows on network/server errors (429, 5xx).
- Added `MAX_BLOCK_DEPTH = 20` and depth parameter to `fetchAllBlocks` to prevent unbounded recursion on deeply nested block trees.
- Added tests: 403 skip behavior, non-permission error rethrow.

### 3c. Sync progress improvements — DONE

- **Files:** `src/shared/types.ts`, `src/main/sync/sync-manager.ts`
- Added `'done' | 'error'` to `SyncProgress.phase` union type.
- Emits final progress with `phase: 'done'` (or `'error'` if any docs failed) and `total: current` after loop completes.
- Optimized errors array copying: only creates a new snapshot when `errors.length` changes, avoiding O(D\*E) allocations.
- Added tests: done phase emission, error phase emission.

### 3d. Embedding model mismatch detection — DONE

- **File:** `src/main/sync/sync-manager.ts`
- After content hash match, checks if existing chunks' `embeddingModel` matches current `getEmbeddingModelName(embedConfig)`.
- If model changed, re-embeds the document even if content is unchanged.
- Added test: model change triggers re-embedding with new model name.

## Phase 4: Security — OAuth & Secrets — COMPLETE

All 5 sub-tasks completed. 143 tests passing, TypeScript clean.

### 4a. Bind OAuth servers to localhost only — DONE

- **Files:** `src/main/auth/google-oauth.ts`, `src/main/auth/notion-oauth.ts`
- Changed `server.listen(REDIRECT_PORT)` to `server.listen(REDIRECT_PORT, "127.0.0.1")` in both OAuth flows, preventing the HTTP callback server from binding to all interfaces.

### 4b. Token refresh cleanup — DONE

- **File:** `src/main/auth/google-oauth.ts`
- Wrapped `client.refreshAccessToken()` in try/catch. On failure, deletes stored `google_tokens` secret and throws user-friendly "re-authenticate in Settings" error instead of leaking raw API errors.

### 4c. Encrypted storage resilience — DONE

- **File:** `src/main/auth/storage.ts`
- Wrapped `safeStorage.decryptString()` in try/catch. On decryption failure (corrupt data, OS keychain change), logs warning, deletes the corrupt entry, and returns `null` instead of crashing.

### 4d. OAuth timeout race — DONE

- **Files:** `src/main/auth/google-oauth.ts`, `src/main/auth/notion-oauth.ts`
- Replaced server-reference comparison (`activeServer === server`) with unique `flowId` per OAuth flow.
- Added `settled` flag and `safeResolve`/`safeReject` wrappers to prevent double-settlement when timeout fires after callback completes (or vice versa).

### 4e. Add PKCE to OAuth flows — DONE

- **Files:** `src/main/auth/google-oauth.ts`, `src/main/auth/notion-oauth.ts`
- Generate `code_verifier` (32 random bytes, base64url) and `code_challenge` (SHA-256 hash, base64url) per flow.
- Google: appends `code_challenge` and `code_challenge_method=S256` to auth URL; passes `codeVerifier` in `client.getToken()`.
- Notion: includes PKCE params in auth URL; sends `code_verifier` in token exchange POST body.

## Phase 5: Search Performance — COMPLETE

All 2 sub-tasks completed (5c deferred per plan). 143 tests passing, TypeScript clean.

### 5a. Eliminate unnecessary Map allocation — DONE

- **File:** `src/main/search/searcher.ts`
- Removed `chunkMap` that built a `Map` from ALL chunks (potentially 10k+). Now carries chunk objects through `topResults` directly — the `scored` array already has chunk references, so stripping them to `chunkId` and re-looking them up was wasteful.
- For rerank path, builds a small `scoredById` Map from only the top-40 cosine results (not all chunks).

### 5b. Batch document lookups (N+1 fix) — DONE

- **Files:** `src/main/search/searcher.ts`, `src/main/db/database.ts`
- Added `getDocumentsByIds(db, ids)` using `WHERE id IN (...)` — single query instead of N individual lookups.
- Collects unique `documentId` values from top results, batch-fetches into a `Map<string, DocumentRow>`.
- Replaces per-result `getDocumentById` loop (was up to 8 individual queries, now always 1).

### 5c. Worker thread for search — DEFERRED

- Per plan guidance: "If time-constrained, defer this — 5a and 5b provide immediate improvement."
- 5a+5b eliminate the two biggest allocations and the N+1 query pattern. Worker thread is a stretch goal for later.

## Phase 6: Database Schema & Query Fixes — COMPLETE

All 5 sub-tasks completed. 148 tests passing, TypeScript clean.

### 6a. Add missing index — DONE

- **File:** `src/main/db/migrations.ts`
- Added migration v4: `CREATE INDEX idx_chunks_embedding_model ON chunks(embedding_model) WHERE embedding IS NOT NULL`
- Speeds up `getChunksWithEmbeddingsByModel` used in every search query.

### 6b. Fix N+1 in sources:list — DONE

- **Files:** `src/main/db/database.ts`, `src/main/ipc/handlers.ts`
- Added `getAllSourcesWithCounts(db)` using `LEFT JOIN documents GROUP BY sources.id` — returns sources with document counts in a single query.
- Replaced loop of `getDocumentCountBySourceId` calls (was N+1 queries, now always 1).

### 6c. Fix INSERT OR REPLACE cascade — DONE

- **File:** `src/main/db/database.ts`
- Changed `insertDocument` from `INSERT OR REPLACE` to `INSERT ... ON CONFLICT(id) DO UPDATE SET ...`
- `INSERT OR REPLACE` was deleting + re-inserting rows, which triggered `ON DELETE CASCADE` and wiped chunks on document metadata updates.
- Added test verifying document update preserves existing chunks.

### 6d. Extract raw SQL to database module — DONE

- **Files:** `src/main/db/database.ts`, `src/main/ipc/handlers.ts`
- Added `getSourceByProviderAndRoot(db, provider, rootExternalId)` to `database.ts`.
- Replaced inline SQL query in `sources:add` handler.

### 6e. Remove dead code — DONE

- **File:** `src/main/db/database.ts`
- Deleted `getChunksWithEmbeddings()` — only `getChunksWithEmbeddingsByModel` is called anywhere.

## Phase 7: React Correctness & Renderer Fixes — COMPLETE

All 5 sub-tasks completed. 148 tests passing, TypeScript clean.

### 7a. Add ErrorBoundary — DONE

- **File:** `src/renderer/src/components/ui/ErrorBoundary.tsx` (new)
- Created class component `ErrorBoundary` with `getDerivedStateFromError` + `componentDidCatch`.
- Default fallback shows error message and "Try again" button that resets state.
- Wrapped main content area in `App.tsx` with `<ErrorBoundary>`.

### 7b. Fix theme management conflict — DONE

- **File:** `src/renderer/src/main.tsx`
- Removed `matchMedia` listener and initial `classList.toggle` that fought with `App.tsx` theme state.
- `App.tsx` is now the single source of truth for dark mode (via `getInitialDark()` + `useEffect` on `dark` state).

### 7c. Lazy page rendering — DONE

- **Files:** `src/renderer/src/App.tsx`, all three page components
- Added `visible` prop to `SearchPage`, `SourcesPage`, `SettingsPage`.
- Pages only mount when first visited (tracked via `visited` Set in App); IPC calls deferred until `visible=true`.
- Prevents mount-time IPC calls for pages the user hasn't navigated to yet.

### 7d. Stabilize callback identities — DONE

- **File:** `src/renderer/src/App.tsx`
- Wrapped `checkReady`, `handleToggleTheme`, `handleProviderReset`, `handlePageChange` in `useCallback`.
- **File:** `src/renderer/src/pages/SearchPage.tsx`
- Used ref for `query` (updated via `useEffect`) to remove it from `handleSearch` deps, giving it a stable identity.

### 7e. Fix React anti-patterns — DONE

- **`SourceList.tsx`:** Used `onRefreshRef` to decouple `onRefresh` from effect deps; changed `loadingDocs` from `boolean` to `Set<string>` (`loadingDocIds`) for per-source loading state.
- **`NotionPicker.tsx` + `DrivePicker.tsx`:** Moved `fetchPage`/`fetchFolder` calls outside `setBreadcrumbs` state updater (side effects in updaters are anti-pattern).
- **`SyncPanel.tsx`:** Reset `startedRef.current = false` in effect cleanup so re-mount triggers sync.
- **`SearchPage.tsx`:** Changed array-index key to content-based key (`documentTitle-score-index`) for `ResultCard`.
- **`ResultCard.tsx`:** Wrapped in `React.memo` to avoid re-renders when parent state changes.

## Phase 8: Packaging, Dependencies & Build — COMPLETE

All 4 sub-tasks completed. 148 tests passing, TypeScript clean. Build produces vendor-split chunks.

### 8a. Replace googleapis monolith — DONE

- **Files:** `src/main/connectors/drive.ts`, `src/main/auth/google-oauth.ts`, `src/main/connectors/__tests__/drive.test.ts`
- Removed `googleapis` (~200MB) and replaced with `@googleapis/drive` (~scoped, much smaller).
- `drive.ts`: Changed `google.drive({ version: "v3", auth })` to `new drive_v3.Drive({ auth })`.
- `google-oauth.ts`: Replaced `google.auth.OAuth2` with `googleAuth.OAuth2` from `@googleapis/drive`'s re-exported auth. Replaced `google.oauth2` userinfo call with direct `fetch` to Google's userinfo endpoint.
- Updated test mock from `vi.mock("googleapis")` to `vi.mock("@googleapis/drive")`.

### 8b. Fix Forge packaging — DONE

- **File:** `forge.config.ts`
- Added `prune: true` to `packagerConfig` — ensures devDependencies are stripped from `node_modules` during packaging.

### 8c. Dependency cleanup — DONE

- **Files:** `package.json`, `src/main/index.ts`
- Removed unused `react-day-picker` from dependencies.
- Added `rimraf` as devDependency; replaced `rm -rf` with `rimraf` in `postinstall` and `posttest` scripts for cross-platform compatibility.
- Moved `dotenv` from dependencies to devDependencies. Guarded import with `if (!app.isPackaged) await import("dotenv/config")` inside `app.whenReady()` callback — dotenv is no longer bundled in production.

### 8d. Build improvements — DONE

- **File:** `electron.vite.config.ts` — Added `manualChunks` for vendor splitting: `vendor-react` (react + react-dom) and `vendor-icons` (lucide-react) are separate chunks for better caching.
- **File:** `pnpm-workspace.yaml` — Set `blockExoticSubdeps: true` to prevent exotic (git/url) subdependencies from being installed without explicit opt-in.
- **Files:** `tsconfig.node.json`, `tsconfig.web.json` — Added `noImplicitAny: true` to both configs (base config had it disabled). No new type errors surfaced.

## Phase 9: Remaining Medium Fixes — COMPLETE

All 3 sub-tasks completed. 148 tests passing, TypeScript clean.

### 9a. Embedder & IPC robustness — DONE

- **File:** `src/main/search/embedder.ts`
  - Batched Ollama calls to 32 texts per request (was unbounded). Uses same pattern as Cohere batching.
  - Fixed shared-memory hazard in `embeddingToBuffer`/`bufferToEmbedding` — now copies data instead of creating views into the same underlying `ArrayBuffer`. Prevents subtle corruption when the source buffer is reused.
- **File:** `src/main/ipc/sync-handlers.ts`
  - Replaced TOCTOU `sender.isDestroyed()` check with try/catch around `sender.send()`. The old pattern could race between the check and the send if the WebContents was destroyed in between.
- **File:** `src/main/ipc/handlers.ts`
  - Replaced synchronous `statSync` with async `stat` from `fs/promises` in `app:storage-stats` handler. Avoids blocking the main process on filesystem I/O.

### 9b. Connector UX — DONE

- **Files:** `src/renderer/src/components/sources/ConnectNotionButton.tsx`, `ConnectDriveButton.tsx`
  - Changed sequential `for..of` + `await` `addSource` loops to `Promise.all` — all selected sources are added concurrently instead of one at a time.
- **Files:** `src/main/search/searcher.ts`, `src/main/ipc/handlers.ts`, `src/main/search/__tests__/searcher.test.ts`
  - Removed redundant `cohereApiKey` parameter from `search()`. Now reads the API key from `embedConfig.apiKey` (where it was already being set). Eliminates passing the same value through two separate channels.

### 9c. Drag throttling — DONE

- **File:** `src/renderer/src/App.tsx`
  - Throttled `window:dragging` IPC in the DragRegion component using `requestAnimationFrame`. Previously fired on every `pointermove` event (potentially hundreds per second), now coalesces to at most one IPC call per frame (~60/sec). Cleans up pending rAF on pointer up.

## Phase 10: Low-Priority Cleanup — COMPLETE

All 8 items completed. 148 tests passing, TypeScript clean.

### Remove `backgroundThrottling: false` — DONE

- **File:** `src/main/index.ts`
- Removed `backgroundThrottling: false` from BrowserWindow `webPreferences`. This option disables Chromium's background throttling, wasting CPU when the app is not focused.

### Delete unused `card.tsx` — DONE

- **File:** `src/renderer/src/components/ui/card.tsx` (deleted)
- Confirmed no imports anywhere in the codebase. Removed the file entirely.

### Delete dead Notion code — DONE

- **File:** `src/shared/types.ts` — Removed `NotionPageSummary` interface (no callers).
- **File:** `src/main/connectors/notion.ts` — Removed `listAccessiblePages()` function (no callers). Cleaned up unused `NotionPageSummary` import.

### Remove duplicate drag div from `index.html` — DONE

- **File:** `src/renderer/index.html`
- Removed the CSS-based `-webkit-app-region: drag` div. The React `DragRegion` component (with rAF throttling from Phase 9c) handles all window dragging.

### Deduplicate `walkSharedWithMe`/`walkFolder` in `drive.ts` — DONE

- **File:** `src/main/connectors/drive.ts`
- Extracted shared file-processing logic (folder recursion, size check, extractContent with try/catch, yield RawDocument) into `processFiles()` private method. Both `walkSharedWithMe` and `walkFolder` now delegate to it.

### Deduplicate `useEffect`/`checkOllama` in `OllamaOption.tsx` — DONE

- **File:** `src/renderer/src/components/setup/OllamaOption.tsx`
- Unified the mount-time useEffect and the manual retry `checkOllama` into a single `useCallback`. The useEffect calls `checkOllama()` on mount; the Retry button calls the same function.

### Consolidate `SourcesPage.tsx` data-fetch paths — DONE

- **File:** `src/renderer/src/pages/SourcesPage.tsx`
- The useEffect and `loadSources` callback were two separate code paths that both called `listSources()`. Consolidated so the useEffect calls `loadSources` directly, eliminating the duplicated fetch/error/loading logic.

### Use `WeakMap` for per-window drag offset — DONE

- **File:** `src/main/index.ts`
- Replaced single `dragOffset` variable with `WeakMap<BrowserWindow, offset>`. Each window now tracks its own drag offset independently, fixing incorrect drag behavior when multiple windows exist. The WeakMap also lets offsets be garbage-collected when windows close.

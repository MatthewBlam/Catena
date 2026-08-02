/**
 * How a source's last sync ended.
 *
 * `partial` means the sync ran to completion but some documents failed;
 * `error` means the sync itself did not run (an expired token, a missing
 * connector) or died outright. The distinction matters to the user: `partial`
 * leaves a usable index behind, `error` does not.
 */
export type SyncOutcome = "ok" | "partial" | "error" | "cancelled";

export interface Source {
  id: string;
  provider: "notion" | "google_drive";
  name: string;
  rootExternalId: string;
  createdAt: string;
  lastSyncAt: string | null;
  lastSyncStatus: SyncOutcome | null;
  lastSyncError: string | null;
  lastSyncErrorCount: number;
}

export interface Document {
  id: string;
  sourceId: string;
  provider: "notion" | "google_drive";
  externalId: string;
  title: string;
  url: string | null;
  mimeType: string | null;
  modifiedAt: string | null;
  contentHash: string | null;
  lastSyncedAt: string | null;
  syncStatus: "pending" | "synced" | "error";
}

export interface Chunk {
  id: string;
  documentId: string;
  chunkIndex: number;
  heading: string | null;
  text: string;
  embedding: Uint8Array | null;
  embeddingModel: string | null;
  tokenCount: number | null;
  createdAt: string;
}

export interface SearchResult {
  chunkId: string;
  documentTitle: string;
  snippet: string;
  heading: string | null;
  url: string | null;
  provider: "notion" | "google_drive";
  score: number;
}

export interface SearchResponse {
  results: SearchResult[];
  rerankFailed: boolean;
  rewrittenQuery?: string;
  /**
   * Set when the vector scan hit its bound before reaching the end of the
   * corpus, so these results were chosen from `scanned` of `total` chunks.
   * Silent truncation is the bug; the renderer must say so.
   */
  truncated?: { scanned: number; total: number };
  /**
   * The query was cancelled or superseded; the renderer must drop this response
   * rather than render it or show an error. A flag rather than a rejection
   * because an Error's `name` does not survive IPC serialization, so the renderer
   * could not otherwise tell an abort from a real failure.
   */
  cancelled?: boolean;
}

/**
 * A span of the generated answer text that a source supports. `chunkId` points
 * at the `SearchResult` (in the same search) the model cited, which the renderer
 * turns into a numbered marker linking back to that result card. Only Cohere
 * produces these; Ollama answers carry an empty citation list (the result list
 * below the answer is its citation surface).
 */
export interface AnswerCitation {
  /** Character offset into the answer text where the cited span starts (inclusive). */
  start: number;
  /** Character offset where the cited span ends (exclusive). */
  end: number;
  chunkId: string;
}

/** A generated answer as persisted with a recent search and rendered in the UI. */
export interface StoredAnswer {
  text: string;
  citations: AnswerCitation[];
}

/**
 * The result of an answer-generation request. Like `SearchResponse`, an abort
 * resolves rather than rejects (`cancelled: true`) because an Error's `name`
 * does not survive IPC, so the renderer could not otherwise tell a user-initiated
 * stop from a real failure. `error`/`errorKind` are set only on a genuine
 * failure; `no_model` means Ollama has no chat model installed and drives a
 * degraded "install a chat model" hint rather than an error banner.
 */
export interface AnswerResponse {
  text: string;
  citations: AnswerCitation[];
  cancelled?: boolean;
  error?: string;
  errorKind?: "no_model" | "failed";
}

/** What the renderer hands the main process to ground an answer on. */
export interface AnswerRequest {
  /** The original user query (not the rewritten one) — the question the answer addresses. */
  query: string;
  /** Monotonic per-renderer token so streamed deltas from a superseded request can be dropped. */
  requestId: number;
  /** The current results, in display order. Titles come from here; text is re-fetched by id in main. */
  docs: { chunkId: string; documentTitle: string }[];
}

/** A streamed chunk of answer text, tagged with the request it belongs to. */
export interface AnswerDelta {
  requestId: number;
  delta: string;
}

export interface RecentSearch {
  id: string;
  query: string;
  resultCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RecentSearchDetail extends RecentSearch {
  results: SearchResult[];
  rewrittenQuery?: string;
  /** A previously generated answer, if one was saved for this search. */
  answer?: StoredAnswer;
}

export interface SyncProgress {
  sourceId: string;
  /**
   * ISO timestamp of when this sync was registered in main — the same value for
   * every event of one sync, and for the pre-first-event snapshot
   * `getActiveSyncProgress` synthesizes. It lets a panel that mounts mid-sync
   * (a Sources tab opened onto an already-running scheduler sync) show elapsed
   * time from the true start rather than from when the panel happened to mount.
   */
  startedAt: string;
  phase:
    | "fetching"
    | "chunking"
    | "embedding"
    | "storing"
    | "reconciling"
    | "done"
    | "error";
  current: number;
  skipped: number;
  total: number;
  /** Documents removed because the provider no longer has them. */
  deleted: number;
  currentDocTitle: string | null;
  errors: string[];
}

export interface SchedulerState {
  enabled: boolean;
  intervalMs: number;
  lastSyncedAt: string | null;
  syncing: boolean;
}

/** What a renderer that mounted mid-sync needs in order to catch up. */
export interface ActiveSyncs {
  active: SyncProgress[];
  scheduler: SchedulerState;
}

export interface EmbeddingHealth {
  provider: "cohere" | "ollama";
  model: string;
  mismatchedChunks: number;
  totalChunks: number;
}

export interface StorageStats {
  sourceCount: number;
  documentCount: number;
  chunkCount: number;
  dbSizeBytes: number;
}

export type SourceWithCount = Source & { documentCount: number };

export type SourceConfig =
  | { provider: "notion"; rootPageId: string; name: string }
  | { provider: "google_drive"; folderId: string; folderName: string };

export interface DriveItemSummary {
  id: string;
  name: string;
  isFolder: boolean;
}

export interface NotionItemSummary {
  id: string;
  title: string;
  icon: string | null;
  isDatabase?: boolean;
}

/**
 * Streamed progress of the managed-Ollama bootstrap (engine download/extract/
 * start, then model pull) and the optional chat-model pull. Mirrors
 * `SyncProgress`: one shape, broadcast on `ollama:progress`, with a `phase`
 * union and optional byte/percent fields the UI turns into a progress bar.
 *
 * `percent` is 0..100 for the current `phase` when it is knowable (a download
 * with a Content-Length, or a pull layer with a `total`); it is omitted for
 * indeterminate phases like `checking`/`extracting`/`starting-engine`.
 */
export interface OllamaProgress {
  phase:
    | "checking"
    | "downloading-engine"
    | "extracting"
    | "starting-engine"
    | "pulling-model"
    | "ready"
    | "error";
  /** Which model a `pulling-model` phase is fetching, e.g. "nomic-embed-text". */
  model?: string;
  /** Bytes fetched so far in the current download/pull, when known. */
  bytesCompleted?: number;
  /** Total bytes for the current download/pull, when known. */
  bytesTotal?: number;
  /** 0..100 for the current phase when determinate; omitted otherwise. */
  percent?: number;
  /** A short human-readable status line, e.g. Ollama's own pull status text. */
  message?: string;
  /** Set only on `phase: "error"` — the failure to show the user. */
  error?: string;
}

/** Detailed Ollama readiness for the setup UI, from `ollama:status`. */
export interface OllamaStatusDetail {
  /** The engine is answering on 127.0.0.1:11434 right now. */
  engineUp: boolean;
  /** All local model names (`/api/tags`), empty when the engine is down. */
  models: string[];
  /** The subset of `models` that are embedding models. */
  embeddingModels: string[];
  /** A usable embedding model is installed — search will work. */
  embeddingReady: boolean;
  /** A usable chat model is installed — grounded answers will work. */
  chatReady: boolean;
  /** A managed setup run is in flight (single-flight guard). */
  setupInProgress: boolean;
  /** A Commons-managed engine binary is present on disk (independent of whether
   * it's running) — i.e. there is something for "Uninstall Ollama" to remove. */
  managedBinaryPresent: boolean;
}

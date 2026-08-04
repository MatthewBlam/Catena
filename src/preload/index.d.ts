export {};

interface CatenaAPI {
  saveSecret(key: string, value: string): Promise<void>;
  /** No `loadSecret` counterpart, by design — see the preload. Use `hasSecret`. */
  validateCohereKey(key: string): Promise<{ valid: boolean }>;
  checkOllama(): Promise<{ available: boolean; models: string[] }>;
  getEmbeddingProvider(): Promise<string>;
  setEmbeddingProvider(provider: string): Promise<void>;
  /** Detailed Ollama readiness for the setup UI (engine + installed models). */
  getOllamaStatusDetail(): Promise<
    import("../shared/types").OllamaStatusDetail
  >;
  /**
   * Runs the managed local-provider bootstrap: ensure the engine (download +
   * extract + serve if needed), pull the embedding model, persist the provider.
   * Progress arrives via `onOllamaProgress`; resolves when `phase: "ready"` is
   * reached, rejects on failure/cancel.
   */
  ollamaSetup(): Promise<void>;
  /** Cancels an in-flight `ollamaSetup`/`pullOllamaChatModel`. */
  cancelOllamaSetup(): Promise<void>;
  /** Downloads the chat model grounded answers need (optional, on-demand). */
  pullOllamaChatModel(): Promise<void>;
  setOllamaModel(model: string): Promise<void>;
  setOllamaChatModel(model: string): Promise<void>;
  /**
   * Completely removes the Catena-managed Ollama: stops our engine, deletes the
   * pulled models + downloaded binary, and clears the Ollama model settings. A
   * user's own system/manual Ollama is never killed or removed.
   */
  uninstallOllama(): Promise<void>;
  /** Streams managed-Ollama setup/pull progress to any interested window. */
  onOllamaProgress(
    callback: (progress: import("../shared/types").OllamaProgress) => void,
  ): () => void;
  openExternal(url: string): Promise<void>;
  search(query: string): Promise<import("../shared/types").SearchResponse>;
  /**
   * Abandons this window's in-flight search. Issuing a new query already
   * supersedes the old one, so this is for leaving the search behind entirely.
   */
  cancelSearch(): Promise<void>;
  /**
   * Generates a grounded answer for a completed search. Resolves with the final
   * text + citations; live tokens arrive via `onAnswerDelta`. Resolves (never
   * rejects) with `cancelled: true` on abort, matching `search`.
   */
  generateAnswer(
    request: import("../shared/types").AnswerRequest,
  ): Promise<import("../shared/types").AnswerResponse>;
  /**
   * Stops this window's in-flight answer generation. Pass `"user_stop"` when the
   * user pressed Stop; the default (`"superseded"`) is for the app abandoning its
   * own work, and is not counted as an abandonment.
   */
  cancelAnswer(
    reason?: import("../shared/types").AnswerCancelReason,
  ): Promise<void>;
  /** Reports that a citation marker was clicked, by its 1-based rank. */
  reportCitationOpened(position: number): Promise<void>;
  /** Streams answer tokens; each delta carries the request id it belongs to. */
  onAnswerDelta(
    callback: (delta: import("../shared/types").AnswerDelta) => void,
  ): () => void;
  /**
   * Runs the Notion OAuth flow. Also the way to *widen* an existing connection:
   * Notion's page picker pre-checks what is already shared, so re-running this
   * adds pages rather than replacing them.
   *
   * Resolves with `workspaceSwitch` set when the flow authorized a different
   * workspace than existing sources belong to; the new token is withheld until
   * `resolveNotionWorkspaceSwitch` settles it.
   */
  startNotionOAuth(): Promise<import("../shared/types").NotionOAuthStarted>;
  cancelNotionOAuth(): Promise<void>;
  /**
   * Commits (`true`) or discards (`false`) a token withheld by a workspace
   * switch. Idempotent — the pending token is dropped either way.
   */
  resolveNotionWorkspaceSwitch(accept: boolean): Promise<void>;
  /**
   * Notion sources whose root page the stored token can no longer read — the
   * casualties of an OAuth re-selection that dropped a previously-granted page.
   * Empty when disconnected or when nothing is stranded.
   */
  checkNotionSourceAccess(): Promise<
    import("../shared/types").OrphanedNotionSource[]
  >;
  listNotionPages(): Promise<import("../shared/types").NotionItemSummary[]>;
  /**
   * Runs the Google OAuth flow. Also the way to reconnect an existing Drive
   * connection — non-destructive, since `drive.readonly` covers the whole
   * account. Resolves with `accountChanged` set only when a *different* Google
   * account was authorized while Drive sources exist.
   */
  startGoogleOAuth(): Promise<import("../shared/types").GoogleOAuthStarted>;
  cancelGoogleOAuth(): Promise<void>;
  listDriveItems(
    parentId?: string,
  ): Promise<import("../shared/types").DriveItemSummary[]>;
  listDocumentsBySource(
    sourceId: string,
  ): Promise<import("../shared/types").Document[]>;
  listSources(): Promise<
    (import("../shared/types").Source & { documentCount: number })[]
  >;
  addSource(
    config: import("../shared/types").SourceConfig,
  ): Promise<import("../shared/types").Source>;
  removeSource(id: string): Promise<void>;
  syncSource(sourceId: string): Promise<void>;
  onSyncProgress(
    callback: (progress: import("../shared/types").SyncProgress) => void,
  ): () => void;
  cancelSync(sourceId: string): Promise<void>;
  /** What is running right now — for a renderer that mounted mid-sync. */
  getActiveSyncs(): Promise<import("../shared/types").ActiveSyncs>;
  /** Fires when `sources:list` has gone stale. Refetch; do not infer. */
  onSourcesChanged(callback: () => void): () => void;
  getStorageStats(): Promise<import("../shared/types").StorageStats>;
  clearAllData(): Promise<void>;
  checkEmbeddingHealth(): Promise<import("../shared/types").EmbeddingHealth>;
  deleteSecret(key: string): Promise<void>;
  hasSecret(key: string): Promise<boolean>;
  getAutoSync(): Promise<import("../shared/types").SchedulerState>;
  setAutoSyncEnabled(enabled: boolean): Promise<void>;
  setAutoSyncInterval(ms: number): Promise<void>;
  getTelemetryEnabled(): Promise<boolean>;
  setTelemetryEnabled(enabled: boolean): Promise<void>;
  /** Whether the user has finished the onboarding wizard at least once. */
  getOnboardingComplete(): Promise<boolean>;
  /** Marks onboarding finished. Write-once; there is no un-complete. */
  setOnboardingComplete(): Promise<void>;
  listRecentSearches(): Promise<import("../shared/types").RecentSearch[]>;
  /**
   * Get a recent search by ID. Returns null if the result has expired or been
   * deleted; treat this as if the search is gone, not an error.
   */
  getRecentSearch(
    id: string,
  ): Promise<import("../shared/types").RecentSearchDetail | null>;
  deleteRecentSearch(id: string): Promise<void>;
  /** Fires when `recents:list` has gone stale. Refetch; do not infer. */
  onRecentsChanged(callback: () => void): () => void;
}

interface ElectronDrag {
  startDrag(): void;
  dragging(): void;
  stopDrag(): void;
}

declare global {
  interface Window {
    api: CatenaAPI;
    electronDrag: ElectronDrag;
  }
}

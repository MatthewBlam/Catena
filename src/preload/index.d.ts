export {};

interface CommonsAPI {
  saveSecret(key: string, value: string): Promise<void>;
  /** No `loadSecret` counterpart, by design — see the preload. Use `hasSecret`. */
  validateCohereKey(key: string): Promise<{ valid: boolean }>;
  checkOllama(): Promise<{ available: boolean; models: string[] }>;
  getEmbeddingProvider(): Promise<string>;
  setEmbeddingProvider(provider: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  search(query: string): Promise<import("../shared/types").SearchResponse>;
  /**
   * Abandons this window's in-flight search. Issuing a new query already
   * supersedes the old one, so this is for leaving the search behind entirely.
   */
  cancelSearch(): Promise<void>;
  startNotionOAuth(): Promise<{ workspaceName: string }>;
  cancelNotionOAuth(): Promise<void>;
  listNotionPages(): Promise<import("../shared/types").NotionItemSummary[]>;
  startGoogleOAuth(): Promise<{ email: string }>;
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
  /**
   * Fires when the recents list has gone stale. Refetch; do not infer.
   */
  onRecentsChanged(callback: () => void): () => void;
}

interface ElectronDrag {
  startDrag(): void;
  dragging(): void;
  stopDrag(): void;
}

declare global {
  interface Window {
    api: CommonsAPI;
    electronDrag: ElectronDrag;
  }
}

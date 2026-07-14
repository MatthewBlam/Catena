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
  search: (query: string): Promise<import("../shared/types").SearchResponse> =>
    ipcRenderer.invoke("search:query", query),
  startNotionOAuth: (): Promise<{ workspaceName: string }> =>
    ipcRenderer.invoke("auth:notion-oauth-start"),
  cancelNotionOAuth: (): Promise<void> =>
    ipcRenderer.invoke("auth:notion-oauth-cancel"),
  listNotionPages: (): Promise<import("../shared/types").NotionItemSummary[]> =>
    ipcRenderer.invoke("notion:list-pages"),
  startGoogleOAuth: (): Promise<{ email: string }> =>
    ipcRenderer.invoke("auth:google-oauth-start"),
  cancelGoogleOAuth: (): Promise<void> =>
    ipcRenderer.invoke("auth:google-oauth-cancel"),
  listDriveItems: (
    parentId?: string,
  ): Promise<import("../shared/types").DriveItemSummary[]> =>
    ipcRenderer.invoke("drive:list-items", parentId),
  listDocumentsBySource: (
    sourceId: string,
  ): Promise<import("../shared/types").Document[]> =>
    ipcRenderer.invoke("documents:list-by-source", sourceId),
  listSources: (): Promise<
    (import("../shared/types").Source & { documentCount: number })[]
  > => ipcRenderer.invoke("sources:list"),
  addSource: (
    config: import("../shared/types").SourceConfig,
  ): Promise<import("../shared/types").Source> =>
    ipcRenderer.invoke("sources:add", config),
  removeSource: (id: string): Promise<void> =>
    ipcRenderer.invoke("sources:remove", id),
  syncSource: (sourceId: string): Promise<void> =>
    ipcRenderer.invoke("sync:start", sourceId),
  onSyncProgress: (
    callback: (progress: import("../shared/types").SyncProgress) => void,
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      progress: import("../shared/types").SyncProgress,
    ): void => {
      callback(progress);
    };
    ipcRenderer.on("sync:progress", handler);
    return () => {
      ipcRenderer.removeListener("sync:progress", handler);
    };
  },
  cancelSync: (sourceId: string): Promise<void> =>
    ipcRenderer.invoke("sync:cancel", sourceId),
  getActiveSyncs: (): Promise<import("../shared/types").ActiveSyncs> =>
    ipcRenderer.invoke("sync:get-active"),
  onSourcesChanged: (callback: () => void): (() => void) => {
    const handler = (): void => {
      callback();
    };
    ipcRenderer.on("sources:changed", handler);
    return () => {
      ipcRenderer.removeListener("sources:changed", handler);
    };
  },
  getStorageStats: (): Promise<import("../shared/types").StorageStats> =>
    ipcRenderer.invoke("app:storage-stats"),
  clearAllData: (): Promise<void> => ipcRenderer.invoke("app:clear-all-data"),
  checkEmbeddingHealth: (): Promise<
    import("../shared/types").EmbeddingHealth
  > => ipcRenderer.invoke("embedding:health"),
  deleteSecret: (key: string): Promise<void> =>
    ipcRenderer.invoke("secrets:delete", key),
  hasSecret: (key: string): Promise<boolean> =>
    ipcRenderer.invoke("secrets:has", key),
  getAutoSync: (): Promise<import("../shared/types").SchedulerState> =>
    ipcRenderer.invoke("settings:get-auto-sync"),
  setAutoSyncEnabled: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("settings:set-auto-sync-enabled", enabled),
  setAutoSyncInterval: (ms: number): Promise<void> =>
    ipcRenderer.invoke("settings:set-auto-sync-interval", ms),
  getTelemetryEnabled: (): Promise<boolean> =>
    ipcRenderer.invoke("settings:get-telemetry-enabled"),
  setTelemetryEnabled: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("settings:set-telemetry-enabled", enabled),
};

contextBridge.exposeInMainWorld("api", api);

contextBridge.exposeInMainWorld("electronDrag", {
  startDrag: (): void => ipcRenderer.send("window:start-drag"),
  dragging: (): void => ipcRenderer.send("window:dragging"),
  stopDrag: (): void => ipcRenderer.send("window:stop-drag"),
});

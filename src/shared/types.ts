export interface Source {
  id: string;
  provider: "notion" | "google_drive";
  name: string;
  rootExternalId: string;
  createdAt: string;
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
}

export interface SyncProgress {
  sourceId: string;
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

import type Database from "better-sqlite3";
import type { SearchResult, SearchResponse } from "../../shared/types";
import type { EmbedConfig } from "./embedder";
import type { ChunkRow } from "../db/database";
import {
  embedQuery,
  bufferToEmbedding,
  getEmbeddingModelName,
} from "./embedder";
import {
  getChunksWithEmbeddingsByModel,
  getDocumentsByIds,
  searchFts,
} from "../db/database";
import { rerank } from "./reranker";
import { rewriteQuery } from "./query-rewriter";

const COSINE_TOP_K = 40;
const FTS_TOP_K = 40;
const RRF_K = 60;
const RERANK_CANDIDATES = 40;
const RESULT_LIMIT = 8;

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(
      `Embedding dimension mismatch: query has ${a.length}, chunk has ${b.length}`,
    );
  }
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

function rrfMerge(
  vectorRanked: { chunk: ChunkRow; score: number }[],
  ftsRanked: ChunkRow[],
  limit: number,
): { chunk: ChunkRow; score: number }[] {
  const scores = new Map<string, number>();
  const chunkMap = new Map<string, ChunkRow>();

  for (let i = 0; i < vectorRanked.length; i++) {
    const { chunk } = vectorRanked[i];
    scores.set(chunk.id, (scores.get(chunk.id) ?? 0) + 1 / (RRF_K + i + 1));
    chunkMap.set(chunk.id, chunk);
  }

  for (let i = 0; i < ftsRanked.length; i++) {
    const chunk = ftsRanked[i];
    scores.set(chunk.id, (scores.get(chunk.id) ?? 0) + 1 / (RRF_K + i + 1));
    if (!chunkMap.has(chunk.id)) {
      chunkMap.set(chunk.id, chunk);
    }
  }

  return [...scores.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([id, score]) => ({ chunk: chunkMap.get(id)!, score }));
}

export async function search(
  db: Database.Database,
  query: string,
  embedConfig: EmbedConfig,
): Promise<SearchResponse> {
  const embeddingPromise = embedQuery(query, embedConfig);
  const rewritePromise = rewriteQuery(query, embedConfig);

  const rewritten = await rewritePromise;
  if (rewritten !== query) {
    console.log(`Query rewrite: "${query}" → "${rewritten}"`);
  }

  const ftsResults = searchFts(db, rewritten, FTS_TOP_K);
  const queryEmbedding = await embeddingPromise;

  const model = getEmbeddingModelName(embedConfig);
  const chunks = getChunksWithEmbeddingsByModel(db, model);

  if (chunks.length === 0 && ftsResults.length === 0) {
    return { results: [], rerankFailed: false };
  }

  if (chunks.length >= 5000) {
    console.warn(
      `Search loading ${chunks.length} chunks into memory — consider limiting corpus size`,
    );
  }

  const vectorScored = chunks
    .map((chunk) => ({
      chunk,
      score: cosineSimilarity(
        queryEmbedding,
        bufferToEmbedding(chunk.embedding!),
      ),
    }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((a, b) => b.score - a.score)
    .slice(0, COSINE_TOP_K);

  const merged =
    ftsResults.length > 0
      ? rrfMerge(vectorScored, ftsResults, RERANK_CANDIDATES)
      : vectorScored.slice(0, RERANK_CANDIDATES);

  let topResults: { chunk: ChunkRow; score: number }[];
  let rerankFailed = false;

  if (embedConfig.apiKey) {
    try {
      const candidates = merged.map((m) => ({
        id: m.chunk.id,
        text: m.chunk.text,
      }));
      const scoredById = new Map(merged.map((m) => [m.chunk.id, m]));
      const reranked = await rerank(
        query,
        candidates,
        embedConfig.apiKey!,
        RESULT_LIMIT,
      );
      console.log(
        `Rerank: ${candidates.length} candidates → ${reranked.length} results (top score: ${reranked[0]?.score.toFixed(3) ?? "n/a"})`,
      );
      topResults = reranked
        .map((r) => {
          const entry = scoredById.get(r.id);
          return entry ? { chunk: entry.chunk, score: r.score } : null;
        })
        .filter((e): e is NonNullable<typeof e> => e !== null);
    } catch (err) {
      console.warn("Rerank failed:", err instanceof Error ? err.message : err);
      rerankFailed = true;
      topResults = merged.slice(0, RESULT_LIMIT);
    }
  } else {
    topResults = merged.slice(0, RESULT_LIMIT);
  }

  const docIds = [...new Set(topResults.map((r) => r.chunk.documentId))];
  const docMap = getDocumentsByIds(db, docIds);

  const results: SearchResult[] = [];
  for (const { chunk, score } of topResults) {
    const doc = docMap.get(chunk.documentId);
    if (!doc) continue;
    results.push({
      chunkId: chunk.id,
      documentTitle: doc.title,
      snippet: chunk.text,
      heading: chunk.heading,
      url: doc.url,
      provider: doc.provider as "notion" | "google_drive",
      score,
    });
  }

  return {
    results,
    rerankFailed,
    ...(rewritten !== query ? { rewrittenQuery: rewritten } : {}),
  };
}

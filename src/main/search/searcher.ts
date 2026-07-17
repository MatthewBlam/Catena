import type Database from "better-sqlite3";
import type { SearchResult, SearchResponse } from "../../shared/types";
import type { EmbedConfig } from "./embedder";
import type { ChunkRow } from "../db/database";
import {
  embedQuery,
  decodeEmbeddingInto,
  getEmbeddingModelName,
} from "./embedder";
import {
  iterateChunksWithEmbeddingsByModel,
  getChunkCountByModel,
  getChunksByIds,
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

/**
 * A backstop, not a budget. The scan is O(1) in memory now, so this exists only
 * to bound how long the main thread can be held; a corpus this large is a
 * different problem (an ANN index) than a bigger constant would solve. When we
 * hit it we *say so* — the old 10k cap truncated results in silence, which is
 * indistinguishable from "your document isn't there".
 */
const MAX_SCAN = 250_000;

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

type Scored = { chunk: ChunkRow; score: number };

/** What the scan loop keeps per candidate — just enough to rank it. */
type ScanEntry = { id: string; score: number };

/**
 * Keeps `top` sorted descending and never longer than K. Ties keep scan order,
 * matching the stable full sort this replaced.
 */
function insertTopK(top: ScanEntry[], entry: ScanEntry, k: number): void {
  if (top.length === k && entry.score <= top[top.length - 1].score) return;

  let lo = 0;
  let hi = top.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (top[mid].score >= entry.score) lo = mid + 1;
    else hi = mid;
  }
  top.splice(lo, 0, entry);
  if (top.length > k) top.pop();
}

export interface SearchOptions {
  /**
   * Rows the vector scan may read before it gives up and reports truncation.
   * Defaults to MAX_SCAN; tests override it so the truncation path can be
   * exercised without seeding a quarter of a million chunks.
   */
  maxScan?: number;
  /** Cancels the search. A superseded query holds a SQLite iterator open. */
  signal?: AbortSignal;
}

/**
 * One streaming pass, holding only the top K. The array-returning query this
 * replaced materialized *every* embedding Buffer — at 1536 dimensions that is
 * ~6 KB a chunk, so its 10k cap was already a 61 MB allocation per search, and
 * the cap was the only thing keeping that number from growing with the corpus.
 * Memory here is O(K), so the cap can go.
 *
 * This function is synchronous, and must stay that way. Two reasons, both load-bearing:
 *
 *  1. better-sqlite3 marks the *connection* busy for as long as an iterator is
 *     open, and refuses every write on it — "This database connection is busy
 *     executing a query". Staying synchronous means the iterator opens and closes
 *     within a single turn of the event loop, so it can never overlap a sync
 *     writing chunks. Yield anywhere in this loop and a background sync starts
 *     failing.
 *  2. Which is also why there is no abort check in here, tempting as it looks: a
 *     synchronous loop cannot be interrupted. `controller.abort()` is a JS call
 *     and needs the event loop we are holding, so `signal.aborted` physically
 *     cannot flip between two iterations. A check here would be a comforting no-op.
 *
 * Cancellation therefore happens at the async boundaries — the rewrite, the query
 * embed, the rerank — which is where a search spends its time anyway.
 */
function scanVectors(
  db: Database.Database,
  model: string,
  queryEmbedding: Float32Array,
  maxScan: number,
): { top: ScanEntry[]; scanned: number } {
  const top: ScanEntry[] = [];
  let scanned = 0;

  // One scratch buffer for the whole scan, sized to the query's own dimensions
  // (every chunk here is expected to share them — that's what `model` filters
  // for). decodeEmbeddingInto only writes through it and hands back the same
  // reference each call: nothing here retains that reference past the
  // cosineSimilarity call below, so reusing it across iterations is safe. Only
  // `id` and `score` — plain values, not views into anything — make it into `top`.
  const scratch = new Float32Array(queryEmbedding.length);

  // `for…of` calls .return() on the generator on *any* abrupt exit — the `break`
  // below, or a throw out of cosineSimilarity — and that is what closes the
  // underlying statement. Do not rewrite this as a manual .next() loop without
  // closing the iterator yourself: an abandoned one leaves the connection busy
  // and every subsequent write fails.
  for (const chunk of iterateChunksWithEmbeddingsByModel(db, model)) {
    scanned++;
    const score = cosineSimilarity(
      queryEmbedding,
      decodeEmbeddingInto(chunk.embedding, scratch),
    );
    if (Number.isFinite(score))
      insertTopK(top, { id: chunk.id, score }, COSINE_TOP_K);
    if (scanned >= maxScan) break;
  }

  return { top, scanned };
}

export async function search(
  db: Database.Database,
  query: string,
  embedConfig: EmbedConfig,
  options: SearchOptions = {},
): Promise<SearchResponse> {
  const { maxScan = MAX_SCAN, signal } = options;
  signal?.throwIfAborted();

  // Kicked off before the rewrite so the two run concurrently.
  const embeddingPromise = embedQuery(query, embedConfig, signal);
  // …which means there is a window where we can leave without awaiting it: the
  // checkpoint below, or a throw out of searchFts. Once the signal reaches
  // embedQuery, an abort makes that rejection a *certainty*, and an un-awaited
  // rejection in the main process is an unhandledRejection. Attaching a handler
  // now marks it handled; the `await` below is still the one that matters.
  void embeddingPromise.catch(() => {});

  const rewritten = await rewriteQuery(query, embedConfig, signal);
  // rewriteQuery swallows its own abort and hands back the original query, so
  // this checkpoint — not the rewrite — is what stops a cancelled search.
  signal?.throwIfAborted();

  const ftsResults = searchFts(db, rewritten, FTS_TOP_K);
  const queryEmbedding = await embeddingPromise;
  signal?.throwIfAborted();

  const model = getEmbeddingModelName(embedConfig);
  const { top, scanned } = scanVectors(db, model, queryEmbedding, maxScan);

  // The scan only ever touched `id` + `embedding`; survivors' full rows (text
  // for rerank/snippets, document_id for the doc join) come back here. The `IN`
  // query makes no ordering promise, so this reorders by `top` — already score
  // desc, stable for ties in scan order — rather than trusting query-result
  // order, which the id-refetch could otherwise silently scramble.
  const survivorRows = getChunksByIds(
    db,
    top.map((t) => t.id),
  );
  const survivorById = new Map(survivorRows.map((r) => [r.id, r]));
  const vectorScored: Scored[] = top.flatMap((t) => {
    const chunk = survivorById.get(t.id);
    return chunk ? [{ chunk, score: t.score }] : [];
  });

  if (vectorScored.length === 0 && ftsResults.length === 0) {
    return { results: [], rerankFailed: false };
  }

  // Only pay for the COUNT when we actually stopped short. `scanned === maxScan`
  // on a corpus of exactly maxScan chunks saw everything and is not truncated.
  let truncated: SearchResponse["truncated"];
  if (scanned >= maxScan) {
    const total = getChunkCountByModel(db, model);
    if (total > scanned) truncated = { scanned, total };
  }

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
        signal,
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
      // A cancelled search is not a degraded search. Swallowing the abort here
      // would return results for a query the user has already replaced, flagged
      // "reranking unavailable" — a warning about a fault that does not exist.
      // Checked on our own signal, not the error name: the 15s rerank timeout
      // aborts too, and *that* one really is a rerank failure.
      if (signal?.aborted) throw err;
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
    ...(truncated ? { truncated } : {}),
  };
}

export interface EmbedConfig {
  provider: "cohere" | "ollama";
  apiKey?: string;
  ollamaModel?: string;
}

const COHERE_MODEL = "embed-v4.0";
const COHERE_BATCH_SIZE = 96;
const OLLAMA_BATCH_SIZE = 32;
const DEFAULT_OLLAMA_MODEL = "nomic-embed-text";

const COHERE_TIMEOUT_MS = 30_000;
const OLLAMA_TIMEOUT_MS = 120_000;
const COHERE_MAX_RETRIES = 3;
const COHERE_RETRY_BACKOFF = [1000, 2000, 4000];

const COHERE_EMBED_CONCURRENCY = 3;
const OLLAMA_EMBED_CONCURRENCY = 2;

interface CohereEmbedResponse {
  embeddings: {
    float: number[][];
  };
}

interface OllamaEmbedResponse {
  embeddings: number[][];
}

/**
 * Aborting has to be an exception, never an early return.
 *
 * Each batch writes into a pre-sized `results` array. A batch that bails out
 * quietly leaves `undefined` holes behind, and the caller — which has no way to
 * tell a hole from a real embedding — happily hands them to `embeddingToBuffer`.
 * The resulting TypeError is caught by the sync manager and recorded as a
 * *document* error, which is how cancelling a sync used to poison documents.
 */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

async function runConcurrent<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  limit: number,
): Promise<void> {
  const active = new Set<Promise<void>>();
  for (const item of items) {
    const p = fn(item).finally(() => active.delete(p));
    active.add(p);
    if (active.size >= limit) await Promise.race(active);
  }
  await Promise.all(active);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  maxRetries: number,
  backoffMs: number[],
  signal?: AbortSignal,
): Promise<Response> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const signals = [AbortSignal.timeout(timeoutMs)];
      if (signal) signals.push(signal);
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.any(signals),
      });

      if (res.ok) return res;

      if (isRetryableStatus(res.status) && attempt < maxRetries) {
        lastError = new Error(`${res.status} ${res.statusText}`);
        await new Promise((r) => setTimeout(r, backoffMs[attempt]));
        continue;
      }

      return res;
    } catch (err) {
      if (signal?.aborted) throw err;
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, backoffMs[attempt]));
        continue;
      }
    }
  }

  throw lastError;
}

async function embedWithCohere(
  texts: string[],
  inputType: "search_document" | "search_query",
  apiKey: string,
  signal?: AbortSignal,
): Promise<Float32Array[]> {
  const batches: { start: number; texts: string[] }[] = [];
  for (let i = 0; i < texts.length; i += COHERE_BATCH_SIZE) {
    batches.push({ start: i, texts: texts.slice(i, i + COHERE_BATCH_SIZE) });
  }

  const results = new Array<Float32Array>(texts.length);

  await runConcurrent(
    batches,
    async (batch) => {
      throwIfAborted(signal);
      const res = await fetchWithRetry(
        "https://api.cohere.com/v2/embed",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: COHERE_MODEL,
            texts: batch.texts,
            input_type: inputType,
            embedding_types: ["float"],
          }),
        },
        COHERE_TIMEOUT_MS,
        COHERE_MAX_RETRIES,
        COHERE_RETRY_BACKOFF,
        signal,
      );

      if (!res.ok) {
        throw new Error(`Cohere embed failed: ${res.status} ${res.statusText}`);
      }

      const data = (await res.json()) as CohereEmbedResponse;
      if (data.embeddings.float.length !== batch.texts.length) {
        throw new Error(
          `Cohere returned ${data.embeddings.float.length} embeddings for ${batch.texts.length} texts`,
        );
      }
      for (let j = 0; j < data.embeddings.float.length; j++) {
        results[batch.start + j] = new Float32Array(data.embeddings.float[j]);
      }
    },
    COHERE_EMBED_CONCURRENCY,
  );

  return results;
}

async function embedWithOllama(
  texts: string[],
  model: string,
  signal?: AbortSignal,
): Promise<Float32Array[]> {
  const batches: { start: number; texts: string[] }[] = [];
  for (let i = 0; i < texts.length; i += OLLAMA_BATCH_SIZE) {
    batches.push({ start: i, texts: texts.slice(i, i + OLLAMA_BATCH_SIZE) });
  }

  const results = new Array<Float32Array>(texts.length);

  await runConcurrent(
    batches,
    async (batch) => {
      throwIfAborted(signal);
      const res = await fetchWithRetry(
        "http://localhost:11434/api/embed",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, input: batch.texts }),
        },
        OLLAMA_TIMEOUT_MS,
        COHERE_MAX_RETRIES,
        COHERE_RETRY_BACKOFF,
        signal,
      );

      if (!res.ok) {
        throw new Error(`Ollama embed failed: ${res.status} ${res.statusText}`);
      }

      const data = (await res.json()) as OllamaEmbedResponse;
      if (data.embeddings.length !== batch.texts.length) {
        throw new Error(
          `Ollama returned ${data.embeddings.length} embeddings for ${batch.texts.length} texts`,
        );
      }
      for (let j = 0; j < data.embeddings.length; j++) {
        results[batch.start + j] = new Float32Array(data.embeddings[j]);
      }
    },
    OLLAMA_EMBED_CONCURRENCY,
  );

  return results;
}

export async function embedDocuments(
  texts: string[],
  config: EmbedConfig,
  signal?: AbortSignal,
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];

  if (config.provider === "cohere") {
    if (!config.apiKey) throw new Error("Cohere API key required");
    return embedWithCohere(texts, "search_document", config.apiKey, signal);
  }
  return embedWithOllama(
    texts,
    config.ollamaModel ?? DEFAULT_OLLAMA_MODEL,
    signal,
  );
}

export async function embedQuery(
  text: string,
  config: EmbedConfig,
  signal?: AbortSignal,
): Promise<Float32Array> {
  if (config.provider === "cohere") {
    if (!config.apiKey) throw new Error("Cohere API key required");
    const [result] = await embedWithCohere(
      [text],
      "search_query",
      config.apiKey,
      signal,
    );
    return result;
  }
  const [result] = await embedWithOllama(
    [text],
    config.ollamaModel ?? DEFAULT_OLLAMA_MODEL,
    signal,
  );
  return result;
}

export function getEmbeddingModelName(config: EmbedConfig): string {
  return config.provider === "cohere"
    ? COHERE_MODEL
    : (config.ollamaModel ?? DEFAULT_OLLAMA_MODEL);
}

export function embeddingToBuffer(embedding: Float32Array): Buffer {
  const copy = Buffer.alloc(embedding.byteLength);
  copy.set(
    new Uint8Array(
      embedding.buffer,
      embedding.byteOffset,
      embedding.byteLength,
    ),
  );
  return copy;
}

export function bufferToEmbedding(buf: Buffer): Float32Array {
  const copy = new ArrayBuffer(buf.byteLength);
  new Uint8Array(copy).set(buf);
  return new Float32Array(copy);
}

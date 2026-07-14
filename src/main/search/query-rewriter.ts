import type { EmbedConfig } from "./embedder";

const SYSTEM_PROMPT =
  "You are a search query optimizer. Rewrite the user's question as a short keyword-rich search phrase (5-10 words). Output ONLY the rewritten query, nothing else.";

const COHERE_TIMEOUT_MS = 3_000;
const OLLAMA_TIMEOUT_MS = 5_000;
const OLLAMA_FALLBACK_MODEL = "llama3.2:1b";

const QUESTION_WORDS = new Set([
  "who",
  "what",
  "when",
  "where",
  "why",
  "how",
  "is",
  "are",
  "do",
  "does",
  "can",
  "will",
  "should",
  "could",
  "would",
  "did",
  "has",
  "have",
  "was",
  "were",
]);

function isQuestionQuery(query: string): boolean {
  if (query.endsWith("?")) return true;
  const firstWord = query.split(/\s+/)[0]?.toLowerCase();
  return firstWord ? QUESTION_WORDS.has(firstWord) : false;
}

function wordCount(query: string): number {
  return query.split(/\s+/).filter(Boolean).length;
}

/** Our timeout, plus the caller's cancellation if it gave us one. */
function withTimeout(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  return AbortSignal.any(signals);
}

async function rewriteWithCohere(
  query: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const res = await fetch("https://api.cohere.com/v2/chat", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "command-r",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: query },
      ],
    }),
    signal: withTimeout(COHERE_TIMEOUT_MS, signal),
  });

  if (!res.ok) return null;

  const data = (await res.json()) as {
    message?: { content?: Array<{ text?: string }> };
  };
  const text = data.message?.content?.[0]?.text?.trim();
  if (!text || text.length === 0) return null;
  return text;
}

async function rewriteWithOllama(
  query: string,
  model: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const res = await fetch("http://localhost:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      system: SYSTEM_PROMPT,
      prompt: query,
      stream: false,
    }),
    signal: withTimeout(OLLAMA_TIMEOUT_MS, signal),
  });

  if (!res.ok) return null;

  const data = (await res.json()) as { response?: string };
  const text = data.response?.trim();
  if (!text || text.length === 0) return null;
  return text;
}

/**
 * Never throws — a rewrite is an optimization, and a failed one must not take the
 * search down with it. That includes an *abort*: a cancelled rewrite returns the
 * original query, and the caller's own abort checkpoint is what actually stops the
 * search. Passing the signal here still matters, because it releases the in-flight
 * request instead of leaving it to run out its 3-second timeout.
 */
export async function rewriteQuery(
  query: string,
  embedConfig: EmbedConfig,
  signal?: AbortSignal,
): Promise<string> {
  if (wordCount(query) <= 3 || !isQuestionQuery(query)) {
    return query;
  }

  try {
    if (embedConfig.apiKey) {
      const result = await rewriteWithCohere(query, embedConfig.apiKey, signal);
      if (result) return result;
      return query;
    }

    const primaryModel = embedConfig.ollamaModel;
    if (primaryModel) {
      const result = await rewriteWithOllama(query, primaryModel, signal);
      if (result) return result;
    }

    // A cancelled search must not fall through to a second model.
    if (signal?.aborted) return query;

    if (primaryModel !== OLLAMA_FALLBACK_MODEL) {
      const result = await rewriteWithOllama(
        query,
        OLLAMA_FALLBACK_MODEL,
        signal,
      );
      if (result) return result;
    }
  } catch {
    // never block search
  }

  return query;
}

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

async function rewriteWithCohere(
  query: string,
  apiKey: string,
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
    signal: AbortSignal.timeout(COHERE_TIMEOUT_MS),
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
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
  });

  if (!res.ok) return null;

  const data = (await res.json()) as { response?: string };
  const text = data.response?.trim();
  if (!text || text.length === 0) return null;
  return text;
}

export async function rewriteQuery(
  query: string,
  embedConfig: EmbedConfig,
): Promise<string> {
  if (wordCount(query) <= 3 || !isQuestionQuery(query)) {
    return query;
  }

  try {
    if (embedConfig.apiKey) {
      const result = await rewriteWithCohere(query, embedConfig.apiKey);
      if (result) return result;
      return query;
    }

    const primaryModel = embedConfig.ollamaModel;
    if (primaryModel) {
      const result = await rewriteWithOllama(query, primaryModel);
      if (result) return result;
    }

    if (primaryModel !== OLLAMA_FALLBACK_MODEL) {
      const result = await rewriteWithOllama(query, OLLAMA_FALLBACK_MODEL);
      if (result) return result;
    }
  } catch {
    // never block search
  }

  return query;
}

import type { EmbedConfig } from "./embedder";

// Written against the failure mode `isUsableRewrite` catches: asked only to be
// concise, a model handed a vague question ("what are all the important dates?")
// answers it conversationally — offering help, requesting clarification — because
// that is the natural chat completion. So the prompt forbids that turn explicitly
// and gives it something to do instead (extract the terms), rather than relying on
// "output ONLY the query" to be self-evident.
const SYSTEM_PROMPT =
  "You are a search query optimizer. Rewrite the user's question as a short keyword-rich search phrase (5-10 words). " +
  "Output ONLY that phrase — no preamble, no explanation, no quotes. " +
  "Never ask for clarification and never address the user: if the question is vague, just extract its key nouns.";

// Command R, the same snapshot the answerer uses. This was briefly Command R7B
// (smallest/cheapest, on the theory that keyword extraction is trivial) — but the
// task is not "trivial", it is *instruction-following*, and R7B routinely answered
// the question instead of rewriting it. `isUsableRewrite` now discards such a
// reply, so a weak model degrades to no rewrite rather than a poisoned one; this
// is about how often that happens, since a discarded rewrite is a wasted call.
const COHERE_REWRITE_MODEL = "command-r-08-2024";

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

/** The prompt asks for 5-10 words; allow slack before calling a reply non-compliant. */
const MAX_REWRITE_WORDS = 12;

/**
 * Whether a model's reply is actually a search phrase.
 *
 * A rewrite is only ever *asked* for — nothing makes the model comply, and an
 * HTTP 200 carrying a refusal, a preamble, or a clarifying question is not a
 * failure any status check can catch. Small models (the cheap ones this uses)
 * answer conversationally often enough that this is the common case, not an edge
 * one. Accepting such a reply is worse than not rewriting at all: it becomes the
 * FTS query, where `searchFts` splits it on whitespace and ORs every token, so a
 * one-sentence pleasantry dilutes keyword search into dozens of stopwords — and
 * it surfaces to the user as the "searched as" label.
 *
 * The three rejections below are shape checks, not content checks: prose runs
 * long, chat replies carry a preamble line, and a "rewrite" that grew has
 * condensed nothing. A rejected rewrite degrades to the raw query, exactly as an
 * HTTP failure does.
 */
function isUsableRewrite(rewrite: string, original: string): boolean {
  if (rewrite.includes("\n")) return false;
  if (wordCount(rewrite) > MAX_REWRITE_WORDS) return false;
  if (rewrite.length > original.length) return false;
  return true;
}

/** The rewrite if it is usable, else null — logged, since a silent fallback is
 *  indistinguishable from a model that is quietly never complying. */
function acceptRewrite(
  rewrite: string | null,
  original: string,
): string | null {
  if (rewrite === null) return null;
  if (isUsableRewrite(rewrite, original)) return rewrite;
  console.warn(
    `Discarded a non-compliant query rewrite (${wordCount(rewrite)} words): ${JSON.stringify(rewrite.slice(0, 120))}`,
  );
  return null;
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
      model: COHERE_REWRITE_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: query },
      ],
    }),
    signal: withTimeout(COHERE_TIMEOUT_MS, signal),
  });

  if (!res.ok) {
    // A failed rewrite is swallowed (search falls back to the raw query), which
    // hides that Cohere's chat endpoint is rejecting requests. Log it so a plain
    // search surfaces the same root cause the AI answer hits — both use /v2/chat.
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      /* body unavailable */
    }
    console.error(
      `Cohere chat (query rewrite) failed: HTTP ${res.status} ${res.statusText} — ${detail.slice(0, 300)}`,
    );
    return null;
  }

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
      const result = acceptRewrite(
        await rewriteWithCohere(query, embedConfig.apiKey, signal),
        query,
      );
      if (result) return result;
      return query;
    }

    const primaryModel = embedConfig.ollamaModel;
    if (primaryModel) {
      const result = acceptRewrite(
        await rewriteWithOllama(query, primaryModel, signal),
        query,
      );
      if (result) return result;
    }

    // A cancelled search must not fall through to a second model.
    if (signal?.aborted) return query;

    if (primaryModel !== OLLAMA_FALLBACK_MODEL) {
      const result = acceptRewrite(
        await rewriteWithOllama(query, OLLAMA_FALLBACK_MODEL, signal),
        query,
      );
      if (result) return result;
    }
  } catch {
    // never block search
  }

  return query;
}

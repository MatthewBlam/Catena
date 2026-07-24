import type { EmbedConfig } from "./embedder";
import type { AnswerCitation, AnswerResponse } from "../../shared/types";

/** One retrieved source the answer is grounded on. `text` is the full chunk body. */
export interface AnswerDoc {
  chunkId: string;
  title: string;
  text: string;
}

interface GenerateOptions {
  signal?: AbortSignal;
  onDelta: (text: string) => void;
  /** The Ollama chat model to use; the handler resolves it from settings. */
  ollamaChatModel?: string;
}

const COHERE_ANSWER_MODEL = "command-r";
export const DEFAULT_OLLAMA_CHAT_MODEL = "llama3.2";

/** Per-source cap sent to the model. Cohere recommends ≤300 words per snippet. */
const MAX_DOC_CHARS = 2_000;

/**
 * Whole-generation ceiling, additive to the caller's cancel signal. A stream
 * that never terminates must not hang the request forever; a real answer streams
 * well inside this.
 */
const ANSWER_TIMEOUT_MS = 120_000;

const SYSTEM_PROMPT =
  "You are a helpful assistant answering questions using ONLY the provided sources. " +
  "If the sources do not contain the answer, say you couldn't find it in the connected documents. " +
  "Be concise and factual, and do not invent information that is not in the sources.";

const FAILED_MESSAGE = "Couldn't generate an answer. Try again.";
const EMPTY_MESSAGE = "No answer could be generated from your sources.";

function truncateDoc(text: string): string {
  return text.length > MAX_DOC_CHARS ? text.slice(0, MAX_DOC_CHARS) : text;
}

/** Our timeout, plus the caller's cancellation if it gave us one. */
function withTimeout(signal?: AbortSignal): AbortSignal {
  const signals = [AbortSignal.timeout(ANSWER_TIMEOUT_MS)];
  if (signal) signals.push(signal);
  return AbortSignal.any(signals);
}

function failed(error = FAILED_MESSAGE): AnswerResponse {
  return { text: "", citations: [], errorKind: "failed", error };
}

/**
 * Reads a fetch body stream line by line, invoking `onLine` for each complete
 * line. Shared by the Cohere SSE parser and the Ollama NDJSON parser — the only
 * difference between the two is how a line is interpreted. Flushes a trailing
 * partial line (no final newline) at the end.
 */
async function forEachLine(
  body: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      onLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  const tail = buffer.trim();
  if (tail) onLine(tail);
}

/**
 * Cohere source ids look like `doc:0` or `doc:0:0`; the document's position in
 * the `documents` array we sent is the trailing integer. Returns null for an id
 * that carries no number so the caller can drop the citation.
 */
function parseSourceDocIndex(sourceId: unknown): number | null {
  if (typeof sourceId !== "string") return null;
  const nums = sourceId.match(/\d+/g);
  if (!nums) return null;
  return Number(nums[nums.length - 1]);
}

interface CohereCitation {
  start?: number;
  end?: number;
  sources?: { id?: unknown }[];
}

/**
 * Turns one Cohere `citation-start` payload into zero or more AnswerCitations —
 * one per cited source, all sharing the span, each resolved back to a chunkId by
 * the document's position. Citations whose span is malformed or whose source
 * index is out of range are dropped rather than rendered against the wrong chunk.
 */
function citationsFromCohere(
  citation: CohereCitation,
  docs: AnswerDoc[],
): AnswerCitation[] {
  const { start, end, sources } = citation;
  if (typeof start !== "number" || typeof end !== "number" || end <= start) {
    return [];
  }
  if (!Array.isArray(sources)) return [];
  const out: AnswerCitation[] = [];
  for (const source of sources) {
    const index = parseSourceDocIndex(source?.id);
    if (index === null || index < 0 || index >= docs.length) continue;
    out.push({ start, end, chunkId: docs[index].chunkId });
  }
  return out;
}

async function generateWithCohere(
  query: string,
  docs: AnswerDoc[],
  apiKey: string,
  opts: GenerateOptions,
): Promise<AnswerResponse> {
  const res = await fetch("https://api.cohere.com/v2/chat", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: COHERE_ANSWER_MODEL,
      stream: true,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: query },
      ],
      documents: docs.map((d) => ({
        data: { title: d.title, snippet: truncateDoc(d.text) },
      })),
    }),
    signal: withTimeout(opts.signal),
  });

  if (!res.ok || !res.body) return failed();

  let text = "";
  const citations: AnswerCitation[] = [];

  await forEachLine(res.body, (line) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;

    let payload: {
      type?: string;
      delta?: {
        message?: {
          content?: { text?: string };
          citations?: CohereCitation | CohereCitation[];
        };
      };
    };
    try {
      payload = JSON.parse(data);
    } catch {
      return; // a malformed event must not abort the whole stream
    }

    if (payload.type === "content-delta") {
      const piece = payload.delta?.message?.content?.text;
      if (piece) {
        text += piece;
        opts.onDelta(piece);
      }
    } else if (payload.type === "citation-start") {
      const raw = payload.delta?.message?.citations;
      const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
      for (const c of list) citations.push(...citationsFromCohere(c, docs));
    }
  });

  return { text, citations };
}

/** Builds the manual-RAG user message Ollama gets, since it has no `documents` field. */
function ollamaUserMessage(query: string, docs: AnswerDoc[]): string {
  const sources = docs
    .map((d, i) => `[${i + 1}] ${d.title}\n${truncateDoc(d.text)}`)
    .join("\n\n");
  return `Sources:\n\n${sources}\n\nUsing only the sources above, answer this question: ${query}`;
}

async function ollamaHasModel(
  model: string,
  signal: AbortSignal,
): Promise<boolean> {
  const res = await fetch("http://localhost:11434/api/tags", { signal });
  if (!res.ok) return false;
  const data = (await res.json()) as { models?: { name?: string }[] };
  const names = (data.models ?? []).map((m) => m.name ?? "");
  // Match `llama3.2` against `llama3.2`, `llama3.2:latest`, `llama3.2:1b`, etc.
  return names.some((name) => name === model || name.startsWith(`${model}:`));
}

async function generateWithOllama(
  query: string,
  docs: AnswerDoc[],
  model: string,
  opts: GenerateOptions,
): Promise<AnswerResponse> {
  const signal = withTimeout(opts.signal);

  if (!(await ollamaHasModel(model, signal))) {
    return {
      text: "",
      citations: [],
      errorKind: "no_model",
      error: `Install a chat model in Ollama (e.g. \`ollama pull ${model}\`) to generate answers.`,
    };
  }

  const res = await fetch("http://localhost:11434/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: ollamaUserMessage(query, docs) },
      ],
    }),
    signal,
  });

  if (!res.ok || !res.body) return failed();

  let text = "";
  await forEachLine(res.body, (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let payload: { message?: { content?: string } };
    try {
      payload = JSON.parse(trimmed);
    } catch {
      return;
    }
    const piece = payload.message?.content;
    if (piece) {
      text += piece;
      opts.onDelta(piece);
    }
  });

  return { text, citations: [] };
}

/**
 * Generates a grounded answer to `query` from the retrieved `docs`, streaming
 * text through `opts.onDelta` and resolving with the final text + citations.
 *
 * Never throws — a failed or cancelled answer must not surface as an unhandled
 * rejection across IPC. An abort (the user pressed Stop, or a newer request
 * superseded this one) resolves with `cancelled: true` and whatever text had
 * streamed so far, mirroring how search signals an abort with a flag rather than
 * a rejection (an Error's `name` does not survive IPC serialization). Cohere
 * yields native citations; Ollama has no citation API, so its list is always
 * empty and the source cards below the answer are the citation surface.
 */
export async function generateAnswer(
  query: string,
  docs: AnswerDoc[],
  embedConfig: EmbedConfig,
  opts: GenerateOptions,
): Promise<AnswerResponse> {
  if (docs.length === 0) return failed(EMPTY_MESSAGE);

  try {
    let response: AnswerResponse;
    if (embedConfig.provider === "cohere") {
      if (!embedConfig.apiKey) return failed();
      response = await generateWithCohere(
        query,
        docs,
        embedConfig.apiKey,
        opts,
      );
    } else {
      const model = opts.ollamaChatModel || DEFAULT_OLLAMA_CHAT_MODEL;
      response = await generateWithOllama(query, docs, model, opts);
    }

    // An empty answer from a request that otherwise succeeded is a soft failure —
    // there is nothing to show or persist. A degraded (no_model) response already
    // carries its own message and is returned untouched.
    if (!response.errorKind && response.text.trim() === "") {
      return failed(EMPTY_MESSAGE);
    }
    return response;
  } catch (err) {
    // The caller's cancel is a stop, not a failure: return the partial text with
    // the cancelled flag. A timeout (our signal, not the caller's) is a real
    // failure. `partial` is unavailable here — the stream loop owns it — so a
    // cancelled generation returns empty text; the renderer keeps what it already
    // received via onDelta.
    if (opts.signal?.aborted) {
      return { text: "", citations: [], cancelled: true };
    }
    if (err instanceof Error && err.name === "TimeoutError") {
      return failed();
    }
    return failed();
  }
}

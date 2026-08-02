import { OLLAMA_BASE_URL } from "./platform";

/**
 * Heuristic for "is this an embedding model", mirrored from the renderer's
 * `isEmbeddingModel` (`src/renderer/src/lib/ollama.ts`). Kept in sync by hand;
 * both are the same three-substring check.
 */
export function isEmbeddingModel(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("embed") || n.includes("nomic") || n.includes("mxbai");
}

/**
 * Reads a fetch body stream line by line. A local copy of `answerer.ts`'s
 * `forEachLine` so this module stays self-contained (the answerer's is private
 * to that file). Flushes a trailing partial line at the end.
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

/** Local model names from `/api/tags`; `[]` if the engine is unreachable. */
export async function listModels(signal?: AbortSignal): Promise<string[]> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: signal ?? AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: { name: string }[] };
    return data.models?.map((m) => m.name) ?? [];
  } catch {
    return [];
  }
}

/** `true` if `model` (or a `model:...` tag of it) is installed locally. */
export async function hasModel(
  model: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const models = await listModels(signal);
  return models.some((m) => m === model || m.startsWith(`${model}:`));
}

/**
 * Removes `model` from the local store via `DELETE /api/delete` (Ollama unlinks
 * the underlying blobs itself, so we never touch `~/.ollama` by hand). Treats a
 * 404 as success — the goal state is "model is gone", and it not being there is
 * that state. Only a real server error (5xx, malformed) rejects.
 */
export async function deleteModel(
  model: string,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/delete`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  if (res.ok || res.status === 404) return;
  throw new Error(`Ollama could not delete "${model}" (HTTP ${res.status}).`);
}

export interface PullProgress {
  /** Ollama's own status line, e.g. "pulling manifest" / "pulling <digest>". */
  message: string;
  /** Aggregate bytes across all layers seen so far, when any layer reports size. */
  bytesCompleted?: number;
  bytesTotal?: number;
  /** 0..100 aggregate, when total is known. */
  percent?: number;
}

interface PullLine {
  status?: string;
  digest?: string;
  total?: number;
  completed?: number;
  error?: string;
}

/**
 * Pulls `model` via `POST /api/pull` (streamed NDJSON), reporting aggregate
 * progress across layers. Resolves on the terminal `success` status; rejects on
 * a stream `error`, a non-OK response, or abort.
 *
 * Ollama reports progress per layer (keyed by `digest`); we sum the latest
 * `completed`/`total` per digest into one smooth overall bar rather than jumping
 * back to 0% at each layer boundary.
 */
export async function pullModel(
  model: string,
  onProgress: (p: PullProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: true }),
    signal,
  });

  if (!res.ok || !res.body) {
    throw new Error(
      `Ollama could not pull "${model}" (HTTP ${res.status}). Is the engine running?`,
    );
  }

  // Latest known bytes per layer digest, summed for the aggregate bar.
  const byDigest = new Map<string, { completed: number; total: number }>();
  let sawSuccess = false;
  let streamError: string | null = null;

  await forEachLine(res.body, (line) => {
    if (!line.trim()) return;
    let parsed: PullLine;
    try {
      parsed = JSON.parse(line) as PullLine;
    } catch {
      return; // ignore a malformed keep-alive line rather than fail the pull
    }

    if (parsed.error) {
      streamError = parsed.error;
      return;
    }
    if (parsed.status === "success") sawSuccess = true;

    if (parsed.digest && typeof parsed.total === "number") {
      byDigest.set(parsed.digest, {
        completed: parsed.completed ?? 0,
        total: parsed.total,
      });
    }

    let bytesCompleted = 0;
    let bytesTotal = 0;
    for (const { completed, total } of byDigest.values()) {
      bytesCompleted += completed;
      bytesTotal += total;
    }
    onProgress({
      message: parsed.status ?? "pulling",
      bytesCompleted: bytesTotal > 0 ? bytesCompleted : undefined,
      bytesTotal: bytesTotal > 0 ? bytesTotal : undefined,
      percent:
        bytesTotal > 0
          ? Math.min(100, Math.floor((bytesCompleted / bytesTotal) * 100))
          : undefined,
    });
  });

  if (streamError) {
    throw new Error(`Ollama failed to pull "${model}": ${streamError}`);
  }
  // The stream can end without an explicit "success" only if it was cut short;
  // an aborted pull already threw out of `forEachLine`. Treat a clean end with
  // no success as a failure so the caller doesn't report a half-pull as done.
  if (!sawSuccess) {
    throw new Error(
      `Ollama's pull of "${model}" ended before completing. Please retry.`,
    );
  }
}

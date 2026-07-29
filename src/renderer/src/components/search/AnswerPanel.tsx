import { SparklesIcon, SquareIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { OllamaChatModelButton } from "@renderer/components/setup/OllamaChatModelButton";
import { openExternal } from "@renderer/lib/openExternal";
import type { AnswerCitation, SearchResult } from "../../../../shared/types";

export type AnswerStatus = "idle" | "streaming" | "done" | "error";

interface AnswerPanelProps {
  status: AnswerStatus;
  text: string;
  citations: AnswerCitation[];
  results: SearchResult[];
  error?: string;
  errorKind?: string;
  onGenerate: () => void;
  onStop: () => void;
  onRetry: () => void;
}

/** A clickable citation marker `[n]` that opens its source document, if it has a url. */
function CitationMarker({
  n,
  url,
}: {
  n: number;
  url: string | null;
}): React.JSX.Element {
  const label = `[${n}]`;
  if (!url) {
    return (
      <sup className="ml-0.5 text-[0.7em] text-muted-foreground">{label}</sup>
    );
  }
  return (
    <button
      type="button"
      onClick={() => void openExternal(url)}
      aria-label={`Open source ${n}`}
      className="ml-0.5 cursor-pointer align-super text-[0.7em] text-primary hover:underline"
    >
      {label}
    </button>
  );
}

/**
 * Renders the answer with inline citation markers. Markers are placed at each
 * cited span's end (academic style), numbered by the source's position in the
 * result list. Citations pointing at a chunk that is not in the current results,
 * or with an out-of-range span, are dropped — a marker must never reference a
 * card that is not there.
 */
function renderAnswerBody(
  text: string,
  citations: AnswerCitation[],
  results: SearchResult[],
): React.ReactNode {
  const indexByChunk = new Map<string, number>();
  results.forEach((r, i) => indexByChunk.set(r.chunkId, i));

  const valid = citations.filter(
    (c) =>
      indexByChunk.has(c.chunkId) &&
      c.start >= 0 &&
      c.end > c.start &&
      c.end <= text.length,
  );
  if (valid.length === 0) return text;

  // Group by span so one phrase cited from several sources renders `[1][2]`.
  const groups = new Map<string, { end: number; chunkIds: string[] }>();
  for (const c of valid) {
    const key = `${c.start}:${c.end}`;
    const group = groups.get(key) ?? { end: c.end, chunkIds: [] };
    if (!group.chunkIds.includes(c.chunkId)) group.chunkIds.push(c.chunkId);
    groups.set(key, group);
  }
  const ordered = [...groups.values()].sort((a, b) => a.end - b.end);

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (const group of ordered) {
    // Only emit body text — and advance — when this group ends past the cursor.
    // A distinct group that shares its end offset with an earlier one (same
    // `end`, different `start`) has no new text to contribute, but its markers
    // must still render: skipping the whole group here silently dropped a valid
    // citation. Guard the text slice, not the markers.
    if (group.end > cursor) {
      nodes.push(<span key={key++}>{text.slice(cursor, group.end)}</span>);
      cursor = group.end;
    }
    for (const chunkId of group.chunkIds) {
      const idx = indexByChunk.get(chunkId)!;
      nodes.push(
        <CitationMarker key={key++} n={idx + 1} url={results[idx].url} />,
      );
    }
  }
  if (cursor < text.length) {
    nodes.push(<span key={key++}>{text.slice(cursor)}</span>);
  }
  return nodes;
}

function AnswerCard({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <SparklesIcon className="size-4 text-muted-foreground" />
          Answer
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

export function AnswerPanel({
  status,
  text,
  citations,
  results,
  error,
  errorKind,
  onGenerate,
  onStop,
  onRetry,
}: AnswerPanelProps): React.JSX.Element | null {
  if (status === "idle") {
    return (
      <div>
        <Button variant="outline" size="sm" onClick={onGenerate}>
          <SparklesIcon />
          Generate answer
        </Button>
      </div>
    );
  }

  if (status === "streaming") {
    return (
      <AnswerCard
        action={
          <Button variant="ghost" size="xs" onClick={onStop}>
            <SquareIcon />
            Stop
          </Button>
        }
      >
        <p className="text-sm text-foreground leading-relaxed select-text whitespace-pre-wrap">
          {text}
          <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse bg-foreground/70" />
        </p>
      </AnswerCard>
    );
  }

  if (status === "error") {
    // A missing Ollama chat model is a setup gap, not a failure — show the hint
    // and no "Try again" (retrying without pulling a model just fails again).
    const isNoModel = errorKind === "no_model";
    return (
      <AnswerCard
        action={
          isNoModel ? undefined : (
            <Button variant="ghost" size="xs" onClick={onRetry}>
              <RotateCcwIcon />
              Try again
            </Button>
          )
        }
      >
        <p className="text-sm text-muted-foreground leading-relaxed">
          {error ?? "Couldn't generate an answer. Try again."}
        </p>
        {/* A missing chat model is a one-click fix now: download it, then retry
            generating the answer. */}
        {isNoModel && (
          <div className="pt-1">
            <OllamaChatModelButton onInstalled={onRetry} />
          </div>
        )}
      </AnswerCard>
    );
  }

  // done
  return (
    <AnswerCard>
      <p className="text-sm text-foreground leading-relaxed select-text whitespace-pre-wrap">
        {renderAnswerBody(text, citations, results)}
      </p>
      {citations.length === 0 && (
        <p className="text-xs text-muted-foreground/60">
          Based on the sources below.
        </p>
      )}
    </AnswerCard>
  );
}

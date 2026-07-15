import { useEffect, useState, useRef } from "react";
import { Button } from "@renderer/components/ui/button";
import { Spinner } from "@renderer/components/ui/spinner";
import type { SyncProgress } from "../../../../shared/types";

interface SyncPanelProps {
  sourceId: string;
  sourceName: string;
  onComplete: () => void;
}

const PHASE_LABELS: Record<string, string> = {
  fetching: "Fetching documents",
  chunking: "Chunking text",
  embedding: "Generating embeddings",
  storing: "Storing data",
  reconciling: "Checking for deletions",
};

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

export function SyncPanel({
  sourceId,
  sourceName,
  onComplete,
}: SyncPanelProps): React.JSX.Element {
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [status, setStatus] = useState<
    "syncing" | "complete" | "canceled" | "error"
  >("syncing");
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const startedRef = useRef(false);
  // Mirrors `status` so the async sync callbacks can read the *current* value
  // without a stale closure. The only thing that moves status off "syncing"
  // before the sync settles is the user hitting Cancel.
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // M16: the sync is started exactly once (guarded), but the progress
  // subscription lives in its own *unguarded* effect. Folding both into one
  // guarded effect meant that under StrictMode the first mount subscribed, the
  // cleanup unsubscribed, and the guarded re-run early-returned before
  // re-subscribing — so in dev no progress listener existed at all.
  useEffect(() => {
    const unsub = window.api.onSyncProgress((p) => {
      if (p.sourceId === sourceId) {
        setProgress(p);
      }
    });
    return unsub;
  }, [sourceId]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    window.api
      .syncSource(sourceId)
      .then(() => {
        if (statusRef.current === "syncing") setStatus("complete");
      })
      .catch((err) => {
        // M8: guard the same way the success path does. A Cancel transitions to
        // "canceled" and then the sync rejects with an abort error — writing
        // "error" unconditionally would flash "Sync canceled" then an abort
        // failure over it.
        if (statusRef.current !== "syncing") return;
        setError(err instanceof Error ? err.message : "Sync failed");
        setStatus("error");
      });
  }, [sourceId]);

  useEffect(() => {
    if (status !== "syncing") return;
    const interval = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(interval);
  }, [status]);

  useEffect(() => {
    // H3: only a clean completion self-dismisses. An "error" or "canceled" panel
    // stays put so its reason remains on screen until the user acts.
    if (status !== "complete") return;
    const timer = setTimeout(onComplete, 1500);
    return () => clearTimeout(timer);
  }, [status, onComplete]);

  function handleCancel(): void {
    window.api.cancelSync(sourceId).catch(() => {});
    statusRef.current = "canceled";
    setStatus("canceled");
  }

  const phaseLabel = progress
    ? (PHASE_LABELS[progress.phase] ?? progress.phase)
    : "Starting sync";

  const statusLabel =
    status === "complete"
      ? "Sync complete"
      : status === "canceled"
        ? "Sync canceled"
        : status === "error"
          ? `Sync failed for ${sourceName}`
          : `Syncing ${sourceName}`;

  return (
    <div className="border-x border-b border-border rounded-b-lg bg-card/50 px-4 py-3 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{statusLabel}</h3>
        {status === "syncing" && (
          <Button variant="ghost" size="xs" onClick={handleCancel}>
            Cancel
          </Button>
        )}
      </div>

      {status === "syncing" && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner className="size-3.5" />
            <span>{phaseLabel}</span>
            <span className="ml-auto tabular-nums">
              {formatElapsed(elapsed)}
            </span>
          </div>

          {progress && progress.current > 0 && (
            <p className="text-xs text-muted-foreground">
              {progress.current} document{progress.current !== 1 ? "s" : ""}{" "}
              processed
            </p>
          )}

          {progress?.currentDocTitle && (
            <p className="text-xs text-muted-foreground truncate">
              {progress.currentDocTitle}
            </p>
          )}
        </div>
      )}

      {error && <p className="text-sm text-destructive-foreground">{error}</p>}

      {progress && progress.errors.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-warning-foreground">
            {progress.errors.length} error
            {progress.errors.length > 1 ? "s" : ""}
          </summary>
          <ul className="mt-1 space-y-0.5 text-muted-foreground">
            {progress.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </details>
      )}

      {status !== "syncing" && (
        <div className="text-xs text-muted-foreground space-y-0.5">
          {status === "complete" && progress && progress.skipped > 0 && (
            <p>{progress.skipped} unchanged, skipped</p>
          )}
          {status === "complete" && progress && progress.deleted > 0 && (
            <p>
              {progress.deleted} document{progress.deleted !== 1 ? "s" : ""}{" "}
              removed
            </p>
          )}
          <p>{status === "complete" ? "Dismissing…" : "Done"}</p>
        </div>
      )}
    </div>
  );
}

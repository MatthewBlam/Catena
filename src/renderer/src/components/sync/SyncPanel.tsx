import { useEffect, useState, useRef } from "react";
import { Button } from "@renderer/components/ui/button";
import { Spinner } from "@renderer/components/ui/spinner";
import { toErrorMessage } from "@renderer/lib/errors";
import type { SyncProgress } from "../../../../shared/types";

interface SyncPanelProps {
  sourceId: string;
  sourceName: string;
  /** Dismisses the panel: called by the "complete" auto-timer, or by the user
   * clicking Dismiss on an "error"/"canceled" panel. */
  onComplete: () => void;
  /**
   * Called exactly once when `status` moves off `syncing` into any terminal
   * value (`complete`, `error`, `canceled`) — before the user has necessarily
   * dismissed anything. SourceList uses this to free the sync's queue slot
   * right away; the panel itself may stay mounted well past this point,
   * showing the result until `onComplete` fires.
   */
  onSettled?: () => void;
  /**
   * Whether this panel owns the sync. `true` (default): it calls `syncSource`
   * and self-dismisses when the call settles. `false`: the sync is already
   * running in main (started by the scheduler or another window), so this panel
   * only observes progress — starting it again would throw "sync already in
   * progress". Its parent unmounts it when main reports the sync finished.
   */
  autoStart?: boolean;
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
  onSettled,
  autoStart = true,
}: SyncPanelProps): React.JSX.Element {
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [status, setStatus] = useState<
    "syncing" | "complete" | "canceled" | "error"
  >("syncing");
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  // The sync's true start (epoch ms), learned from `SyncProgress.startedAt`.
  // Null until the first progress event (or the observe-only mount fetch
  // below) supplies it; the elapsed timer falls back to first-tick time until
  // then — accurate for an autoStart panel (it starts the sync at mount).
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);
  const startedRef = useRef(false);
  // Mirrors `status` so the async sync callbacks can read the *current* value
  // without a stale closure. The only thing that moves status off "syncing"
  // before the sync settles is the user hitting Cancel.
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  // Guards `onSettled` to fire exactly once per panel instance: the
  // status-transition effect below re-runs whenever `onSettled`/`onComplete`
  // change identity (the parent typically passes fresh inline closures each
  // render), which would otherwise re-invoke it on every unrelated re-render
  // while a terminal panel sits on screen waiting to be dismissed.
  const settledRef = useRef(false);
  // The parent passes fresh inline `onComplete`/`onSettled` closures on every
  // render, so the settle/dismiss effect below must NOT depend on their
  // identities — a sibling sync's progress re-render would otherwise re-run it
  // and re-arm the 1.5s dismiss timer, which then never fires. Keep the latest
  // closures in refs and fire through them, depending only on `status`.
  const onCompleteRef = useRef(onComplete);
  const onSettledRef = useRef(onSettled);
  useEffect(() => {
    onCompleteRef.current = onComplete;
    onSettledRef.current = onSettled;
  });

  // M16: the sync is started exactly once (guarded), but the progress
  // subscription lives in its own *unguarded* effect. Folding both into one
  // guarded effect meant that under StrictMode the first mount subscribed, the
  // cleanup unsubscribed, and the guarded re-run early-returned before
  // re-subscribing — so in dev no progress listener existed at all.
  useEffect(() => {
    const unsub = window.api.onSyncProgress((p) => {
      if (p.sourceId === sourceId) {
        setProgress(p);
        // Learn the true start once. It is identical across every event of a
        // sync, so keep the first non-null value we see and ignore the rest.
        const ms = Date.parse(p.startedAt);
        if (!Number.isNaN(ms)) setStartedAtMs((prev) => prev ?? ms);
      }
    });
    return unsub;
  }, [sourceId]);

  // Observe-only panels mount onto a sync already running in main, and may not
  // see a progress event for a moment (main could be mid-embedding on a large
  // document). Fetch the active-sync snapshot once so the elapsed timer shows
  // the true elapsed from mount instead of counting up from zero until then.
  useEffect(() => {
    if (autoStart) return;
    let cancelled = false;
    window.api
      .getActiveSyncs()
      .then(({ active }) => {
        if (cancelled) return;
        const mine = active.find((a) => a.sourceId === sourceId);
        if (!mine) return;
        const ms = Date.parse(mine.startedAt);
        if (!Number.isNaN(ms)) setStartedAtMs((prev) => prev ?? ms);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [autoStart, sourceId]);

  useEffect(() => {
    // Observe-only: the sync already runs in main; do not start it again.
    if (!autoStart) return;
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
        setError(toErrorMessage(err, "Sync failed."));
        setStatus("error");
      });
  }, [sourceId, autoStart]);

  useEffect(() => {
    if (status !== "syncing") return;
    // Derive elapsed from a fixed base timestamp rather than incrementing a
    // counter: the base is the sync's true start (`startedAtMs`) once known, so
    // an observe-only panel that mounted mid-sync shows the real elapsed time,
    // not seconds-since-mount. It also self-corrects across sleep/throttling,
    // where an incrementing tick would drift. Recompute immediately so a switch
    // to the true base (once it arrives) is reflected without a 1s lag. Until
    // `startedAtMs` arrives the base is this effect's first run (~mount, since
    // deps are stable while syncing) — right for an autoStart panel.
    const base = startedAtMs ?? Date.now();
    const tick = (): void =>
      setElapsed(Math.max(0, Math.floor((Date.now() - base) / 1000)));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [status, startedAtMs]);

  useEffect(() => {
    // F1/F9: any terminal status frees the queue slot via onSettled, exactly
    // once — a failed/canceled sync must not keep occupying a "Sync all" slot
    // just because its panel is still showing the reason on screen.
    if (status === "syncing") return;
    if (!settledRef.current) {
      settledRef.current = true;
      onSettledRef.current?.();
    }
    // H3: only a clean completion self-dismisses on a timer. An "error" or
    // "canceled" panel stays put — with a Dismiss button — until the user acts.
    if (status !== "complete") return;
    const timer = setTimeout(() => onCompleteRef.current(), 1500);
    return () => clearTimeout(timer);
    // Depends ONLY on the status transition — see the onCompleteRef note above.
  }, [status]);

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
        {(status === "error" || status === "canceled") && (
          <Button variant="ghost" size="xs" onClick={onComplete}>
            Dismiss
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

      {/* F9: "error" already shows its reason via the `error` paragraph above;
          an unconditional "Done" here used to contradict a failed sync. */}
      {(status === "complete" || status === "canceled") && (
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
          <p>{status === "complete" ? "Dismissing…" : "Canceled"}</p>
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Trash2Icon,
  RefreshCwIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  SearchIcon,
  AlertTriangleIcon,
} from "lucide-react";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { SyncPanel } from "@renderer/components/sync/SyncPanel";
import { ErrorBanner } from "@renderer/components/ui/error-banner";
import { Spinner } from "@renderer/components/ui/spinner";
import { VirtualList } from "@renderer/components/ui/VirtualList";
import type { SourceWithCount, Document } from "../../../../shared/types";
import { providerLabel } from "@renderer/lib/format";
import { cn, debounce } from "@renderer/lib/utils";

interface SourceListProps {
  sources: SourceWithCount[];
  label?: string;
  onRefresh: () => void;
}

/** How many sources "Sync all" runs at once, to avoid stampeding the provider. */
const SYNC_ALL_CONCURRENCY = 2;

/** The one-line summary a non-`ok` last sync leaves on a source row. */
function syncStatusMessage(source: SourceWithCount): {
  text: string;
  tone: "error" | "warning" | "muted";
} | null {
  switch (source.lastSyncStatus) {
    case "error":
      return {
        tone: "error",
        text: source.lastSyncError?.split("\n")[0] ?? "Last sync failed",
      };
    case "partial":
      return {
        tone: "warning",
        text:
          source.lastSyncErrorCount > 0
            ? `Last sync finished with ${source.lastSyncErrorCount} error${
                source.lastSyncErrorCount !== 1 ? "s" : ""
              }`
            : "Last sync finished with errors",
      };
    case "cancelled":
      return { tone: "muted", text: "Last sync was canceled" };
    default:
      return null;
  }
}

export function SourceList({
  sources,
  label,
  onRefresh,
}: SourceListProps): React.JSX.Element {
  // Sync activity vs. panel visibility are tracked separately (F1/F9): a
  // failed/canceled sync must free its queue slot immediately, but its panel
  // should stay on screen until the user dismisses it.
  //  - `mainActive`: what main reports is syncing right now (the scheduler, or
  //    another window). Hydrated on mount, on focus, and on `sources:changed`.
  //    Panels for these observe only — main already owns the sync, and its
  //    panel unmounts the moment main reports it gone from this set.
  //  - `startedLocally`: syncs this list is actively running right now — the
  //    set "Sync all" concurrency is measured against. `startedLocallyRef` is
  //    the synchronous mirror the queue reads so a burst of starts sees its
  //    own additions without waiting for a state flush. This shrinks the
  //    moment a sync *settles*, not when its panel is dismissed.
  //  - `shownLocally`: locally-owned panels that should stay mounted, each
  //    keyed to a generation number. Added alongside `startedLocally` but only
  //    removed on dismiss, so a settled panel can keep showing its result
  //    after its slot is already free. The generation forces a fresh
  //    SyncPanel (and a fresh `syncSource` call) if the same source is
  //    started again before its old, still-showing panel is dismissed.
  const [mainActive, setMainActive] = useState<Set<string>>(new Set());
  const [startedLocally, setStartedLocally] = useState<Set<string>>(new Set());
  const startedLocallyRef = useRef<Set<string>>(new Set());
  const [shownLocally, setShownLocally] = useState<Map<string, number>>(
    new Map(),
  );
  const nextGenRef = useRef(0);
  const queueRef = useRef<string[]>([]);

  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkRemoving, setBulkRemoving] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [docsCache, setDocsCache] = useState<Map<string, Document[]>>(
    new Map(),
  );
  const [loadingDocIds, setLoadingDocIds] = useState<Set<string>>(new Set());
  const onRefreshRef = useRef(onRefresh);

  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  const syncingIds = useMemo(
    () => new Set([...startedLocally, ...mainActive]),
    [startedLocally, mainActive],
  );

  const commitStartedLocally = useCallback(() => {
    setStartedLocally(new Set(startedLocallyRef.current));
  }, []);

  // Pull main's active-sync set. This is authoritative for syncs main owns; a
  // sync we started locally that main has not registered yet stays visible
  // because it also lives in `startedLocally`. A failed hydrate is swallowed —
  // it must not wipe locally-started syncs.
  const hydrateActive = useCallback(() => {
    window.api
      .getActiveSyncs()
      .then(({ active }) =>
        setMainActive(new Set(active.map((a) => a.sourceId))),
      )
      .catch(() => {});
  }, []);

  // Start as many queued Sync-all sources as there are free slots. Reads the
  // ref, not state, so a single pump can fill both slots at once.
  const pumpQueue = useCallback(() => {
    const slots = SYNC_ALL_CONCURRENCY - startedLocallyRef.current.size;
    if (slots <= 0 || queueRef.current.length === 0) return;
    const toStart = queueRef.current.splice(0, slots);
    for (const id of toStart) startedLocallyRef.current.add(id);
    commitStartedLocally();
    setShownLocally((prev) => {
      const next = new Map(prev);
      for (const id of toStart) next.set(id, ++nextGenRef.current);
      return next;
    });
  }, [commitStartedLocally]);

  const startLocalSync = useCallback(
    (id: string) => {
      // The Sync button is already `disabled={isSyncing}`, but a click can
      // still land after main (or a progress event) reports the source
      // active and before that re-render commits. Guard against `syncingIds`
      // as a whole, not just `startedLocallyRef` — a scheduler-started sync
      // living only in `mainActive` must not mount a second, locally-owned
      // panel destined to hit "Sync already in progress".
      if (syncingIds.has(id)) return;
      startedLocallyRef.current.add(id);
      commitStartedLocally();
      setShownLocally((prev) => new Map(prev).set(id, ++nextGenRef.current));
    },
    [commitStartedLocally, syncingIds],
  );

  // A locally-owned sync reached a terminal status (F1/F9): free its queue
  // slot right away so a waiting Sync-all source can take it. `shownLocally`
  // is untouched — the panel keeps showing the result until dismissed.
  const releaseSlot = useCallback(
    (id: string) => {
      if (startedLocallyRef.current.delete(id)) commitStartedLocally();
      pumpQueue();
    },
    [commitStartedLocally, pumpQueue],
  );

  // A panel was dismissed, or its source was removed: forget it everywhere
  // (queue slot, panel, main's active set) and let a waiting Sync-all source
  // take the freed slot. Every removal here is a no-op if `releaseSlot`
  // already ran for this id, so dismissing (or removing) a settled panel
  // never double-releases.
  const releaseSync = useCallback(
    (id: string) => {
      if (startedLocallyRef.current.delete(id)) commitStartedLocally();
      setShownLocally((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      setMainActive((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      queueRef.current = queueRef.current.filter((q) => q !== id);
      pumpQueue();
    },
    [commitStartedLocally, pumpQueue],
  );

  useEffect(() => {
    hydrateActive();
  }, [hydrateActive]);

  // A window brought to the foreground may have missed syncs that started (or
  // finished) while it was hidden.
  useEffect(() => {
    window.addEventListener("focus", hydrateActive);
    return () => window.removeEventListener("focus", hydrateActive);
  }, [hydrateActive]);

  // `sources:changed` is the authoritative "your view is stale" signal: refetch
  // the list (its per-source status just changed) and re-hydrate the active set
  // (a sync just started or ended).
  //
  // `sources:changed` only fires at sync *end* (sync-handlers.ts, scheduler.ts),
  // so a scheduler-started sync on an already-focused Sources tab is otherwise
  // invisible until it finishes. `sync:progress` is main's start-time signal —
  // it broadcasts for every active sync, manual or scheduler-started — so a
  // non-terminal event for a source not yet in `mainActive` adds it, and a
  // terminal one (`done`/`error`) removes it; `sources:changed` still does the
  // authoritative refetch a moment later. `setMainActive` bails out to the same
  // `prev` reference when membership is unchanged, so a burst of progress
  // events for a sync already tracked does not churn state or re-render.
  //
  // F11: `sources:changed` fires once per source completion, so a large
  // "Sync all" run can fire it in a tight burst — each occurrence re-runs the
  // `getAllSourcesWithCounts` join and re-hydrates the active set. That is
  // debounced (trailing, so the last event in a burst still refetches); the
  // `sync:progress` membership updates below are the prompt active-sync
  // indication (Task 3) and stay un-debounced.
  useEffect(() => {
    const debouncedSourcesChanged = debounce(() => {
      onRefreshRef.current();
      hydrateActive();
    }, 250);
    const unsubSources = window.api.onSourcesChanged(debouncedSourcesChanged);
    const unsubProgress = window.api.onSyncProgress((progress) => {
      const terminal = progress.phase === "done" || progress.phase === "error";
      setMainActive((prev) => {
        const has = prev.has(progress.sourceId);
        if (terminal) {
          if (!has) return prev;
          const next = new Set(prev);
          next.delete(progress.sourceId);
          return next;
        }
        if (has) return prev;
        const next = new Set(prev);
        next.add(progress.sourceId);
        return next;
      });
    });
    return () => {
      debouncedSourcesChanged.cancel();
      unsubSources();
      unsubProgress();
    };
  }, [hydrateActive]);

  const fetchDocs = useCallback(async (sourceId: string): Promise<void> => {
    setLoadingDocIds((prev) => new Set(prev).add(sourceId));
    try {
      const result = await window.api.listDocumentsBySource(sourceId);
      setDocsCache((prev) => new Map(prev).set(sourceId, result));
    } catch {
      setDocsCache((prev) => new Map(prev).set(sourceId, []));
    } finally {
      setLoadingDocIds((prev) => {
        const next = new Set(prev);
        next.delete(sourceId);
        return next;
      });
    }
  }, []);

  const prevSyncingRef = useRef<Set<string>>(new Set());

  // When a source stops syncing, its documents changed underneath us. Drop its
  // stale doc cache and, if it is expanded, refetch. (`sources:changed` already
  // refreshes the source list; this is only about the per-source doc list.)
  useEffect(() => {
    const justFinished = [...prevSyncingRef.current].filter(
      (id) => !syncingIds.has(id),
    );
    if (justFinished.length > 0) {
      setDocsCache((prev) => {
        const next = new Map(prev);
        for (const id of justFinished) next.delete(id);
        return next;
      });
      if (expandedId && justFinished.includes(expandedId)) {
        fetchDocs(expandedId);
      }
    }
    prevSyncingRef.current = new Set(syncingIds);
  }, [syncingIds, expandedId, fetchDocs]);

  function toggleSelect(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function toggleExpand(sourceId: string): Promise<void> {
    if (expandedId === sourceId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(sourceId);
    if (!docsCache.has(sourceId)) {
      await fetchDocs(sourceId);
    }
  }

  async function handleBulkRemove(): Promise<void> {
    if (selected.size === 0) return;
    const ids = [...selected];
    const count = ids.length;
    if (
      !confirm(
        `Remove ${count} source${count !== 1 ? "s" : ""}? All synced documents will be deleted.`,
      )
    ) {
      return;
    }
    setBulkRemoving(true);
    setError(null);
    // allSettled, not a loop that breaks on the first rejection: one failure
    // must not hide which of the others succeeded, nor strand the whole
    // selection. Mirrors ConnectNotionButton.handlePickAdd.
    const results = await Promise.allSettled(
      ids.map((id) => window.api.removeSource(id)),
    );
    const succeeded = ids.filter((_, i) => results[i].status === "fulfilled");
    const failed = ids.filter((_, i) => results[i].status === "rejected");

    for (const id of succeeded) releaseSync(id);
    setDocsCache((prev) => {
      const next = new Map(prev);
      for (const id of succeeded) next.delete(id);
      return next;
    });
    if (expandedId && succeeded.includes(expandedId)) setExpandedId(null);
    // Keep the failures selected so a retry is one click away; drop the rest.
    setSelected(new Set(failed));

    if (failed.length > 0) {
      const names = failed.map(
        (id) => sources.find((s) => s.id === id)?.name ?? id,
      );
      setError(`Failed to remove: ${names.join(", ")}`);
    }
    onRefreshRef.current();
    setBulkRemoving(false);
  }

  async function handleRemove(id: string): Promise<void> {
    if (!confirm("Remove this source? All synced documents will be deleted.")) {
      return;
    }
    setRemoving(id);
    setError(null);
    try {
      // `sources:remove` in main aborts any in-flight sync and waits for it to
      // unwind before deleting, so there is nothing to cancel here first.
      await window.api.removeSource(id);
      releaseSync(id);
      if (expandedId === id) setExpandedId(null);
      setDocsCache((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      onRefreshRef.current();
    } catch {
      setError("Failed to remove source.");
    } finally {
      setRemoving(null);
    }
  }

  const filtered = useMemo(
    () =>
      searchQuery
        ? sources.filter((s) =>
            s.name.toLowerCase().includes(searchQuery.toLowerCase()),
          )
        : sources,
    [sources, searchQuery],
  );

  function handleSyncAll(): void {
    const queued = new Set(queueRef.current);
    for (const s of filtered) {
      if (!syncingIds.has(s.id) && !queued.has(s.id)) {
        queueRef.current.push(s.id);
      }
    }
    pumpQueue();
  }

  if (sources.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        Add a source above to get started
      </p>
    );
  }

  const selecting = selected.size > 0;
  const allSyncing =
    filtered.length > 0 && filtered.every((s) => syncingIds.has(s.id));

  return (
    <div className="space-y-3">
      {error && (
        <ErrorBanner variant="error" onDismiss={() => setError(null)}>
          {error}
        </ErrorBanner>
      )}

      <div className="flex items-center gap-2">
        {label && (
          <h2 className="text-sm font-medium text-muted-foreground mr-auto">
            {selecting ? `${selected.size} selected` : label}
          </h2>
        )}
        {selecting ? (
          <>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setSelected(new Set())}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="xs"
              onClick={handleBulkRemove}
              loading={bulkRemoving}
            >
              Remove {selected.size}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setSelected(new Set(filtered.map((s) => s.id)))}
            >
              Select all
            </Button>
            <Button
              variant="outline"
              size="xs"
              onClick={handleSyncAll}
              disabled={allSyncing}
            >
              <RefreshCwIcon />
              Sync all
            </Button>
          </>
        )}
      </div>

      <div className="relative">
        <SearchIcon className="absolute left-2.5 top-1/2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        <Input
          type="search"
          size="sm"
          placeholder="Filter sources..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-5.5"
          nativeInput
        />
      </div>

      {filtered.map((source) => {
        const isExpanded = expandedId === source.id;
        // Real activity (for the Sync button, "Sync all", and the last-sync
        // status line) vs. panel visibility (for mounting SyncPanel) are
        // deliberately different: a settled sync frees `isSyncing` right
        // away, but its panel — `showPanel` — stays up until dismissed.
        const isSyncing = syncingIds.has(source.id);
        const localGen = shownLocally.get(source.id);
        const showPanel = localGen !== undefined || mainActive.has(source.id);
        const hasBottomPanel = showPanel || isExpanded;
        // Gate on `showPanel`, not just `isSyncing`: main broadcasts
        // `sources:changed` (refreshing `lastSyncStatus`) on every sync exit
        // path, including error/canceled, at roughly the same moment
        // `isSyncing` frees up — but the panel itself stays mounted until
        // dismissed. Without this, the row would show "Last sync failed"
        // right above a SyncPanel already showing the same failure.
        const statusMsg =
          isSyncing || showPanel ? null : syncStatusMessage(source);

        return (
          <div key={source.id}>
            <div
              className={`rounded-lg border border-border bg-card p-4 ${hasBottomPanel ? "rounded-b-none border-b-0" : ""}`}
            >
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  className="flex items-center cursor-pointer gap-3 min-w-0 text-left rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24"
                  onClick={() => !selecting && toggleExpand(source.id)}
                  disabled={selecting}
                >
                  {!selecting && (
                    <ChevronRightIcon
                      className={`size-4 shrink-0 text-muted-foreground transition-transform ${isExpanded ? "rotate-90" : ""}`}
                    />
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium text-sm truncate">
                        {source.name}
                      </h3>
                      <span className="shrink-0 rounded-md bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">
                        {providerLabel(source.provider)}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {source.documentCount} doc
                      {source.documentCount !== 1 ? "s" : ""} synced
                    </p>
                    {statusMsg && (
                      <p
                        className={cn(
                          "flex items-center gap-1 text-xs mt-0.5",
                          statusMsg.tone === "error" &&
                            "text-destructive-foreground",
                          statusMsg.tone === "warning" &&
                            "text-warning-foreground",
                          statusMsg.tone === "muted" && "text-muted-foreground",
                        )}
                      >
                        {statusMsg.tone !== "muted" && (
                          <AlertTriangleIcon className="size-3 shrink-0" />
                        )}
                        <span className="truncate">{statusMsg.text}</span>
                      </p>
                    )}
                  </div>
                </button>
                {selecting ? (
                  <Checkbox
                    checked={selected.has(source.id)}
                    onChange={() => toggleSelect(source.id)}
                  />
                ) : (
                  <div className="flex gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => startLocalSync(source.id)}
                      disabled={isSyncing}
                      title="Sync"
                    >
                      <RefreshCwIcon
                        className={isSyncing ? "animate-spin" : ""}
                      />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => handleRemove(source.id)}
                      loading={removing === source.id}
                      title="Remove"
                    >
                      <Trash2Icon />
                    </Button>
                  </div>
                )}
              </div>
            </div>
            {isExpanded && (
              <div className="rounded-b-lg border border-t-0 border-border bg-card px-4 pb-1">
                <VirtualList
                  className="max-h-64 overflow-y-auto"
                  items={docsCache.get(source.id) ?? []}
                  getKey={(doc) => doc.id}
                  estimatedRowHeight={40}
                  loading={
                    loadingDocIds.has(source.id) && !docsCache.has(source.id)
                  }
                  loadingState={
                    <div className="flex justify-center py-3">
                      <Spinner className="size-4 text-muted-foreground" />
                    </div>
                  }
                  emptyState={
                    <p className="text-xs text-muted-foreground py-3 text-center">
                      No documents synced
                    </p>
                  }
                  renderItem={(doc, index) => (
                    // Fixed height (box-border folds the separator into it) so a
                    // row with an "open" button and a row without stay the same
                    // height — the virtualizer assumes uniform rows.
                    <div
                      className={`flex h-10 items-center gap-2 ${
                        index > 0 ? "border-t border-border" : ""
                      }`}
                    >
                      <span
                        className={`size-1.5 shrink-0 rounded-full ${doc.syncStatus === "synced" ? "bg-success" : doc.syncStatus === "pending" ? "bg-warning" : "bg-destructive"}`}
                      />
                      <span className="text-sm truncate min-w-0 flex-1">
                        {doc.title}
                      </span>
                      {doc.url && (
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => void window.api.openExternal(doc.url!)}
                          title="Open source"
                        >
                          <ExternalLinkIcon />
                        </Button>
                      )}
                    </div>
                  )}
                />
              </div>
            )}
            {showPanel && (
              <SyncPanel
                // Keyed on the generation, not just the source id, so
                // restarting a source whose previous panel is still showing
                // a terminal result (F1/F9: its slot already freed, so the
                // Sync button re-enabled) remounts a fresh panel instead of
                // reusing one that already settled and won't sync again.
                key={localGen !== undefined ? `local-${localGen}` : "main"}
                sourceId={source.id}
                sourceName={source.name}
                autoStart={localGen !== undefined}
                onSettled={() => releaseSlot(source.id)}
                onComplete={() => releaseSync(source.id)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

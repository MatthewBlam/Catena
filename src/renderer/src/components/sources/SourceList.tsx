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
import type { SourceWithCount, Document } from "../../../../shared/types";
import { providerLabel } from "@renderer/lib/format";
import { cn } from "@renderer/lib/utils";

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
  // The set of sources showing a SyncPanel is the union of two truths:
  //  - `mainActive`: what main reports is syncing right now (the scheduler, or
  //    another window). Hydrated on mount, on focus, and on `sources:changed`.
  //    Panels for these observe only — main already owns the sync.
  //  - `startedLocally`: syncs this list kicked off. `startedLocallyRef` is the
  //    synchronous mirror the queue reads so a burst of starts sees its own
  //    additions without waiting for a state flush.
  const [mainActive, setMainActive] = useState<Set<string>>(new Set());
  const [startedLocally, setStartedLocally] = useState<Set<string>>(new Set());
  const startedLocallyRef = useRef<Set<string>>(new Set());
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
  }, [commitStartedLocally]);

  const startLocalSync = useCallback(
    (id: string) => {
      if (startedLocallyRef.current.has(id)) return;
      startedLocallyRef.current.add(id);
      commitStartedLocally();
    },
    [commitStartedLocally],
  );

  // A sync finished, or its source was removed: forget it everywhere and let a
  // waiting Sync-all source take the freed slot.
  const releaseSync = useCallback(
    (id: string) => {
      if (startedLocallyRef.current.delete(id)) commitStartedLocally();
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
  useEffect(() => {
    const unsub = window.api.onSourcesChanged(() => {
      onRefreshRef.current();
      hydrateActive();
    });
    return unsub;
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
        const isSyncing = syncingIds.has(source.id);
        const hasBottomPanel = isSyncing || isExpanded;
        const statusMsg = isSyncing ? null : syncStatusMessage(source);

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
                {loadingDocIds.has(source.id) && !docsCache.has(source.id) ? (
                  <div className="flex justify-center py-3">
                    <Spinner className="size-4 text-muted-foreground" />
                  </div>
                ) : (docsCache.get(source.id) ?? []).length === 0 ? (
                  <p className="text-xs text-muted-foreground py-3 text-center">
                    No documents synced
                  </p>
                ) : (
                  <ul className="divide-y divide-border">
                    {(docsCache.get(source.id) ?? []).map((doc) => (
                      <li
                        key={doc.id}
                        className="flex items-center gap-2 py-2 first:pt-1"
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
                            onClick={() =>
                              void window.api.openExternal(doc.url!)
                            }
                            title="Open source"
                          >
                            <ExternalLinkIcon />
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {isSyncing && (
              <SyncPanel
                sourceId={source.id}
                sourceName={source.name}
                autoStart={startedLocally.has(source.id)}
                onComplete={() => releaseSync(source.id)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

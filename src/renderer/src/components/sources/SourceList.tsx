import { useState, useEffect, useRef, useCallback } from "react";
import { Trash2Icon, RefreshCwIcon, ChevronRightIcon, ExternalLinkIcon, SearchIcon } from "lucide-react";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { SyncPanel } from "@renderer/components/sync/SyncPanel";
import { ErrorBanner } from "@renderer/components/ui/error-banner";
import { Spinner } from "@renderer/components/ui/spinner";
import type { SourceWithCount, Document } from "../../../../shared/types";
import { providerLabel } from "@renderer/lib/format";

interface SourceListProps {
  sources: SourceWithCount[];
  label?: string;
  onRefresh: () => void;
}

export function SourceList({ sources, label, onRefresh }: SourceListProps): React.JSX.Element {
  const [syncingIds, setSyncingIds] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkRemoving, setBulkRemoving] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [docsCache, setDocsCache] = useState<Map<string, Document[]>>(new Map());
  const [loadingDocIds, setLoadingDocIds] = useState<Set<string>>(new Set());
  const onRefreshRef = useRef(onRefresh);

  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  const prevSyncingRef = useRef<Set<string>>(new Set());

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

  useEffect(() => {
    const justFinished = [...prevSyncingRef.current].filter((id) => !syncingIds.has(id));
    if (justFinished.length > 0) {
      onRefreshRef.current();
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
    const count = selected.size;
    if (!confirm(`Remove ${count} source${count !== 1 ? "s" : ""}? All synced documents will be deleted.`)) {
      return;
    }
    setBulkRemoving(true);
    setError(null);
    try {
      for (const id of selected) {
        await window.api.removeSource(id);
      }
      if (expandedId && selected.has(expandedId)) setExpandedId(null);
      setDocsCache((prev) => {
        const next = new Map(prev);
        for (const id of selected) next.delete(id);
        return next;
      });
      setSelected(new Set());
    } catch {
      setError("Failed to remove some sources.");
    } finally {
      onRefreshRef.current();
      setBulkRemoving(false);
    }
  }

  async function handleRemove(id: string): Promise<void> {
    if (!confirm("Remove this source? All synced documents will be deleted.")) {
      return;
    }
    if (syncingIds.has(id)) {
      await window.api.cancelSync(id).catch(() => {});
      setSyncingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
    setRemoving(id);
    setError(null);
    try {
      await window.api.removeSource(id);
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

  if (sources.length === 0) {
    return <p className="text-sm text-muted-foreground py-8 text-center">Add a source above to get started</p>;
  }

  const filtered = searchQuery ? sources.filter((s) => s.name.toLowerCase().includes(searchQuery.toLowerCase())) : sources;
  const selecting = selected.size > 0;

  return (
    <div className="space-y-3">
      {error && (
        <ErrorBanner variant="error" onDismiss={() => setError(null)}>
          {error}
        </ErrorBanner>
      )}

      <div className="flex items-center gap-2">
        {label && <h2 className="text-sm font-medium text-muted-foreground mr-auto">{selecting ? `${selected.size} selected` : label}</h2>}
        {selecting ? (
          <>
            <Button variant="ghost" size="xs" onClick={() => setSelected(new Set())}>
              Cancel
            </Button>
            <Button variant="destructive" size="xs" onClick={handleBulkRemove} loading={bulkRemoving}>
              Remove {selected.size}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="xs" onClick={() => setSelected(new Set(filtered.map((s) => s.id)))}>
              Select all
            </Button>
            <Button
              variant="outline"
              size="xs"
              onClick={async () => {
                const notSyncing = filtered.filter((s) => !syncingIds.has(s.id)).map((s) => s.id);
                for (const id of notSyncing) {
                  setSyncingIds((prev) => new Set(prev).add(id));
                  await new Promise((r) => setTimeout(r, 500));
                }
              }}
              disabled={filtered.every((s) => syncingIds.has(s.id))}>
              <RefreshCwIcon />
              Sync all
            </Button>
          </>
        )}
      </div>

      <div className="relative">
        <SearchIcon className="absolute left-2.5 top-1/2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        <Input type="search" size="sm" placeholder="Filter sources..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-5.5" nativeInput />
      </div>

      {filtered.map((source) => {
        const isExpanded = expandedId === source.id;
        const isSyncing = syncingIds.has(source.id);
        const hasBottomPanel = isSyncing || isExpanded;

        return (
          <div key={source.id}>
            <div className={`rounded-lg border border-border bg-card p-4 ${hasBottomPanel ? "rounded-b-none border-b-0" : ""}`}>
              <div className="flex items-center justify-between gap-3">
                <button type="button" className="flex items-center cursor-pointer gap-3 min-w-0 text-left rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24" onClick={() => !selecting && toggleExpand(source.id)} disabled={selecting}>
                  {!selecting && <ChevronRightIcon className={`size-4 shrink-0 text-muted-foreground transition-transform ${isExpanded ? "rotate-90" : ""}`} />}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-medium text-sm truncate">{source.name}</h3>
                      <span className="shrink-0 rounded-md bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">{providerLabel(source.provider)}</span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {source.documentCount} doc
                      {source.documentCount !== 1 ? "s" : ""} synced
                    </p>
                  </div>
                </button>
                {selecting ? (
                  <Checkbox checked={selected.has(source.id)} onChange={() => toggleSelect(source.id)} />
                ) : (
                  <div className="flex gap-1 shrink-0">
                    <Button variant="ghost" size="icon-xs" onClick={() => setSyncingIds((prev) => new Set(prev).add(source.id))} disabled={isSyncing} title="Sync">
                      <RefreshCwIcon className={isSyncing ? "animate-spin" : ""} />
                    </Button>
                    <Button variant="ghost" size="icon-xs" onClick={() => handleRemove(source.id)} loading={removing === source.id} title="Remove">
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
                  <p className="text-xs text-muted-foreground py-3 text-center">No documents synced</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {(docsCache.get(source.id) ?? []).map((doc) => (
                      <li key={doc.id} className="flex items-center gap-2 py-2 first:pt-1">
                        <span className={`size-1.5 shrink-0 rounded-full ${doc.syncStatus === "synced" ? "bg-success" : doc.syncStatus === "pending" ? "bg-warning" : "bg-destructive"}`} />
                        <span className="text-sm truncate min-w-0 flex-1">{doc.title}</span>
                        {doc.url && (
                          <Button variant="ghost" size="icon-xs" onClick={() => window.api.openExternal(doc.url!)} title="Open source">
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
                onComplete={() => {
                  setSyncingIds((prev) => {
                    const next = new Set(prev);
                    next.delete(source.id);
                    return next;
                  });
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

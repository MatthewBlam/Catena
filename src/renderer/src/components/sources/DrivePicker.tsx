import { useEffect, useMemo, useRef, useState, Fragment } from "react";
import {
  FolderIcon,
  FileTextIcon,
  ChevronRightIcon,
  SearchIcon,
} from "lucide-react";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Spinner } from "@renderer/components/ui/spinner";
import { ErrorBanner } from "@renderer/components/ui/error-banner";
import { VirtualList } from "@renderer/components/ui/VirtualList";
import { toErrorMessage, authAwareMessage } from "@renderer/lib/errors";
import type { DriveItemSummary } from "../../../../shared/types";

interface DrivePickerProps {
  onAdd: (
    selections: Array<{ id: string; name: string }>,
  ) => Promise<{ added: number; failed: number }>;
  onClose: () => void;
}

interface Breadcrumb {
  id: string;
  name: string;
}

export function DrivePicker({
  onAdd,
  onClose,
}: DrivePickerProps): React.JSX.Element {
  const [items, setItems] = useState<DriveItemSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const [adding, setAdding] = useState(false);
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([
    { id: "root", name: "My Drive" },
  ]);
  const [searchQuery, setSearchQuery] = useState("");
  // A monotonic request id, not a single boolean: navigating A (slow) then B
  // (fast) must not let A's late response clobber B's contents while the
  // breadcrumbs read B — which would add a source under the wrong parent. Only
  // the newest request writes state. mountedRef additionally suppresses writes
  // after unmount. (Bump the id *before* the cache check so a synchronous
  // cache-hit navigation also invalidates any still-pending async fetch.)
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const cacheRef = useRef(new Map<string, DriveItemSummary[]>());

  async function fetchFolder(
    folderId: string,
    skipCache?: boolean,
  ): Promise<void> {
    const id = ++requestIdRef.current;

    if (!skipCache) {
      const cached = cacheRef.current.get(folderId);
      if (cached) {
        setItems(cached);
        setLoading(false);
        setError(null);
        return;
      }
    }

    setLoading(true);
    setError(null);
    try {
      const result = await window.api.listDriveItems(
        folderId === "root" ? undefined : folderId,
      );
      if (!mountedRef.current || id !== requestIdRef.current) return;
      cacheRef.current.set(folderId, result);
      setItems(result);
    } catch (err) {
      if (!mountedRef.current || id !== requestIdRef.current) return;
      const msg = toErrorMessage(err, "Failed to load Drive items");
      setError(authAwareMessage(msg));
    } finally {
      if (mountedRef.current && id === requestIdRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    // Reset on every run, not just declaration: StrictMode mounts, unmounts
    // (flipping this false), then remounts — without the reset the remounted
    // instance would treat itself as unmounted and never write.
    mountedRef.current = true;
    void fetchFolder("root");
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function navigateInto(folder: DriveItemSummary): void {
    setSearchQuery("");
    setBreadcrumbs((prev) => [...prev, { id: folder.id, name: folder.name }]);
    void fetchFolder(folder.id);
  }

  function navigateTo(index: number): void {
    setSearchQuery("");
    setBreadcrumbs((prev) => prev.slice(0, index + 1));
    const targetId = breadcrumbs[index].id;
    void fetchFolder(targetId);
  }

  function toggleSelect(folder: DriveItemSummary): void {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(folder.id)) next.delete(folder.id);
      else next.set(folder.id, folder.name);
      return next;
    });
  }

  async function handleAdd(): Promise<void> {
    const selections = Array.from(selected.entries()).map(([id, name]) => ({
      id,
      name,
    }));
    setAdding(true);
    try {
      const result = await onAdd(selections);
      if (result.added > 0) setSelected(new Map());
    } finally {
      setAdding(false);
    }
  }

  const filtered = useMemo(
    () =>
      searchQuery
        ? items.filter((i) =>
            i.name.toLowerCase().includes(searchQuery.toLowerCase()),
          )
        : items,
    [items, searchQuery],
  );
  const folders = useMemo(() => filtered.filter((i) => i.isFolder), [filtered]);
  const files = useMemo(() => filtered.filter((i) => !i.isFolder), [filtered]);
  // Folders first, then files — one flat list to virtualize, since only its
  // visible slice is in the DOM. `renderItem` still branches on `isFolder`.
  const rows = useMemo(() => [...folders, ...files], [folders, files]);
  const allFoldersSelected =
    folders.length > 0 && folders.every((f) => selected.has(f.id));

  function toggleSelectAll(): void {
    setSelected((prev) => {
      if (allFoldersSelected) {
        const next = new Map(prev);
        for (const f of folders) next.delete(f.id);
        return next;
      }
      const next = new Map(prev);
      for (const f of folders) next.set(f.id, f.name);
      return next;
    });
  }

  if (error) {
    return (
      <div className="space-y-3">
        <ErrorBanner>{error}</ErrorBanner>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              fetchFolder(breadcrumbs[breadcrumbs.length - 1].id, true)
            }
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Select folders to sync</p>

      <div className="relative">
        <SearchIcon className="absolute left-2.5 top-1/2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        <Input
          type="search"
          size="sm"
          placeholder="Filter..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-5.5"
          nativeInput
        />
      </div>

      <div className="space-y-1.5">
        {!loading && folders.length > 0 && (
          <div className="flex items-center">
            <button
              type="button"
              onClick={toggleSelectAll}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {allFoldersSelected ? "Deselect all" : "Select all"}
            </button>
            {selected.size > 0 && !allFoldersSelected && (
              <button
                type="button"
                onClick={() => setSelected(new Map())}
                className="ml-auto text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Clear selection
              </button>
            )}
          </div>
        )}

        <VirtualList
          className="max-h-64 overflow-y-auto rounded-lg border border-input"
          items={rows}
          getKey={(item) => item.id}
          loading={loading}
          loadingState={
            <div className="flex items-center justify-center py-8">
              <Spinner className="size-5 text-muted-foreground" />
            </div>
          }
          emptyState={
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {searchQuery ? "No results found" : "This folder is empty."}
            </p>
          }
          renderItem={(item, index) => {
            // Row border is per-item now (dropped on the last) since virtualized
            // rows are not DOM siblings for `last:border-b-0` to reach.
            const border =
              index < rows.length - 1 ? "border-b border-input" : "";
            return item.isFolder ? (
              <div
                className={`flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-accent/50 transition-colors ${border}`}
              >
                <Checkbox
                  checked={selected.has(item.id)}
                  onChange={() => toggleSelect(item)}
                />
                <button
                  type="button"
                  onClick={() => navigateInto(item)}
                  className="flex flex-1 items-center gap-2 text-left min-w-0"
                >
                  <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{item.name}</span>
                  <ChevronRightIcon className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
                </button>
              </div>
            ) : (
              <div
                className={`flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground ${border}`}
              >
                <div className="size-4 shrink-0" />
                <FileTextIcon className="size-4 shrink-0" />
                <span className="truncate">{item.name}</span>
              </div>
            );
          }}
        />
      </div>

      <div className="-ml-1 -mt-1.5 flex items-center gap-0.5 text-xs text-muted-foreground overflow-x-auto">
        {breadcrumbs.map((crumb, i) => (
          <Fragment key={crumb.id}>
            {i > 0 && <ChevronRightIcon className="size-3 shrink-0" />}
            <button
              type="button"
              onClick={() => navigateTo(i)}
              className={`shrink-0 rounded px-1 py-0.5 hover:text-foreground transition-colors ${i === breadcrumbs.length - 1 ? "text-foreground font-medium" : ""}`}
            >
              {crumb.name}
            </button>
          </Fragment>
        ))}
      </div>

      <div className="flex gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
        <Button
          size="sm"
          onClick={handleAdd}
          disabled={selected.size === 0 || adding}
        >
          {adding
            ? "Adding…"
            : selected.size === 0
              ? "Add sources"
              : `Add ${selected.size} source${selected.size !== 1 ? "s" : ""}`}
        </Button>
      </div>
    </div>
  );
}

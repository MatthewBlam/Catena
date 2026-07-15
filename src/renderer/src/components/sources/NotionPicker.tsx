import { useEffect, useRef, useState } from "react";
import { FileTextIcon, DatabaseIcon, SearchIcon } from "lucide-react";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Spinner } from "@renderer/components/ui/spinner";
import { ErrorBanner } from "@renderer/components/ui/error-banner";
import type { NotionItemSummary } from "../../../../shared/types";

interface NotionPickerProps {
  onAdd: (
    selections: Array<{ id: string; name: string }>,
  ) => Promise<{ added: number; failed: number }>;
  onClose: () => void;
}

export function NotionPicker({
  onAdd,
  onClose,
}: NotionPickerProps): React.JSX.Element {
  const [items, setItems] = useState<NotionItemSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const [adding, setAdding] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const cancelRef = useRef(false);

  const fetchItems = useRef(() => {
    cancelRef.current = false;
    setLoading(true);
    setError(null);
    window.api
      .listNotionPages()
      .then((result) => {
        if (!cancelRef.current) setItems(result);
      })
      .catch((err: unknown) => {
        if (!cancelRef.current) {
          const msg =
            err instanceof Error ? err.message : "Failed to load Notion pages";
          setError(
            msg.includes("401") || msg.toLowerCase().includes("unauthorized")
              ? "Session expired — please reconnect in Settings."
              : msg,
          );
        }
      })
      .finally(() => {
        if (!cancelRef.current) setLoading(false);
      });
  });

  useEffect(() => {
    fetchItems.current();
    return () => {
      cancelRef.current = true;
    };
  }, []);

  const filtered = searchQuery
    ? items.filter((i) =>
        i.title.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : items;
  const allFilteredSelected =
    filtered.length > 0 && filtered.every((i) => selected.has(i.id));

  function toggleSelectAll(): void {
    setSelected((prev) => {
      if (allFilteredSelected) {
        const next = new Map(prev);
        for (const item of filtered) next.delete(item.id);
        return next;
      }
      const next = new Map(prev);
      for (const item of filtered) next.set(item.id, item.title);
      return next;
    });
  }

  function toggleSelect(item: NotionItemSummary): void {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.set(item.id, item.title);
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
            onClick={() => fetchItems.current()}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Select pages to sync</p>

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
        {!loading && filtered.length > 0 && (
          <div className="flex items-center">
            <button
              type="button"
              onClick={toggleSelectAll}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {allFilteredSelected ? "Deselect all" : "Select all"}
            </button>
            {selected.size > 0 && !allFilteredSelected && (
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

        <div className="max-h-64 overflow-y-auto rounded-lg border border-input">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Spinner className="size-5 text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {searchQuery ? "No results found" : "No pages found"}
            </p>
          ) : (
            filtered.map((item) => (
              // H8: a bare <div onClick> with a Checkbox that had no `onChange`
              // was invisible to the keyboard — the checkbox degraded to a
              // non-focusable span and nothing else was tabbable, so setup could
              // not be completed without a mouse. This mirrors DrivePicker: a
              // real checkbox plus a real button, both operable.
              <div
                key={item.id}
                className="flex items-center gap-2.5 border-b border-input px-3 py-2 text-sm hover:bg-accent/50 transition-colors last:border-b-0"
              >
                <Checkbox
                  checked={selected.has(item.id)}
                  onChange={() => toggleSelect(item)}
                />
                <button
                  type="button"
                  onClick={() => toggleSelect(item)}
                  className="flex flex-1 items-center gap-2.5 text-left min-w-0 rounded outline-none focus-visible:ring-[3px] focus-visible:ring-ring/24"
                >
                  {item.icon ? (
                    <span className="text-base shrink-0">{item.icon}</span>
                  ) : item.isDatabase ? (
                    <DatabaseIcon className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{item.title}</span>
                </button>
              </div>
            ))
          )}
        </div>
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

import { useEffect, useRef, useState } from "react";
import { FileTextIcon, DatabaseIcon, SearchIcon } from "lucide-react";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Spinner } from "@renderer/components/ui/spinner";
import { ErrorBanner } from "@renderer/components/ui/error-banner";
import { VirtualList } from "@renderer/components/ui/VirtualList";
import { ConfirmDialog } from "@renderer/components/ui/confirm-dialog";
import { toErrorMessage, authAwareMessage } from "@renderer/lib/errors";
import type {
  NotionItemSummary,
  NotionOAuthStarted,
  OrphanedNotionSource,
} from "../../../../shared/types";

/** One label for the three places this flow can be started from. */
const REAUTH_LABEL = "Choose pages in Notion…";

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
  const [reauthorizing, setReauthorizing] = useState(false);
  // Kept apart from `error`, which is fatal and replaces the whole picker: a
  // re-authorization that fails leaves the already-loaded list perfectly usable,
  // so it must not take the list down with it.
  const [reauthError, setReauthError] = useState<string | null>(null);
  const [switchPrompt, setSwitchPrompt] = useState<NonNullable<
    NotionOAuthStarted["workspaceSwitch"]
  > | null>(null);
  // Shown *before* the browser opens. Notion's picker replaces the whole grant
  // and opens unchecked, so sending the user in without telling them what to
  // re-tick is what silently drops their existing pages.
  const [confirmReauth, setConfirmReauth] = useState(false);
  const [connectedNames, setConnectedNames] = useState<string[]>([]);
  const [orphaned, setOrphaned] = useState<OrphanedNotionSource[]>([]);
  // ConfirmDialog's cancel is a bare Close with no callback — it only reports
  // `onOpenChange(false)`, the same thing Escape does. This records whether the
  // close came from the confirm button, so a dismissal is not read as consent.
  const switchAcceptedRef = useRef(false);
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
          const msg = toErrorMessage(err, "Failed to load Notion pages.");
          setError(authAwareMessage(msg));
        }
      })
      .finally(() => {
        if (!cancelRef.current) setLoading(false);
      });
  });

  useEffect(() => {
    fetchItems.current();
    // The names the user must keep ticked in Notion's picker. Sources, not the
    // full grant: a granted page nobody made a source of costs nothing to lose.
    window.api
      .listSources()
      .then((sources) => {
        if (cancelRef.current) return;
        setConnectedNames(
          sources.filter((s) => s.provider === "notion").map((s) => s.name),
        );
      })
      .catch(() => {});
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

  /**
   * Re-runs Notion's page picker, the only way a *public* connection's page
   * access can change (the per-page "Add connections" menu is internal-only).
   *
   * The picker opens with nothing selected and the selection it returns becomes
   * the complete grant — it does not add to the previous one. So this is a
   * destructive operation wearing an additive-looking hat, which is why it is
   * gated behind `confirmReauth` and audited by `checkAccess` afterwards.
   */
  async function handleReauthorize(): Promise<void> {
    setReauthError(null);
    setOrphaned([]);
    setReauthorizing(true);
    try {
      const result = await window.api.startNotionOAuth();
      if (cancelRef.current) return;
      if (result.workspaceSwitch) {
        // Main is withholding the new token until this is answered. Reloading
        // now would query the *old* workspace and read as "nothing happened".
        setSwitchPrompt(result.workspaceSwitch);
        return;
      }
      fetchItems.current();
      void checkAccess();
    } catch (err) {
      if (cancelRef.current) return;
      const msg = toErrorMessage(err, "Failed to connect to Notion.");
      // Cancelling is a decision, not a failure — same convention as
      // ConnectNotionButton, which also swallows this one message.
      if (msg !== "OAuth canceled") setReauthError(authAwareMessage(msg));
    } finally {
      if (!cancelRef.current) setReauthorizing(false);
    }
  }

  /**
   * Audits what the new grant actually covers. Without this a dropped page is
   * invisible until the next sync fails — the source still lists its old
   * document count and looks perfectly healthy.
   */
  async function checkAccess(): Promise<void> {
    try {
      const lost = await window.api.checkNotionSourceAccess();
      if (!cancelRef.current) setOrphaned(lost);
    } catch {
      // An audit that fails must not look like an audit that passed, but it also
      // must not block the flow; the next sync still reports the real failure.
    }
  }

  function handleCancelReauthorize(): void {
    // Drop the waiting state immediately; the rejection this triggers arrives
    // as "OAuth canceled" and is swallowed above.
    setReauthorizing(false);
    window.api.cancelNotionOAuth().catch(() => {});
  }

  function handleSwitchOpenChange(open: boolean): void {
    if (open) return;
    const accepted = switchAcceptedRef.current;
    switchAcceptedRef.current = false;
    setSwitchPrompt(null);
    window.api
      .resolveNotionWorkspaceSwitch(accepted)
      .then(() => {
        // Only a committed switch changes what Notion will return; declining
        // leaves the original connection exactly as it was.
        if (accepted && !cancelRef.current) {
          fetchItems.current();
          void checkAccess();
        }
      })
      .catch(() => {});
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
      {orphaned.length > 0 && (
        <ErrorBanner variant="warning" onDismiss={() => setOrphaned([])}>
          <div className="space-y-2">
            <p>
              Catena no longer has access to{" "}
              {orphaned.map((o) => o.name).join(", ")}. Notion&apos;s picker
              replaced the previous selection, so{" "}
              {orphaned.length === 1 ? "this source" : "these sources"} will
              stop syncing until you grant{" "}
              {orphaned.length === 1 ? "it" : "them"} again.
            </p>
            <Button
              variant="outline"
              size="xs"
              onClick={() => setConfirmReauth(true)}
            >
              {REAUTH_LABEL}
            </Button>
          </div>
        </ErrorBanner>
      )}

      <p className="text-sm text-muted-foreground">Select pages to sync</p>

      <div className="relative">
        <SearchIcon className="absolute left-2.5 top-1/2 z-10 size-3.5 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        <Input
          type="search"
          size="sm"
          placeholder="Filter"
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

        <VirtualList
          className="max-h-64 overflow-y-auto rounded-lg border border-input"
          items={filtered}
          getKey={(item) => item.id}
          loading={loading}
          loadingState={
            <div className="flex items-center justify-center py-8">
              <Spinner className="size-5 text-muted-foreground" />
            </div>
          }
          emptyState={
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {searchQuery ? "No results found." : "No pages found."}
            </p>
          }
          renderItem={(item, index) => (
            // H8: a bare <div onClick> with a Checkbox that had no `onChange`
            // was invisible to the keyboard — the checkbox degraded to a
            // non-focusable span and nothing else was tabbable, so setup could
            // not be completed without a mouse. This mirrors DrivePicker: a
            // real checkbox plus a real button, both operable. (The row border
            // is per-item now, dropped on the last, since virtualized rows are
            // not DOM siblings for `last:` to reach.)
            <div
              className={`flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-accent/50 transition-colors ${
                index < filtered.length - 1 ? "border-b border-input" : ""
              }`}
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
          )}
        />
      </div>

      {/* Below the list rather than inside the empty state, so the one control
          covers both "my page is missing" and "no pages at all" — the latter
          used to be a dead end. */}
      {reauthorizing ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          <span>Waiting for Notion authorization…</span>
          <Button
            className="ml-auto"
            variant="destructive-outline"
            size="xs"
            onClick={handleCancelReauthorize}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            Don&apos;t see a page?
          </span>
          <Button
            variant="outline"
            size="xs"
            onClick={() => setConfirmReauth(true)}
          >
            {REAUTH_LABEL}
          </Button>
        </div>
      )}

      {reauthError && <ErrorBanner>{reauthError}</ErrorBanner>}

      <ConfirmDialog
        open={confirmReauth}
        onOpenChange={setConfirmReauth}
        title="Notion replaces your page selection"
        confirmLabel="Open Notion"
        confirmVariant="destructive"
        cancelVariant="default"
        onConfirm={() => {
          void handleReauthorize();
        }}
      >
        <p>
          Notion&apos;s picker opens with <strong>nothing selected</strong>, and
          whatever you tick becomes the complete list Catena can read. Any page
          you don&apos;t re-tick loses access.
        </p>
        {connectedNames.length > 0 && (
          <>
            <p>Keep these ticked, or their sources stop syncing:</p>
            <ul className="max-h-32 overflow-y-auto rounded-md border border-input px-3 py-2 text-foreground">
              {connectedNames.map((name) => (
                <li key={name} className="truncate">
                  {name}
                </li>
              ))}
            </ul>
          </>
        )}
        <p>
          Tip: selecting a <strong>parent page</strong> also covers everything
          inside it, so you rarely need to come back here.
        </p>
      </ConfirmDialog>

      {switchPrompt && (
        <ConfirmDialog
          open
          onOpenChange={handleSwitchOpenChange}
          title="Switch Notion workspace?"
          confirmLabel="Switch anyway"
          confirmVariant="destructive"
          // The safe path is the prominent one: staying put costs nothing,
          // switching orphans real sources.
          cancelVariant="default"
          onConfirm={() => {
            switchAcceptedRef.current = true;
          }}
        >
          <p>
            You authorized{" "}
            <strong>{switchPrompt.nextName || "another workspace"}</strong>, but
            your existing sources come from{" "}
            <strong>
              {switchPrompt.previousName || "a different workspace"}
            </strong>
            .
          </p>
          <p>
            Switching will stop {switchPrompt.sourceCount} Notion source
            {switchPrompt.sourceCount === 1 ? "" : "s"} from syncing. Your
            current connection stays as it is unless you continue.
          </p>
        </ConfirmDialog>
      )}

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

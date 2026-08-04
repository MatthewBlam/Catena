import { useEffect, useState, useRef, useCallback } from "react";
import { SunIcon, MoonIcon } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Switch } from "@renderer/components/ui/switch";
import { ErrorBanner } from "@renderer/components/ui/error-banner";
import { ConfirmDialog } from "@renderer/components/ui/confirm-dialog";
import { CohereIcon, OllamaIcon } from "@renderer/components/brand-icons";
import { OllamaInstallPanel } from "@renderer/components/setup/OllamaInstallPanel";
import { debounce } from "@renderer/lib/utils";
import { formatRelativeTime } from "@renderer/lib/format";
import { openExternal } from "@renderer/lib/openExternal";
import type { StorageStats, OllamaStatusDetail } from "../../../shared/types";

interface SettingsPageProps {
  visible: boolean;
  dark: boolean;
  onToggleTheme: () => void;
  onProviderReset: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function SettingsPage({ visible, dark, onToggleTheme, onProviderReset }: SettingsPageProps): React.JSX.Element {
  const [provider, setProvider] = useState<string>("cohere");
  const [hasKey, setHasKey] = useState(false);
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [newKey, setNewKey] = useState("");
  const [validating, setValidating] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keySuccess, setKeySuccess] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [disconnectingNotion, setDisconnectingNotion] = useState(false);
  const [disconnectingDrive, setDisconnectingDrive] = useState(false);
  const [hasNotion, setHasNotion] = useState(false);
  const [hasDrive, setHasDrive] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(false);
  const [autoSyncInterval, setAutoSyncInterval] = useState(30 * 60 * 1000);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [autoSyncing, setAutoSyncing] = useState(false);
  const [telemetryEnabled, setTelemetryEnabled] = useState(true);
  const [showTelemetryConfirm, setShowTelemetryConfirm] = useState(false);
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatusDetail | null>(null);
  const [uninstalling, setUninstalling] = useState(false);
  const [showUninstallConfirm, setShowUninstallConfirm] = useState(false);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevVisibleRef = useRef(false);
  // Separate from `prevVisibleRef` above: that ref is updated inside the
  // `refresh()` effect, which runs (and mutates it) before this effect on the
  // same render, so sharing it would make the "just became visible" check
  // below always see the already-updated value. Own ref, own transition.
  const prevSyncVisibleRef = useRef(false);

  // Every reader of settings state in one place, so anything that changes it —
  // becoming visible, clearing all data — can put the UI back in sync with a
  // single call instead of hand-patching individual fields.
  const refresh = useCallback((): void => {
    Promise.all([
      window.api.getEmbeddingProvider(),
      window.api.hasSecret("cohere_api_key"),
      window.api.getStorageStats(),
      window.api.getAutoSync(),
      window.api.hasSecret("notion_token"),
      window.api.hasSecret("google_tokens"),
      window.api.getTelemetryEnabled(),
      window.api.getOllamaStatusDetail(),
    ])
      .then(([p, keyPresent, s, sync, notion, drive, telemetry, ollama]) => {
        setProvider(p);
        setHasKey(keyPresent);
        setStats(s);
        setAutoSyncEnabled(sync.enabled);
        setAutoSyncInterval(sync.intervalMs);
        setLastSyncedAt(sync.lastSyncedAt);
        setAutoSyncing(sync.syncing);
        setHasNotion(notion);
        setHasDrive(drive);
        setTelemetryEnabled(telemetry);
        setOllamaStatus(ollama);
        setLoadError(null);
      })
      .catch(() => {
        setLoadError("Failed to load settings.");
      });
  }, []);

  useEffect(() => {
    if (visible && !prevVisibleRef.current) {
      refresh();
    }
    prevVisibleRef.current = visible;
  }, [visible, refresh]);

  // M11: the auto-sync line was a one-shot snapshot, so a background sync left it
  // reading "Syncing now…" forever. Refetch the scheduler's live state whenever a
  // sync makes progress or the source list changes. Only the sync-status fields
  // are touched — the user-controlled enabled/interval must not be clobbered by a
  // progress event mid-toggle. This split from `refresh()` above is deliberate
  // and must stay that way: `refresh()` overwrites every field from a single
  // snapshot, so folding it in here would let a progress event mid-toggle
  // clobber `autoSyncEnabled`/`autoSyncInterval` with a stale read.
  //
  // F11: `sync:progress` fires ~4 times per document, so a large sync is a
  // `getAutoSync()` IPC round-trip per progress event. Debounced (trailing, so
  // the terminal event still lands) and skipped entirely while the page is not
  // visible — nothing on screen depends on this state when the tab is not
  // showing. Becoming visible re-syncs once, immediately, so switching back
  // mid-sync (or right after one settles) does not wait out a stale debounce
  // window for state that was never refetched while hidden.
  useEffect(() => {
    const doRefetch = (): void => {
      window.api
        .getAutoSync()
        .then((sync) => {
          setLastSyncedAt(sync.lastSyncedAt);
          setAutoSyncing(sync.syncing);
        })
        .catch(() => {});
    };
    const debouncedRefetch = debounce(doRefetch, 300);
    const refetchSyncState = (): void => {
      if (visible) debouncedRefetch();
    };
    const unsubProgress = window.api.onSyncProgress(refetchSyncState);
    const unsubSources = window.api.onSourcesChanged(refetchSyncState);

    if (visible && !prevSyncVisibleRef.current) {
      doRefetch();
    }
    prevSyncVisibleRef.current = visible;

    return () => {
      debouncedRefetch.cancel();
      unsubProgress();
      unsubSources();
    };
  }, [visible]);

  useEffect(() => {
    return () => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
    };
  }, []);

  async function handleUpdateKey(): Promise<void> {
    const trimmed = newKey.trim();
    if (!trimmed) return;
    setValidating(true);
    setKeyError(null);
    setKeySuccess(false);

    try {
      const result = await window.api.validateCohereKey(trimmed);
      if (result.valid) {
        await window.api.saveSecret("cohere_api_key", trimmed);
        setHasKey(true);
        setNewKey("");
        setKeySuccess(true);
        if (successTimerRef.current) clearTimeout(successTimerRef.current);
        successTimerRef.current = setTimeout(() => setKeySuccess(false), 3000);
      } else {
        setKeyError("Invalid API key. Please check and try again.");
      }
    } catch {
      setKeyError("Failed to validate key. Check your connection.");
    } finally {
      setValidating(false);
    }
  }

  async function handleRemoveKey(): Promise<void> {
    if (!confirm("Remove your Cohere API key? Search will be disabled until you add a " + "new key. Your synced documents stay on this device.")) return;
    try {
      await window.api.deleteSecret("cohere_api_key");
      // M12: deliberately NOT onProviderReset() — that flips App to ready=false,
      // which unmounts everything for the OnboardingWizard and throws away the
      // user's place in Settings. The "no key" banner below already tells them
      // search is off; they can add a key without leaving the page.
      setHasKey(false);
    } catch {
      setKeyError("Failed to remove key.");
    }
  }

  async function handleSwitchProvider(newProvider: "cohere" | "ollama"): Promise<void> {
    if (newProvider === provider) return;
    // A null `stats` means the count fetch failed — we cannot rule out that
    // there are chunks to invalidate, so prompt anyway. (The old `stats && …`
    // guard let a failed fetch skip the confirm entirely.)
    const mayHaveChunks = !stats || stats.chunkCount > 0;
    if (mayHaveChunks && !confirm("Switching providers requires re-embedding all documents. Continue?")) return;
    try {
      await window.api.setEmbeddingProvider(newProvider);
      setProvider(newProvider);
      // H12: re-evaluate readiness in BOTH directions. Switching to a provider
      // that is not configured (Ollama not installed, or Cohere with no key)
      // must not leave stale readiness state so every search fails silently at
      // the embedder. The user stays in the app either way — App's wizard
      // gates on onboarding only, and SearchPage re-checks provider readiness
      // itself and renders its disabled state until the provider is set up.
      onProviderReset();
    } catch {
      setLoadError("Failed to switch provider.");
    }
  }

  async function handleToggleAutoSync(enabled: boolean): Promise<void> {
    try {
      await window.api.setAutoSyncEnabled(enabled);
      setAutoSyncEnabled(enabled);
    } catch {
      setLoadError("Failed to update auto-sync setting.");
    }
  }

  async function handleSetSyncInterval(ms: number): Promise<void> {
    try {
      await window.api.setAutoSyncInterval(ms);
      setAutoSyncInterval(ms);
    } catch {
      setLoadError("Failed to update sync interval.");
    }
  }

  async function applyTelemetry(next: boolean): Promise<void> {
    // Optimistic, then reconciled: a switch that does not move under the cursor
    // feels broken. If the write fails we put it back rather than leave the UI
    // claiming a setting that was never saved.
    setTelemetryEnabled(next);
    try {
      await window.api.setTelemetryEnabled(next);
    } catch {
      setTelemetryEnabled(!next);
      setLoadError("Failed to update analytics setting.");
    }
  }

  function handleToggleTelemetry(next: boolean): void {
    // Turning analytics OFF opens a confirmation first — it is the one privacy
    // control whose value to the project the user cannot see, so it is worth a
    // moment's explanation. The switch stays visually on (we don't touch state)
    // until the choice is confirmed. Turning it back on is frictionless.
    if (!next) {
      setShowTelemetryConfirm(true);
      return;
    }
    void applyTelemetry(true);
  }

  async function handleDisconnectNotion(): Promise<void> {
    if (!confirm("Disconnect Notion? You will need to re-authenticate to sync Notion sources.")) return;
    setDisconnectingNotion(true);
    try {
      await window.api.deleteSecret("notion_token");
      setHasNotion(false);
    } catch {
      setLoadError("Failed to disconnect Notion.");
    } finally {
      setDisconnectingNotion(false);
    }
  }

  async function handleDisconnectDrive(): Promise<void> {
    if (!confirm("Disconnect Google Drive? You will need to re-authenticate to sync Drive sources.")) return;
    setDisconnectingDrive(true);
    try {
      await window.api.deleteSecret("google_tokens");
      setHasDrive(false);
    } catch {
      setLoadError("Failed to disconnect Google Drive.");
    } finally {
      setDisconnectingDrive(false);
    }
  }

  async function handleClearAllData(): Promise<void> {
    if (!confirm("Delete all sources, documents, and settings? This cannot be undone.")) return;
    setClearing(true);
    try {
      await window.api.clearAllData();
      // M10: re-read everything so the page reflects the wiped state (zeroed
      // stats, no key, disconnected providers) instead of insisting the data is
      // still there. Staying in Settings rather than bouncing to onboarding is
      // deliberate — same reasoning as removing a key (M12).
      refresh();
    } catch {
      setLoadError("Failed to clear data.");
    } finally {
      setClearing(false);
    }
  }

  async function handleUninstallOllama(): Promise<void> {
    setUninstalling(true);
    try {
      await window.api.uninstallOllama();
      // Re-read so the button reflects the now-removed install (and any provider
      // fallout). Deliberately NOT onProviderReset() — keep the user in Settings
      // where they can switch to Cohere, same reasoning as M10/M12 above.
      refresh();
    } catch {
      setLoadError("Failed to uninstall Ollama.");
    } finally {
      setUninstalling(false);
    }
  }

  // "Detected" = an engine is answering now, or a Catena-managed binary is on
  // disk. The Uninstall button is enabled only when something is detected, so
  // once a teardown removes everything it disables itself. `ready` also requires
  // an embedding model, which gates the Settings install flow below.
  const ollamaDetected = !!ollamaStatus && (ollamaStatus.engineUp || ollamaStatus.managedBinaryPresent);
  const ollamaReady = !!ollamaStatus && ollamaStatus.engineUp && ollamaStatus.embeddingReady;
  const canUninstallOllama = ollamaDetected;

  return (
    <div className="max-w-3xl mx-auto px-10 pt-3 pb-8">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-semibold">Settings</h1>
        {/* Compact light/dark toggle, moved here from a standalone Appearance
            section: a switch flanked by sun/moon icons, the active side lit. */}
        <div className="flex items-center gap-1.5">
          <SunIcon className={`size-4 ${dark ? "text-muted-foreground" : "text-foreground"}`} />
          <Switch checked={dark} onCheckedChange={() => onToggleTheme()} aria-label="Dark theme" />
          <MoonIcon className={`size-4 ${dark ? "text-foreground" : "text-muted-foreground"}`} />
        </div>
      </div>
      <p className="text-muted-foreground text-sm mb-6">Manage your embedding provider and app data.</p>

      {loadError && (
        <ErrorBanner variant="error" className="mb-6">
          {loadError}
        </ErrorBanner>
      )}

      <div className="space-y-8">
        <div className="grid grid-cols-2 gap-4">
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">Embedding Provider</h2>
            <div className="flex gap-2">
              <Button variant={provider === "ollama" ? "default" : "outline"} size="sm" onClick={() => handleSwitchProvider("ollama")}>
                <OllamaIcon className="opacity-100" />
                Ollama
              </Button>
              <Button variant={provider === "cohere" ? "default" : "outline"} size="sm" onClick={() => handleSwitchProvider("cohere")}>
                <CohereIcon className="opacity-100" />
                Cohere
              </Button>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">Background Sync</h2>
            <div className="flex gap-2">
              <Button variant={autoSyncEnabled ? "default" : "outline"} size="sm" onClick={() => handleToggleAutoSync(true)}>
                Enabled
              </Button>
              <Button variant={!autoSyncEnabled ? "default" : "outline"} size="sm" onClick={() => handleToggleAutoSync(false)}>
                Disabled
              </Button>
            </div>
            {autoSyncEnabled && (
              <div className="flex gap-2">
                {[
                  { label: "15 min", ms: 15 * 60 * 1000 },
                  { label: "30 min", ms: 30 * 60 * 1000 },
                  { label: "1 hr", ms: 60 * 60 * 1000 },
                  { label: "2 hr", ms: 2 * 60 * 60 * 1000 },
                ].map((opt) => (
                  <Button key={opt.ms} variant={autoSyncInterval === opt.ms ? "default" : "outline"} size="sm" onClick={() => handleSetSyncInterval(opt.ms)}>
                    {opt.label}
                  </Button>
                ))}
              </div>
            )}
            {autoSyncEnabled && <p className="text-xs text-muted-foreground">{autoSyncing ? "Syncing now…" : lastSyncedAt ? `Last synced ${formatRelativeTime(lastSyncedAt)}` : "No sync yet"}</p>}
          </section>
        </div>

        {provider === "cohere" && (
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">Cohere API Key</h2>
            {hasKey ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-foreground">Key configured</span>
                <span className="text-xs text-muted-foreground">••••••••</span>
                <Button variant="ghost" size="xs" onClick={handleRemoveKey}>
                  Remove
                </Button>
              </div>
            ) : (
              <ErrorBanner variant="warning">No API key configured — search is disabled until you add one.</ErrorBanner>
            )}
            <div className="flex gap-2">
              <Input type="password" placeholder="Paste new Cohere API key" value={newKey} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewKey(e.target.value)} />
              <Button size="sm" onClick={handleUpdateKey} loading={validating} disabled={!newKey.trim()}>
                {hasKey ? "Update" : "Save"}
              </Button>
            </div>
            {keyError && <ErrorBanner variant="error">{keyError}</ErrorBanner>}
            {keySuccess && <p className="text-sm text-success-foreground">API key updated successfully.</p>}
          </section>
        )}

        {provider === "ollama" && (
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">Local Model</h2>
            {ollamaStatus === null ? (
              <p className="text-sm text-muted-foreground">Checking Ollama…</p>
            ) : ollamaReady ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-foreground">Ollama installed</span>
                <span className="text-xs text-muted-foreground">{ollamaStatus.embeddingModels.join(", ")}</span>
              </div>
            ) : (
              <>
                <ErrorBanner variant="warning">Ollama isn&apos;t set up yet — search is disabled until you install it.</ErrorBanner>
                {/* Same one-click flow as the onboarding wizard. On success, refresh
                    so the section flips to "installed" and the Danger Zone button enables. */}
                <OllamaInstallPanel onInstalled={refresh} />
              </>
            )}
          </section>
        )}

        <div className="border-t border-border" />

        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">Storage</h2>
          {stats ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-border bg-card p-3">
                <p className="text-2xl font-semibold">{stats.sourceCount}</p>
                <p className="text-xs text-muted-foreground">Sources</p>
              </div>
              <div className="rounded-lg border border-border bg-card p-3">
                <p className="text-2xl font-semibold">{stats.documentCount}</p>
                <p className="text-xs text-muted-foreground">Documents</p>
              </div>
              <div className="rounded-lg border border-border bg-card p-3">
                <p className="text-2xl font-semibold">{stats.chunkCount}</p>
                <p className="text-xs text-muted-foreground">Chunks</p>
              </div>
              <div className="rounded-lg border border-border bg-card p-3">
                <p className="text-2xl font-semibold">{formatBytes(stats.dbSizeBytes)}</p>
                <p className="text-xs text-muted-foreground">Database size</p>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="rounded-lg border border-border bg-card p-3 space-y-1">
                  <div className="h-7 w-12 rounded bg-muted animate-pulse" />
                  <div className="h-3 w-16 rounded bg-muted animate-pulse" />
                </div>
              ))}
            </div>
          )}
        </section>

        <div className="border-t border-border" />

        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">Privacy</h2>

          <div className="flex items-start justify-between gap-6 rounded-lg border border-border bg-card p-3">
            <div className="space-y-0.5">
              <label htmlFor="telemetry-toggle" className="text-sm font-medium text-foreground">
                Anonymous usage analytics
              </label>
              <p className="text-xs text-muted-foreground">Counts of things like searches run and sources added, tied to a random device ID. Never your queries, your documents, or their titles.</p>
            </div>
            <Switch id="telemetry-toggle" checked={telemetryEnabled} onCheckedChange={handleToggleTelemetry} className="mt-0.5" />
          </div>

          <ConfirmDialog
            open={showTelemetryConfirm}
            onOpenChange={setShowTelemetryConfirm}
            title="Turn off anonymous analytics?"
            confirmLabel="Turn it off"
            cancelLabel="Keep it on"
            confirmVariant="outline"
            cancelVariant="default"
            onConfirm={() => void applyTelemetry(false)}>
            <p>Catena is built by one developer. These anonymous counts are how I see what people actually use, catch crashes, and decide what to fix next — without them I&apos;m working blind.</p>
            <p>
              It stays completely anonymous: just tallies like how many searches were run or sources added, tied to a random device ID.{" "}
              <span className="font-medium text-foreground">Your queries, your documents, and their titles are never sent or tracked</span> — that never changes whether this is on or off.
            </p>
          </ConfirmDialog>

          {/*
            Catena is local-first, not local-only, and the difference is not
            self-evident from the marketing. Someone deciding whether to point
            this at their organization's documents deserves to read the actual answer on
            the settings page, not infer it.
          */}
          <div className="rounded-lg border border-border bg-card p-3 space-y-1">
            <p className="text-sm font-medium text-foreground">What leaves your device</p>
            {provider === "cohere" ? (
              <ul className="text-xs text-muted-foreground list-disc pl-4 space-y-1">
                <li>
                  <span className="text-foreground">Your document text</span> is sent to Cohere to be embedded — every chunk of every document you sync, once per sync.
                </li>
                <li>
                  <span className="text-foreground">Your search queries</span> are sent to Cohere to be rewritten, and the top matching chunks are sent back for reranking.
                </li>
                <li>
                  When you <span className="text-foreground">generate an answer</span>, your question and the top matching chunks are sent to Cohere to write it.
                </li>
                <li>Your documents and embeddings are stored only on this device. Cohere does not keep them.</li>
              </ul>
            ) : (
              <ul className="text-xs text-muted-foreground list-disc pl-4 space-y-1">
                <li>
                  <span className="text-foreground">Nothing.</span> Ollama runs on this machine, so your documents, queries, and generated answers never leave it.
                </li>
                <li>Syncing still fetches your documents from Notion or Google Drive, which is how they get here in the first place.</li>
              </ul>
            )}
            <Button
              variant="link"
              size="xs"
              className="px-0"
              onClick={() => {
                void openExternal("https://github.com/MatthewBlam/Catena/blob/main/PRIVACY.md");
              }}>
              Read the full privacy policy
            </Button>
          </div>
        </section>

        <div className="border-t border-border" />

        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">Danger Zone</h2>
          <div className="flex gap-2">
            <Button variant="destructive-outline" size="sm" onClick={handleClearAllData} loading={clearing}>
              Clear all data
            </Button>
            <Button variant="destructive-outline" size="sm" onClick={handleDisconnectNotion} loading={disconnectingNotion} disabled={!hasNotion}>
              Disconnect Notion
            </Button>
            <Button variant="destructive-outline" size="sm" onClick={handleDisconnectDrive} loading={disconnectingDrive} disabled={!hasDrive}>
              Disconnect Google Drive
            </Button>
            <Button variant="destructive-outline" size="sm" onClick={() => setShowUninstallConfirm(true)} loading={uninstalling} disabled={!canUninstallOllama}>
              Uninstall Ollama
            </Button>
          </div>

          <ConfirmDialog
            open={showUninstallConfirm}
            onOpenChange={setShowUninstallConfirm}
            title="Uninstall Ollama?"
            confirmLabel="Uninstall"
            cancelLabel="Cancel"
            confirmVariant="destructive"
            onConfirm={() => void handleUninstallOllama()}>
            <p>
              This removes the local Ollama engine Catena downloaded and the models it pulled ( <span className="font-medium text-foreground">freeing up around 2&nbsp;GB</span> ). Your synced
              documents stay on this device.
            </p>
            {provider === "ollama" && <p>Ollama is your current search provider, so search will be disabled until you switch to Cohere or set up Ollama again.</p>}
            <p>A separate copy of Ollama you installed yourself is left untouched.</p>
          </ConfirmDialog>
        </section>
      </div>
    </div>
  );
}

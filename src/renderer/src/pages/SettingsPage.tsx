import { useEffect, useState, useRef } from "react";
import { SunIcon, MoonIcon } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Switch } from "@renderer/components/ui/switch";
import { ErrorBanner } from "@renderer/components/ui/error-banner";
import type { StorageStats } from "../../../shared/types";

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

function formatRelativeTime(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function SettingsPage({
  visible,
  dark,
  onToggleTheme,
  onProviderReset,
}: SettingsPageProps): React.JSX.Element {
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
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevVisibleRef = useRef(false);

  useEffect(() => {
    if (visible && !prevVisibleRef.current) {
      Promise.all([
        window.api.getEmbeddingProvider(),
        window.api.hasSecret("cohere_api_key"),
        window.api.getStorageStats(),
        window.api.getAutoSync(),
        window.api.hasSecret("notion_token"),
        window.api.hasSecret("google_tokens"),
        window.api.getTelemetryEnabled(),
      ])
        .then(([p, keyPresent, s, sync, notion, drive, telemetry]) => {
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
          setLoadError(null);
        })
        .catch(() => {
          setLoadError("Failed to load settings.");
        });
    }
    prevVisibleRef.current = visible;
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
    if (!confirm("Remove your Cohere API key? Search will stop working."))
      return;
    try {
      await window.api.deleteSecret("cohere_api_key");
      setHasKey(false);
      onProviderReset();
    } catch {
      setKeyError("Failed to remove key.");
    }
  }

  async function handleSwitchProvider(
    newProvider: "cohere" | "ollama",
  ): Promise<void> {
    if (newProvider === provider) return;
    if (
      stats &&
      stats.chunkCount > 0 &&
      !confirm(
        "Switching providers requires re-embedding all documents. Continue?",
      )
    )
      return;
    try {
      await window.api.setEmbeddingProvider(newProvider);
      setProvider(newProvider);
      if (newProvider === "ollama") {
        onProviderReset();
      }
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

  async function handleToggleTelemetry(next: boolean): Promise<void> {
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

  async function handleDisconnectNotion(): Promise<void> {
    if (
      !confirm(
        "Disconnect Notion? You will need to re-authenticate to sync Notion sources.",
      )
    )
      return;
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
    if (
      !confirm(
        "Disconnect Google Drive? You will need to re-authenticate to sync Drive sources.",
      )
    )
      return;
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
    if (
      !confirm(
        "Delete all sources, documents, and settings? This cannot be undone.",
      )
    )
      return;
    setClearing(true);
    try {
      await window.api.clearAllData();
      setHasNotion(false);
      setHasDrive(false);
      onProviderReset();
    } catch {
      setLoadError("Failed to clear data.");
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-10 pt-3 pb-8">
      <h1 className="text-2xl font-semibold mb-1">Settings</h1>
      <p className="text-muted-foreground text-sm mb-6">
        Manage your embedding provider and app data
      </p>

      {loadError && (
        <ErrorBanner variant="error" className="mb-6">
          {loadError}
        </ErrorBanner>
      )}

      <div className="space-y-8">
        <div className="grid grid-cols-2 gap-4">
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">
              Embedding Provider
            </h2>
            <div className="flex gap-2">
              <Button
                variant={provider === "cohere" ? "default" : "outline"}
                size="sm"
                onClick={() => handleSwitchProvider("cohere")}
              >
                Cohere API
              </Button>
              <Button
                variant={provider === "ollama" ? "default" : "outline"}
                size="sm"
                onClick={() => handleSwitchProvider("ollama")}
              >
                Ollama (Local)
              </Button>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">
              Background Sync
            </h2>
            <div className="flex gap-2">
              <Button
                variant={autoSyncEnabled ? "default" : "outline"}
                size="sm"
                onClick={() => handleToggleAutoSync(true)}
              >
                Enabled
              </Button>
              <Button
                variant={!autoSyncEnabled ? "default" : "outline"}
                size="sm"
                onClick={() => handleToggleAutoSync(false)}
              >
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
                  <Button
                    key={opt.ms}
                    variant={
                      autoSyncInterval === opt.ms ? "default" : "outline"
                    }
                    size="sm"
                    onClick={() => handleSetSyncInterval(opt.ms)}
                  >
                    {opt.label}
                  </Button>
                ))}
              </div>
            )}
            {autoSyncEnabled && (
              <p className="text-xs text-muted-foreground">
                {autoSyncing
                  ? "Syncing now…"
                  : lastSyncedAt
                    ? `Last synced ${formatRelativeTime(lastSyncedAt)}`
                    : "No sync yet"}
              </p>
            )}
          </section>
        </div>

        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">
            Appearance
          </h2>
          <div className="flex gap-2">
            <Button
              variant={!dark ? "default" : "outline"}
              size="sm"
              onClick={() => dark && onToggleTheme()}
            >
              <SunIcon className="size-4 mr-1.5" />
              Light
            </Button>
            <Button
              variant={dark ? "default" : "outline"}
              size="sm"
              onClick={() => !dark && onToggleTheme()}
            >
              <MoonIcon className="size-4 mr-1.5" />
              Dark
            </Button>
          </div>
        </section>

        {provider === "cohere" && (
          <section className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">
              Cohere API Key
            </h2>
            {hasKey ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-foreground">Key configured</span>
                <span className="text-xs text-muted-foreground">••••••••</span>
                <Button variant="ghost" size="xs" onClick={handleRemoveKey}>
                  Remove
                </Button>
              </div>
            ) : (
              <ErrorBanner variant="warning">
                No API key configured. Search will not work.
              </ErrorBanner>
            )}
            <div className="flex gap-2">
              <Input
                type="password"
                placeholder="Paste new Cohere API key"
                value={newKey}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setNewKey(e.target.value)
                }
              />
              <Button
                size="sm"
                onClick={handleUpdateKey}
                loading={validating}
                disabled={!newKey.trim()}
              >
                {hasKey ? "Update" : "Save"}
              </Button>
            </div>
            {keyError && <ErrorBanner variant="error">{keyError}</ErrorBanner>}
            {keySuccess && (
              <p className="text-sm text-success-foreground">
                API key updated successfully.
              </p>
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
                <p className="text-2xl font-semibold">
                  {formatBytes(stats.dbSizeBytes)}
                </p>
                <p className="text-xs text-muted-foreground">Database size</p>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {Array.from({ length: 4 }, (_, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-border bg-card p-3 space-y-1"
                >
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
              <label
                htmlFor="telemetry-toggle"
                className="text-sm font-medium text-foreground"
              >
                Anonymous usage analytics
              </label>
              <p className="text-xs text-muted-foreground">
                Counts of things like searches run and sources added, tied to a
                random device ID. Never your queries, your documents, or their
                titles.
              </p>
            </div>
            <Switch
              id="telemetry-toggle"
              checked={telemetryEnabled}
              onCheckedChange={handleToggleTelemetry}
              className="mt-0.5"
            />
          </div>

          {/*
            Commons is local-first, not local-only, and the difference is not
            self-evident from the marketing. Someone deciding whether to point
            this at their club's documents deserves to read the actual answer on
            the settings page, not infer it.
          */}
          <div className="rounded-lg border border-border bg-card p-3 space-y-1">
            <p className="text-sm font-medium text-foreground">
              What leaves your device
            </p>
            {provider === "cohere" ? (
              <ul className="text-xs text-muted-foreground list-disc pl-4 space-y-1">
                <li>
                  <span className="text-foreground">Your document text</span> is
                  sent to Cohere to be embedded — every chunk of every document
                  you sync, once per sync.
                </li>
                <li>
                  <span className="text-foreground">Your search queries</span>{" "}
                  are sent to Cohere to be rewritten, and the top matching
                  chunks are sent back for reranking.
                </li>
                <li>
                  Your documents and embeddings are stored only on this device.
                  Cohere does not keep them.
                </li>
              </ul>
            ) : (
              <ul className="text-xs text-muted-foreground list-disc pl-4 space-y-1">
                <li>
                  <span className="text-foreground">Nothing.</span> Ollama runs
                  on this machine, so your documents and queries never leave it.
                </li>
                <li>
                  Syncing still fetches your documents from Notion or Google
                  Drive, which is how they get here in the first place.
                </li>
              </ul>
            )}
            <Button
              variant="link"
              size="xs"
              className="px-0"
              onClick={() => {
                void window.api.openExternal(
                  "https://github.com/MatthewBlam/commons-app/blob/main/PRIVACY.md",
                );
              }}
            >
              Read the full privacy policy
            </Button>
          </div>
        </section>

        <div className="border-t border-border" />

        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">
            Danger Zone
          </h2>
          <div className="flex gap-2">
            <Button
              variant="destructive-outline"
              size="sm"
              onClick={handleClearAllData}
              loading={clearing}
            >
              Clear all data
            </Button>
            <Button
              variant="destructive-outline"
              size="sm"
              onClick={handleDisconnectNotion}
              loading={disconnectingNotion}
              disabled={!hasNotion}
            >
              Disconnect Notion
            </Button>
            <Button
              variant="destructive-outline"
              size="sm"
              onClick={handleDisconnectDrive}
              loading={disconnectingDrive}
              disabled={!hasDrive}
            >
              Disconnect Google Drive
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}

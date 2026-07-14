import { useEffect, useState, useCallback, useRef } from "react";
import { ConnectNotionButton } from "@renderer/components/sources/ConnectNotionButton";
import { ConnectDriveButton } from "@renderer/components/sources/ConnectDriveButton";
import { SourceList } from "@renderer/components/sources/SourceList";
import { ErrorBanner } from "@renderer/components/ui/error-banner";
import type { SourceWithCount } from "../../../shared/types";

interface SourcesPageProps {
  visible: boolean;
}

export function SourcesPage({ visible }: SourcesPageProps): React.JSX.Element {
  const [sources, setSources] = useState<SourceWithCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const prevVisibleRef = useRef(false);

  const loadSources = useCallback(() => {
    setError(null);
    window.api
      .listSources()
      .then(setSources)
      .catch(() => setError("Failed to load sources. Try refreshing."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (visible && !prevVisibleRef.current) {
      loadSources();
    }
    prevVisibleRef.current = visible;
  }, [visible, loadSources]);

  return (
    <div className="max-w-3xl mx-auto px-10 pt-3 pb-8">
      <h1 className="text-2xl font-semibold mb-1">Sources</h1>

      <div className="space-y-6">
        <section>
          <h2 className="text-sm font-medium text-muted-foreground mb-3">
            Connect a source
          </h2>
          <div className="space-y-2">
            <ConnectNotionButton onSourceAdded={loadSources} />
            <ConnectDriveButton onSourceAdded={loadSources} />
          </div>
        </section>

        <div className="border-t border-border" />

        <section>
          {error && (
            <ErrorBanner variant="error" className="mb-3">
              {error}
            </ErrorBanner>
          )}

          {loading ? (
            <div className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">
                Connected sources
              </h2>
              {Array.from({ length: 2 }, (_, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-border bg-card p-4 space-y-2"
                >
                  <div className="h-4 w-1/3 rounded bg-muted animate-pulse" />
                  <div className="h-3 w-1/4 rounded bg-muted animate-pulse" />
                </div>
              ))}
            </div>
          ) : (
            <SourceList
              sources={sources}
              label="Connected sources"
              onRefresh={loadSources}
            />
          )}
        </section>
      </div>
    </div>
  );
}

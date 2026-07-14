import { useState, useCallback, useEffect, useRef } from "react";
import { SearchInput } from "@renderer/components/search/SearchInput";
import { ResultCard } from "@renderer/components/search/ResultCard";
import { EmptyState } from "@renderer/components/search/EmptyState";
import { ErrorBanner } from "@renderer/components/ui/error-banner";
import type { SearchResult, EmbeddingHealth } from "../../../shared/types";

interface SearchPageProps {
  visible: boolean;
}

export function SearchPage({ visible }: SearchPageProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [lastQuery, setLastQuery] = useState("");
  const [lastRewritten, setLastRewritten] = useState<string | null>(null);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rerankFailed, setRerankFailed] = useState(false);
  const [health, setHealth] = useState<EmbeddingHealth | null>(null);
  const [healthDismissed, setHealthDismissed] = useState(false);
  const queryRef = useRef(query);
  const healthLoaded = useRef(false);
  const requestIdRef = useRef(0);

  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  useEffect(() => {
    if (!visible || healthLoaded.current) return;
    healthLoaded.current = true;
    window.api
      .checkEmbeddingHealth()
      .then(setHealth)
      .catch(() => {});
  }, [visible]);

  const handleSearch = useCallback(async (searchQuery?: string) => {
    const q = (searchQuery ?? queryRef.current).trim();
    if (!q) return;

    setLastQuery(q);
    setLastRewritten(null);
    setLoading(true);
    setError(null);
    setRerankFailed(false);

    const id = ++requestIdRef.current;

    try {
      const response = await window.api.search(q);
      if (id !== requestIdRef.current) return;
      setResults(response.results);
      setRerankFailed(response.rerankFailed);
      setLastRewritten(response.rewrittenQuery ?? null);
    } catch (err) {
      if (id !== requestIdRef.current) return;
      setError(
        err instanceof Error ? err.message : "Search failed. Try again.",
      );
      setResults(null);
    } finally {
      if (id === requestIdRef.current) setLoading(false);
    }
  }, []);

  const handleSelectQuestion = useCallback(
    (question: string) => {
      setQuery(question);
      handleSearch(question);
    },
    [handleSearch],
  );

  const hasMismatch =
    health &&
    health.mismatchedChunks > 0 &&
    health.totalChunks > 0 &&
    !healthDismissed;

  return (
    <div className="min-h-full flex flex-col pt-3 pb-8">
      <div className="w-full max-w-3xl mx-auto px-10 mb-3">
        <h1 className="text-2xl font-semibold mb-1">Search</h1>
        <p className="text-muted-foreground text-sm mb-6">
          Don&apos;t see what you&apos;re looking for? Try searching using
          keywords.
        </p>
        <SearchInput
          value={query}
          onChange={setQuery}
          onSubmit={() => handleSearch()}
          loading={loading}
        />
      </div>

      <div className="w-full max-w-3xl mx-auto px-10 flex-1 space-y-3">
        {hasMismatch && (
          <ErrorBanner
            variant="warning"
            onDismiss={() => setHealthDismissed(true)}
          >
            Some documents were embedded with a different model. Results may be
            less accurate. Re-sync your sources from the Sources tab to fix.
          </ErrorBanner>
        )}

        {rerankFailed && (
          <ErrorBanner variant="warning">
            Reranking unavailable — results may be less accurate.
          </ErrorBanner>
        )}

        {error && <ErrorBanner variant="error">{error}</ErrorBanner>}

        {loading && (
          <div className="space-y-3">
            {Array.from({ length: 3 }, (_, i) => (
              <div
                key={i}
                className="rounded-lg border border-border bg-card p-4 space-y-2"
              >
                <div className="h-4 w-2/3 rounded bg-muted animate-pulse" />
                <div className="h-3 w-full rounded bg-muted animate-pulse" />
                <div className="h-3 w-4/5 rounded bg-muted animate-pulse" />
              </div>
            ))}
          </div>
        )}

        {!loading && results !== null && results.length > 0 && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Results for &ldquo;{lastQuery}&rdquo;
              {lastRewritten && (
                <span> &mdash; searched as &ldquo;{lastRewritten}&rdquo;</span>
              )}
            </p>
            {results.map((result) => (
              <ResultCard key={result.chunkId} result={result} />
            ))}
          </div>
        )}

        {!loading && results !== null && results.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-12">
            No results found. Try a different question or sync more docs.
          </p>
        )}

        {!loading && results === null && !error && (
          <EmptyState onSelectQuestion={handleSelectQuestion} />
        )}
      </div>
    </div>
  );
}

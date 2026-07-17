import { useState, useCallback, useEffect, useRef } from "react";
import { SearchInput } from "@renderer/components/search/SearchInput";
import { ResultCard } from "@renderer/components/search/ResultCard";
import { EmptyState } from "@renderer/components/search/EmptyState";
import { ErrorBanner } from "@renderer/components/ui/error-banner";
import { getOllamaStatus } from "@renderer/lib/ollama";
import { debounce } from "@renderer/lib/utils";
import { toErrorMessage } from "@renderer/lib/errors";
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
  const [dismissedSignature, setDismissedSignature] = useState<string | null>(
    null,
  );
  const [truncated, setTruncated] = useState<{
    scanned: number;
    total: number;
  } | null>(null);
  // null = not yet loaded (show the suggested-questions empty state, not the
  // "connect a source" one — otherwise it flashes on every mount).
  const [sourceCount, setSourceCount] = useState<number | null>(null);
  // F7: null = readiness not checked yet. Treated the same as "ready" for
  // rendering so the disabled banner never flashes on the initial mount while
  // the check is in flight — it only appears once we positively know there is
  // no usable provider.
  const [providerReady, setProviderReady] = useState<boolean | null>(null);
  const [embeddingProvider, setEmbeddingProvider] = useState<string | null>(
    null,
  );
  const queryRef = useRef(query);
  const providerReadyRef = useRef<boolean | null>(null);
  const requestIdRef = useRef(0);
  const readinessIdRef = useRef(0);

  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  const refreshHealth = useCallback(() => {
    window.api
      .checkEmbeddingHealth()
      .then(setHealth)
      .catch(() => {});
  }, []);

  const refreshSources = useCallback(() => {
    window.api
      .listSources()
      .then((sources) => setSourceCount(sources.length))
      .catch(() => {});
  }, []);

  // F7: mirrors App.tsx's checkReady provider check, but scoped to this page —
  // App deliberately does NOT re-run its own readiness gate when a Cohere key is
  // removed in Settings (M12, so the user isn't yanked into onboarding), which
  // means nothing else gates search once a key is gone. Ollama readiness only
  // requires it to be reachable, matching App.tsx; it does not require an
  // embedding model to be pulled, same gap App.tsx has.
  const refreshReadiness = useCallback(() => {
    // Same stale-response guard as the search-response check below: two
    // in-flight checks can resolve out of order (add a key in Settings,
    // switch back to Search quickly — the "before" check's slower promise
    // must not clobber the "after" check's already-applied result).
    const id = ++readinessIdRef.current;
    window.api
      .getEmbeddingProvider()
      .then(async (provider) => {
        const isReady =
          provider === "ollama"
            ? (await getOllamaStatus()).available
            : await window.api.hasSecret("cohere_api_key");
        if (id !== readinessIdRef.current) return;
        setEmbeddingProvider(provider);
        providerReadyRef.current = isReady;
        setProviderReady(isReady);
      })
      .catch(() => {
        if (id !== readinessIdRef.current) return;
        // Once a real state has ever been established, a later transient IPC
        // failure leaves it alone — matches refreshHealth/refreshSources.
        // But while still null (the very first check, which renders as
        // "ready" per the comment above), failing open would leave the gate
        // open forever on a rejected call. Fail closed instead, matching
        // App.tsx's checkReady convention for its own initial check.
        if (providerReadyRef.current === null) {
          providerReadyRef.current = false;
          setProviderReady(false);
        }
      });
  }, []);

  // H11: re-check every time the page becomes visible — which is exactly when
  // the user returns from switching providers in Settings — rather than once per
  // session. The old once-gate meant the mismatch warning never fired for the
  // flow that *creates* the mismatch. Source count and provider readiness are
  // refreshed alongside so the "connect a source" empty state and the "no
  // provider" banner clear the moment the user fixes them in Settings.
  useEffect(() => {
    if (visible) {
      refreshHealth();
      refreshSources();
      refreshReadiness();
    }
  }, [visible, refreshHealth, refreshSources, refreshReadiness]);

  // And after any sync/source change: a re-embed can clear a mismatch (or create
  // one), and adding/removing sources changes the empty-state.
  //
  // F11: `sources:changed` fires once per source completion, so a large sync
  // run fires it in a tight burst — each occurrence re-runs the embedding-health
  // COUNT queries and the source list fetch. Debounced (trailing) so the last
  // event in a burst still refetches; `refreshReadiness`'s own sequence guard
  // (Task 6) is unaffected by debouncing the caller.
  useEffect(() => {
    const debouncedSourcesChanged = debounce(() => {
      refreshHealth();
      refreshSources();
      refreshReadiness();
    }, 250);
    const unsub = window.api.onSourcesChanged(debouncedSourcesChanged);
    return () => {
      debouncedSourcesChanged.cancel();
      unsub();
    };
  }, [refreshHealth, refreshSources, refreshReadiness]);

  // Unmounting leaves any in-flight search with no consumer — but it is still
  // holding a SQLite iterator open on the main thread. (App swaps this page out
  // wholesale when the provider is reset, so this is a live path, not a formality.)
  useEffect(() => {
    return () => {
      window.api.cancelSearch().catch(() => {});
    };
  }, []);

  const handleSearch = useCallback(async (searchQuery?: string) => {
    const q = (searchQuery ?? queryRef.current).trim();
    // F7: belt-and-suspenders alongside the disabled input — the empty-state's
    // suggested-question buttons submit through this same function and are not
    // wired to the input's `disabled` attribute.
    if (!q || providerReadyRef.current === false) return;

    setLastQuery(q);
    setLastRewritten(null);
    setLoading(true);
    setError(null);
    setRerankFailed(false);
    setTruncated(null);

    const id = ++requestIdRef.current;

    try {
      const response = await window.api.search(q);
      // `cancelled` means main abandoned this query — it carries no results and
      // is not an error. Dropping it is the whole point of the flag.
      if (id !== requestIdRef.current || response.cancelled) return;
      setResults(response.results);
      setRerankFailed(response.rerankFailed);
      setTruncated(response.truncated ?? null);
      setLastRewritten(response.rewrittenQuery ?? null);
    } catch (err) {
      if (id !== requestIdRef.current) return;
      setError(toErrorMessage(err, "Search failed. Try again."));
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

  // Key the dismissal to *which* mismatch was dismissed, not a bare boolean, so
  // a fresh mismatch (new model, different count — e.g. right after a provider
  // switch) resurfaces the banner instead of staying hidden by an earlier dismiss.
  const healthSignature =
    health && health.mismatchedChunks > 0 && health.totalChunks > 0
      ? `${health.model}:${health.mismatchedChunks}`
      : null;
  const hasMismatch =
    healthSignature !== null && healthSignature !== dismissedSignature;

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
          disabled={providerReady === false}
        />
      </div>

      <div
        className="w-full max-w-3xl mx-auto px-10 flex-1 space-y-3"
        aria-live="polite"
      >
        {providerReady === false && (
          <ErrorBanner variant="warning">
            {embeddingProvider === "ollama"
              ? "Search is disabled — start Ollama to search"
              : "Search is disabled — add your API key in Settings"}
          </ErrorBanner>
        )}

        {hasMismatch && (
          <ErrorBanner
            variant="warning"
            onDismiss={() => setDismissedSignature(healthSignature)}
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

        {truncated && (
          <ErrorBanner variant="warning">
            Your library is large, so this search covered{" "}
            {truncated.scanned.toLocaleString()} of{" "}
            {truncated.total.toLocaleString()} indexed sections. Some matches
            may be missing — try a more specific query.
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

        {!loading &&
          results === null &&
          !error &&
          (sourceCount === 0 ? (
            <div className="text-center py-12 space-y-1">
              <p className="text-sm text-foreground">
                No sources connected yet.
              </p>
              <p className="text-sm text-muted-foreground">
                Add a source from the Sources tab to start searching.
              </p>
            </div>
          ) : (
            <EmptyState onSelectQuestion={handleSelectQuestion} />
          ))}
      </div>
    </div>
  );
}

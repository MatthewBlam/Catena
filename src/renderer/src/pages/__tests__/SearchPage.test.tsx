// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { SearchPage } from "../SearchPage";
import type {
  EmbeddingHealth,
  RecentSearchDetail,
  SearchResponse,
} from "../../../../shared/types";

afterEach(cleanup);

interface MockApiState {
  provider: string;
  hasCohereKey: boolean;
  ollamaAvailable: boolean;
  searchResponse: SearchResponse;
  /**
   * Drives `listSources().length`, i.e. `sourceCount`. Defaults to 0, which
   * renders the "no sources connected" text instead of `EmptyState` — tests
   * that need `EmptyState`'s clickable suggested-question buttons on screen
   * (to exercise the not-ready guard in `handleSearch`) must override this.
   */
  sourceCount: number;
}

const DEFAULT_HEALTH: EmbeddingHealth = {
  provider: "cohere",
  model: "embed-v4",
  mismatchedChunks: 0,
  totalChunks: 0,
};

/**
 * Mirrors SourceList.test.tsx's `mockApi` helper: stub only what SearchPage
 * calls, and hand back a mutable `state` plus a `fireSourcesChanged` trigger
 * so a test can simulate the user fixing (or breaking) provider setup in
 * Settings and firing the same refresh triggers SearchPage itself listens for.
 */
function mockApi(overrides: Partial<MockApiState> = {}): {
  state: MockApiState;
  fireSourcesChanged: () => void;
} {
  const state: MockApiState = {
    provider: "cohere",
    hasCohereKey: true,
    ollamaAvailable: false,
    searchResponse: { results: [], rerankFailed: false },
    sourceCount: 0,
    ...overrides,
  };
  let listeners: Array<() => void> = [];

  window.api = {
    checkEmbeddingHealth: vi.fn(() => Promise.resolve(DEFAULT_HEALTH)),
    listSources: vi.fn(() =>
      Promise.resolve(
        // Only `.length` is read by SearchPage; the entries themselves are
        // never inspected, so empty placeholder objects are sufficient.
        Array.from({ length: state.sourceCount }, () => ({})),
      ),
    ),
    onSourcesChanged: vi.fn((cb: () => void) => {
      listeners.push(cb);
      return () => {
        listeners = listeners.filter((l) => l !== cb);
      };
    }),
    cancelSearch: vi.fn(() => Promise.resolve()),
    getEmbeddingProvider: vi.fn(() => Promise.resolve(state.provider)),
    hasSecret: vi.fn(() => Promise.resolve(state.hasCohereKey)),
    checkOllama: vi.fn(() =>
      Promise.resolve({
        available: state.ollamaAvailable,
        models: state.ollamaAvailable ? ["nomic-embed-text"] : [],
      }),
    ),
    search: vi.fn(() => Promise.resolve(state.searchResponse)),
  } as unknown as typeof window.api;

  return {
    state,
    fireSourcesChanged: () => {
      act(() => {
        for (const listener of listeners) listener();
      });
    },
  };
}

/** A manually-resolvable promise, for gating a mock's response mid-test. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const RESTORE_DETAIL: RecentSearchDetail = {
  id: "r1",
  query: "reimbursement",
  resultCount: 1,
  createdAt: "2026-07-16T12:00:00.000Z",
  updatedAt: "2026-07-16T12:00:00.000Z",
  results: [
    {
      chunkId: "c1",
      documentTitle: "Reimbursement Policy",
      snippet: "Submit receipts within 30 days...",
      heading: null,
      url: null,
      provider: "notion",
      score: 0.9,
    },
  ],
};

describe("SearchPage — provider readiness", () => {
  it("renders the disabled banner and disables the input when no key is configured", async () => {
    mockApi({ hasCohereKey: false });
    render(<SearchPage visible={true} />);

    expect(
      await screen.findByText(
        "Search is disabled — add your API key in Settings.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Search your documents")).toBeDisabled();
  });

  it("renders the Ollama-appropriate banner when Ollama is not running", async () => {
    mockApi({ provider: "ollama", ollamaAvailable: false });
    render(<SearchPage visible={true} />);

    expect(
      await screen.findByText("Search is disabled — start Ollama to search."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Search your documents")).toBeDisabled();
  });

  it("renders a normal, enabled search when the provider is ready", async () => {
    mockApi({
      hasCohereKey: true,
      sourceCount: 1,
      searchResponse: {
        results: [
          {
            chunkId: "c1",
            documentTitle: "Reimbursement Policy",
            snippet: "Submit receipts within 30 days...",
            heading: null,
            url: null,
            provider: "notion",
            score: 0.9,
          },
        ],
        rerankFailed: false,
      },
    });
    render(<SearchPage visible={true} />);

    // Let the readiness check resolve before asserting its absence.
    await screen.findByLabelText("Search your documents");
    expect(
      screen.queryByText("Search is disabled — add your API key in Settings."),
    ).not.toBeInTheDocument();
    const input = screen.getByLabelText("Search your documents");
    expect(input).not.toBeDisabled();

    fireEvent.change(input, { target: { value: "reimbursement" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByText(/Results for/)).toBeInTheDocument();
    expect(window.api.search).toHaveBeenCalledWith("reimbursement");
  });

  it("disables the search input while no sources are connected, and re-enables when one is added", async () => {
    // Provider fully ready — the only thing missing is a connected source.
    const { state, fireSourcesChanged } = mockApi({ hasCohereKey: true });
    render(<SearchPage visible={true} />);

    const input = await screen.findByLabelText("Search your documents");
    await waitFor(() => {
      expect(input).toBeDisabled();
    });

    state.sourceCount = 1;
    fireSourcesChanged();

    await waitFor(() => {
      expect(input).not.toBeDisabled();
    });
  });

  it("re-evaluates readiness when the page becomes visible again (returning from Settings)", async () => {
    const { state } = mockApi({ hasCohereKey: false, sourceCount: 1 });
    const { rerender } = render(<SearchPage visible={true} />);

    expect(
      await screen.findByText(
        "Search is disabled — add your API key in Settings.",
      ),
    ).toBeInTheDocument();

    // The user adds a key in Settings, then switches back to the Search tab —
    // App.tsx keeps SearchPage mounted the whole time and only toggles
    // `visible`, so that prop flip is the only signal SearchPage gets.
    state.hasCohereKey = true;
    rerender(<SearchPage visible={false} />);
    rerender(<SearchPage visible={true} />);

    expect(
      await screen.findByLabelText("Search your documents"),
    ).not.toBeDisabled();
    expect(
      screen.queryByText("Search is disabled — add your API key in Settings."),
    ).not.toBeInTheDocument();
  });

  it("re-evaluates readiness on a sources:changed event", async () => {
    const { state, fireSourcesChanged } = mockApi({
      hasCohereKey: false,
      sourceCount: 1,
    });
    render(<SearchPage visible={true} />);

    expect(
      await screen.findByText(
        "Search is disabled — add your API key in Settings.",
      ),
    ).toBeInTheDocument();

    state.hasCohereKey = true;
    fireSourcesChanged();

    // F11: the sources:changed handler is now debounced (~250ms), so the
    // refetch it triggers no longer lands within the same microtask flush a
    // bare `findBy*` relies on — poll for the settled state instead.
    await waitFor(() => {
      expect(screen.getByLabelText("Search your documents")).not.toBeDisabled();
    });
  });

  it("fails closed when the very first readiness check's IPC call rejects", async () => {
    mockApi({ hasCohereKey: true });
    // Overrides mockApi's default (resolves) — simulates the initial
    // readiness check itself failing, while `providerReady` is still null
    // (which otherwise renders as "ready" — see the null comment in
    // SearchPage.tsx). Failing open here would leave the gate open forever.
    window.api.getEmbeddingProvider = vi.fn(() =>
      Promise.reject(new Error("IPC unavailable")),
    );
    render(<SearchPage visible={true} />);

    expect(
      await screen.findByText(
        "Search is disabled — add your API key in Settings.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Search your documents")).toBeDisabled();
  });

  it("leaves a known-good readiness state alone on a later transient IPC failure", async () => {
    mockApi({ hasCohereKey: true, sourceCount: 1 });
    const { rerender } = render(<SearchPage visible={true} />);

    // Establish a real (non-null) ready state first.
    expect(
      await screen.findByLabelText("Search your documents"),
    ).not.toBeDisabled();

    // A later check fails transiently — must not flip an already-established
    // good state to disabled (unlike the first-check case above).
    window.api.getEmbeddingProvider = vi.fn(() =>
      Promise.reject(new Error("transient hiccup")),
    );
    rerender(<SearchPage visible={false} />);
    rerender(<SearchPage visible={true} />);
    await act(async () => {});

    expect(screen.getByLabelText("Search your documents")).not.toBeDisabled();
    expect(
      screen.queryByText("Search is disabled — add your API key in Settings."),
    ).not.toBeInTheDocument();
  });

  it("blocks a suggested-question click while not ready, even though the input's disabled attribute does not cover it", async () => {
    // sourceCount: 1 forces the `EmptyState` branch (sourceCount === 0 shows
    // "no sources connected" text instead) — EmptyState's suggested-question
    // buttons submit through `handleSearch` directly and are not wired to the
    // input's `disabled` attribute, so this is the path the `handleSearch`
    // guard exists to protect against.
    mockApi({ hasCohereKey: false, sourceCount: 1 });
    render(<SearchPage visible={true} />);

    expect(
      await screen.findByText(
        "Search is disabled — add your API key in Settings.",
      ),
    ).toBeInTheDocument();

    const suggestion = await screen.findByText("How do I get reimbursed?");
    fireEvent.click(suggestion);
    await act(async () => {});

    expect(window.api.search).not.toHaveBeenCalled();
  });
});

describe("SearchPage — sources:changed debounce (F11)", () => {
  it("collapses a burst of sources:changed events into a single refetch", async () => {
    const { fireSourcesChanged } = mockApi({ hasCohereKey: true });
    render(<SearchPage visible={true} />);
    await screen.findByLabelText("Search your documents");

    const healthCallsBefore = (
      window.api.checkEmbeddingHealth as ReturnType<typeof vi.fn>
    ).mock.calls.length;
    const sourcesCallsBefore = (
      window.api.listSources as ReturnType<typeof vi.fn>
    ).mock.calls.length;

    vi.useFakeTimers();
    try {
      // Simulates a large sync completing many sources in a tight burst —
      // each completion fires `sources:changed` once.
      fireSourcesChanged();
      fireSourcesChanged();
      fireSourcesChanged();

      expect(window.api.checkEmbeddingHealth).toHaveBeenCalledTimes(
        healthCallsBefore,
      );

      act(() => {
        vi.advanceTimersByTime(250);
      });

      expect(window.api.checkEmbeddingHealth).toHaveBeenCalledTimes(
        healthCallsBefore + 1,
      );
      expect(window.api.listSources).toHaveBeenCalledTimes(
        sourcesCallsBefore + 1,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SearchPage — restore mechanics", () => {
  it("renders a restored snapshot without calling search, and cancels any in-flight main-side work", async () => {
    mockApi({ hasCohereKey: true, sourceCount: 1 });
    render(
      <SearchPage
        visible={true}
        restore={{ detail: RESTORE_DETAIL, token: 1 }}
      />,
    );

    expect(
      await screen.findByDisplayValue("reimbursement"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Results for/)).toBeInTheDocument();
    expect(screen.getByText("Reimbursement Policy")).toBeInTheDocument();
    expect(screen.getByText(/^Saved results from/)).toBeInTheDocument();
    expect(window.api.search).not.toHaveBeenCalled();
    expect(window.api.cancelSearch).toHaveBeenCalled();
  });

  it("shows the searched-as line when the snapshot carries a rewritten query", async () => {
    mockApi({ hasCohereKey: true, sourceCount: 1 });
    render(
      <SearchPage
        visible={true}
        restore={{
          detail: { ...RESTORE_DETAIL, rewrittenQuery: "reimbursement policy" },
          token: 1,
        }}
      />,
    );

    expect(
      await screen.findByText(/searched as\s*“reimbursement policy”/),
    ).toBeInTheDocument();
  });

  it("Search again re-runs the saved query and clears the banner", async () => {
    mockApi({
      hasCohereKey: true,
      sourceCount: 1,
      searchResponse: { results: [], rerankFailed: false },
    });
    render(
      <SearchPage
        visible={true}
        restore={{ detail: RESTORE_DETAIL, token: 1 }}
      />,
    );
    await screen.findByText(/^Saved results from/);

    fireEvent.click(screen.getByRole("button", { name: "Search again" }));

    await waitFor(() => {
      expect(window.api.search).toHaveBeenCalledWith("reimbursement");
    });
    await waitFor(() => {
      expect(screen.queryByText(/^Saved results from/)).not.toBeInTheDocument();
    });
  });

  it("Search again uses the saved query, not a live edit to the input", async () => {
    // Guards `handleSearch(lastQuery)` at the "Search again" callsite — every
    // other restore test clicks it while the input still equals the saved
    // query, so a regression to a bare `handleSearch()` (which falls back to
    // the live input via `queryRef.current`) would pass them undetected.
    mockApi({
      hasCohereKey: true,
      sourceCount: 1,
      searchResponse: { results: [], rerankFailed: false },
    });
    render(
      <SearchPage
        visible={true}
        restore={{ detail: RESTORE_DETAIL, token: 1 }}
      />,
    );
    await screen.findByText(/^Saved results from/);

    const input = screen.getByLabelText("Search your documents");
    fireEvent.change(input, { target: { value: "something else entirely" } });

    fireEvent.click(screen.getByRole("button", { name: "Search again" }));

    await waitFor(() => {
      expect(window.api.search).toHaveBeenCalledWith("reimbursement");
    });
    expect(window.api.search).not.toHaveBeenCalledWith(
      "something else entirely",
    );
  });

  it("disables Search again when the provider is not ready, while the snapshot keeps rendering", async () => {
    mockApi({ hasCohereKey: false, sourceCount: 1 });
    render(
      <SearchPage
        visible={true}
        restore={{ detail: RESTORE_DETAIL, token: 1 }}
      />,
    );

    expect(await screen.findByText("Reimbursement Policy")).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Search again" }),
      ).toBeDisabled();
    });
  });

  it("a restore that lands mid-flight of a live search wins — the stale response is dropped", async () => {
    const { promise: searchPromise, resolve: resolveSearch } =
      deferred<SearchResponse>();
    mockApi({ hasCohereKey: true, sourceCount: 1 });
    window.api.search = vi.fn(() => searchPromise);

    const { rerender } = render(<SearchPage visible={true} />);
    const input = await screen.findByLabelText("Search your documents");
    fireEvent.change(input, { target: { value: "budget" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Live search now in flight — skeleton on screen.
    expect(document.querySelectorAll(".animate-pulse").length).toBeGreaterThan(
      0,
    );

    rerender(
      <SearchPage
        visible={true}
        restore={{ detail: RESTORE_DETAIL, token: 1 }}
      />,
    );

    expect(await screen.findByText("Reimbursement Policy")).toBeInTheDocument();
    expect(screen.getByText(/^Saved results from/)).toBeInTheDocument();
    expect(document.querySelectorAll(".animate-pulse").length).toBe(0);

    resolveSearch({
      results: [
        {
          chunkId: "c2",
          documentTitle: "Different Doc",
          snippet: "unrelated",
          heading: null,
          url: null,
          provider: "notion",
          score: 0.5,
        },
      ],
      rerankFailed: false,
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Reimbursement Policy")).toBeInTheDocument();
    expect(screen.queryByText("Different Doc")).not.toBeInTheDocument();
    expect(screen.getByText(/^Saved results from/)).toBeInTheDocument();
    expect(document.querySelectorAll(".animate-pulse").length).toBe(0);
  });

  it("re-hydrates the same entry when restored again with a new token after an intervening live search", async () => {
    mockApi({
      hasCohereKey: true,
      sourceCount: 1,
      searchResponse: {
        results: [
          {
            chunkId: "c3",
            documentTitle: "Live Result",
            snippet: "live",
            heading: null,
            url: null,
            provider: "notion",
            score: 0.4,
          },
        ],
        rerankFailed: false,
      },
    });

    const { rerender } = render(
      <SearchPage
        visible={true}
        restore={{ detail: RESTORE_DETAIL, token: 1 }}
      />,
    );
    await screen.findByText("Reimbursement Policy");

    // Intervening live search clears the banner and the restored snapshot.
    fireEvent.click(screen.getByRole("button", { name: "Search again" }));
    await screen.findByText("Live Result");
    expect(screen.queryByText(/^Saved results from/)).not.toBeInTheDocument();

    // Restoring the same entry again requires a new token to re-fire the effect.
    rerender(
      <SearchPage
        visible={true}
        restore={{ detail: RESTORE_DETAIL, token: 2 }}
      />,
    );

    expect(await screen.findByText(/^Saved results from/)).toBeInTheDocument();
    expect(screen.getByText("Reimbursement Policy")).toBeInTheDocument();
    expect(screen.queryByText("Live Result")).not.toBeInTheDocument();
  });

  it("a fresh live search after a restore clears the banner", async () => {
    mockApi({
      hasCohereKey: true,
      sourceCount: 1,
      searchResponse: { results: [], rerankFailed: false },
    });
    render(
      <SearchPage
        visible={true}
        restore={{ detail: RESTORE_DETAIL, token: 1 }}
      />,
    );
    await screen.findByText(/^Saved results from/);

    const input = screen.getByLabelText("Search your documents");
    fireEvent.change(input, { target: { value: "new query" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(screen.queryByText(/^Saved results from/)).not.toBeInTheDocument();
    });
    expect(window.api.search).toHaveBeenCalledWith("new query");
  });
});

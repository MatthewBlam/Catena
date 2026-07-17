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
import { SourceList } from "../SourceList";
import type {
  SourceWithCount,
  SyncProgress,
} from "../../../../../shared/types";

afterEach(cleanup);

function makeSource(overrides: Partial<SourceWithCount> = {}): SourceWithCount {
  return {
    id: "s1",
    provider: "notion",
    name: "Source One",
    rootExternalId: "root1",
    createdAt: "2024-01-01T00:00:00.000Z",
    lastSyncAt: null,
    lastSyncStatus: null,
    lastSyncError: null,
    lastSyncErrorCount: 0,
    documentCount: 3,
    ...overrides,
  };
}

function makeProgress(overrides: Partial<SyncProgress> = {}): SyncProgress {
  return {
    sourceId: "s1",
    phase: "fetching",
    current: 0,
    skipped: 0,
    total: 0,
    deleted: 0,
    currentDocTitle: null,
    errors: [],
    ...overrides,
  };
}

/**
 * Mirrors SyncPanel.test.tsx's `mockApi` helper: stub only what the
 * component under test (and the SyncPanel it may mount) actually calls.
 * `onSyncProgress` fans out to every subscriber — both SourceList's own
 * subscription and any mounted SyncPanel's — via `fireProgress`, the same
 * "capture the callback" idiom used to simulate main pushing an event.
 * `fireSourcesChanged` does the same for `sources:changed`.
 *
 * `syncSource` is deferred per source id rather than left permanently
 * pending: a mounted SyncPanel's `autoStart` effect calls it and hangs until
 * `resolveSyncSource(id)` releases that specific call, so a test can hold a
 * sync "in flight" and free its queue slot at a chosen moment (Finding 1).
 */
function mockApi(): {
  fireProgress: (p: SyncProgress) => void;
  fireSourcesChanged: () => void;
  resolveSyncSource: (sourceId: string) => Promise<void>;
} {
  let progressListeners: Array<(p: SyncProgress) => void> = [];
  let sourcesListeners: Array<() => void> = [];
  const syncResolvers = new Map<string, () => void>();
  window.api = {
    getActiveSyncs: vi.fn(() =>
      Promise.resolve({
        active: [],
        scheduler: {
          enabled: false,
          intervalMs: 0,
          lastSyncedAt: null,
          syncing: false,
        },
      }),
    ),
    onSourcesChanged: vi.fn((cb: () => void) => {
      sourcesListeners.push(cb);
      return () => {
        sourcesListeners = sourcesListeners.filter((l) => l !== cb);
      };
    }),
    onSyncProgress: vi.fn((cb: (p: SyncProgress) => void) => {
      progressListeners.push(cb);
      return () => {
        progressListeners = progressListeners.filter((l) => l !== cb);
      };
    }),
    listDocumentsBySource: vi.fn(() => Promise.resolve([])),
    removeSource: vi.fn(() => Promise.resolve()),
    openExternal: vi.fn(() => Promise.resolve()),
    syncSource: vi.fn(
      (sourceId: string) =>
        new Promise<void>((resolve) => {
          syncResolvers.set(sourceId, resolve);
        }),
    ),
    cancelSync: vi.fn(() => Promise.resolve()),
  } as unknown as typeof window.api;

  return {
    fireProgress: (p) => {
      act(() => {
        for (const listener of progressListeners) listener(p);
      });
    },
    fireSourcesChanged: () => {
      act(() => {
        for (const listener of sourcesListeners) listener();
      });
    },
    resolveSyncSource: async (sourceId) => {
      syncResolvers.get(sourceId)?.();
      await act(async () => {});
    },
  };
}

describe("SourceList — scheduler-started syncs", () => {
  it("a sync:progress event for an unknown source adds a syncing indicator", async () => {
    const { fireProgress } = mockApi();
    render(<SourceList sources={[makeSource()]} onRefresh={vi.fn()} />);
    await screen.findByText("Source One");
    expect(screen.getByTitle("Sync")).not.toBeDisabled();

    fireProgress(makeProgress({ sourceId: "s1", phase: "fetching" }));

    expect(screen.getByTitle("Sync")).toBeDisabled();
    expect(screen.getByText("Syncing Source One")).toBeInTheDocument();
  });

  it("a terminal-phase event removes the syncing indicator", async () => {
    const { fireProgress } = mockApi();
    render(<SourceList sources={[makeSource()]} onRefresh={vi.fn()} />);
    await screen.findByText("Source One");

    fireProgress(makeProgress({ sourceId: "s1", phase: "fetching" }));
    expect(screen.getByTitle("Sync")).toBeDisabled();

    fireProgress(makeProgress({ sourceId: "s1", phase: "done" }));

    expect(screen.getByTitle("Sync")).not.toBeDisabled();
    expect(screen.queryByText("Syncing Source One")).not.toBeInTheDocument();
  });

  it("startLocalSync no-ops when the source is already syncing", async () => {
    const { fireProgress } = mockApi();
    render(<SourceList sources={[makeSource()]} onRefresh={vi.fn()} />);
    await screen.findByText("Source One");

    // A scheduler-started sync main now owns.
    fireProgress(makeProgress({ sourceId: "s1", phase: "fetching" }));
    expect(screen.getByText("Syncing Source One")).toBeInTheDocument();

    // Clicking Sync while it's already active must not start a second,
    // locally-owned sync — that would call `syncSource` again and hit
    // "Sync already in progress" in main.
    fireEvent.click(screen.getByTitle("Sync"));

    expect(window.api.syncSource).not.toHaveBeenCalled();
    expect(screen.getAllByText("Syncing Source One")).toHaveLength(1);
  });
});

describe("SourceList — sources:changed debounce (F11)", () => {
  it("collapses a burst of sources:changed events into a single refetch", async () => {
    const onRefresh = vi.fn();
    const { fireSourcesChanged } = mockApi();
    render(<SourceList sources={[makeSource()]} onRefresh={onRefresh} />);
    await screen.findByText("Source One");
    onRefresh.mockClear();
    (window.api.getActiveSyncs as ReturnType<typeof vi.fn>).mockClear();

    vi.useFakeTimers();
    try {
      // Simulates "Sync all" completing N sources in a tight burst — each
      // completion fires `sources:changed` once.
      fireSourcesChanged();
      fireSourcesChanged();
      fireSourcesChanged();

      // Nothing has fired yet — still within the debounce window.
      expect(onRefresh).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(250);
      });

      expect(onRefresh).toHaveBeenCalledTimes(1);
      expect(window.api.getActiveSyncs).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending debounced refetch on unmount", async () => {
    const onRefresh = vi.fn();
    const { fireSourcesChanged } = mockApi();
    const { unmount } = render(
      <SourceList sources={[makeSource()]} onRefresh={onRefresh} />,
    );
    await screen.findByText("Source One");
    onRefresh.mockClear();

    vi.useFakeTimers();
    try {
      fireSourcesChanged();
      unmount();

      act(() => {
        vi.advanceTimersByTime(250);
      });

      expect(onRefresh).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SourceList — Sync-all queue coherence (Finding 1)", () => {
  function threeSources(): SourceWithCount[] {
    return [
      makeSource({ id: "s1", name: "Source One" }),
      makeSource({ id: "s2", name: "Source Two" }),
      makeSource({ id: "s3", name: "Source Three" }),
    ];
  }

  it("does not re-start a still-queued source that main claims mid-drain", async () => {
    const { fireProgress, resolveSyncSource } = mockApi();
    render(<SourceList sources={threeSources()} onRefresh={vi.fn()} />);
    await screen.findByText("Source One");

    // Sync-all at concurrency 2: s1 and s2 start immediately, s3 queues.
    fireEvent.click(screen.getByRole("button", { name: "Sync all" }));

    expect(window.api.syncSource).toHaveBeenCalledTimes(2);
    expect(window.api.syncSource).toHaveBeenCalledWith("s1");
    expect(window.api.syncSource).toHaveBeenCalledWith("s2");
    expect(window.api.syncSource).not.toHaveBeenCalledWith("s3");

    // Main claims the still-queued s3 mid-drain — e.g. the scheduler beat
    // the queue to it, or another window started it.
    fireProgress(makeProgress({ sourceId: "s3", phase: "fetching" }));
    expect(screen.getByText("Syncing Source Three")).toBeInTheDocument();

    // A slot frees: s1's sync completes.
    await resolveSyncSource("s1");
    await screen.findByText("Sync complete");

    // The freed slot must not be handed to s3 — it's already syncing under
    // main's ownership. Before the fix, `pumpQueue` spliced ids off the
    // queue without checking `mainActiveRef`, so it would hand s3 a new
    // local generation and remount its panel with a fresh `autoStart` that
    // re-called `syncSource` while main's own sync was still in flight —
    // producing a spurious "Sync already in progress" error panel.
    expect(window.api.syncSource).toHaveBeenCalledTimes(2);
    expect(window.api.syncSource).not.toHaveBeenCalledWith("s3");
    // Still the single, main-owned panel — not a second, locally-started one.
    expect(screen.getAllByText("Syncing Source Three")).toHaveLength(1);
  });

  it("dequeues a source when the user starts it manually before its turn", async () => {
    const { resolveSyncSource } = mockApi();
    render(<SourceList sources={threeSources()} onRefresh={vi.fn()} />);
    await screen.findByText("Source One");

    // Sync-all at concurrency 2: s1 and s2 start immediately, s3 queues.
    fireEvent.click(screen.getByRole("button", { name: "Sync all" }));
    expect(window.api.syncSource).toHaveBeenCalledTimes(2);

    // The user clicks s3's own Sync button while it is still waiting in the
    // queue.
    const syncButtons = screen.getAllByTitle("Sync");
    fireEvent.click(syncButtons[2]);

    expect(window.api.syncSource).toHaveBeenCalledTimes(3);
    expect(window.api.syncSource).toHaveBeenCalledWith("s3");

    // s3 itself finishes first: `releaseSlot` drops it out of
    // `startedLocallyRef`, so from here on `pumpQueue`'s own
    // already-syncing filter can no longer protect it — only having been
    // dequeued from `queueRef` up front (in `startLocalSync`) can.
    await resolveSyncSource("s3");
    await screen.findByText("Sync complete");

    // A second slot frees. If `startLocalSync` had not dequeued s3 from
    // `queueRef` when the user clicked it, this stale entry would still be
    // sitting in the queue — no longer shielded by `startedLocallyRef` now
    // that s3 has already settled — and `pumpQueue` would start it again.
    await resolveSyncSource("s1");
    await waitFor(() => {
      expect(screen.getAllByText("Sync complete")).toHaveLength(2);
    });

    const s3Calls = (
      window.api.syncSource as ReturnType<typeof vi.fn>
    ).mock.calls.filter(([id]) => id === "s3");
    expect(s3Calls).toHaveLength(1);
  });
});

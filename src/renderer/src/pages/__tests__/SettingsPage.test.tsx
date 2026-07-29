// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  render,
  screen,
  cleanup,
  act,
  fireEvent,
} from "@testing-library/react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { SettingsPage } from "../SettingsPage";
import type { StorageStats } from "../../../../shared/types";

afterEach(cleanup);

const STATS: StorageStats = {
  sourceCount: 1,
  documentCount: 2,
  chunkCount: 3,
  dbSizeBytes: 1024,
};

/**
 * Stubs the full surface `refresh()` reads on mount, plus `getAutoSync` for
 * the debounced sync-status effect under test (F11). `onSyncProgress` /
 * `onSourcesChanged` capture listeners so a test can simulate main pushing a
 * burst of events — mirrors SourceList.test.tsx / SearchPage.test.tsx.
 */
function mockApi(): {
  fireProgress: () => void;
  fireSourcesChanged: () => void;
} {
  let progressListeners: Array<() => void> = [];
  let sourcesListeners: Array<() => void> = [];
  window.api = {
    getEmbeddingProvider: vi.fn(() => Promise.resolve("cohere")),
    hasSecret: vi.fn(() => Promise.resolve(true)),
    getStorageStats: vi.fn(() => Promise.resolve(STATS)),
    getAutoSync: vi.fn(() =>
      Promise.resolve({
        enabled: true,
        intervalMs: 30 * 60 * 1000,
        lastSyncedAt: null,
        syncing: false,
      }),
    ),
    getTelemetryEnabled: vi.fn(() => Promise.resolve(true)),
    onSyncProgress: vi.fn((cb: () => void) => {
      progressListeners.push(cb);
      return () => {
        progressListeners = progressListeners.filter((l) => l !== cb);
      };
    }),
    onSourcesChanged: vi.fn((cb: () => void) => {
      sourcesListeners.push(cb);
      return () => {
        sourcesListeners = sourcesListeners.filter((l) => l !== cb);
      };
    }),
  } as unknown as typeof window.api;

  return {
    fireProgress: () => {
      act(() => {
        for (const l of progressListeners) l();
      });
    },
    fireSourcesChanged: () => {
      act(() => {
        for (const l of sourcesListeners) l();
      });
    },
  };
}

describe("SettingsPage — sync-state refetch debounce + visibility gate (F11)", () => {
  it("does not refetch sync state from progress events while not visible, then re-syncs once on becoming visible", async () => {
    const { fireProgress } = mockApi();
    const { rerender } = render(
      <SettingsPage
        visible={false}
        dark={false}
        onToggleTheme={vi.fn()}
        onProviderReset={vi.fn()}
      />,
    );
    await act(async () => {});
    expect(window.api.getAutoSync).not.toHaveBeenCalled();

    // Progress events while the page is not visible must not trigger the
    // getAutoSync round-trip at all — not even a deferred/debounced one.
    fireProgress();
    fireProgress();
    fireProgress();
    expect(window.api.getAutoSync).not.toHaveBeenCalled();

    // Switching to the Settings tab: the page becomes visible and must catch
    // up immediately (not wait out a debounce window) so state missed while
    // hidden — including a terminal sync that finished off-screen — is not
    // stuck stale.
    rerender(
      <SettingsPage
        visible={true}
        dark={false}
        onToggleTheme={vi.fn()}
        onProviderReset={vi.fn()}
      />,
    );

    expect(window.api.getAutoSync).toHaveBeenCalled();
  });

  it("collapses a burst of onSyncProgress events into a single trailing refetch while visible", async () => {
    const { fireProgress } = mockApi();
    render(
      <SettingsPage
        visible={true}
        dark={false}
        onToggleTheme={vi.fn()}
        onProviderReset={vi.fn()}
      />,
    );
    // Let the initial mount settle (refresh()'s Promise.all plus the
    // becoming-visible catch-up call) before measuring the burst in isolation.
    await screen.findByText("Sources");
    const callsBefore = (window.api.getAutoSync as ReturnType<typeof vi.fn>)
      .mock.calls.length;

    vi.useFakeTimers();
    try {
      // Sync-manager emits ~4 sync:progress events per document — a burst,
      // not a trickle.
      fireProgress();
      fireProgress();
      fireProgress();
      fireProgress();

      expect(window.api.getAutoSync).toHaveBeenCalledTimes(callsBefore);

      act(() => {
        vi.advanceTimersByTime(300);
      });

      // Trailing edge: exactly one refetch lands for the whole burst.
      expect(window.api.getAutoSync).toHaveBeenCalledTimes(callsBefore + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending debounced refetch on unmount", async () => {
    const { fireProgress } = mockApi();
    const { unmount } = render(
      <SettingsPage
        visible={true}
        dark={false}
        onToggleTheme={vi.fn()}
        onProviderReset={vi.fn()}
      />,
    );
    await screen.findByText("Sources");
    const callsBefore = (window.api.getAutoSync as ReturnType<typeof vi.fn>)
      .mock.calls.length;

    vi.useFakeTimers();
    try {
      fireProgress();
      unmount();

      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(window.api.getAutoSync).toHaveBeenCalledTimes(callsBefore);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("SettingsPage — analytics off confirmation", () => {
  function renderVisible(): void {
    render(
      <SettingsPage
        visible={true}
        dark={false}
        onToggleTheme={vi.fn()}
        onProviderReset={vi.fn()}
      />,
    );
  }

  it("turning analytics off asks first and only persists on confirm", async () => {
    mockApi();
    const setTelemetry = vi.fn(() => Promise.resolve());
    window.api.setTelemetryEnabled = setTelemetry;
    renderVisible();
    await act(async () => {});

    const toggle = screen.getByRole("switch", {
      name: "Anonymous usage analytics",
    });
    fireEvent.click(toggle);

    // The confirmation modal appears and nothing is persisted yet.
    expect(
      screen.getByText("Turn off anonymous analytics?"),
    ).toBeInTheDocument();
    expect(setTelemetry).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Turn it off" }));
    await act(async () => {});

    expect(setTelemetry).toHaveBeenCalledWith(false);
  });

  it("keeping analytics on persists nothing and leaves the toggle on", async () => {
    mockApi();
    const setTelemetry = vi.fn(() => Promise.resolve());
    window.api.setTelemetryEnabled = setTelemetry;
    renderVisible();
    await act(async () => {});

    const toggle = screen.getByRole("switch", {
      name: "Anonymous usage analytics",
    });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(
      screen.getByText("Turn off anonymous analytics?"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Keep it on" }));
    await act(async () => {});

    expect(setTelemetry).not.toHaveBeenCalled();
    // The switch never moved — the disable was never applied.
    expect(toggle).toBeChecked();
  });
});

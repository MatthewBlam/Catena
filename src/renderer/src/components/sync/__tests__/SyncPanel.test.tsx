// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { SyncPanel } from "../SyncPanel";
import type { SyncProgress } from "../../../../../shared/types";

afterEach(cleanup);

function makeProgress(overrides: Partial<SyncProgress> = {}): SyncProgress {
  return {
    sourceId: "s1",
    startedAt: "2024-01-01T00:00:00Z",
    phase: "done",
    current: 0,
    skipped: 0,
    total: 0,
    deleted: 0,
    currentDocTitle: null,
    errors: [],
    ...overrides,
  };
}

function mockApi(overrides: {
  syncSource?: () => Promise<void>;
  cancelSync?: () => Promise<void>;
  // The observe-only elapsed fetch (5b). Defaults to "no active syncs", so a
  // panel with no seeded start time falls back to counting from mount.
  getActiveSyncs?: () => Promise<{ active: unknown[] }>;
}): void {
  window.api = {
    onSyncProgress: vi.fn(() => () => {}),
    syncSource: vi.fn(overrides.syncSource ?? (() => new Promise(() => {}))),
    cancelSync: vi.fn(overrides.cancelSync ?? (() => Promise.resolve())),
    getActiveSyncs: vi.fn(
      overrides.getActiveSyncs ?? (() => Promise.resolve({ active: [] })),
    ),
  } as unknown as typeof window.api;
}

beforeEach(() => {
  mockApi({});
});

describe("SyncPanel", () => {
  it("shows Cancel (not Dismiss) while syncing", () => {
    render(
      <SyncPanel
        sourceId="s1"
        sourceName="My Source"
        onComplete={vi.fn()}
        autoStart={false}
      />,
    );
    expect(screen.getByText("Syncing My Source")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Dismiss" }),
    ).not.toBeInTheDocument();
  });

  it("on a failed sync: shows Dismiss and the error, never 'Done', and settles once", async () => {
    mockApi({
      syncSource: () => Promise.reject(new Error("bad key")),
    });
    const onSettled = vi.fn();
    const onComplete = vi.fn();
    render(
      <SyncPanel
        sourceId="s1"
        sourceName="My Source"
        onComplete={onComplete}
        onSettled={onSettled}
      />,
    );

    await screen.findByText("Sync failed for My Source");
    expect(screen.getByText("bad key")).toBeInTheDocument();
    expect(screen.queryByText("Done")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Cancel" }),
    ).not.toBeInTheDocument();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("does not call onSettled again when the parent re-renders with a new callback identity", async () => {
    mockApi({ syncSource: () => Promise.reject(new Error("bad key")) });
    const onSettled1 = vi.fn();
    const { rerender } = render(
      <SyncPanel
        sourceId="s1"
        sourceName="My Source"
        onComplete={vi.fn()}
        onSettled={onSettled1}
      />,
    );
    await screen.findByText("Sync failed for My Source");
    expect(onSettled1).toHaveBeenCalledTimes(1);

    // Simulate SourceList's inline `onSettled={() => releaseSlot(id)}`, which
    // is a fresh function identity on every parent re-render.
    const onSettled2 = vi.fn();
    rerender(
      <SyncPanel
        sourceId="s1"
        sourceName="My Source"
        onComplete={vi.fn()}
        onSettled={onSettled2}
      />,
    );
    expect(onSettled1).toHaveBeenCalledTimes(1);
    expect(onSettled2).not.toHaveBeenCalled();
  });

  it("on cancel: shows the Canceled footer and Dismiss, never 'Done', and settles once", async () => {
    const onSettled = vi.fn();
    const onComplete = vi.fn();
    render(
      <SyncPanel
        sourceId="s1"
        sourceName="My Source"
        onComplete={onComplete}
        onSettled={onSettled}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(await screen.findByText("Sync canceled")).toBeInTheDocument();
    expect(screen.getByText("Canceled")).toBeInTheDocument();
    expect(screen.queryByText("Done")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("still auto-dismisses on the 1.5s timer when a sibling re-render re-passes fresh callbacks mid-window (5a)", async () => {
    vi.useFakeTimers();
    try {
      mockApi({ syncSource: () => Promise.resolve() });
      const onComplete1 = vi.fn();
      const { rerender } = render(
        <SyncPanel
          sourceId="s1"
          sourceName="My Source"
          onComplete={onComplete1}
          onSettled={vi.fn()}
        />,
      );

      // Let syncSource resolve → status "complete" → the 1.5s timer is armed.
      await act(async () => {});

      // Partway through the window, a sibling sync's progress re-renders the
      // parent, which passes brand-new inline closures. The old effect (deps
      // included onComplete) tore down and re-armed the timer on every such
      // re-render, so it never reached 1.5s of uninterrupted time.
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      const onComplete2 = vi.fn();
      rerender(
        <SyncPanel
          sourceId="s1"
          sourceName="My Source"
          onComplete={onComplete2}
          onSettled={vi.fn()}
        />,
      );

      // Another 1s — 2s total since the status transition, but only 1s since the
      // re-render. The fixed timer (armed once, on the transition) has fired.
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      expect(onComplete2).toHaveBeenCalledTimes(1);
      expect(onComplete1).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("observe-only panel counts elapsed from the sync's true start, not mount (5b)", async () => {
    // The sync (owned by main) began ~2m5s ago. A Sources tab opened now mounts
    // an observe-only panel; it must show the real elapsed, not seconds-from-mount.
    const startedAt = new Date(Date.now() - 125_000).toISOString();
    mockApi({
      getActiveSyncs: () =>
        Promise.resolve({
          active: [
            {
              sourceId: "s1",
              startedAt,
              phase: "fetching",
              current: 0,
              skipped: 0,
              total: 0,
              deleted: 0,
              currentDocTitle: null,
              errors: [],
            },
          ],
        }),
    });

    render(
      <SyncPanel
        sourceId="s1"
        sourceName="My Source"
        onComplete={vi.fn()}
        autoStart={false}
      />,
    );

    // Once the active-sync fetch resolves, elapsed reflects the true ~2m start,
    // not the "0s" it would show counting from mount.
    expect(await screen.findByText(/^2m \d+s$/)).toBeInTheDocument();
  });

  it("on completion: shows the Dismissing… footer, never 'Done', and settles once", async () => {
    mockApi({ syncSource: () => Promise.resolve() });
    const onSettled = vi.fn();
    render(
      <SyncPanel
        sourceId="s1"
        sourceName="My Source"
        onComplete={vi.fn()}
        onSettled={onSettled}
      />,
    );

    await screen.findByText("Sync complete");
    expect(screen.getByText("Dismissing…")).toBeInTheDocument();
    expect(screen.queryByText("Done")).not.toBeInTheDocument();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("holds the panel open (no auto-dismiss) when the sync completed with per-document errors", async () => {
    vi.useFakeTimers();
    try {
      let fire!: (p: SyncProgress) => void;
      window.api = {
        onSyncProgress: vi.fn((cb: (p: SyncProgress) => void) => {
          fire = cb;
          return () => {};
        }),
        syncSource: vi.fn(() => Promise.resolve()),
        cancelSync: vi.fn(() => Promise.resolve()),
        getActiveSyncs: vi.fn(() => Promise.resolve({ active: [] })),
      } as unknown as typeof window.api;

      const onComplete = vi.fn();
      const onSettled = vi.fn();
      render(
        <SyncPanel
          sourceId="s1"
          sourceName="My Source"
          onComplete={onComplete}
          onSettled={onSettled}
        />,
      );

      // The final progress event carries a per-document error; then the sync
      // itself resolves (a partial success — not a thrown failure).
      act(() => {
        fire(
          makeProgress({
            phase: "done",
            errors: ["Doc X failed: rate limited"],
          }),
        );
      });
      await act(async () => {});

      // Labeled as a completion-with-errors, the error is shown, and a Dismiss
      // button is offered — it does NOT claim to be auto-dismissing.
      expect(
        screen.getByText("Sync completed with errors"),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Doc X failed: rate limited"),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Dismiss" }),
      ).toBeInTheDocument();
      expect(screen.queryByText("Dismissing…")).not.toBeInTheDocument();
      // Settled once (frees the queue slot) but not dismissed.
      expect(onSettled).toHaveBeenCalledTimes(1);

      // The 1.5s auto-dismiss window passes without dismissing.
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(onComplete).not.toHaveBeenCalled();

      // The user can still dismiss manually.
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      expect(onComplete).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

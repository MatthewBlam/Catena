// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  cleanup,
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
 */
function mockApi(): { fireProgress: (p: SyncProgress) => void } {
  let listeners: Array<(p: SyncProgress) => void> = [];
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
    onSourcesChanged: vi.fn(() => () => {}),
    onSyncProgress: vi.fn((cb: (p: SyncProgress) => void) => {
      listeners.push(cb);
      return () => {
        listeners = listeners.filter((l) => l !== cb);
      };
    }),
    listDocumentsBySource: vi.fn(() => Promise.resolve([])),
    removeSource: vi.fn(() => Promise.resolve()),
    openExternal: vi.fn(() => Promise.resolve()),
    syncSource: vi.fn(() => new Promise(() => {})),
    cancelSync: vi.fn(() => Promise.resolve()),
  } as unknown as typeof window.api;

  return {
    fireProgress: (p) => {
      act(() => {
        for (const listener of listeners) listener(p);
      });
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

// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { SyncPanel } from "../SyncPanel";

afterEach(cleanup);

function mockApi(overrides: {
  syncSource?: () => Promise<void>;
  cancelSync?: () => Promise<void>;
}): void {
  window.api = {
    onSyncProgress: vi.fn(() => () => {}),
    syncSource: vi.fn(overrides.syncSource ?? (() => new Promise(() => {}))),
    cancelSync: vi.fn(overrides.cancelSync ?? (() => Promise.resolve())),
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
});

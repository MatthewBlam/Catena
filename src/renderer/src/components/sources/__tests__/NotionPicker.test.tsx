// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { NotionPicker } from "../NotionPicker";
import type {
  NotionItemSummary,
  NotionOAuthStarted,
  OrphanedNotionSource,
  SourceWithCount,
} from "../../../../../shared/types";

afterEach(cleanup);

function page(id: string, title: string): NotionItemSummary {
  return { id, title, icon: null };
}

const ORIGINAL = [page("p1", "Onboarding Guide")];
const WIDENED = [page("p1", "Onboarding Guide"), page("p2", "Budget 2026")];

function source(id: string, name: string): SourceWithCount {
  return {
    id,
    provider: "notion",
    name,
    rootExternalId: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSyncAt: null,
    lastSyncStatus: null,
    lastSyncError: null,
    lastSyncErrorCount: 0,
    documentCount: 1,
  };
}

const SOURCES = [source("p1", "Onboarding Guide")];

interface ApiOverrides {
  listNotionPages?: () => Promise<NotionItemSummary[]>;
  startNotionOAuth?: () => Promise<NotionOAuthStarted>;
  checkNotionSourceAccess?: () => Promise<OrphanedNotionSource[]>;
  listSources?: () => Promise<SourceWithCount[]>;
}

function mockApi(overrides: ApiOverrides = {}): {
  listNotionPages: ReturnType<typeof vi.fn>;
  startNotionOAuth: ReturnType<typeof vi.fn>;
  cancelNotionOAuth: ReturnType<typeof vi.fn>;
  resolveNotionWorkspaceSwitch: ReturnType<typeof vi.fn>;
  checkNotionSourceAccess: ReturnType<typeof vi.fn>;
  listSources: ReturnType<typeof vi.fn>;
} {
  const api = {
    listNotionPages: vi.fn(
      overrides.listNotionPages ?? (() => Promise.resolve(ORIGINAL)),
    ),
    startNotionOAuth: vi.fn(
      overrides.startNotionOAuth ??
        (() => Promise.resolve({ workspaceName: "Design Team" })),
    ),
    cancelNotionOAuth: vi.fn(() => Promise.resolve()),
    resolveNotionWorkspaceSwitch: vi.fn(() => Promise.resolve()),
    checkNotionSourceAccess: vi.fn(
      overrides.checkNotionSourceAccess ?? (() => Promise.resolve([])),
    ),
    listSources: vi.fn(
      overrides.listSources ?? (() => Promise.resolve(SOURCES)),
    ),
  };
  window.api = api as unknown as typeof window.api;
  return api;
}

function renderPicker(): void {
  render(
    <NotionPicker
      onAdd={() => Promise.resolve({ added: 0, failed: 0 })}
      onClose={() => {}}
    />,
  );
}

const REAUTH_BUTTON = "Choose pages in Notion…";

/** Click through the pre-flight warning to the point OAuth actually opens. */
async function startReauth(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: REAUTH_BUTTON }));
  await screen.findByText(/replaces your page selection/i);
  fireEvent.click(screen.getByRole("button", { name: "Open Notion" }));
}

describe("NotionPicker — warning before Notion's replacing picker", () => {
  it("warns, and names the pages to keep selected, before opening Notion", async () => {
    // The whole bug: Notion's picker opens unchecked and the selection made
    // there becomes the *complete* grant, so anything not re-ticked is dropped.
    const api = mockApi();
    renderPicker();
    await screen.findByText("Onboarding Guide");

    fireEvent.click(screen.getByRole("button", { name: REAUTH_BUTTON }));

    await screen.findByText(/replaces your page selection/i);
    // The user cannot re-tick what they cannot remember.
    expect(
      screen.getByText("Onboarding Guide", { selector: "li" }),
    ).toBeInTheDocument();
    // Nothing has happened yet — the browser has not been opened.
    expect(api.startNotionOAuth).not.toHaveBeenCalled();
  });

  it("does not open Notion when the warning is dismissed", async () => {
    const api = mockApi();
    renderPicker();
    await screen.findByText("Onboarding Guide");

    fireEvent.click(screen.getByRole("button", { name: REAUTH_BUTTON }));
    await screen.findByText(/replaces your page selection/i);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(
        screen.queryByText(/replaces your page selection/i),
      ).not.toBeInTheDocument(),
    );
    expect(api.startNotionOAuth).not.toHaveBeenCalled();
  });

  it("reloads the list once the user confirms and authorizes", async () => {
    const api = mockApi();
    api.listNotionPages
      .mockImplementationOnce(() => Promise.resolve(ORIGINAL))
      .mockImplementationOnce(() => Promise.resolve(WIDENED));
    renderPicker();
    await screen.findByText("Onboarding Guide");

    await startReauth();

    expect(api.startNotionOAuth).toHaveBeenCalled();
    await screen.findByText("Budget 2026");
  });

  it("offers the flow from the empty state", async () => {
    mockApi({ listNotionPages: () => Promise.resolve([]) });
    renderPicker();

    await screen.findByText("No pages found.");
    expect(
      screen.getByRole("button", { name: REAUTH_BUTTON }),
    ).toBeInTheDocument();
  });

  it("shows a cancellable waiting state while the browser flow is open", async () => {
    const api = mockApi({ startNotionOAuth: () => new Promise(() => {}) });
    renderPicker();
    await screen.findByText("Onboarding Guide");

    await startReauth();

    await screen.findByText(/Waiting for Notion authorization/i);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.cancelNotionOAuth).toHaveBeenCalled();
  });

  it("returns quietly to the list when the user cancels the flow", async () => {
    mockApi({
      startNotionOAuth: () => Promise.reject(new Error("OAuth canceled")),
    });
    renderPicker();
    await screen.findByText("Onboarding Guide");

    await startReauth();

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: REAUTH_BUTTON }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/failed/i)).not.toBeInTheDocument();
    expect(screen.getByText("Onboarding Guide")).toBeInTheDocument();
  });

  it("reports a genuine failure without destroying the loaded list", async () => {
    mockApi({
      startNotionOAuth: () =>
        Promise.reject(new Error("Token exchange failed")),
    });
    renderPicker();
    await screen.findByText("Onboarding Guide");

    await startReauth();

    await screen.findByText("Token exchange failed");
    expect(screen.getByText("Onboarding Guide")).toBeInTheDocument();
  });
});

describe("NotionPicker — catching sources that lost access", () => {
  it("names the sources stranded by the new selection", async () => {
    // Silent until now: a stranded source keeps looking healthy in the Sources
    // tab and only fails at the next sync.
    mockApi({
      checkNotionSourceAccess: () =>
        Promise.resolve([{ id: "s2", name: "Budget 2026" }]),
    });
    renderPicker();
    await screen.findByText("Onboarding Guide");

    await startReauth();

    await screen.findByText(/no longer has access/i);
    expect(screen.getByText(/Budget 2026/)).toBeInTheDocument();
  });

  it("stays quiet when nothing was stranded", async () => {
    mockApi();
    renderPicker();
    await screen.findByText("Onboarding Guide");

    await startReauth();

    await waitFor(() =>
      expect(window.api.checkNotionSourceAccess).toHaveBeenCalled(),
    );
    expect(screen.queryByText(/no longer has access/i)).not.toBeInTheDocument();
  });
});

describe("NotionPicker — workspace switch guard", () => {
  const SWITCH: NotionOAuthStarted = {
    workspaceName: "Personal",
    workspaceSwitch: {
      previousName: "Design Team",
      nextName: "Personal",
      sourceCount: 4,
    },
  };

  function mockSwitchApi(): ReturnType<typeof mockApi> {
    return mockApi({ startNotionOAuth: () => Promise.resolve(SWITCH) });
  }

  it("asks before switching, and does not reload against the withheld token", async () => {
    const api = mockSwitchApi();
    renderPicker();
    await screen.findByText("Onboarding Guide");
    api.listNotionPages.mockClear();

    await startReauth();

    await screen.findByText(/Switch Notion workspace/i);
    expect(api.listNotionPages).not.toHaveBeenCalled();
    expect(api.resolveNotionWorkspaceSwitch).not.toHaveBeenCalled();
  });

  it("commits and reloads when the switch is confirmed", async () => {
    const api = mockSwitchApi();
    renderPicker();
    await screen.findByText("Onboarding Guide");
    api.listNotionPages.mockClear();
    api.listNotionPages.mockImplementation(() => Promise.resolve(WIDENED));

    await startReauth();
    await screen.findByText(/Switch Notion workspace/i);
    fireEvent.click(screen.getByRole("button", { name: "Switch anyway" }));

    await waitFor(() =>
      expect(api.resolveNotionWorkspaceSwitch).toHaveBeenCalledWith(true),
    );
    await screen.findByText("Budget 2026");
  });

  it("discards the withheld token when the dialog is dismissed", async () => {
    const api = mockSwitchApi();
    renderPicker();
    await screen.findByText("Onboarding Guide");
    api.listNotionPages.mockClear();

    await startReauth();
    await screen.findByText(/Switch Notion workspace/i);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(api.resolveNotionWorkspaceSwitch).toHaveBeenCalledWith(false),
    );
    expect(api.listNotionPages).not.toHaveBeenCalled();
  });
});

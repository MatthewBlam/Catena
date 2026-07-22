// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import App from "../App";
import type { RecentSearch, RecentSearchDetail } from "../../../shared/types";

afterEach(cleanup);

const RECENT_1: RecentSearch = {
  id: "r1",
  query: "reimbursement policy",
  resultCount: 3,
  createdAt: "2026-07-16T12:00:00.000Z",
  updatedAt: "2026-07-16T12:00:00.000Z",
};

const RECENT_2: RecentSearch = {
  id: "r2",
  query: "parking permits",
  resultCount: 1,
  createdAt: "2026-07-15T12:00:00.000Z",
  updatedAt: "2026-07-15T12:00:00.000Z",
};

const RECENT_1_DETAIL: RecentSearchDetail = {
  ...RECENT_1,
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

/**
 * The wizard gates on the onboarding flag ONLY. Provider readiness is handled
 * in-app (SearchPage's disabled banner, Settings' key form), so an onboarded
 * user who switches to an unconfigured provider must never be dumped back
 * into onboarding.
 */
function mockApi(overrides: {
  onboarded: boolean;
  hasCohereKey?: boolean;
  recents?: RecentSearch[];
}): {
  fireRecentsChanged: () => void;
} {
  let recentsListeners: Array<() => void> = [];

  window.api = {
    getOnboardingComplete: vi.fn(() => Promise.resolve(overrides.onboarded)),
    getEmbeddingProvider: vi.fn(() => Promise.resolve("cohere")),
    hasSecret: vi.fn(() => Promise.resolve(overrides.hasCohereKey ?? false)),
    checkOllama: vi.fn(() => Promise.resolve({ available: false, models: [] })),
    listSources: vi.fn(() => Promise.resolve([])),
    checkEmbeddingHealth: vi.fn(() =>
      Promise.resolve({
        provider: "cohere",
        model: "embed-v4",
        mismatchedChunks: 0,
        totalChunks: 0,
      }),
    ),
    search: vi.fn(),
    cancelSearch: vi.fn(() => Promise.resolve()),
    onSourcesChanged: vi.fn(() => () => {}),
    listRecentSearches: vi.fn(() => Promise.resolve(overrides.recents ?? [])),
    getRecentSearch: vi.fn(() => Promise.resolve(null)),
    deleteRecentSearch: vi.fn(() => Promise.resolve()),
    onRecentsChanged: vi.fn((cb: () => void) => {
      recentsListeners.push(cb);
      return () => {
        recentsListeners = recentsListeners.filter((l) => l !== cb);
      };
    }),
  } as unknown as typeof window.api;

  return {
    fireRecentsChanged: () => {
      act(() => {
        for (const listener of recentsListeners) listener();
      });
    },
  };
}

beforeEach(() => {
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  localStorage.clear();
});

describe("App readiness gate", () => {
  it("keeps an onboarded user in the app when the provider is unconfigured", async () => {
    // Onboarded, but on Cohere with no key stored — e.g. the user just
    // switched providers in Settings. Must stay in the app shell.
    mockApi({ onboarded: true, hasCohereKey: false });
    render(<App />);

    expect(
      await screen.findByRole("button", { name: "Settings" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Welcome to Commons")).not.toBeInTheDocument();
  });

  it("still gates a fresh install behind the wizard", async () => {
    mockApi({ onboarded: false, hasCohereKey: true });
    render(<App />);

    expect(await screen.findByText("Welcome to Commons")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Settings" }),
    ).not.toBeInTheDocument();
  });
});

describe("App recents sidebar", () => {
  it("renders a Recents heading and rows when the list is non-empty, and omits the section when empty", async () => {
    mockApi({ onboarded: true, recents: [RECENT_1, RECENT_2] });
    render(<App />);

    expect(await screen.findByText("Recents")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: RECENT_1.query }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: RECENT_2.query }),
    ).toBeInTheDocument();

    cleanup();

    mockApi({ onboarded: true, recents: [] });
    render(<App />);

    // Wait for the app to finish loading before asserting absence.
    await screen.findByRole("button", { name: "Settings" });
    expect(screen.queryByText("Recents")).not.toBeInTheDocument();
  });

  it("selecting a recent fetches its detail and navigates to Search", async () => {
    mockApi({ onboarded: true, recents: [RECENT_1] });
    vi.mocked(window.api.getRecentSearch).mockResolvedValue(RECENT_1_DETAIL);
    render(<App />);

    const settingsButton = await screen.findByRole("button", {
      name: "Settings",
    });
    fireEvent.click(settingsButton);
    expect(settingsButton).toHaveAttribute("aria-current", "page");

    const searchButton = screen.getByRole("button", { name: "Search" });
    expect(searchButton).not.toHaveAttribute("aria-current");

    const recentRow = await screen.findByRole("button", {
      name: RECENT_1.query,
    });
    fireEvent.click(recentRow);

    await waitFor(() => {
      expect(window.api.getRecentSearch).toHaveBeenCalledWith(RECENT_1.id);
    });

    await waitFor(() => {
      expect(searchButton).toHaveAttribute("aria-current", "page");
    });
    expect(settingsButton).not.toHaveAttribute("aria-current");
  });

  it("re-fetches when the same recent is clicked twice (restore re-fires per click)", async () => {
    mockApi({ onboarded: true, recents: [RECENT_1] });
    vi.mocked(window.api.getRecentSearch).mockResolvedValue(RECENT_1_DETAIL);
    render(<App />);

    fireEvent.click(
      await screen.findByRole("button", { name: RECENT_1.query }),
    );
    await waitFor(() => {
      expect(window.api.getRecentSearch).toHaveBeenCalledTimes(1);
    });

    // A second click of the same entry must not be a no-op — each click bumps
    // the restore token so SearchPage re-hydrates even for identical detail.
    fireEvent.click(screen.getByRole("button", { name: RECENT_1.query }));
    await waitFor(() => {
      expect(window.api.getRecentSearch).toHaveBeenCalledTimes(2);
    });
  });

  it("does not navigate when the recent has expired, and refetches the list instead", async () => {
    mockApi({ onboarded: true, recents: [RECENT_1] });
    vi.mocked(window.api.getRecentSearch).mockResolvedValue(null);
    render(<App />);

    const settingsButton = await screen.findByRole("button", {
      name: "Settings",
    });
    fireEvent.click(settingsButton);
    expect(settingsButton).toHaveAttribute("aria-current", "page");

    await waitFor(() => {
      expect(window.api.listRecentSearches).toHaveBeenCalledTimes(1);
    });

    const recentRow = await screen.findByRole("button", {
      name: RECENT_1.query,
    });
    fireEvent.click(recentRow);

    await waitFor(() => {
      expect(window.api.getRecentSearch).toHaveBeenCalledWith(RECENT_1.id);
    });

    await waitFor(() => {
      expect(window.api.listRecentSearches).toHaveBeenCalledTimes(2);
    });

    const searchButton = screen.getByRole("button", { name: "Search" });
    expect(searchButton).not.toHaveAttribute("aria-current");
    expect(settingsButton).toHaveAttribute("aria-current", "page");
  });

  it("deleting a recent calls deleteRecentSearch, and a recents:changed broadcast re-renders the sidebar", async () => {
    const { fireRecentsChanged } = mockApi({
      onboarded: true,
      recents: [RECENT_1],
    });
    render(<App />);

    await screen.findByText("Recents");

    const deleteButton = await screen.findByRole("button", {
      name: `Remove "${RECENT_1.query}" from recents`,
    });
    fireEvent.click(deleteButton);

    await waitFor(() => {
      expect(window.api.deleteRecentSearch).toHaveBeenCalledWith(RECENT_1.id);
    });

    vi.mocked(window.api.listRecentSearches).mockResolvedValueOnce([RECENT_2]);
    fireRecentsChanged();

    expect(
      await screen.findByRole("button", { name: RECENT_2.query }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: RECENT_1.query }),
    ).not.toBeInTheDocument();
  });

  it("never fetches recents before onboarding completes", async () => {
    mockApi({ onboarded: false, recents: [RECENT_1] });
    render(<App />);

    await screen.findByText("Welcome to Commons");
    expect(window.api.listRecentSearches).not.toHaveBeenCalled();
  });
});

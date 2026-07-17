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
import { SearchPage } from "../SearchPage";
import type { EmbeddingHealth, SearchResponse } from "../../../../shared/types";

afterEach(cleanup);

interface MockApiState {
  provider: string;
  hasCohereKey: boolean;
  ollamaAvailable: boolean;
  searchResponse: SearchResponse;
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
    ...overrides,
  };
  let listeners: Array<() => void> = [];

  window.api = {
    checkEmbeddingHealth: vi.fn(() => Promise.resolve(DEFAULT_HEALTH)),
    listSources: vi.fn(() => Promise.resolve([])),
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

describe("SearchPage — provider readiness", () => {
  it("renders the disabled banner and disables the input when no key is configured", async () => {
    mockApi({ hasCohereKey: false });
    render(<SearchPage visible={true} />);

    expect(
      await screen.findByText(
        "Search is disabled — add your API key in Settings",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Search your documents")).toBeDisabled();
  });

  it("renders the Ollama-appropriate banner when Ollama is not running", async () => {
    mockApi({ provider: "ollama", ollamaAvailable: false });
    render(<SearchPage visible={true} />);

    expect(
      await screen.findByText("Search is disabled — start Ollama to search"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Search your documents")).toBeDisabled();
  });

  it("renders a normal, enabled search when the provider is ready", async () => {
    mockApi({
      hasCohereKey: true,
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
      screen.queryByText("Search is disabled — add your API key in Settings"),
    ).not.toBeInTheDocument();
    const input = screen.getByLabelText("Search your documents");
    expect(input).not.toBeDisabled();

    fireEvent.change(input, { target: { value: "reimbursement" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByText(/Results for/)).toBeInTheDocument();
    expect(window.api.search).toHaveBeenCalledWith("reimbursement");
  });

  it("re-evaluates readiness when the page becomes visible again (returning from Settings)", async () => {
    const { state } = mockApi({ hasCohereKey: false });
    const { rerender } = render(<SearchPage visible={true} />);

    expect(
      await screen.findByText(
        "Search is disabled — add your API key in Settings",
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
      screen.queryByText("Search is disabled — add your API key in Settings"),
    ).not.toBeInTheDocument();
  });

  it("re-evaluates readiness on a sources:changed event", async () => {
    const { state, fireSourcesChanged } = mockApi({ hasCohereKey: false });
    render(<SearchPage visible={true} />);

    expect(
      await screen.findByText(
        "Search is disabled — add your API key in Settings",
      ),
    ).toBeInTheDocument();

    state.hasCohereKey = true;
    fireSourcesChanged();

    expect(
      await screen.findByLabelText("Search your documents"),
    ).not.toBeDisabled();
  });
});

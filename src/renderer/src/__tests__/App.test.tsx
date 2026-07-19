// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import App from "../App";

afterEach(cleanup);

/**
 * The wizard gates on the onboarding flag ONLY. Provider readiness is handled
 * in-app (SearchPage's disabled banner, Settings' key form), so an onboarded
 * user who switches to an unconfigured provider must never be dumped back
 * into onboarding.
 */
function mockApi(overrides: {
  onboarded: boolean;
  hasCohereKey?: boolean;
}): void {
  window.api = {
    getOnboardingComplete: vi.fn(() => Promise.resolve(overrides.onboarded)),
    getEmbeddingProvider: vi.fn(() => Promise.resolve("cohere")),
    hasSecret: vi.fn(() => Promise.resolve(overrides.hasCohereKey ?? false)),
    checkOllama: vi.fn(() =>
      Promise.resolve({ available: false, models: [] }),
    ),
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
  } as unknown as typeof window.api;
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

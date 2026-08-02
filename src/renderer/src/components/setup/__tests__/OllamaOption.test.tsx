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
import { OllamaOption } from "../OllamaOption";
import type {
  OllamaProgress,
  OllamaStatusDetail,
} from "../../../../../shared/types";

afterEach(cleanup);

const READY: OllamaStatusDetail = {
  engineUp: true,
  models: ["nomic-embed-text:latest"],
  embeddingModels: ["nomic-embed-text:latest"],
  embeddingReady: true,
  chatReady: false,
  setupInProgress: false,
  managedBinaryPresent: true,
};

const NOT_READY: OllamaStatusDetail = {
  engineUp: false,
  models: [],
  embeddingModels: [],
  embeddingReady: false,
  chatReady: false,
  setupInProgress: false,
  managedBinaryPresent: false,
};

// Lets a test drive the progress stream that `onOllamaProgress` delivers.
let emitProgress: (p: OllamaProgress) => void;

function mockApi(
  overrides: Partial<{
    getOllamaStatusDetail: () => Promise<OllamaStatusDetail>;
    ollamaSetup: () => Promise<void>;
    setEmbeddingProvider: () => Promise<void>;
  }>,
): void {
  window.api = {
    getOllamaStatusDetail: vi.fn(
      overrides.getOllamaStatusDetail ?? (() => Promise.resolve(NOT_READY)),
    ),
    ollamaSetup: vi.fn(overrides.ollamaSetup ?? (() => new Promise(() => {}))),
    cancelOllamaSetup: vi.fn(() => Promise.resolve()),
    setEmbeddingProvider: vi.fn(
      overrides.setEmbeddingProvider ?? (() => Promise.resolve()),
    ),
    onOllamaProgress: vi.fn((cb: (p: OllamaProgress) => void): (() => void) => {
      emitProgress = cb;
      return () => {};
    }),
  } as unknown as typeof window.api;
}

describe("OllamaOption", () => {
  beforeEach(() => {
    mockApi({});
  });

  it("offers a one-click setup when Ollama isn't ready, then streams progress", async () => {
    render(<OllamaOption onSuccess={vi.fn()} />);

    const setupButton = await screen.findByRole("button", {
      name: "Set up Ollama",
    });
    fireEvent.click(setupButton);

    // A progress event flips the panel to the progress bar.
    await act(async () => {
      emitProgress({ phase: "downloading-engine", percent: 42 });
    });
    expect(screen.getByText("Downloading Ollama…")).toBeInTheDocument();
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("calls onSuccess when setup resolves", async () => {
    const onSuccess = vi.fn();
    mockApi({ ollamaSetup: () => Promise.resolve() });
    render(<OllamaOption onSuccess={onSuccess} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "Set up Ollama" }),
    );
    await act(async () => {});

    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("skips setup and uses the existing engine when already ready", async () => {
    const onSuccess = vi.fn();
    const setEmbeddingProvider = vi.fn(() => Promise.resolve());
    mockApi({
      getOllamaStatusDetail: () => Promise.resolve(READY),
      setEmbeddingProvider,
    });
    render(<OllamaOption onSuccess={onSuccess} />);

    const useButton = await screen.findByRole("button", { name: "Use Ollama" });
    fireEvent.click(useButton);
    await act(async () => {});

    expect(setEmbeddingProvider).toHaveBeenCalledWith("ollama");
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});

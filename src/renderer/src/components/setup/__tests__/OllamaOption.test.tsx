// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { OllamaOption } from "../OllamaOption";

afterEach(cleanup);

const PULL_COMMAND = "ollama pull nomic-embed-text";

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.api = {
    checkOllama: vi.fn(() =>
      Promise.resolve({ available: true, models: ["llama3"] }),
    ),
    setEmbeddingProvider: vi.fn(() => Promise.resolve()),
  } as unknown as typeof window.api;
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

describe("OllamaOption pull-command copy button", () => {
  it("copies the pull command to the clipboard and shows feedback", async () => {
    render(<OllamaOption onSuccess={vi.fn()} />);

    expect(await screen.findByText(PULL_COMMAND)).toBeInTheDocument();

    const copyButton = screen.getByRole("button", { name: "Copy command" });
    fireEvent.click(copyButton);

    expect(writeText).toHaveBeenCalledWith(PULL_COMMAND);
    expect(
      await screen.findByRole("button", { name: "Copied" }),
    ).toBeInTheDocument();
  });
});

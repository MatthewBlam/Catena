// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { AnswerPanel } from "../AnswerPanel";
import type { SearchResult, AnswerCitation } from "../../../../../shared/types";

afterEach(cleanup);

const RESULTS: SearchResult[] = [
  {
    chunkId: "c0",
    documentTitle: "Doc Zero",
    snippet: "zero",
    heading: null,
    url: "https://example.com/zero",
    provider: "notion",
    score: 0.9,
  },
  {
    chunkId: "c1",
    documentTitle: "Doc One",
    snippet: "one",
    heading: null,
    url: null,
    provider: "google_drive",
    score: 0.8,
  },
];

beforeEach(() => {
  window.api = {
    openExternal: vi.fn(() => Promise.resolve()),
  } as unknown as typeof window.api;
});

function baseProps(): Parameters<typeof AnswerPanel>[0] {
  return {
    status: "idle",
    text: "",
    citations: [],
    results: RESULTS,
    onGenerate: vi.fn(),
    onStop: vi.fn(),
    onRetry: vi.fn(),
  };
}

describe("AnswerPanel", () => {
  it("shows a Generate answer button when idle and calls onGenerate", () => {
    const onGenerate = vi.fn();
    render(
      <AnswerPanel {...baseProps()} status="idle" onGenerate={onGenerate} />,
    );
    const button = screen.getByRole("button", { name: "Generate answer" });
    fireEvent.click(button);
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });

  it("renders live text and a Stop button while streaming", () => {
    const onStop = vi.fn();
    render(
      <AnswerPanel
        {...baseProps()}
        status="streaming"
        text="Partial answer"
        onStop={onStop}
      />,
    );
    expect(screen.getByText("Partial answer")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("renders citation markers and opens the cited source on click", () => {
    const citations: AnswerCitation[] = [{ start: 0, end: 7, chunkId: "c0" }];
    render(
      <AnswerPanel
        {...baseProps()}
        status="done"
        text="Emperor penguins are tall."
        citations={citations}
      />,
    );
    const marker = screen.getByRole("button", { name: "Open source 1" });
    expect(marker).toHaveTextContent("[1]");
    fireEvent.click(marker);
    expect(window.api.openExternal).toHaveBeenCalledWith(
      "https://example.com/zero",
    );
  });

  it("renders a non-clickable marker for a cited source that has no url", () => {
    const citations: AnswerCitation[] = [{ start: 0, end: 7, chunkId: "c1" }];
    render(
      <AnswerPanel
        {...baseProps()}
        status="done"
        text="Some text here."
        citations={citations}
      />,
    );
    // c1 is index 1 → marker [2], and it is not a button (no url to open).
    expect(
      screen.queryByRole("button", { name: /Open source/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("[2]")).toBeInTheDocument();
  });

  it("renders both markers when two citations share an end offset", () => {
    // Two distinct spans ending at the same offset (7): grouped separately by
    // `${start}:${end}`. The old `group.end <= cursor` skip dropped the second
    // group's markers because the first already advanced the cursor to 7. Both
    // markers must render, and the body text must stay intact.
    const citations: AnswerCitation[] = [
      { start: 0, end: 7, chunkId: "c0" },
      { start: 4, end: 7, chunkId: "c1" },
    ];
    render(
      <AnswerPanel
        {...baseProps()}
        status="done"
        text="Emperor penguins are tall."
        citations={citations}
      />,
    );
    // c0 (index 0) has a url → clickable [1]; c1 (index 1) has none → plain [2].
    expect(
      screen.getByRole("button", { name: "Open source 1" }),
    ).toHaveTextContent("[1]");
    expect(screen.getByText("[2]")).toBeInTheDocument();
    // Body text is neither duplicated nor dropped.
    expect(document.body.textContent).toContain("Emperor");
    expect(document.body.textContent).toContain("penguins are tall.");
  });

  it("drops a citation whose chunk is not in the results", () => {
    const citations: AnswerCitation[] = [{ start: 0, end: 4, chunkId: "gone" }];
    render(
      <AnswerPanel
        {...baseProps()}
        status="done"
        text="Text without a valid citation."
        citations={citations}
      />,
    );
    expect(screen.queryByText(/\[\d+\]/)).not.toBeInTheDocument();
    expect(
      screen.getByText("Text without a valid citation."),
    ).toBeInTheDocument();
  });

  it("shows the sources footnote when a done answer has no citations", () => {
    render(
      <AnswerPanel
        {...baseProps()}
        status="done"
        text="A local answer with no citations."
        citations={[]}
      />,
    );
    expect(screen.getByText("Based on the sources below.")).toBeInTheDocument();
  });

  it("shows a Try again button for a generic failure", () => {
    const onRetry = vi.fn();
    render(
      <AnswerPanel
        {...baseProps()}
        status="error"
        errorKind="failed"
        error="Couldn't generate an answer. Try again."
        onRetry={onRetry}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows the pull hint and no Try again for a missing Ollama model", () => {
    render(
      <AnswerPanel
        {...baseProps()}
        status="error"
        errorKind="no_model"
        error="Install a chat model in Ollama (e.g. `ollama pull llama3.2`) to generate answers."
      />,
    );
    expect(screen.getByText(/ollama pull llama3\.2/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Try again" }),
    ).not.toBeInTheDocument();
  });
});

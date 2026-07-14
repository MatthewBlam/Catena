// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { SearchInput } from "../SearchInput";

afterEach(cleanup);

describe("SearchInput", () => {
  it("renders with placeholder", () => {
    render(
      <SearchInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        loading={false}
      />,
    );
    expect(screen.getByLabelText("Search your documents")).toBeInTheDocument();
  });

  it("calls onSubmit on Enter key", () => {
    const onSubmit = vi.fn();
    render(
      <SearchInput
        value="test query"
        onChange={vi.fn()}
        onSubmit={onSubmit}
        loading={false}
      />,
    );
    fireEvent.keyDown(screen.getByLabelText("Search your documents"), {
      key: "Enter",
    });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("does not submit when loading", () => {
    const onSubmit = vi.fn();
    render(
      <SearchInput
        value="test query"
        onChange={vi.fn()}
        onSubmit={onSubmit}
        loading={true}
      />,
    );
    fireEvent.keyDown(screen.getByLabelText("Search your documents"), {
      key: "Enter",
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

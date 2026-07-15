// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, it, expect } from "vitest";
import { VirtualList } from "../VirtualList";

// jsdom has no layout engine, so the virtualizer's geometry reads all return 0.
// These helpers install just enough fake geometry to exercise the measuring
// path: a scrolled-down container plus a per-row height. `restorers` undoes it.
const restorers: Array<() => void> = [];

function stubGetter(
  proto: object,
  prop: string,
  impl: (this: HTMLElement) => unknown,
): void {
  const original = Object.getOwnPropertyDescriptor(proto, prop);
  Object.defineProperty(proto, prop, { configurable: true, get: impl });
  restorers.push(() => {
    if (original) Object.defineProperty(proto, prop, original);
    else delete (proto as Record<string, unknown>)[prop];
  });
}

function isRow(node: HTMLElement): boolean {
  return node.getAttribute("role") === "listitem";
}

afterEach(() => {
  cleanup();
  while (restorers.length) restorers.pop()!();
});

describe("VirtualList", () => {
  it("does not loop when scrolled and row measurements vary (regression: max update depth)", () => {
    // Reproduces the "Maximum update depth exceeded" crash seen while scrolling
    // the Notion picker. The container is scrolled down (scrollTop > 0) so the
    // first *windowed* row's index depends on rowHeight, and each row measurement
    // oscillates the way a real browser's sub-pixel getBoundingClientRect does.
    // Before the fix, writing a new rowHeight re-selected and re-measured the
    // first row forever; React throws after ~50 nested updates.
    const heights = [40, 60];
    let rowRead = 0;
    const rowHeight = (): number => heights[rowRead++ % heights.length];

    stubGetter(HTMLElement.prototype, "clientHeight", () => 200);
    stubGetter(HTMLElement.prototype, "scrollTop", () => 1000);
    stubGetter(HTMLElement.prototype, "offsetHeight", function () {
      return isRow(this) ? rowHeight() : 0;
    });
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      const height = isRow(this) ? rowHeight() : 0;
      return {
        height,
        width: 0,
        top: 0,
        left: 0,
        right: 0,
        bottom: height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    };
    restorers.push(() => {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
    });

    const items = Array.from({ length: 100 }, (_, i) => ({ id: i }));

    expect(() =>
      render(
        <VirtualList
          items={items}
          getKey={(item) => String(item.id)}
          renderItem={(item) => <span>Row {item.id}</span>}
        />,
      ),
    ).not.toThrow();

    // It actually windowed and rendered rows (didn't bail to an empty tree).
    expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0);
  });
});

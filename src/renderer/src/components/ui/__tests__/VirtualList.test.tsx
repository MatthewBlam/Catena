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

  it("clamps the window when items shrink below the scrolled position (regression: blank viewport)", () => {
    // Reproduces the blank-viewport bug: scrolled deep into a long list (e.g.
    // NotionPicker), then `items` shrinks — filter typing or a cache-hit
    // folder nav — while the internal `scrollTop` state is still latched at
    // the old, now out-of-range offset. Without a render-time clamp, `start`
    // derived from that stale offset exceeds the new item count, so
    // `items.slice(start, end)` (start > end) comes back empty and the
    // viewport renders nothing until a later scroll event happens to correct
    // `scrollTop`. jsdom does no real layout, so `scrollTop` is stubbed to a
    // fixed deep offset for the life of the test — the fix must clamp it at
    // render time, not by observing a fresh scroll event.
    const rowHeightPx = 40;
    stubGetter(HTMLElement.prototype, "clientHeight", () => 200);
    stubGetter(HTMLElement.prototype, "scrollTop", () => 1000);
    stubGetter(HTMLElement.prototype, "offsetHeight", function () {
      return isRow(this) ? rowHeightPx : 0;
    });

    const manyItems = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const { rerender } = render(
      <VirtualList
        items={manyItems}
        getKey={(item) => String(item.id)}
        renderItem={(item) => <span>Row {item.id}</span>}
      />,
    );
    expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0);

    // Shrink far below where the (still-1000, stubbed) scroll offset would
    // place the window: 3 items * 40px rowHeight = 120px, well under 1000.
    const fewItems = manyItems.slice(0, 3);
    rerender(
      <VirtualList
        items={fewItems}
        getKey={(item) => String(item.id)}
        renderItem={(item) => <span>Row {item.id}</span>}
      />,
    );

    const rows = screen.getAllByRole("listitem");
    expect(rows.length).toBe(fewItems.length);
    expect(screen.getByText("Row 0")).toBeInTheDocument();
  });

  it("reconciles scroll state with the DOM across a shrink-then-regrow race (regression: blank viewport, regrow direction)", () => {
    // A second blank-viewport path, from the opposite direction. Real browsers
    // clamp a container's *actual* `scrollTop` synchronously, as part of
    // layout, the instant its scrollable content shrinks below the current
    // position — reading `el.scrollTop` right after that DOM mutation always
    // returns the already-clamped value, with no dependency on the 'scroll'
    // event (which is not guaranteed to land before the next commit). If
    // `items` shrinks and then grows back — a filter typed, then cleared,
    // before that event is processed — a fix that only reacted to the scroll
    // event would leave React's `scrollTop` state stuck at the pre-shrink
    // offset: the render-time clamp (previous test) hides that while the list
    // is still small, but once `items` regrows the clamp stops biting and the
    // window re-anchors to the stale deep offset while the DOM is really
    // scrolled near the top — rows render, just not the ones actually in
    // view.
    //
    // jsdom does no real layout, so nothing auto-clamps `scrollTop` for us;
    // `realScrollTop` stands in for the DOM's true position and is mutated by
    // hand at the shrink step only, to model that synchronous browser clamp.
    // It is deliberately left untouched across the regrow, matching real
    // browsers: growing content never moves the scroll position back down.
    const rowHeightPx = 40;
    let realScrollTop = 1000;
    stubGetter(HTMLElement.prototype, "clientHeight", () => 200);
    stubGetter(HTMLElement.prototype, "scrollTop", () => realScrollTop);
    stubGetter(HTMLElement.prototype, "offsetHeight", function () {
      return isRow(this) ? rowHeightPx : 0;
    });

    const manyItems = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const { rerender } = render(
      <VirtualList
        items={manyItems}
        getKey={(item) => String(item.id)}
        renderItem={(item) => <span>Row {item.id}</span>}
      />,
    );
    expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0);

    // Shrink: 3 items * 40px = 120px of content is under the 200px viewport,
    // so a real browser can't scroll at all and clamps scrollTop to 0 as
    // part of the same layout pass that shrank the content.
    realScrollTop = 0;
    const fewItems = manyItems.slice(0, 3);
    rerender(
      <VirtualList
        items={fewItems}
        getKey={(item) => String(item.id)}
        renderItem={(item) => <span>Row {item.id}</span>}
      />,
    );
    expect(screen.getAllByRole("listitem").length).toBe(3);

    // Regrow before any corrective 'scroll' event — `realScrollTop` is
    // deliberately left at 0, since growing content doesn't restore a
    // previous scroll offset in a real browser either.
    rerender(
      <VirtualList
        items={manyItems}
        getKey={(item) => String(item.id)}
        renderItem={(item) => <span>Row {item.id}</span>}
      />,
    );

    // The window must follow the real (near-top) DOM position, not the
    // stale pre-shrink offset — row 0 must be among the rendered rows.
    // Pre-fix, state stayed latched at 1000 and this rendered rows ~19-35
    // instead, leaving the actually-visible top of the list blank.
    expect(screen.getByText("Row 0")).toBeInTheDocument();
  });
});

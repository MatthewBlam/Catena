import { useRef, useState, useLayoutEffect, useCallback } from "react";

interface VirtualListProps<T> {
  items: T[];
  getKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => React.ReactNode;
  /**
   * First-guess row height in px. The real height is measured from a rendered
   * row after mount, so this only needs to be close enough to window the first
   * paint — every row in these lists is a single truncated line of equal height.
   */
  estimatedRowHeight?: number;
  /** Classes for the scroll container (owns `max-h`/`overflow-y-auto`). */
  className?: string;
  overscan?: number;
  loading?: boolean;
  loadingState?: React.ReactNode;
  emptyState?: React.ReactNode;
}

/**
 * A minimal fixed-height list virtualizer. Only the rows in (and near) the
 * viewport are in the DOM, so a workspace with thousands of Notion pages, a
 * Drive folder with thousands of files, or a source with thousands of documents
 * renders a constant number of nodes instead of one-per-item (M20).
 *
 * Hand-rolled rather than pulling in a windowing library: every row here is one
 * truncated line of identical height, which is the one case this handles well,
 * and it keeps the (already fragile) dependency tree untouched.
 */
export function VirtualList<T>({
  items,
  getKey,
  renderItem,
  estimatedRowHeight = 37,
  className,
  overscan = 6,
  loading = false,
  loadingState = null,
  emptyState = null,
}: VirtualListProps<T>): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [rowHeight, setRowHeight] = useState(estimatedRowHeight);
  const [scrollTop, setScrollTop] = useState(0);
  // Seed the viewport large enough to window the first paint (~14 rows) so a
  // huge list never renders every row for even one commit; the real height is
  // measured before paint below.
  const [viewport, setViewport] = useState(estimatedRowHeight * 14);
  const total = items.length;

  // Track scroll offset and visible height. `useLayoutEffect` + an initial
  // measure means the first painted frame is already windowed; the
  // ResizeObserver keeps it correct as the container grows or shrinks (fewer
  // items than its max height, a resized modal) without waiting for a scroll.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = (): void => {
      const newTop = el.scrollTop;
      // Bail out of the state update (and the re-render it would trigger)
      // when the new offset still maps to the same windowed row as before —
      // sub-row scroll deltas don't change `start`/`end`, so most scroll
      // events are otherwise pure render churn.
      setScrollTop((prev) =>
        Math.floor(newTop / rowHeight) === Math.floor(prev / rowHeight)
          ? prev
          : newTop,
      );
      setViewport(el.clientHeight);
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    // ResizeObserver is absent under jsdom; degrade to scroll + initial measure
    // rather than throw if this ever mounts in a test.
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : null;
    observer?.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
    // `rowHeight` only changes once, when the first row is measured (see
    // `measureRow` below) — this re-subscribes at most once, not a loop.
  }, [rowHeight]);

  // The browser clamps the container's *real* `scrollTop` synchronously, as
  // part of layout, the moment the scrollable content (`total * rowHeight`)
  // shrinks below the current position — reading `el.scrollTop` right after
  // a DOM mutation always returns that already-clamped value. But our own
  // `scrollTop` state above is only ever written by the scroll *event*
  // listener, and dispatching that event is not guaranteed to happen (or be
  // processed) before the next commit. If `items` shrinks and then grows
  // back — a filter typed, then cleared, before that event lands — `state`
  // can still hold the pre-shrink offset. The render-time clamp below hides
  // that gap while `items` is still small (it derives its own clamp from
  // the shrunk `total`), but once `items` grows back `maxScrollTop` grows
  // too, the clamp stops biting, and the window re-anchors to the stale
  // offset while the DOM is really scrolled near the top — rows render,
  // just not the ones actually in view. Blank viewport, same family of bug,
  // from the regrow direction.
  //
  // Reconcile explicitly whenever `total` changes: read the live (already
  // browser-clamped) `el.scrollTop` and adopt it into state if the two
  // disagree. Only updates on an actual mismatch, so it cannot become a
  // render-feedback loop — and it's keyed on `total`, not `rowHeight`, so it
  // cannot interact with the measure loop fixed in cffc45a.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollTop((prev) => (el.scrollTop === prev ? prev : el.scrollTop));
  }, [total]);

  // All rows share a height; measure one real row exactly once and lock it in.
  // A callback ref (not an effect) fires when the first row mounts — including
  // the first time rows appear after a loading/empty state — but it records the
  // height only on the first positive reading.
  //
  // It must NOT keep re-measuring: `start` (which row sits at i===0) depends on
  // `rowHeight`, so writing a new height re-selects the measured row, and
  // `getBoundingClientRect().height` is the painted, device-pixel-rounded height
  // that shifts with a row's sub-pixel `translateY`. While scrolled, those never
  // agree, so the ref re-fired forever — "Maximum update depth exceeded". We read
  // `offsetHeight` (the integer layout height, independent of the transform) and
  // stop after the first row we successfully measure.
  const measured = useRef(false);
  const measureRow = useCallback((el: HTMLDivElement | null) => {
    if (!el || measured.current) return;
    const height = el.offsetHeight;
    if (height > 0) {
      measured.current = true;
      setRowHeight(height);
    }
  }, []);

  const visibleCount = Math.max(1, Math.ceil(viewport / rowHeight));
  // Clamp the offset used to derive the window to the scrollable range for
  // the *current* item count, not whatever `scrollTop` last reported. Filter
  // typing or a cache-hit folder nav can shrink `items` in the same tick
  // that a deep scroll position is still latched in state — without this,
  // `start` derived from the stale offset can exceed `total`, `slice` comes
  // back empty, and the viewport goes blank until a later scroll event
  // happens to correct `scrollTop`. Recomputed every render (pure
  // derivation), so it's correct immediately, not just after a scroll.
  const maxScrollTop = Math.max(0, total * rowHeight - viewport);
  const clampedScrollTop = Math.min(scrollTop, maxScrollTop);
  const start = Math.max(
    0,
    Math.floor(clampedScrollTop / rowHeight) - overscan,
  );
  const end = Math.min(total, start + visibleCount + overscan * 2);

  let body: React.ReactNode;
  if (loading) {
    body = loadingState;
  } else if (total === 0) {
    body = emptyState;
  } else {
    body = (
      <div
        role="list"
        style={{
          height: total * rowHeight,
          position: "relative",
          width: "100%",
        }}
      >
        {items.slice(start, end).map((item, i) => {
          const index = start + i;
          return (
            <div
              key={getKey(item, index)}
              ref={i === 0 ? measureRow : undefined}
              role="listitem"
              aria-setsize={total}
              aria-posinset={index + 1}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${index * rowHeight}px)`,
              }}
            >
              {renderItem(item, index)}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div ref={scrollRef} className={className}>
      {body}
    </div>
  );
}

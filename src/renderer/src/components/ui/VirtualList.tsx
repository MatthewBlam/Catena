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

  // Track scroll offset and visible height. `useLayoutEffect` + an initial
  // measure means the first painted frame is already windowed; the
  // ResizeObserver keeps it correct as the container grows or shrinks (fewer
  // items than its max height, a resized modal) without waiting for a scroll.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = (): void => {
      setScrollTop(el.scrollTop);
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
  }, []);

  // All rows share a height; measure one real row and adopt it. A callback ref
  // (not an effect) fires whenever the measured row mounts — including the first
  // time rows appear after a loading state — and the tolerance stops it looping.
  const measureRow = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const measured = el.getBoundingClientRect().height;
    if (measured > 0) {
      setRowHeight((prev) =>
        Math.abs(measured - prev) > 0.5 ? measured : prev,
      );
    }
  }, []);

  const total = items.length;
  const visibleCount = Math.max(1, Math.ceil(viewport / rowHeight));
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
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

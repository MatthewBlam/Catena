import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { debounce } from "../utils";

describe("debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("collapses a burst of calls into a single trailing invocation", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 250);

    debounced();
    debounced();
    debounced();
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(249);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("carries the arguments from the last call in the burst", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced("first");
    debounced("second");
    debounced("third");
    vi.advanceTimersByTime(100);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("third");
  });

  it("fires again for a call after the previous burst already settled", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);

    debounced();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("cancel() drops a pending call without running it", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    debounced.cancel();
    vi.advanceTimersByTime(100);

    expect(fn).not.toHaveBeenCalled();
  });

  it("cancel() is a no-op when nothing is pending", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    expect(() => debounced.cancel()).not.toThrow();
    vi.advanceTimersByTime(100);
    expect(fn).not.toHaveBeenCalled();
  });
});

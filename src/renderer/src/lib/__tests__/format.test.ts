import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatRelativeTime } from "../format";

describe("formatRelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'recently' for invalid ISO string", () => {
    expect(formatRelativeTime("not a date")).toBe("recently");
    expect(formatRelativeTime("")).toBe("recently");
    expect(formatRelativeTime("2024-13-45")).toBe("recently");
  });

  it("returns 'just now' for times less than 60 seconds ago", () => {
    const now = new Date("2024-01-01T12:00:00Z").getTime();
    vi.setSystemTime(now);

    // 0 seconds ago
    const iso0 = new Date(now).toISOString();
    expect(formatRelativeTime(iso0)).toBe("just now");

    // 30 seconds ago
    const iso30 = new Date(now - 30 * 1000).toISOString();
    expect(formatRelativeTime(iso30)).toBe("just now");

    // 59 seconds ago
    const iso59 = new Date(now - 59 * 1000).toISOString();
    expect(formatRelativeTime(iso59)).toBe("just now");
  });

  it("returns minute tier for times 1-59 minutes ago", () => {
    const now = new Date("2024-01-01T12:00:00Z").getTime();
    vi.setSystemTime(now);

    // 1 minute ago
    const iso1m = new Date(now - 60 * 1000).toISOString();
    expect(formatRelativeTime(iso1m)).toBe("1m ago");

    // 5 minutes ago
    const iso5m = new Date(now - 5 * 60 * 1000).toISOString();
    expect(formatRelativeTime(iso5m)).toBe("5m ago");

    // 59 minutes ago
    const iso59m = new Date(now - 59 * 60 * 1000).toISOString();
    expect(formatRelativeTime(iso59m)).toBe("59m ago");
  });

  it("returns hour tier for times 1-23 hours ago", () => {
    const now = new Date("2024-01-01T12:00:00Z").getTime();
    vi.setSystemTime(now);

    // 1 hour ago
    const iso1h = new Date(now - 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(iso1h)).toBe("1h ago");

    // 3 hours ago
    const iso3h = new Date(now - 3 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(iso3h)).toBe("3h ago");

    // 23 hours ago
    const iso23h = new Date(now - 23 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(iso23h)).toBe("23h ago");
  });

  it("returns day tier for times 1+ days ago", () => {
    const now = new Date("2024-01-01T12:00:00Z").getTime();
    vi.setSystemTime(now);

    // 1 day ago
    const iso1d = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(iso1d)).toBe("1d ago");

    // 2 days ago
    const iso2d = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(iso2d)).toBe("2d ago");

    // 7 days ago
    const iso7d = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(iso7d)).toBe("7d ago");
  });
});

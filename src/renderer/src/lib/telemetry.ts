/**
 * Renderer-side analytics reporting. There is no general "send any event" bridge
 * — main exposes one narrow channel per interaction it wants to hear about, and
 * this module is the renderer half.
 *
 * Every call here is fire-and-forget and must never affect the interaction it is
 * measuring: an analytics failure cannot be allowed to swallow a click.
 */
export function reportCitationOpened(position: number): void {
  try {
    void window.api.reportCitationOpened(position).catch(() => {});
  } catch {
    // The bridge is missing (an old preload, a test harness). Nothing to do.
  }
}

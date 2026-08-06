/**
 * What platform the renderer is running on.
 *
 * The preload bridge is the only source for this — a renderer has no `process`
 * — and it is absent under jsdom, where the tests mount components directly, so
 * every read has to tolerate `undefined`.
 */
export const PLATFORM = window.electronDrag?.platform;

/** macOS is the one platform that runs frameless, with overlay scrollbars. */
export const IS_MAC = PLATFORM === "darwin";

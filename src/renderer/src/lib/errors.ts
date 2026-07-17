/**
 * Electron's `ipcRenderer.invoke` wraps a rejection from the main process as an
 * `Error` whose message is scaffolding, not the message the handler actually
 * threw:
 *
 *   Error invoking remote method 'sync:start': Error: Source not found: abc
 *
 * — or, when the thrown value's own message didn't itself already read as an
 * `Error: ...` string, without that second occurrence:
 *
 *   Error invoking remote method 'sync:start': Source not found: abc
 *
 * Strip the prefix (both variants) so the renderer shows the message a
 * handler actually wrote, not IPC plumbing.
 */
const IPC_ERROR_PREFIX = /^Error invoking remote method '[^']*': (?:Error: )?/;

/**
 * Narrows an unknown catch value to a display string: an `Error`'s message or
 * a plain string, with the IPC wrapper prefix stripped from either; anything
 * else (including `undefined`/non-Error/non-string throws) falls back to
 * `fallback`.
 */
export function toErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) {
    return err.message.replace(IPC_ERROR_PREFIX, "");
  }
  if (typeof err === "string") {
    return err.replace(IPC_ERROR_PREFIX, "");
  }
  return fallback;
}

/**
 * Maps a 401/"unauthorized" error message to the message every OAuth-backed
 * picker shows for it. Case-insensitive on "unauthorized" only — "401" is a
 * status code, not prose, so it does not get the same treatment.
 */
export function authAwareMessage(msg: string): string {
  return msg.includes("401") || msg.toLowerCase().includes("unauthorized")
    ? "Session expired — please reconnect in Settings."
    : msg;
}

/**
 * Opens a URL in the user's default browser via the main process.
 *
 * `window.api.openExternal` returns a promise that can reject (IPC failure, a
 * shell that refuses the URL). Callers used to `void` it, so a rejection became
 * an unhandled promise rejection with no feedback. This wrapper always catches
 * and logs, so no call site can leak one. It resolves to `true` on success and
 * `false` on failure, letting a caller with an error surface react if it wants.
 */
export async function openExternal(url: string): Promise<boolean> {
  try {
    await window.api.openExternal(url);
    return true;
  } catch (err) {
    console.error("Failed to open external link:", err);
    return false;
  }
}

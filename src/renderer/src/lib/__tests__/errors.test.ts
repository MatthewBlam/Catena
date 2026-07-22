import { describe, it, expect } from "vitest";
import { toErrorMessage, authAwareMessage } from "../errors";

describe("toErrorMessage", () => {
  it("strips the IPC wrapper prefix including the second 'Error: '", () => {
    const err = new Error(
      "Error invoking remote method 'sync:start': Error: Source not found: abc",
    );
    expect(toErrorMessage(err, "fallback")).toBe("Source not found: abc");
  });

  it("strips the IPC wrapper prefix when there is no second 'Error: '", () => {
    const err = new Error(
      "Error invoking remote method 'sync:start': Source not found: abc",
    );
    expect(toErrorMessage(err, "fallback")).toBe("Source not found: abc");
  });

  it("recovers the exact 'OAuth canceled' sentinel from an IPC-wrapped rejection", () => {
    // ConnectNotionButton/ConnectDriveButton compare the result to the literal
    // "OAuth canceled" to return to idle silently. The IPC wrapper must strip
    // cleanly or that `=== "OAuth canceled"` check breaks and a user-initiated
    // cancel surfaces as an error banner instead.
    const err = new Error(
      "Error invoking remote method 'auth:notion-oauth-start': Error: OAuth canceled",
    );
    expect(toErrorMessage(err, "fallback")).toBe("OAuth canceled");
  });

  it("leaves an Error message alone when it never carried the IPC prefix", () => {
    const err = new Error("Notion token not found. Connect Notion first.");
    expect(toErrorMessage(err, "fallback")).toBe(
      "Notion token not found. Connect Notion first.",
    );
  });

  it("narrows a plain string, stripping the prefix the same way", () => {
    expect(
      toErrorMessage(
        "Error invoking remote method 'sync:cancel': Error: boom",
        "fallback",
      ),
    ).toBe("boom");
    expect(toErrorMessage("already plain", "fallback")).toBe("already plain");
  });

  it("falls back for anything that is neither an Error nor a string", () => {
    expect(toErrorMessage(undefined, "fallback")).toBe("fallback");
    expect(toErrorMessage(null, "fallback")).toBe("fallback");
    expect(toErrorMessage(42, "fallback")).toBe("fallback");
    expect(
      toErrorMessage({ message: "not an Error instance" }, "fallback"),
    ).toBe("fallback");
  });
});

describe("authAwareMessage", () => {
  const SESSION_EXPIRED = "Session expired — please reconnect in Settings.";

  it("maps a message containing '401' to the session-expired message", () => {
    expect(authAwareMessage("Request failed with status 401")).toBe(
      SESSION_EXPIRED,
    );
  });

  it("maps a message containing 'unauthorized' case-insensitively", () => {
    expect(authAwareMessage("Unauthorized")).toBe(SESSION_EXPIRED);
    expect(authAwareMessage("UNAUTHORIZED: token expired")).toBe(
      SESSION_EXPIRED,
    );
  });

  it("passes an unrelated message through unchanged", () => {
    expect(authAwareMessage("Network error")).toBe("Network error");
  });
});

// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { DrivePicker } from "../DrivePicker";
import type {
  DriveItemSummary,
  GoogleOAuthStarted,
} from "../../../../../shared/types";

afterEach(cleanup);

function folder(id: string, name: string): DriveItemSummary {
  return { id, name, isFolder: true };
}

const ROOT = [folder("f1", "Club Documents")];
const ROOT_AFTER = [folder("f1", "Club Documents"), folder("f2", "Minutes")];

interface ApiOverrides {
  listDriveItems?: () => Promise<DriveItemSummary[]>;
  startGoogleOAuth?: () => Promise<GoogleOAuthStarted>;
}

function mockApi(overrides: ApiOverrides = {}): {
  listDriveItems: ReturnType<typeof vi.fn>;
  startGoogleOAuth: ReturnType<typeof vi.fn>;
  cancelGoogleOAuth: ReturnType<typeof vi.fn>;
} {
  const api = {
    listDriveItems: vi.fn(
      overrides.listDriveItems ?? (() => Promise.resolve(ROOT)),
    ),
    startGoogleOAuth: vi.fn(
      overrides.startGoogleOAuth ??
        (() => Promise.resolve({ email: "club@school.edu" })),
    ),
    cancelGoogleOAuth: vi.fn(() => Promise.resolve()),
  };
  window.api = api as unknown as typeof window.api;
  return api;
}

function renderPicker(): void {
  render(
    <DrivePicker
      onAdd={() => Promise.resolve({ added: 0, failed: 0 })}
      onClose={() => {}}
    />,
  );
}

const RECONNECT_BUTTON = "Reconnect Google Drive";

describe("DrivePicker — refreshing", () => {
  it("refetches the current folder, bypassing the cached listing", async () => {
    // Drive's scope already covers the whole account, so newly added files are
    // reachable without re-authorizing — the picker's own cache is what hides
    // them. Refresh is the fix for the stated need, not the OAuth round-trip.
    const api = mockApi();
    api.listDriveItems
      .mockImplementationOnce(() => Promise.resolve(ROOT))
      .mockImplementationOnce(() => Promise.resolve(ROOT_AFTER));
    renderPicker();
    await screen.findByText("Club Documents");

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await screen.findByText("Minutes");
    expect(api.listDriveItems).toHaveBeenCalledTimes(2);
  });
});

describe("DrivePicker — reconnecting", () => {
  it("reconnects without any warning and reloads the listing", async () => {
    // Deliberately unlike Notion: a Drive reconnect re-grants the whole account,
    // so there is nothing to lose and nothing to confirm.
    const api = mockApi();
    api.listDriveItems
      .mockImplementationOnce(() => Promise.resolve(ROOT))
      .mockImplementationOnce(() => Promise.resolve(ROOT_AFTER));
    renderPicker();
    await screen.findByText("Club Documents");

    fireEvent.click(screen.getByRole("button", { name: RECONNECT_BUTTON }));

    expect(api.startGoogleOAuth).toHaveBeenCalled();
    await screen.findByText("Minutes");
  });

  it("shows a cancellable waiting state while the browser flow is open", async () => {
    const api = mockApi({ startGoogleOAuth: () => new Promise(() => {}) });
    renderPicker();
    await screen.findByText("Club Documents");

    fireEvent.click(screen.getByRole("button", { name: RECONNECT_BUTTON }));

    await screen.findByText(/Waiting for Google authorization/i);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.cancelGoogleOAuth).toHaveBeenCalled();
  });

  it("returns quietly to the list when the user cancels the flow", async () => {
    mockApi({
      startGoogleOAuth: () => Promise.reject(new Error("OAuth canceled")),
    });
    renderPicker();
    await screen.findByText("Club Documents");

    fireEvent.click(screen.getByRole("button", { name: RECONNECT_BUTTON }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: RECONNECT_BUTTON }),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/failed/i)).not.toBeInTheDocument();
    expect(screen.getByText("Club Documents")).toBeInTheDocument();
  });

  it("reports a genuine failure without destroying the loaded listing", async () => {
    mockApi({
      startGoogleOAuth: () =>
        Promise.reject(new Error("Token exchange failed")),
    });
    renderPicker();
    await screen.findByText("Club Documents");

    fireEvent.click(screen.getByRole("button", { name: RECONNECT_BUTTON }));

    await screen.findByText("Token exchange failed");
    expect(screen.getByText("Club Documents")).toBeInTheDocument();
  });

  it("warns when a different Google account was authorized", async () => {
    // The one destructive case: existing sources point at folders the new
    // account cannot see. Reported after the fact, never blocking.
    mockApi({
      startGoogleOAuth: () =>
        Promise.resolve({
          email: "personal@gmail.com",
          accountChanged: {
            previousEmail: "club@school.edu",
            sourceCount: 2,
          },
        }),
    });
    renderPicker();
    await screen.findByText("Club Documents");

    fireEvent.click(screen.getByRole("button", { name: RECONNECT_BUTTON }));

    await screen.findByText(/club@school\.edu/);
    expect(screen.getByText(/personal@gmail\.com/)).toBeInTheDocument();
  });
});

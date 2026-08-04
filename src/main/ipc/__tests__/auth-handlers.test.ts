import { describe, it, expect, beforeEach, vi } from "vitest";

// Same stubbing approach as answer-handlers.test.ts: handlers.ts pulls in the
// whole main process, so every collaborator is mocked and only the Notion auth
// channels are exercised.
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: vi.fn(() => "/tmp") },
  shell: { openExternal: vi.fn() },
}));
vi.mock("../../db/singleton", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("../../db/database", () => ({
  getSetting: vi.fn(() => null),
  upsertSetting: vi.fn(),
  deleteSetting: vi.fn(),
  getAllSources: vi.fn(() => []),
  getChunksByIds: vi.fn(() => []),
  updateRecentSearchAnswer: vi.fn(),
  getAllSourcesWithCounts: vi.fn(),
  insertSource: vi.fn(),
  deleteSource: vi.fn(),
  getSourceById: vi.fn(),
  getSourceByProviderAndRoot: vi.fn(),
  getDocumentsBySourceId: vi.fn(),
  getStorageStats: vi.fn(),
  clearAllData: vi.fn(),
  getEmbeddingHealth: vi.fn(),
  getChunkCountByModel: vi.fn(),
  listRecentSearches: vi.fn(),
  getRecentSearchById: vi.fn(),
  deleteRecentSearch: vi.fn(),
  pruneExpiredRecentSearches: vi.fn(),
  saveRecentSearchFromResponse: vi.fn(),
}));
vi.mock("../../auth/storage", () => ({
  saveSecret: vi.fn(),
  loadSecret: vi.fn(),
  deleteSecret: vi.fn(),
}));
vi.mock("../../search/searcher", () => ({ search: vi.fn() }));
vi.mock("../../search/answerer", () => ({
  generateAnswer: vi.fn(),
  COHERE_ANSWER_MODEL: "command-r-08-2024",
  DEFAULT_OLLAMA_CHAT_MODEL: "llama3.2",
}));
vi.mock("../../auth/notion-oauth", () => ({
  startNotionOAuth: vi.fn(),
  cancelNotionOAuth: vi.fn(),
}));
vi.mock("../../connectors/notion", () => ({
  listNotionItems: vi.fn(),
  checkNotionPageAccess: vi.fn(),
}));
vi.mock("../../auth/google-oauth", () => ({
  startGoogleOAuth: vi.fn(),
  cancelGoogleOAuth: vi.fn(),
  getAuthenticatedClient: vi.fn(),
  refreshIfNeeded: vi.fn(),
}));
vi.mock("../../connectors/drive", () => ({ listDriveItems: vi.fn() }));
vi.mock("../../search/embedder", () => ({ getEmbeddingModelName: vi.fn() }));
vi.mock("../sync-handlers", () => ({
  cancelSync: vi.fn(),
  cancelAllSyncs: vi.fn(),
  buildEmbedConfig: vi.fn(() => ({ provider: "cohere", apiKey: "k" })),
  broadcastSourcesChanged: vi.fn(),
  broadcastRecentsChanged: vi.fn(),
  getActiveSyncProgress: vi.fn(),
  setClearingAllData: vi.fn(),
}));
vi.mock("../../sync/scheduler", () => ({
  syncScheduler: { getState: vi.fn(), start: vi.fn(), stop: vi.fn() },
}));
vi.mock("../../telemetry/posthog", () => ({
  track: vi.fn(),
  initTelemetry: vi.fn(),
  isTelemetryEnabled: vi.fn(),
  setTelemetryEnabled: vi.fn(),
}));

import { ipcMain } from "electron";
import { registerIpcHandlers } from "../handlers";
import { startNotionOAuth } from "../../auth/notion-oauth";
import { startGoogleOAuth } from "../../auth/google-oauth";
import { saveSecret, deleteSecret, loadSecret } from "../../auth/storage";
import { checkNotionPageAccess } from "../../connectors/notion";
import {
  getSetting,
  upsertSetting,
  deleteSetting,
  getAllSources,
} from "../../db/database";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function handlerFor(channel: string): Handler {
  const call = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.find(
    ([c]) => c === channel,
  );
  if (!call) throw new Error(`no handler registered for ${channel}`);
  return call[1] as Handler;
}

const WORKSPACE_A = "11111111-2222-3333-4444-555555555555";
const WORKSPACE_B = "99999999-8888-7777-6666-555555555555";

/** Settings the fake DB currently holds, keyed as `getSetting` sees them. */
let settings: Record<string, string | null>;

function notionSource(id: string): Record<string, unknown> {
  return { id, provider: "notion", name: id, rootExternalId: id };
}

function named(id: string, name: string): Record<string, unknown> {
  return { id, provider: "notion", name, rootExternalId: `root-${id}` };
}

function oauthResolves(workspaceId: string, workspaceName: string): void {
  (startNotionOAuth as ReturnType<typeof vi.fn>).mockResolvedValue({
    accessToken: `token-for-${workspaceId}`,
    workspaceId,
    workspaceName,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NOTION_CLIENT_ID", "client-id");
  vi.stubEnv("NOTION_TOKEN_PROXY_URL", "https://proxy.example/notion/token");
  vi.stubEnv("GOOGLE_CLIENT_ID", "google-client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-client-secret");

  settings = {};
  (getSetting as ReturnType<typeof vi.fn>).mockImplementation(
    (_db: unknown, key: string) => settings[key] ?? null,
  );
  (upsertSetting as ReturnType<typeof vi.fn>).mockImplementation(
    (_db: unknown, key: string, value: string) => {
      settings[key] = value;
    },
  );
  (deleteSetting as ReturnType<typeof vi.fn>).mockImplementation(
    (_db: unknown, key: string) => {
      delete settings[key];
    },
  );
  (getAllSources as ReturnType<typeof vi.fn>).mockReturnValue([]);
  // Default to "already connected" — the state a re-authorization starts from.
  (loadSecret as ReturnType<typeof vi.fn>).mockReturnValue("existing-token");

  registerIpcHandlers();
  // `pendingNotionAuth` is module state and outlives `clearAllMocks`. Discard
  // anything a previous test left uncommitted so each test starts clean.
  void handlerFor("auth:notion-workspace-switch-resolve")({}, false);
});

describe("auth:notion-oauth-start", () => {
  it("commits the token and records the workspace on a first connection", async () => {
    oauthResolves(WORKSPACE_A, "Design Team");

    const result = await handlerFor("auth:notion-oauth-start")({});

    expect(saveSecret).toHaveBeenCalledWith(
      expect.anything(),
      "notion_token",
      `token-for-${WORKSPACE_A}`,
    );
    expect(result).toEqual({ workspaceName: "Design Team" });
    expect(settings.notion_workspace_id).toBe(WORKSPACE_A);
    expect(settings.notion_workspace_name).toBe("Design Team");
  });

  it("commits silently when re-authorizing the same workspace", async () => {
    settings.notion_workspace_id = WORKSPACE_A;
    settings.notion_workspace_name = "Design Team";
    (getAllSources as ReturnType<typeof vi.fn>).mockReturnValue([
      notionSource("s1"),
    ]);
    oauthResolves(WORKSPACE_A, "Design Team");

    const result = await handlerFor("auth:notion-oauth-start")({});

    // The whole point of the feature: adding pages must not prompt.
    expect(result).toEqual({ workspaceName: "Design Team" });
    expect(saveSecret).toHaveBeenCalled();
  });

  it("ignores dash and case differences in the workspace id", async () => {
    settings.notion_workspace_id = WORKSPACE_A.replace(/-/g, "").toUpperCase();
    settings.notion_workspace_name = "Design Team";
    (getAllSources as ReturnType<typeof vi.fn>).mockReturnValue([
      notionSource("s1"),
    ]);
    oauthResolves(WORKSPACE_A, "Design Team");

    const result = await handlerFor("auth:notion-oauth-start")({});

    expect(result).toEqual({ workspaceName: "Design Team" });
    expect(saveSecret).toHaveBeenCalled();
  });

  it("withholds the token when a different workspace would orphan existing sources", async () => {
    settings.notion_workspace_id = WORKSPACE_A;
    settings.notion_workspace_name = "Design Team";
    (getAllSources as ReturnType<typeof vi.fn>).mockReturnValue([
      notionSource("s1"),
      notionSource("s2"),
      { id: "s3", provider: "google_drive" },
    ]);
    oauthResolves(WORKSPACE_B, "Personal");

    const result = await handlerFor("auth:notion-oauth-start")({});

    expect(result).toEqual({
      workspaceName: "Personal",
      workspaceSwitch: {
        previousName: "Design Team",
        nextName: "Personal",
        sourceCount: 2, // Notion only — the Drive source is unaffected.
      },
    });
    // The old connection must keep working until the user decides.
    expect(saveSecret).not.toHaveBeenCalled();
    expect(settings.notion_workspace_id).toBe(WORKSPACE_A);
  });

  it("commits without prompting when no token is stored, whatever the settings say", async () => {
    // ConnectNotionButton only runs OAuth when `hasSecret("notion_token")` is
    // false, and it ignores the result — so a withheld token there would be
    // dropped with nobody to resolve it, leaving the user unconnected. With no
    // stored token there is no working connection to protect, so never withhold.
    settings.notion_workspace_id = WORKSPACE_A;
    settings.notion_workspace_name = "Design Team";
    (getAllSources as ReturnType<typeof vi.fn>).mockReturnValue([
      notionSource("s1"),
    ]);
    (loadSecret as ReturnType<typeof vi.fn>).mockReturnValue(null);
    oauthResolves(WORKSPACE_B, "Personal");

    const result = await handlerFor("auth:notion-oauth-start")({});

    expect(result).toEqual({ workspaceName: "Personal" });
    expect(saveSecret).toHaveBeenCalled();
    expect(settings.notion_workspace_id).toBe(WORKSPACE_B);
  });

  it("commits a different workspace without prompting when no Notion sources exist", async () => {
    settings.notion_workspace_id = WORKSPACE_A;
    settings.notion_workspace_name = "Design Team";
    (getAllSources as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: "s3", provider: "google_drive" },
    ]);
    oauthResolves(WORKSPACE_B, "Personal");

    const result = await handlerFor("auth:notion-oauth-start")({});

    // Nothing is bound to the old workspace, so there is nothing to warn about.
    expect(result).toEqual({ workspaceName: "Personal" });
    expect(settings.notion_workspace_id).toBe(WORKSPACE_B);
  });
});

describe("auth:notion-workspace-switch-resolve", () => {
  async function pendSwitch(): Promise<void> {
    settings.notion_workspace_id = WORKSPACE_A;
    settings.notion_workspace_name = "Design Team";
    (getAllSources as ReturnType<typeof vi.fn>).mockReturnValue([
      notionSource("s1"),
    ]);
    oauthResolves(WORKSPACE_B, "Personal");
    await handlerFor("auth:notion-oauth-start")({});
  }

  it("commits the withheld token when the switch is accepted", async () => {
    await pendSwitch();

    await handlerFor("auth:notion-workspace-switch-resolve")({}, true);

    expect(saveSecret).toHaveBeenCalledWith(
      expect.anything(),
      "notion_token",
      `token-for-${WORKSPACE_B}`,
    );
    expect(settings.notion_workspace_id).toBe(WORKSPACE_B);
    expect(settings.notion_workspace_name).toBe("Personal");
  });

  it("discards the withheld token when the switch is declined", async () => {
    await pendSwitch();

    await handlerFor("auth:notion-workspace-switch-resolve")({}, false);

    expect(saveSecret).not.toHaveBeenCalled();
    expect(settings.notion_workspace_id).toBe(WORKSPACE_A);
  });

  it("is idempotent — a second resolve cannot commit an already-discarded token", async () => {
    await pendSwitch();

    await handlerFor("auth:notion-workspace-switch-resolve")({}, false);
    await handlerFor("auth:notion-workspace-switch-resolve")({}, true);

    expect(saveSecret).not.toHaveBeenCalled();
  });

  it("does nothing when no switch is pending", async () => {
    await handlerFor("auth:notion-workspace-switch-resolve")({}, true);

    expect(saveSecret).not.toHaveBeenCalled();
  });

  it("drops a stale pending token when a new OAuth flow starts", async () => {
    await pendSwitch();

    // A second flow, this time back to the original workspace, commits normally.
    oauthResolves(WORKSPACE_A, "Design Team");
    await handlerFor("auth:notion-oauth-start")({});
    vi.mocked(saveSecret).mockClear();

    // Accepting now must not resurrect the abandoned Workspace B token.
    await handlerFor("auth:notion-workspace-switch-resolve")({}, true);

    expect(saveSecret).not.toHaveBeenCalled();
    expect(settings.notion_workspace_id).toBe(WORKSPACE_A);
  });
});

describe("secrets:delete", () => {
  it("clears the recorded workspace when the Notion token is deleted", async () => {
    settings.notion_workspace_id = WORKSPACE_A;
    settings.notion_workspace_name = "Design Team";

    await handlerFor("secrets:delete")({}, "notion_token");

    expect(deleteSecret).toHaveBeenCalledWith(
      expect.anything(),
      "notion_token",
    );
    // Otherwise the next fresh connect to a different workspace would be
    // reported as a "switch" away from a workspace we are no longer in.
    expect(settings.notion_workspace_id).toBeUndefined();
    expect(settings.notion_workspace_name).toBeUndefined();
  });

  it("leaves the recorded workspace alone when another secret is deleted", async () => {
    settings.notion_workspace_id = WORKSPACE_A;

    await handlerFor("secrets:delete")({}, "cohere_api_key");

    expect(settings.notion_workspace_id).toBe(WORKSPACE_A);
  });
});

describe("notion:check-source-access", () => {
  it("names the sources whose root page the token can no longer read", async () => {
    (getAllSources as ReturnType<typeof vi.fn>).mockReturnValue([
      named("s1", "Handbook"),
      named("s2", "Budget"),
      {
        id: "s3",
        provider: "google_drive",
        name: "Drive",
        rootExternalId: "d",
      },
    ]);
    (checkNotionPageAccess as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Set(["root-s1"]),
    );

    const orphaned = await handlerFor("notion:check-source-access")({});

    // Drive is never checked; s2's root is gone.
    expect(checkNotionPageAccess).toHaveBeenCalledWith("existing-token", [
      "root-s1",
      "root-s2",
    ]);
    expect(orphaned).toEqual([{ id: "s2", name: "Budget" }]);
  });

  it("reports nothing when every source is still reachable", async () => {
    (getAllSources as ReturnType<typeof vi.fn>).mockReturnValue([
      named("s1", "Handbook"),
    ]);
    (checkNotionPageAccess as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Set(["root-s1"]),
    );

    expect(await handlerFor("notion:check-source-access")({})).toEqual([]);
  });

  it("reports nothing, and checks nothing, without a stored token", async () => {
    // No token means no connection to judge against — "everything is orphaned"
    // would be a false alarm, and the disconnected state is already visible.
    (loadSecret as ReturnType<typeof vi.fn>).mockReturnValue(null);
    (getAllSources as ReturnType<typeof vi.fn>).mockReturnValue([
      named("s1", "Handbook"),
    ]);

    expect(await handlerFor("notion:check-source-access")({})).toEqual([]);
    expect(checkNotionPageAccess).not.toHaveBeenCalled();
  });
});

describe("auth:google-oauth-start", () => {
  function googleResolves(email: string): void {
    (startGoogleOAuth as ReturnType<typeof vi.fn>).mockResolvedValue({ email });
  }

  function driveSource(id: string): Record<string, unknown> {
    return { id, provider: "google_drive", name: id, rootExternalId: id };
  }

  it("records the account on a first connection", async () => {
    googleResolves("club@school.edu");

    const result = await handlerFor("auth:google-oauth-start")({});

    expect(result).toEqual({ email: "club@school.edu" });
    expect(settings.google_account_email).toBe("club@school.edu");
  });

  it("reconnecting the same account reports nothing", async () => {
    // Drive grants read access to the whole account, so a plain reconnect is
    // routine and must never interrupt — that is the whole point of the button.
    settings.google_account_email = "club@school.edu";
    (getAllSources as ReturnType<typeof vi.fn>).mockReturnValue([
      driveSource("s1"),
    ]);
    googleResolves("club@school.edu");

    const result = await handlerFor("auth:google-oauth-start")({});

    expect(result).toEqual({ email: "club@school.edu" });
  });

  it("flags a different account when Drive sources already exist", async () => {
    settings.google_account_email = "club@school.edu";
    (getAllSources as ReturnType<typeof vi.fn>).mockReturnValue([
      driveSource("s1"),
      driveSource("s2"),
      notionSource("s3"),
    ]);
    googleResolves("personal@gmail.com");

    const result = await handlerFor("auth:google-oauth-start")({});

    expect(result).toEqual({
      email: "personal@gmail.com",
      accountChanged: {
        previousEmail: "club@school.edu",
        sourceCount: 2, // Drive only — the Notion source is unaffected.
      },
    });
    // Reported, not blocked: the tokens are already stored by the OAuth flow and
    // the user asked for a reconnect, so this is a heads-up, not a gate.
    expect(settings.google_account_email).toBe("personal@gmail.com");
  });

  it("says nothing about a different account when no Drive sources exist", async () => {
    settings.google_account_email = "club@school.edu";
    (getAllSources as ReturnType<typeof vi.fn>).mockReturnValue([
      notionSource("s1"),
    ]);
    googleResolves("personal@gmail.com");

    expect(await handlerFor("auth:google-oauth-start")({})).toEqual({
      email: "personal@gmail.com",
    });
  });

  it("clears the recorded account when the Google tokens are deleted", async () => {
    settings.google_account_email = "club@school.edu";

    await handlerFor("secrets:delete")({}, "google_tokens");

    expect(settings.google_account_email).toBeUndefined();
  });
});

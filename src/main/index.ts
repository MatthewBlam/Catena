import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  screen,
  crashReporter,
  dialog,
} from "electron";
import { join } from "path";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import started from "electron-squirrel-startup";
import icon from "../../resources/icon.png?asset";
import { registerIpcHandlers } from "./ipc/handlers";
import { registerSyncHandlers, cancelAllSyncs } from "./ipc/sync-handlers";
import { syncScheduler } from "./sync/scheduler";
import { getDb, closeDb } from "./db/singleton";
import {
  resetStalePendingDocuments,
  getStorageStats,
  getSetting,
  pruneExpiredRecentSearches,
} from "./db/database";
import { initTelemetry, track, shutdownTelemetry } from "./telemetry/posthog";

if (started) app.quit();

// Collect minidumps for native crashes locally. `uploadToServer: false` keeps
// this a local-first app — nothing leaves the machine — while still giving a
// crash something to leave behind (see `app.getPath("crashDumps")`) instead of
// vanishing. Started as early as possible so it covers the main process too.
crashReporter.start({ uploadToServer: false });

// A thrown-but-uncaught error or rejected-but-unhandled promise in the main
// process would otherwise die silently (or take the whole app down with no
// trail). Log them so there is at least a diagnostic; the renderer has its own
// `unhandledrejection` logger in `main.tsx`.
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception in main process:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection in main process:", reason);
});

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1000,
    height: 750,
    minWidth: 800,
    minHeight: 750,
    show: false,
    autoHideMenuBar: true,
    frame: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 22, y: 23 },
    icon,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
    if (is.dev) mainWindow.webContents.openDevTools();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    try {
      const parsed = new URL(details.url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        shell.openExternal(details.url);
      }
    } catch {
      /* invalid URL, ignore */
    }
    return { action: "deny" };
  });

  // `setWindowOpenHandler` only covers `window.open`; nothing stops in-page
  // navigation (a stray anchor, an injected redirect) from replacing the app
  // itself. The window loads exactly one document and never navigates on its
  // own, so the only legitimate navigation is a dev-server HMR reload of that
  // same document — permitted via the same-origin check. Everything else is
  // blocked, and real external links are handed to the OS browser, mirroring
  // the window-open handler above.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    let sameOrigin = false;
    try {
      sameOrigin =
        new URL(url).origin === new URL(mainWindow.webContents.getURL()).origin;
    } catch {
      sameOrigin = false;
    }
    if (sameOrigin) return;

    event.preventDefault();
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        shell.openExternal(url);
      }
    } catch {
      /* invalid URL, ignore */
    }
  });

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app
  .whenReady()
  .then(async () => {
    electronApp.setAppUserModelId("com.commons.app");

    app.on("browser-window-created", (_, window) => {
      optimizer.watchWindowShortcuts(window);
    });

    const dragOffsets = new WeakMap<BrowserWindow, { x: number; y: number }>();

    ipcMain.on("window:start-drag", (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return;
      const [wx, wy] = win.getPosition();
      const cursor = screen.getCursorScreenPoint();
      dragOffsets.set(win, { x: cursor.x - wx, y: cursor.y - wy });
    });

    ipcMain.on("window:dragging", (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return;
      const offset = dragOffsets.get(win);
      if (!offset) return;
      const cursor = screen.getCursorScreenPoint();
      win.setPosition(cursor.x - offset.x, cursor.y - offset.y);
    });

    ipcMain.on("window:stop-drag", (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win) dragOffsets.delete(win);
    });

    registerIpcHandlers();
    registerSyncHandlers();
    const db = getDb();
    const staleCount = resetStalePendingDocuments(db);
    if (staleCount > 0) {
      console.log(
        `Reset ${staleCount} stale pending documents to error status`,
      );
    }
    const prunedRecentCount = pruneExpiredRecentSearches(db);
    if (prunedRecentCount > 0) {
      console.log(`Pruned ${prunedRecentCount} expired recent searches`);
    }

    initTelemetry(db);
    const stats = getStorageStats(db);
    track("commons_app_opened", {
      app_version: app.getVersion(),
      platform: process.platform,
      source_count: stats.sourceCount,
      document_count: stats.documentCount,
      chunk_count: stats.chunkCount,
      embedding_provider: getSetting(db, "embedding_provider") ?? "cohere",
      auto_sync_enabled: getSetting(db, "auto_sync_enabled") === "true",
    });

    syncScheduler.start(db);
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch((err) => {
    console.error("Fatal: app initialization failed:", err);
    // Show the user *why* before dying. Init can fail on a schema too new for
    // this build (the forward-compat guard) or a corrupt database — a silent
    // `app.quit()` makes that guard invisible to the very person it protects.
    // `showErrorBox` is safe to call this early and blocks until dismissed.
    dialog.showErrorBox(
      "Commons couldn't start",
      err instanceof Error ? err.message : String(err),
    );
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

let quitting = false;

app.on("will-quit", (event) => {
  // Re-entrant: the `app.quit()` below fires `will-quit` a second time. The
  // guard lets that pass through so the app actually dies.
  if (quitting) return;
  quitting = true;

  // Hold the quit open long enough to flush buffered PostHog events —
  // `shutdownTelemetry` returns the flush promise, and dropping it on exit was
  // silently losing the tail of every session. Bounded by a hard deadline so a
  // dead network can never wedge the quit.
  event.preventDefault();

  // `cancelAllSyncs` aborts every controller synchronously before its first
  // `await`, so the abort lands now; we do not wait for the unwind. The sync
  // epilogue already tolerates a closed database (it records outcomes
  // best-effort), and better-sqlite3 is synchronous, so there is no
  // half-applied transaction to close on top of.
  void cancelAllSyncs();
  syncScheduler.stop();

  Promise.race([
    shutdownTelemetry(),
    new Promise<void>((resolve) => setTimeout(resolve, 3000)),
  ]).finally(() => {
    // Close last, after the flush window, so any late sync unwind still writes
    // its outcome against an open connection rather than tripping the
    // best-effort catch.
    closeDb();
    app.quit();
  });
});

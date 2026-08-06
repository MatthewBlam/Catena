import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

// Runtime holds module-level state (`child` / `ownedByUs`). Each test re-imports
// a fresh module via `vi.resetModules()` so that state never leaks across tests.

interface FakeChild extends EventEmitter {
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

const h = vi.hoisted(() => ({
  userDataDir: "",
  spawn: null as unknown as ReturnType<typeof vi.fn>,
  lastChild: null as FakeChild | null,
  /** What `systemInstallCandidates` reports for a test. Read at call time. */
  systemCandidates: [] as string[],
}));

vi.mock("electron", () => ({
  app: { getPath: (_name: string) => h.userDataDir },
}));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) =>
    (h.spawn as unknown as (...a: unknown[]) => unknown)(...args),
}));

// runtime.ts imports "./download"; from this test file that resolves to
// "../download" — the same absolute module, so this intercepts it.
vi.mock("../download", () => ({
  downloadWithProgress: vi.fn(),
  extractArchive: vi.fn(),
}));

// Only the system-install probe is faked; ollamaDir()/binaryPath() stay real so
// they still resolve against the temp userData dir above.
vi.mock("../platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform")>()),
  systemInstallCandidates: () => h.systemCandidates,
}));

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

/** The engine binary name findExecutable() looks for on this platform. */
const binName = process.platform === "win32" ? "ollama.exe" : "ollama";

beforeEach(() => {
  vi.resetModules();
  h.userDataDir = mkdtempSync(join(tmpdir(), "catena-rt-"));
  h.lastChild = null;
  h.systemCandidates = [];
  h.spawn = vi.fn(() => {
    const c = makeChild();
    h.lastChild = c;
    return c;
  });
});

afterEach(() => {
  rmSync(h.userDataDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/** Writes a fake engine executable where findExecutable() expects it. */
function placeBinary(): void {
  const dir = join(h.userDataDir, "ollama");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, binName), "#!/bin/sh\n");
}

describe("isEngineUp", () => {
  it("is true when /api/version returns a version string", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ version: "0.32.5" }),
      })),
    );
    const { isEngineUp } = await import("../runtime");
    expect(await isEngineUp()).toBe(true);
  });

  it("is false when the response carries no version (a foreign squatter)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    const { isEngineUp } = await import("../runtime");
    expect(await isEngineUp()).toBe(false);
  });

  it("is false when the request throws (nothing listening)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const { isEngineUp } = await import("../runtime");
    expect(await isEngineUp()).toBe(false);
  });
});

describe("ensureEngine", () => {
  it("reuses an already-running engine and never spawns", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ version: "0.32.5" }),
      })),
    );
    const { ensureEngine, isEngineOwned } = await import("../runtime");
    const onProgress = vi.fn();

    await ensureEngine(onProgress);

    expect(h.spawn).not.toHaveBeenCalled();
    expect(isEngineOwned()).toBe(false);
    expect(onProgress).toHaveBeenCalledWith({ phase: "checking" });
  });

  it("spawns the on-disk binary when the engine is down, then polls until ready", async () => {
    placeBinary();
    // First check (initial isEngineUp) fails; the readiness poll then succeeds
    // on its first attempt, so waitUntilUp resolves without any sleep.
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls === 1) throw new Error("down");
        return { ok: true, json: async () => ({ version: "0.32.5" }) };
      }),
    );

    const { ensureEngine, isEngineOwned, stopEngine } =
      await import("../runtime");
    await ensureEngine(vi.fn());

    expect(h.spawn).toHaveBeenCalledTimes(1);
    const [bin, args] = h.spawn.mock.calls[0] as [string, string[]];
    expect(bin.endsWith(binName)).toBe(true);
    expect(args).toEqual(["serve"]);
    expect(isEngineOwned()).toBe(true);

    // stopEngine kills the child we own.
    const spawned = h.lastChild!;
    stopEngine();
    expect(spawned.kill).toHaveBeenCalledTimes(1);
    expect(isEngineOwned()).toBe(false);
  });
});

describe("stopEngine", () => {
  it("is a no-op when nothing was spawned", async () => {
    const { stopEngine } = await import("../runtime");
    expect(() => stopEngine()).not.toThrow();
    expect(h.lastChild).toBeNull();
  });
});

/** A real executable file at `dir/<name>`, so existsSync/statSync see it. */
function placeFile(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const full = join(dir, name);
  writeFileSync(full, "#!/bin/sh\n");
  return full;
}

/** Engine down on the first probe, up on every poll after — the spawn path. */
function engineDownThenUp(): void {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("down");
      return { ok: true, json: async () => ({ version: "0.32.5" }) };
    }),
  );
}

describe("ensureEngine — reusing an existing install", () => {
  it("spawns a user's own Ollama instead of downloading a second copy", async () => {
    // The gap this closes: an engine that is *installed but not running* used to
    // be invisible, so a 146 MB download happened on top of it.
    const sysDir = mkdtempSync(join(tmpdir(), "catena-sys-"));
    const sysBin = placeFile(sysDir, binName);
    h.systemCandidates = [join(sysDir, "missing"), sysBin];
    engineDownThenUp();

    const { downloadWithProgress } = await import("../download");
    const { ensureEngine } = await import("../runtime");
    await ensureEngine(vi.fn());

    expect(downloadWithProgress).not.toHaveBeenCalled();
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect((h.spawn.mock.calls[0] as [string])[0]).toBe(sysBin);

    rmSync(sysDir, { recursive: true, force: true });
  });

  it("prefers our managed binary when both exist", async () => {
    // Keeps the change strictly additive: an install that already has a managed
    // binary behaves exactly as it did before.
    placeBinary();
    const sysDir = mkdtempSync(join(tmpdir(), "catena-sys-"));
    h.systemCandidates = [placeFile(sysDir, binName)];
    engineDownThenUp();

    const { ensureEngine } = await import("../runtime");
    await ensureEngine(vi.fn());

    const spawned = (h.spawn.mock.calls[0] as [string])[0];
    expect(spawned.startsWith(h.userDataDir)).toBe(true);

    rmSync(sysDir, { recursive: true, force: true });
  });

  it("ignores a candidate path that is a directory, not an executable", async () => {
    const sysDir = mkdtempSync(join(tmpdir(), "catena-sys-"));
    // A directory literally named `ollama` must not be mistaken for the binary.
    mkdirSync(join(sysDir, binName), { recursive: true });
    h.systemCandidates = [join(sysDir, binName)];
    engineDownThenUp();

    const { downloadWithProgress, extractArchive } =
      await import("../download");
    vi.mocked(downloadWithProgress).mockImplementation(async (_u, dest) => {
      // The real implementation mkdirs the destination first.
      mkdirSync(join(h.userDataDir, "ollama"), { recursive: true });
      writeFileSync(dest as string, "archive");
    });
    vi.mocked(extractArchive).mockImplementation(async () => {
      placeBinary();
    });

    const { ensureEngine } = await import("../runtime");
    await ensureEngine(vi.fn());

    expect(downloadWithProgress).toHaveBeenCalled();
    rmSync(sysDir, { recursive: true, force: true });
  });

  it("managedBinaryExists ignores a system install", async () => {
    // Load-bearing: `managedBinaryPresent` drives the "Uninstall Ollama" button,
    // and uninstall only ever deletes <userData>/ollama. Reporting true for a
    // user's own install would offer an uninstall that silently does nothing.
    const sysDir = mkdtempSync(join(tmpdir(), "catena-sys-"));
    h.systemCandidates = [placeFile(sysDir, binName)];

    const { managedBinaryExists } = await import("../runtime");
    expect(managedBinaryExists()).toBe(false);

    rmSync(sysDir, { recursive: true, force: true });
  });
});

describe("ensureEngine — downloading", () => {
  it("deletes the archive once it has been extracted", async () => {
    engineDownThenUp();
    const { downloadWithProgress, extractArchive } =
      await import("../download");
    let archivePath = "";
    vi.mocked(downloadWithProgress).mockImplementation(async (_u, dest) => {
      archivePath = dest as string;
      mkdirSync(join(h.userDataDir, "ollama"), { recursive: true });
      writeFileSync(archivePath, "archive bytes");
    });
    vi.mocked(extractArchive).mockImplementation(async () => {
      placeBinary();
    });

    const { ensureEngine } = await import("../runtime");
    await ensureEngine(vi.fn());

    expect(archivePath).not.toBe("");
    // 139 MB of dead weight otherwise — the extracted binary is all we need.
    expect(existsSync(archivePath)).toBe(false);
  });
});

describe("ensureEngine — reclaiming a stale archive", () => {
  it("removes a leftover archive left by an earlier version", async () => {
    // Anyone who set up local embeddings before the cleanup landed still has the
    // 139 MB archive on disk, and the download path that now deletes it is never
    // reached again once the binary exists.
    placeBinary();
    // The name has to come from `resolveAsset`, not a literal: it is what
    // `discardArchive` resolves against the running platform, so hardcoding the
    // darwin `.tgz` made this pass on macOS and fail on Windows, where the file
    // it deletes is `ollama-windows-{amd64,arm64}.zip`.
    const { resolveAsset } = await import("../platform");
    const stale = join(h.userDataDir, "ollama", resolveAsset().archiveName);
    writeFileSync(stale, "stale archive");
    engineDownThenUp();

    const { ensureEngine } = await import("../runtime");
    await ensureEngine(vi.fn());

    expect(existsSync(stale)).toBe(false);
    // The binary it produced is untouched.
    expect(existsSync(join(h.userDataDir, "ollama", binName))).toBe(true);
  });
});

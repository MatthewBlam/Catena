import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
  h.userDataDir = mkdtempSync(join(tmpdir(), "commons-rt-"));
  h.lastChild = null;
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

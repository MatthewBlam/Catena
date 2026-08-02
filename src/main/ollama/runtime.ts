import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { OllamaProgress } from "../../shared/types";
import {
  OLLAMA_BASE_URL,
  OLLAMA_HOST,
  resolveAsset,
  ollamaDir,
  binaryPath,
} from "./platform";
import { downloadWithProgress, extractArchive } from "./download";

// The engine we spawned, if any, plus whether this process owns it. A reused
// system/manual Ollama is never `ownedByUs`, so we never kill it on quit.
let child: ChildProcess | null = null;
let ownedByUs = false;

const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 500;

/** True if a real Ollama engine is answering on the default port right now. */
export async function isEngineUp(signal?: AbortSignal): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/version`, {
      signal: signal ?? AbortSignal.timeout(3_000),
    });
    if (!res.ok) return false;
    // Validate it is actually Ollama, so a foreign process squatting on 11434
    // is detected rather than mistaken for the engine.
    const data = (await res.json()) as { version?: unknown };
    return typeof data.version === "string";
  } catch {
    return false;
  }
}

/** Whether the running engine (if any) is one we spawned. */
export function isEngineOwned(): boolean {
  return ownedByUs && child !== null;
}

/**
 * True if a Commons-managed engine binary is present on disk. Cheap and
 * side-effect-free (no spawn, no network) so status/UI can tell whether there is
 * anything to uninstall even when the engine is not running.
 */
export function managedBinaryExists(): boolean {
  return findExecutable() !== null;
}

/**
 * Locates the extracted engine executable. Checks the expected path first, then
 * scans one directory level deep — some archives nest the binary under a folder.
 */
function findExecutable(): string | null {
  const expected = binaryPath();
  if (existsSync(expected)) return expected;

  const dir = ollamaDir();
  if (!existsSync(dir)) return null;
  const exeName = process.platform === "win32" ? "ollama.exe" : "ollama";
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === exeName) return join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = join(dir, entry.name, exeName);
      if (existsSync(nested)) return nested;
    }
  }
  return null;
}

/**
 * Ensures the engine binary exists on disk, downloading + extracting the pinned
 * release archive if it doesn't. Returns the executable path.
 */
async function ensureBinary(
  onProgress: (p: OllamaProgress) => void,
  signal?: AbortSignal,
): Promise<string> {
  const existing = findExecutable();
  if (existing) return existing;

  const asset = resolveAsset();
  const archivePath = join(ollamaDir(), asset.archiveName);

  onProgress({ phase: "downloading-engine", percent: 0 });
  await downloadWithProgress(
    asset.url,
    archivePath,
    (p) =>
      onProgress({
        phase: "downloading-engine",
        bytesCompleted: p.bytesCompleted,
        bytesTotal: p.bytesTotal,
        percent: p.percent,
      }),
    signal,
  );

  onProgress({ phase: "extracting" });
  await extractArchive(archivePath, ollamaDir());

  const bin = findExecutable();
  if (!bin) {
    throw new Error(
      "Downloaded Ollama but could not find its executable after extraction.",
    );
  }
  if (process.platform !== "win32") {
    try {
      chmodSync(bin, 0o755);
    } catch {
      // Best-effort: the archive usually preserves the executable bit already.
    }
  }
  return bin;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Aborted"));
      },
      { once: true },
    );
  });
}

/** Spawns `<bin> serve` on the default host, tracked for shutdown. */
function spawnEngine(bin: string): void {
  const proc = spawn(bin, ["serve"], {
    env: { ...process.env, OLLAMA_HOST },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  proc.stderr?.on("data", (d: Buffer) => {
    // Ollama logs to stderr; surface it for diagnosis without failing on noise.
    console.error(`[ollama] ${d.toString().trimEnd()}`);
  });
  proc.on("exit", (code) => {
    if (proc === child) {
      child = null;
      ownedByUs = false;
    }
    if (code && code !== 0) console.error(`[ollama] serve exited with ${code}`);
  });
  child = proc;
  ownedByUs = true;
}

async function waitUntilUp(signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  // `Date.now()` is fine here (not a workflow script); we just need a wall clock.
  while (Date.now() < deadline) {
    if (await isEngineUp(signal)) return;
    await sleep(READY_POLL_MS, signal);
  }
  throw new Error(
    "Ollama did not become ready in time. Please try again, or start Ollama manually.",
  );
}

/**
 * Guarantees an engine is answering on 11434, in priority order:
 *   1. reuse one already running (system/manual, or ours from earlier);
 *   2. spawn our managed binary if it's on disk;
 *   3. download + extract the pinned release, then spawn it.
 * Emits engine-phase progress; the caller adds the model-pull phases.
 */
export async function ensureEngine(
  onProgress: (p: OllamaProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  onProgress({ phase: "checking" });
  if (await isEngineUp(signal)) return; // reuse; ownership unchanged

  const bin = await ensureBinary(onProgress, signal);

  onProgress({ phase: "starting-engine" });
  spawnEngine(bin);
  await waitUntilUp(signal);
}

/** Stops the engine only if we started it; a reused engine is left alone. */
export function stopEngine(): void {
  if (child && ownedByUs) {
    child.kill();
    child = null;
    ownedByUs = false;
  }
}

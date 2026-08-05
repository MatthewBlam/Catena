import { join, win32 as pathWin32, posix as pathPosix } from "node:path";
import { app } from "electron";

/**
 * The Ollama engine we manage. Pinned to a known-good release so a download is
 * reproducible and testable rather than tracking a moving "latest" that could
 * change asset names or behavior under us. Bump deliberately.
 */
export const OLLAMA_VERSION = "v0.32.5";

/** We always run the engine on the default host/port so every existing HTTP
 * caller (embedder, answerer, query-rewriter — all hardcoded to this) keeps
 * working untouched. Do not make this configurable without touching those. */
export const OLLAMA_HOST = "127.0.0.1:11434";
export const OLLAMA_BASE_URL = `http://${OLLAMA_HOST}`;

/** The embedding model search depends on. Auto-pulled during setup. */
export const EMBED_MODEL = "nomic-embed-text";
/** The chat model grounded answers use. Optional, pulled on demand. */
export const CHAT_MODEL = "llama3.2";

export interface OllamaAsset {
  /** Full GitHub release download URL. */
  url: string;
  /** The archive's on-disk filename, e.g. `ollama-darwin.tgz`. */
  archiveName: string;
}

/**
 * The release asset for a platform/arch. macOS ships a single universal
 * `ollama-darwin.tgz`; Windows ships per-arch zips. Args default to the current
 * process so tests can pin them without stubbing globals.
 */
export function resolveAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): OllamaAsset {
  let archiveName: string;
  if (platform === "darwin") {
    archiveName = "ollama-darwin.tgz";
  } else if (platform === "win32") {
    // Node reports Apple-silicon-emulated x64 too, but on Windows arm64 vs x64
    // is a real hardware split with different binaries.
    archiveName =
      arch === "arm64"
        ? "ollama-windows-arm64.zip"
        : "ollama-windows-amd64.zip";
  } else {
    throw new Error(
      `Automatic Ollama setup is not supported on ${platform}. Install Ollama from ollama.com and start it, then retry.`,
    );
  }
  return {
    archiveName,
    url: `https://github.com/ollama/ollama/releases/download/${OLLAMA_VERSION}/${archiveName}`,
  };
}

/** The engine executable's filename on a platform. */
export function ollamaExecutableName(
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? "ollama.exe" : "ollama";
}

/**
 * Every path an Ollama the *user* installed could plausibly live at, in priority
 * order: explicit install locations first, then each PATH entry.
 *
 * Probing these before downloading is what keeps a second 146 MB engine off the
 * disk of someone who already has Ollama — the running-engine check only helps
 * when it happens to be running, and on macOS it is a menu-bar app people quit.
 *
 * Platform and env are parameters, not globals, so the Windows layout can be
 * verified from a macOS test run and vice versa — including path separators and
 * the PATH delimiter, which is why this uses `path.win32`/`path.posix` rather
 * than the host's `join`. Nothing here touches the filesystem; the caller
 * decides which candidates actually exist.
 */
export function systemInstallCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const isWindows = platform === "win32";
  const p = isWindows ? pathWin32 : pathPosix;
  const exe = ollamaExecutableName(platform);
  const candidates: string[] = [];

  if (platform === "darwin") {
    candidates.push(
      p.join("/usr/local/bin", exe),
      p.join("/opt/homebrew/bin", exe),
      // The official app has shipped the CLI at both of these across versions.
      p.join("/Applications/Ollama.app/Contents/Resources", exe),
      p.join("/Applications/Ollama.app/Contents/MacOS", exe),
    );
    if (env.HOME) {
      candidates.push(
        p.join(env.HOME, "Applications/Ollama.app/Contents/Resources", exe),
        p.join(env.HOME, "Applications/Ollama.app/Contents/MacOS", exe),
      );
    }
  } else if (isWindows) {
    if (env.LOCALAPPDATA) {
      candidates.push(p.join(env.LOCALAPPDATA, "Programs", "Ollama", exe));
    }
    if (env.ProgramFiles) {
      candidates.push(p.join(env.ProgramFiles, "Ollama", exe));
    }
  } else {
    // Linux: `resolveAsset` refuses to auto-install here, but an Ollama the user
    // installed themselves works perfectly well — so look for it rather than
    // dead-ending them.
    candidates.push(p.join("/usr/local/bin", exe), p.join("/usr/bin", exe));
  }

  // PATH last: an install in a known location is a stronger signal than
  // whatever a shell happens to expose. Windows uses `;`, everyone else `:` —
  // taken from the requested platform, not the host's `path.delimiter`.
  const pathVar = env.PATH ?? env.Path;
  if (pathVar) {
    for (const dir of pathVar.split(isWindows ? ";" : ":")) {
      if (dir.trim()) candidates.push(p.join(dir, exe));
    }
  }

  return [...new Set(candidates)];
}

/** The directory our managed engine lives in, under Electron's userData. */
export function ollamaDir(): string {
  return join(app.getPath("userData"), "ollama");
}

/** Where the extracted engine binary is expected. Callers should still tolerate
 * an archive that nests it a level deeper (see `findExecutable` in runtime). */
export function binaryPath(
  platform: NodeJS.Platform = process.platform,
): string {
  return join(ollamaDir(), platform === "win32" ? "ollama.exe" : "ollama");
}

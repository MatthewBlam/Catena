import { join } from "node:path";
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

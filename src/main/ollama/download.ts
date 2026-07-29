import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname } from "node:path";

const execFileAsync = promisify(execFile);

export interface DownloadProgress {
  bytesCompleted: number;
  /** From Content-Length; undefined when the server didn't send one. */
  bytesTotal?: number;
  /** 0..100 when total is known. */
  percent?: number;
}

/**
 * Streams `url` to `destPath`, reporting byte progress. Writes to a `.part`
 * sibling first and renames on success, so an interrupted download never leaves
 * a truncated file that a later run would mistake for complete. Cleans up the
 * partial on any failure/abort.
 */
export async function downloadWithProgress(
  url: string,
  destPath: string,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true });
  const partPath = `${destPath}.part`;
  await rm(partPath, { force: true });

  const res = await fetch(url, { signal, redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (HTTP ${res.status}) for ${url}`);
  }

  const total = Number(res.headers.get("content-length")) || 0;
  const out = createWriteStream(partPath);
  const reader = res.body.getReader();
  let completed = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // The fetch signal already errors `read()` on abort, but check too so we
      // stop writing promptly if a caller aborts between reads.
      if (signal?.aborted) throw signal.reason ?? new Error("Download aborted");
      if (!out.write(value)) await once(out, "drain");
      completed += value.byteLength;
      onProgress({
        bytesCompleted: completed,
        bytesTotal: total || undefined,
        percent: total
          ? Math.min(100, Math.floor((completed / total) * 100))
          : undefined,
      });
    }
    out.end();
    await once(out, "finish");
  } catch (err) {
    out.destroy();
    await rm(partPath, { force: true });
    throw err;
  }

  // Atomic-ish swap into place. `rm` first because rename onto an existing file
  // is not portable on Windows.
  await rm(destPath, { force: true });
  const { rename } = await import("node:fs/promises");
  await rename(partPath, destPath);
}

/**
 * Extracts `archivePath` (a `.tgz` or `.zip`) into `destDir` using the system
 * `tar`. bsdtar ships on macOS and on Windows 10 1803+ and auto-detects both
 * formats, so one command covers every target and avoids a bundled unzip dep.
 */
export async function extractArchive(
  archivePath: string,
  destDir: string,
): Promise<void> {
  await mkdir(destDir, { recursive: true });
  try {
    await execFileAsync("tar", ["-xf", archivePath, "-C", destDir]);
  } catch (err) {
    throw new Error(
      `Failed to extract ${archivePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

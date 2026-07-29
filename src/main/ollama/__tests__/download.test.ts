import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// download.ts calls `promisify(execFile)`, so the mocked execFile must invoke
// its callback node-style: cb(err, stdout, stderr).
const h = vi.hoisted(() => ({
  execFile: vi.fn(
    (
      _cmd: string,
      _args: string[],
      cb: (e: unknown, o: string, s: string) => void,
    ) => cb(null, "", ""),
  ),
}));
vi.mock("node:child_process", () => ({ execFile: h.execFile }));

import { downloadWithProgress, extractArchive } from "../download";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "commons-dl-"));
  h.execFile.mockReset();
  h.execFile.mockImplementation((_cmd, _args, cb) => cb(null, "", ""));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

/** A web ReadableStream that emits `chunks` then closes. */
function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      chunks.forEach((ch) => c.enqueue(ch));
      c.close();
    },
  });
}

describe("downloadWithProgress", () => {
  it("streams the body to disk and reports increasing progress to 100%", async () => {
    const chunks = [
      new Uint8Array([1, 2, 3, 4, 5]),
      new Uint8Array([6, 7, 8, 9, 10]),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: {
          get: (hdr: string) =>
            hdr.toLowerCase() === "content-length" ? "10" : null,
        },
        body: streamOf(chunks),
      })),
    );

    const dest = join(tmp, "out.bin");
    const progress: { bytesCompleted: number; percent?: number }[] = [];
    await downloadWithProgress("https://example/x", dest, (p) =>
      progress.push({ ...p }),
    );

    expect(existsSync(dest)).toBe(true);
    const written = readFileSync(dest);
    expect(written.length).toBe(10);
    expect([...written]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // Progress is monotonically non-decreasing and lands exactly on total.
    expect(progress.length).toBe(2);
    const bytes = progress.map((p) => p.bytesCompleted);
    expect(bytes).toEqual([5, 10]);
    for (let i = 1; i < bytes.length; i++)
      expect(bytes[i]).toBeGreaterThan(bytes[i - 1]);
    expect(progress.at(-1)!.percent).toBe(100);
  });

  it("rejects on a non-ok response and writes no destination file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        headers: { get: () => null },
        body: null,
      })),
    );

    const dest = join(tmp, "nope.bin");
    await expect(
      downloadWithProgress("https://example/fail", dest, () => {}),
    ).rejects.toThrow(/HTTP 500/);
    expect(existsSync(dest)).toBe(false);
  });
});

describe("extractArchive", () => {
  it("invokes system tar with -xf and the archive/dest paths", async () => {
    const archive = join(tmp, "engine.tgz");
    const dest = join(tmp, "extracted");
    await extractArchive(archive, dest);

    expect(h.execFile).toHaveBeenCalledTimes(1);
    expect(h.execFile).toHaveBeenCalledWith(
      "tar",
      ["-xf", archive, "-C", dest],
      expect.any(Function),
    );
  });

  it("rejects with a wrapped message when tar fails", async () => {
    h.execFile.mockImplementation((_cmd, _args, cb) =>
      cb(new Error("tar: broken archive"), "", ""),
    );
    const archive = join(tmp, "bad.tgz");
    const dest = join(tmp, "out");

    await expect(extractArchive(archive, dest)).rejects.toThrow(
      /Failed to extract .*bad\.tgz: .*tar: broken archive/,
    );
  });
});

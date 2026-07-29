import { describe, it, expect } from "vitest";
import { resolveAsset, OLLAMA_VERSION } from "../platform";

describe("resolveAsset", () => {
  it("returns the universal darwin tgz on arm64", () => {
    const asset = resolveAsset("darwin", "arm64");
    expect(asset.archiveName).toBe("ollama-darwin.tgz");
    expect(asset.url).toContain(OLLAMA_VERSION);
    expect(asset.url).toContain("ollama-darwin.tgz");
  });

  it("returns the same universal darwin tgz on x64", () => {
    const asset = resolveAsset("darwin", "x64");
    expect(asset.archiveName).toBe("ollama-darwin.tgz");
    expect(asset.url).toContain(OLLAMA_VERSION);
  });

  it("returns the amd64 zip for windows x64", () => {
    const asset = resolveAsset("win32", "x64");
    expect(asset.archiveName).toBe("ollama-windows-amd64.zip");
    expect(asset.url).toContain(OLLAMA_VERSION);
    expect(asset.url).toContain("ollama-windows-amd64.zip");
  });

  it("returns the arm64 zip for windows arm64", () => {
    const asset = resolveAsset("win32", "arm64");
    expect(asset.archiveName).toBe("ollama-windows-arm64.zip");
    expect(asset.url).toContain("ollama-windows-arm64.zip");
  });

  it("builds the URL from the pinned OLLAMA_VERSION", () => {
    const asset = resolveAsset("darwin", "arm64");
    expect(asset.url).toBe(
      `https://github.com/ollama/ollama/releases/download/${OLLAMA_VERSION}/ollama-darwin.tgz`,
    );
  });

  it("throws on an unsupported platform", () => {
    expect(() => resolveAsset("linux", "x64")).toThrow(
      /not supported on linux/,
    );
  });
});

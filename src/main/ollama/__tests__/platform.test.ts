import { describe, it, expect } from "vitest";
import {
  ollamaExecutableName,
  systemInstallCandidates,
  resolveAsset,
  OLLAMA_VERSION,
} from "../platform";

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

describe("ollamaExecutableName", () => {
  it("uses the .exe suffix only on Windows", () => {
    expect(ollamaExecutableName("darwin")).toBe("ollama");
    expect(ollamaExecutableName("linux")).toBe("ollama");
    expect(ollamaExecutableName("win32")).toBe("ollama.exe");
  });
});

describe("systemInstallCandidates", () => {
  it("covers the standard macOS install locations", () => {
    const found = systemInstallCandidates("darwin", { HOME: "/Users/ada" });

    expect(found).toContain("/usr/local/bin/ollama");
    expect(found).toContain("/opt/homebrew/bin/ollama");
    expect(found).toContain(
      "/Applications/Ollama.app/Contents/Resources/ollama",
    );
    // The official app has moved the CLI between these two across versions.
    expect(found).toContain("/Applications/Ollama.app/Contents/MacOS/ollama");
    expect(found).toContain(
      "/Users/ada/Applications/Ollama.app/Contents/Resources/ollama",
    );
  });

  it("covers the standard Windows install locations, with backslashes", () => {
    const found = systemInstallCandidates("win32", {
      LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local",
      ProgramFiles: "C:\\Program Files",
    });

    expect(found).toContain(
      "C:\\Users\\Ada\\AppData\\Local\\Programs\\Ollama\\ollama.exe",
    );
    expect(found).toContain("C:\\Program Files\\Ollama\\ollama.exe");
  });

  it("splits PATH on the platform's own delimiter", () => {
    // Not the *host* delimiter: these must be right when the tests run on the
    // other OS, which is the whole reason the platform is a parameter.
    expect(
      systemInstallCandidates("win32", { PATH: "C:\\bin;D:\\tools" }),
    ).toEqual(
      expect.arrayContaining(["C:\\bin\\ollama.exe", "D:\\tools\\ollama.exe"]),
    );
    expect(
      systemInstallCandidates("darwin", { PATH: "/usr/bin:/sbin" }),
    ).toEqual(expect.arrayContaining(["/usr/bin/ollama", "/sbin/ollama"]));
  });

  it("prefers explicit install locations over whatever is on PATH", () => {
    const found = systemInstallCandidates("darwin", {
      PATH: "/somewhere/else",
    });
    expect(found.indexOf("/usr/local/bin/ollama")).toBeLessThan(
      found.indexOf("/somewhere/else/ollama"),
    );
  });

  it("still finds a Linux install, even though we cannot download one there", () => {
    // `resolveAsset` refuses to auto-install on Linux, but a user who installed
    // Ollama themselves should still be usable rather than blocked.
    const found = systemInstallCandidates("linux", { PATH: "/usr/local/bin" });
    expect(found).toContain("/usr/local/bin/ollama");
    expect(found).toContain("/usr/bin/ollama");
  });

  it("tolerates a completely empty environment", () => {
    expect(() => systemInstallCandidates("win32", {})).not.toThrow();
    expect(() => systemInstallCandidates("darwin", {})).not.toThrow();
  });

  it("never returns duplicates", () => {
    const found = systemInstallCandidates("darwin", {
      PATH: "/usr/local/bin:/usr/local/bin",
    });
    expect(new Set(found).size).toBe(found.length);
  });
});

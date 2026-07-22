import { describe, it, expect, vi, beforeEach } from "vitest";
import type { drive_v3 } from "@googleapis/drive";
import { DriveConnector, extractFolderIdFromUrl } from "../drive";
import type { GoogleOAuth2Client } from "../../auth/google-oauth";
import type {
  Connector,
  RawDocument,
  SyncWalkResult,
} from "../../sync/sync-manager";

/** Runs a walk to completion and hands back what the connector reported about it. */
async function drainWalk(
  connector: Connector,
  knownDocs?: Map<string, string>,
): Promise<SyncWalkResult> {
  const gen = connector.fetchDocuments(undefined, knownDocs);
  for (;;) {
    const next = await gen.next();
    if (next.done) return next.value;
  }
}

/** DriveConnector only forwards this to `new drive_v3.Drive({ auth })`, which is mocked below. */
const fakeAuth = {} as unknown as GoogleOAuth2Client;

const mockFilesList = vi.fn();
const mockFilesGet = vi.fn();
const mockFilesExport = vi.fn();

vi.mock("@googleapis/drive", () => ({
  drive_v3: {
    Drive: function () {
      return {
        files: {
          list: mockFilesList,
          get: mockFilesGet,
          export: mockFilesExport,
        },
      };
    },
  },
}));

const mockGetText = vi.fn();
const mockDestroy = vi.fn();

vi.mock("pdf-parse", () => ({
  PDFParse: function () {
    return { getText: mockGetText, destroy: mockDestroy };
  },
}));

vi.mock("mammoth", () => ({
  extractRawText: vi.fn(),
}));

function makeDriveFile(
  overrides: Record<string, unknown> = {},
): drive_v3.Schema$File {
  return {
    id: "file-1",
    name: "Test Doc",
    mimeType: "application/vnd.google-apps.document",
    modifiedTime: "2025-06-01T00:00:00.000Z",
    webViewLink: "https://docs.google.com/document/d/file-1",
    size: "1024",
    ...overrides,
  };
}

describe("extractFolderIdFromUrl", () => {
  it("extracts folder ID from standard URL", () => {
    expect(
      extractFolderIdFromUrl(
        "https://drive.google.com/drive/folders/1abc2def3ghi",
      ),
    ).toBe("1abc2def3ghi");
  });

  it("extracts folder ID from URL with user path", () => {
    expect(
      extractFolderIdFromUrl(
        "https://drive.google.com/drive/u/0/folders/1abc2def3ghi",
      ),
    ).toBe("1abc2def3ghi");
  });

  it("handles folder ID with hyphens and underscores", () => {
    expect(
      extractFolderIdFromUrl(
        "https://drive.google.com/drive/folders/1a-b_c2d-ef",
      ),
    ).toBe("1a-b_c2d-ef");
  });

  it("returns null for non-folder URLs", () => {
    expect(
      extractFolderIdFromUrl("https://drive.google.com/file/d/file-id"),
    ).toBeNull();
  });

  it("returns null for invalid URLs", () => {
    expect(extractFolderIdFromUrl("not a url")).toBeNull();
  });
});

describe("DriveConnector", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("yields a document from a Google Doc", async () => {
    mockFilesList.mockResolvedValue({
      data: {
        files: [makeDriveFile()],
        nextPageToken: undefined,
      },
    });
    mockFilesExport.mockResolvedValue({
      data: "Hello from Google Docs",
    });

    const connector = new DriveConnector(fakeAuth, "folder-1");
    const docs: RawDocument[] = [];
    for await (const doc of connector.fetchDocuments()) {
      docs.push(doc);
    }

    expect(docs).toHaveLength(1);
    expect(docs[0].externalId).toBe("file-1");
    expect(docs[0].title).toBe("Test Doc");
    expect(docs[0].content).toBe("Hello from Google Docs");
    expect(docs[0].mimeType).toBe("application/vnd.google-apps.document");
  });

  it("recursively walks subfolders", async () => {
    mockFilesList
      .mockResolvedValueOnce({
        data: {
          files: [
            makeDriveFile({
              id: "subfolder",
              name: "Subfolder",
              mimeType: "application/vnd.google-apps.folder",
            }),
          ],
          nextPageToken: undefined,
        },
      })
      .mockResolvedValueOnce({
        data: {
          files: [makeDriveFile({ id: "nested-doc", name: "Nested Doc" })],
          nextPageToken: undefined,
        },
      });

    mockFilesExport.mockResolvedValue({ data: "Nested content" });

    const connector = new DriveConnector(fakeAuth, "root-folder");
    const docs: RawDocument[] = [];
    for await (const doc of connector.fetchDocuments()) {
      docs.push(doc);
    }

    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe("Nested Doc");
    expect(mockFilesList).toHaveBeenCalledTimes(2);
  });

  it("paginates file listing", async () => {
    mockFilesList
      .mockResolvedValueOnce({
        data: {
          files: [makeDriveFile({ id: "doc-1", name: "Doc 1" })],
          nextPageToken: "page-2",
        },
      })
      .mockResolvedValueOnce({
        data: {
          files: [makeDriveFile({ id: "doc-2", name: "Doc 2" })],
          nextPageToken: undefined,
        },
      });

    mockFilesExport
      .mockResolvedValueOnce({ data: "Content 1" })
      .mockResolvedValueOnce({ data: "Content 2" });

    const connector = new DriveConnector(fakeAuth, "folder-1");
    const docs: RawDocument[] = [];
    for await (const doc of connector.fetchDocuments()) {
      docs.push(doc);
    }

    expect(docs).toHaveLength(2);
    expect(docs[0].title).toBe("Doc 1");
    expect(docs[1].title).toBe("Doc 2");
  });

  it("exports Google Sheets as CSV", async () => {
    mockFilesList.mockResolvedValue({
      data: {
        files: [
          makeDriveFile({
            id: "sheet-1",
            mimeType: "application/vnd.google-apps.spreadsheet",
            name: "Budget Sheet",
          }),
        ],
        nextPageToken: undefined,
      },
    });
    mockFilesExport.mockResolvedValue({ data: "Name,Amount\nAlice,100" });

    const connector = new DriveConnector(fakeAuth, "folder-1");
    const docs: RawDocument[] = [];
    for await (const doc of connector.fetchDocuments()) {
      docs.push(doc);
    }

    expect(docs).toHaveLength(1);
    expect(docs[0].content).toBe("Name,Amount\nAlice,100");
    expect(mockFilesExport).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: "text/csv" }),
    );
  });

  it("exports Google Slides as plain text", async () => {
    mockFilesList.mockResolvedValue({
      data: {
        files: [
          makeDriveFile({
            id: "slides-1",
            mimeType: "application/vnd.google-apps.presentation",
            name: "Meeting Slides",
          }),
        ],
        nextPageToken: undefined,
      },
    });
    mockFilesExport.mockResolvedValue({ data: "Slide 1 content" });

    const connector = new DriveConnector(fakeAuth, "folder-1");
    const docs: RawDocument[] = [];
    for await (const doc of connector.fetchDocuments()) {
      docs.push(doc);
    }

    expect(docs).toHaveLength(1);
    expect(docs[0].content).toBe("Slide 1 content");
  });

  it("reads plain text files via media download", async () => {
    mockFilesList.mockResolvedValue({
      data: {
        files: [
          makeDriveFile({
            id: "txt-1",
            mimeType: "text/plain",
            name: "notes.txt",
          }),
        ],
        nextPageToken: undefined,
      },
    });
    mockFilesGet.mockResolvedValue({ data: "Plain text notes" });

    const connector = new DriveConnector(fakeAuth, "folder-1");
    const docs: RawDocument[] = [];
    for await (const doc of connector.fetchDocuments()) {
      docs.push(doc);
    }

    expect(docs).toHaveLength(1);
    expect(docs[0].content).toBe("Plain text notes");
  });

  it("reads markdown files via media download", async () => {
    mockFilesList.mockResolvedValue({
      data: {
        files: [
          makeDriveFile({
            id: "md-1",
            mimeType: "text/markdown",
            name: "README.md",
          }),
        ],
        nextPageToken: undefined,
      },
    });
    mockFilesGet.mockResolvedValue({ data: "# Hello\nWorld" });

    const connector = new DriveConnector(fakeAuth, "folder-1");
    const docs: RawDocument[] = [];
    for await (const doc of connector.fetchDocuments()) {
      docs.push(doc);
    }

    expect(docs).toHaveLength(1);
    expect(docs[0].content).toBe("# Hello\nWorld");
  });

  it("skips files larger than 50MB", async () => {
    mockFilesList.mockResolvedValue({
      data: {
        files: [
          makeDriveFile({
            id: "big-file",
            size: String(60 * 1024 * 1024),
            name: "huge.pdf",
            mimeType: "application/pdf",
          }),
        ],
        nextPageToken: undefined,
      },
    });

    const connector = new DriveConnector(fakeAuth, "folder-1");
    const docs: RawDocument[] = [];
    for await (const doc of connector.fetchDocuments()) {
      docs.push(doc);
    }

    expect(docs).toHaveLength(0);
  });

  it("skips unsupported file types", async () => {
    mockFilesList.mockResolvedValue({
      data: {
        files: [
          makeDriveFile({
            id: "img-1",
            mimeType: "image/png",
            name: "photo.png",
          }),
        ],
        nextPageToken: undefined,
      },
    });

    const connector = new DriveConnector(fakeAuth, "folder-1");
    const docs: RawDocument[] = [];
    for await (const doc of connector.fetchDocuments()) {
      docs.push(doc);
    }

    expect(docs).toHaveLength(0);
  });

  /**
   * Same blind spot as Notion's: a supported file whose text was deleted exports
   * as "", and treating that as "nothing to index" left its old chunks in place
   * forever. An empty *supported* file is a content change; only an unsupported
   * type is a non-document.
   */
  it("yields supported files that are now empty so their chunks can be cleared", async () => {
    mockFilesList.mockResolvedValue({
      data: {
        files: [makeDriveFile()],
        nextPageToken: undefined,
      },
    });
    mockFilesExport.mockResolvedValue({ data: "" });

    const connector = new DriveConnector(fakeAuth, "folder-1");
    const docs: RawDocument[] = [];
    for await (const doc of connector.fetchDocuments()) {
      docs.push(doc);
    }

    expect(docs).toHaveLength(1);
    expect(docs[0].content).toBe("");
  });

  /**
   * A transient empty export (200-with-empty-body flake) is indistinguishable
   * from a genuine emptying at the first call. Retrying once, same file, same
   * method, and trusting the second result recovers from the flake instead of
   * wiping the document's chunks and then never re-checking it (the doc would
   * re-enter the incremental-skip map keyed to the unchanged modifiedTime).
   */
  it("retries once when export returns empty, then yields the retried content", async () => {
    mockFilesList.mockResolvedValue({
      data: {
        files: [makeDriveFile()],
        nextPageToken: undefined,
      },
    });
    mockFilesExport
      .mockResolvedValueOnce({ data: "" })
      .mockResolvedValueOnce({ data: "hello" });

    const connector = new DriveConnector(fakeAuth, "folder-1");
    const docs: RawDocument[] = [];
    for await (const doc of connector.fetchDocuments()) {
      docs.push(doc);
    }

    expect(docs).toHaveLength(1);
    expect(docs[0].content).toBe("hello");
    expect(mockFilesExport).toHaveBeenCalledTimes(2);
  });

  /**
   * Symmetric with the case above: if the retry *also* comes back empty, that's
   * no longer a flake — it's a genuinely emptied document, and the empty content
   * must still propagate so the doc's stale chunks get cleared.
   */
  it("treats two consecutive empty exports as a genuine emptied document", async () => {
    mockFilesList.mockResolvedValue({
      data: {
        files: [makeDriveFile()],
        nextPageToken: undefined,
      },
    });
    mockFilesExport
      .mockResolvedValueOnce({ data: "" })
      .mockResolvedValueOnce({ data: "" });

    const connector = new DriveConnector(fakeAuth, "folder-1");
    const docs: RawDocument[] = [];
    for await (const doc of connector.fetchDocuments()) {
      docs.push(doc);
    }

    expect(docs).toHaveLength(1);
    expect(docs[0].content).toBe("");
    expect(mockFilesExport).toHaveBeenCalledTimes(2);
  });

  /** The retry must only fire on an empty result, not on every happy-path file. */
  it("does not retry when the first export already returns content", async () => {
    mockFilesList.mockResolvedValue({
      data: {
        files: [makeDriveFile()],
        nextPageToken: undefined,
      },
    });
    mockFilesExport.mockResolvedValue({ data: "Hello from Google Docs" });

    const connector = new DriveConnector(fakeAuth, "folder-1");
    const docs: RawDocument[] = [];
    for await (const doc of connector.fetchDocuments()) {
      docs.push(doc);
    }

    expect(docs).toHaveLength(1);
    expect(docs[0].content).toBe("Hello from Google Docs");
    expect(mockFilesExport).toHaveBeenCalledTimes(1);
  });

  it("handles PDF files", async () => {
    mockFilesList.mockResolvedValue({
      data: {
        files: [
          makeDriveFile({
            id: "pdf-1",
            mimeType: "application/pdf",
            name: "report.pdf",
          }),
        ],
        nextPageToken: undefined,
      },
    });

    const pdfBuffer = new ArrayBuffer(16);
    mockFilesGet.mockResolvedValue({ data: pdfBuffer });
    mockGetText.mockResolvedValue({ text: "Extracted PDF text" });

    const connector = new DriveConnector(fakeAuth, "folder-1");
    const docs: RawDocument[] = [];
    for await (const doc of connector.fetchDocuments()) {
      docs.push(doc);
    }

    expect(docs).toHaveLength(1);
    expect(docs[0].content).toBe("Extracted PDF text");
    expect(mockDestroy).toHaveBeenCalled();
  });

  it("skips files that fail content extraction and continues", async () => {
    mockFilesList.mockResolvedValue({
      data: {
        files: [
          makeDriveFile({ id: "bad-doc", name: "Corrupt Doc" }),
          makeDriveFile({ id: "good-doc", name: "Good Doc" }),
        ],
        nextPageToken: undefined,
      },
    });

    mockFilesExport
      .mockRejectedValueOnce(new Error("Export failed"))
      .mockResolvedValueOnce({ data: "Good content" });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const connector = new DriveConnector(fakeAuth, "folder-1");
    const docs: RawDocument[] = [];
    for await (const doc of connector.fetchDocuments()) {
      docs.push(doc);
    }

    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe("Good Doc");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Corrupt Doc"),
    );
    warnSpy.mockRestore();
  });

  it("stops recursion at MAX_DEPTH (20)", async () => {
    let depth = 0;
    mockFilesList.mockImplementation(() => {
      depth++;
      return Promise.resolve({
        data: {
          files: [
            makeDriveFile({
              id: `folder-${depth}`,
              name: `Folder ${depth}`,
              mimeType: "application/vnd.google-apps.folder",
            }),
          ],
          nextPageToken: undefined,
        },
      });
    });

    const connector = new DriveConnector(fakeAuth, "root-folder");
    const docs: RawDocument[] = [];
    for await (const doc of connector.fetchDocuments()) {
      docs.push(doc);
    }

    expect(docs).toHaveLength(0);
    expect(mockFilesList.mock.calls.length).toBeLessThanOrEqual(21);
  });

  it("detects folder cycles via visited set", async () => {
    mockFilesList
      .mockResolvedValueOnce({
        data: {
          files: [
            makeDriveFile({
              id: "folder-a",
              name: "Folder A",
              mimeType: "application/vnd.google-apps.folder",
            }),
          ],
          nextPageToken: undefined,
        },
      })
      .mockResolvedValueOnce({
        data: {
          files: [
            makeDriveFile({
              id: "root-folder",
              name: "Root (cycle)",
              mimeType: "application/vnd.google-apps.folder",
            }),
          ],
          nextPageToken: undefined,
        },
      });

    const connector = new DriveConnector(fakeAuth, "root-folder");
    const docs: RawDocument[] = [];
    for await (const doc of connector.fetchDocuments()) {
      docs.push(doc);
    }

    expect(docs).toHaveLength(0);
    expect(mockFilesList).toHaveBeenCalledTimes(2);
  });

  it("handles DOCX files", async () => {
    const mammoth = await import("mammoth");

    mockFilesList.mockResolvedValue({
      data: {
        files: [
          makeDriveFile({
            id: "docx-1",
            mimeType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            name: "report.docx",
          }),
        ],
        nextPageToken: undefined,
      },
    });

    const docxBuffer = new ArrayBuffer(16);
    mockFilesGet.mockResolvedValue({ data: docxBuffer });

    (mammoth.extractRawText as ReturnType<typeof vi.fn>).mockResolvedValue({
      value: "Extracted DOCX text",
      messages: [],
    });

    const connector = new DriveConnector(fakeAuth, "folder-1");
    const docs: RawDocument[] = [];
    for await (const doc of connector.fetchDocuments()) {
      docs.push(doc);
    }

    expect(docs).toHaveLength(1);
    expect(docs[0].content).toBe("Extracted DOCX text");
  });
});

describe("DriveConnector walk result", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  /**
   * The whole point of the seen-set. Reconciliation deletes whatever the walk did
   * not see, so a file we merely *declined to index* — too big, unparseable, or
   * unchanged since last sync — must still be reported. Recording it after the
   * skips instead of before would quietly delete every oversized PDF the user has.
   */
  it("reports files it skipped, because a skipped file still exists", async () => {
    mockFilesList.mockResolvedValue({
      data: {
        files: [
          makeDriveFile({ id: "too-big", size: String(60 * 1024 * 1024) }),
          makeDriveFile({ id: "unsupported", mimeType: "image/png" }),
          makeDriveFile({ id: "unparseable" }),
          makeDriveFile({ id: "unchanged" }),
          makeDriveFile({ id: "indexed" }),
        ],
        nextPageToken: undefined,
      },
    });
    mockFilesExport.mockImplementation(({ fileId }: { fileId: string }) => {
      if (fileId === "unparseable") return Promise.reject(new Error("boom"));
      return Promise.resolve({ data: "Some content" });
    });

    const knownDocs = new Map([["unchanged", "2025-06-01T00:00:00.000Z"]]);
    const connector = new DriveConnector(fakeAuth, "folder-1");

    const docs: RawDocument[] = [];
    const gen = connector.fetchDocuments(undefined, knownDocs);
    let walk: SyncWalkResult;
    for (;;) {
      const next = await gen.next();
      if (next.done) {
        walk = next.value;
        break;
      }
      docs.push(next.value);
    }

    expect(docs.map((d) => d.externalId)).toEqual(["indexed"]);
    expect([...walk.seenExternalIds].sort()).toEqual([
      "indexed",
      "too-big",
      "unchanged",
      "unparseable",
      "unsupported",
    ]);
    expect(walk.complete).toBe(true);
  });

  it("marks the walk incomplete when the depth cap prunes a subtree", async () => {
    // Every folder contains one more folder, forever — so the cap always bites.
    let n = 0;
    mockFilesList.mockImplementation(() =>
      Promise.resolve({
        data: {
          files: [
            makeDriveFile({
              id: `folder-${++n}`,
              mimeType: "application/vnd.google-apps.folder",
            }),
          ],
          nextPageToken: undefined,
        },
      }),
    );

    const walk = await drainWalk(new DriveConnector(fakeAuth, "root"));

    expect(walk.complete).toBe(false);
  });
});

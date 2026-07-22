import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  BlockObjectResponse,
  PageObjectResponse,
  RichTextItemResponse,
} from "@notionhq/client/build/src/api-endpoints";
import {
  blocksToText,
  extractPageTitle,
  listNotionItems,
  NotionConnector,
} from "../notion";
import type { Connector, SyncWalkResult } from "../../sync/sync-manager";

/** Runs a walk to completion and hands back what the connector reported about it. */
async function drainWalk(
  connector: Connector,
  signal?: AbortSignal,
): Promise<SyncWalkResult> {
  const gen = connector.fetchDocuments(signal);
  for (;;) {
    const next = await gen.next();
    if (next.done) return next.value;
  }
}

function makeRichText(text: string): RichTextItemResponse[] {
  return [
    {
      type: "text" as const,
      text: { content: text, link: null },
      plain_text: text,
      annotations: {
        bold: false,
        italic: false,
        strikethrough: false,
        underline: false,
        code: false,
        color: "default" as const,
      },
      href: null,
    },
  ];
}

function makeBlock(
  type: string,
  content: Record<string, unknown>,
): BlockObjectResponse {
  return {
    id: crypto.randomUUID(),
    type,
    [type]: content,
    parent: { type: "page_id", page_id: "parent" },
    created_time: "2025-01-01T00:00:00.000Z",
    last_edited_time: "2025-01-01T00:00:00.000Z",
    created_by: { id: "user", object: "user" },
    last_edited_by: { id: "user", object: "user" },
    has_children: false,
    archived: false,
    in_trash: false,
    object: "block",
  } as unknown as BlockObjectResponse;
}

function makePage(
  id: string,
  title: string,
  url: string | null = null,
): PageObjectResponse {
  return {
    id,
    object: "page",
    url: url ?? `https://notion.so/${id}`,
    properties: {
      title: {
        id: "title",
        type: "title",
        title: makeRichText(title),
      },
    },
    parent: { type: "workspace", workspace: true },
    created_time: "2025-01-01T00:00:00.000Z",
    last_edited_time: "2025-01-01T00:00:00.000Z",
    created_by: { id: "user", object: "user" },
    last_edited_by: { id: "user", object: "user" },
    icon: null,
    cover: null,
    archived: false,
    in_trash: false,
    public_url: null,
  } as unknown as PageObjectResponse;
}

describe("blocksToText", () => {
  it("converts paragraph blocks", () => {
    const blocks = [
      makeBlock("paragraph", { rich_text: makeRichText("Hello world") }),
    ];
    expect(blocksToText(blocks)).toBe("Hello world");
  });

  it("converts heading blocks with markdown markers", () => {
    const blocks = [
      makeBlock("heading_1", { rich_text: makeRichText("Title") }),
      makeBlock("heading_2", { rich_text: makeRichText("Subtitle") }),
      makeBlock("heading_3", { rich_text: makeRichText("Section") }),
    ];
    expect(blocksToText(blocks)).toBe("# Title\n## Subtitle\n### Section");
  });

  it("converts list items", () => {
    const blocks = [
      makeBlock("bulleted_list_item", { rich_text: makeRichText("Bullet") }),
      makeBlock("numbered_list_item", { rich_text: makeRichText("Number") }),
    ];
    expect(blocksToText(blocks)).toBe("- Bullet\n1. Number");
  });

  it("converts code blocks with fences", () => {
    const blocks = [
      makeBlock("code", {
        rich_text: makeRichText("const x = 1;"),
        language: "javascript",
      }),
    ];
    expect(blocksToText(blocks)).toBe("```\nconst x = 1;\n```");
  });

  it("converts quote blocks", () => {
    const blocks = [makeBlock("quote", { rich_text: makeRichText("A quote") })];
    expect(blocksToText(blocks)).toBe("> A quote");
  });

  it("converts to_do blocks", () => {
    const blocks = [
      makeBlock("to_do", { rich_text: makeRichText("Done"), checked: true }),
      makeBlock("to_do", {
        rich_text: makeRichText("Not done"),
        checked: false,
      }),
    ];
    expect(blocksToText(blocks)).toBe("[x] Done\n[ ] Not done");
  });

  it("converts callout blocks", () => {
    const blocks = [
      makeBlock("callout", { rich_text: makeRichText("Important note") }),
    ];
    expect(blocksToText(blocks)).toBe("Important note");
  });

  it("converts toggle blocks", () => {
    const blocks = [
      makeBlock("toggle", { rich_text: makeRichText("Toggle heading") }),
    ];
    expect(blocksToText(blocks)).toBe("Toggle heading");
  });

  it("converts divider blocks", () => {
    const blocks = [makeBlock("divider", {})];
    expect(blocksToText(blocks)).toBe("---");
  });

  it("converts table_row blocks", () => {
    const blocks = [
      makeBlock("table_row", {
        cells: [makeRichText("Col A"), makeRichText("Col B")],
      }),
    ];
    expect(blocksToText(blocks)).toBe("Col A | Col B");
  });

  it("skips unsupported block types", () => {
    const blocks = [
      makeBlock("paragraph", { rich_text: makeRichText("Text") }),
      makeBlock("image", {
        type: "external",
        external: { url: "https://img.png" },
      }),
      makeBlock("paragraph", { rich_text: makeRichText("More text") }),
    ];
    expect(blocksToText(blocks)).toBe("Text\nMore text");
  });

  it("handles mixed block types", () => {
    const blocks = [
      makeBlock("heading_1", { rich_text: makeRichText("Introduction") }),
      makeBlock("paragraph", { rich_text: makeRichText("Welcome.") }),
      makeBlock("bulleted_list_item", { rich_text: makeRichText("Item 1") }),
      makeBlock("bulleted_list_item", { rich_text: makeRichText("Item 2") }),
      makeBlock("divider", {}),
      makeBlock("quote", { rich_text: makeRichText("A wise quote") }),
    ];
    expect(blocksToText(blocks)).toBe(
      "# Introduction\nWelcome.\n- Item 1\n- Item 2\n---\n> A wise quote",
    );
  });

  it("returns empty string for empty block list", () => {
    expect(blocksToText([])).toBe("");
  });
});

describe("extractPageTitle", () => {
  it("extracts title from page properties", () => {
    const page = makePage("p1", "My Page Title");
    expect(extractPageTitle(page)).toBe("My Page Title");
  });

  it("returns Untitled when no title property", () => {
    const page = makePage("p1", "");
    page.properties = {
      name: { id: "n", type: "rich_text", rich_text: [] },
    } as unknown as PageObjectResponse["properties"];
    expect(extractPageTitle(page)).toBe("Untitled");
  });
});

const mockClient = {
  pages: {
    retrieve: vi.fn(),
  },
  blocks: {
    children: {
      list: vi.fn(),
    },
  },
  databases: {
    retrieve: vi.fn(),
  },
  dataSources: {
    query: vi.fn(),
  },
  search: vi.fn(),
};

vi.mock("@notionhq/client", () => {
  const isRecord = (obj: unknown): obj is Record<string, unknown> =>
    typeof obj === "object" && obj !== null;

  return {
    Client: function () {
      return mockClient;
    },
    isFullPage: (obj: unknown): boolean =>
      isRecord(obj) && obj.object === "page" && "url" in obj,
    isFullDatabase: (obj: unknown): boolean =>
      isRecord(obj) && obj.object === "database" && "data_sources" in obj,
    isFullDataSource: (obj: unknown): boolean =>
      isRecord(obj) && obj.object === "data_source" && "title" in obj,
    LogLevel: { DEBUG: "debug", INFO: "info", WARN: "warn", ERROR: "error" },
  };
});

describe("NotionConnector", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("yields a document from a single page", async () => {
    mockClient.pages.retrieve.mockResolvedValue(makePage("root", "Root Page"));
    mockClient.blocks.children.list.mockResolvedValue({
      results: [
        makeBlock("paragraph", {
          rich_text: makeRichText("Page content here."),
        }),
      ],
      has_more: false,
      next_cursor: null,
    });

    const connector = new NotionConnector("test-token", "root", 0);
    const docs: import("../../sync/sync-manager").RawDocument[] = [];
    for await (const doc of connector.fetchDocuments()) {
      docs.push(doc);
    }

    expect(docs).toHaveLength(1);
    expect(docs[0].externalId).toBe("root");
    expect(docs[0].title).toBe("Root Page");
    expect(docs[0].content).toBe("Page content here.");
  });

  it("paginates block fetching", async () => {
    mockClient.pages.retrieve.mockResolvedValue(makePage("root", "Root"));
    mockClient.blocks.children.list
      .mockResolvedValueOnce({
        results: [
          makeBlock("paragraph", { rich_text: makeRichText("Page 1") }),
        ],
        has_more: true,
        next_cursor: "cursor-1",
      })
      .mockResolvedValueOnce({
        results: [
          makeBlock("paragraph", { rich_text: makeRichText("Page 2") }),
        ],
        has_more: false,
        next_cursor: null,
      });

    const connector = new NotionConnector("test-token", "root", 0);
    const docs: import("../../sync/sync-manager").RawDocument[] = [];
    for await (const doc of connector.fetchDocuments()) {
      docs.push(doc);
    }

    expect(docs).toHaveLength(1);
    expect(docs[0].content).toBe("Page 1\nPage 2");
    expect(mockClient.blocks.children.list).toHaveBeenCalledTimes(2);
  });

  it("recursively walks child pages", async () => {
    mockClient.pages.retrieve
      .mockResolvedValueOnce(makePage("root", "Root"))
      .mockResolvedValueOnce(makePage("child-1", "Child Page"));

    mockClient.blocks.children.list
      .mockResolvedValueOnce({
        results: [
          makeBlock("paragraph", { rich_text: makeRichText("Root content") }),
          {
            ...makeBlock("child_page", { title: "Child Page" }),
            type: "child_page",
            id: "child-1",
          },
        ],
        has_more: false,
        next_cursor: null,
      })
      .mockResolvedValueOnce({
        results: [
          makeBlock("paragraph", { rich_text: makeRichText("Child content") }),
        ],
        has_more: false,
        next_cursor: null,
      });

    const connector = new NotionConnector("test-token", "root", 0);
    const docs: import("../../sync/sync-manager").RawDocument[] = [];
    for await (const doc of connector.fetchDocuments()) {
      docs.push(doc);
    }

    expect(docs).toHaveLength(2);
    expect(docs[0].title).toBe("Root");
    expect(docs[1].title).toBe("Child Page");
  });

  it("respects max depth guard", async () => {
    let depth = 0;
    mockClient.pages.retrieve.mockImplementation(
      ({ page_id }: { page_id: string }) => {
        return Promise.resolve(makePage(page_id, `Page ${depth++}`));
      },
    );
    mockClient.blocks.children.list.mockImplementation(
      ({ block_id }: { block_id: string }) => {
        return Promise.resolve({
          results: [
            makeBlock("paragraph", {
              rich_text: makeRichText(`Content at ${block_id}`),
            }),
            {
              ...makeBlock("child_page", { title: "Next" }),
              type: "child_page",
              id: `child-${depth}`,
            },
          ],
          has_more: false,
          next_cursor: null,
        });
      },
    );

    const connector = new NotionConnector("test-token", "root", 0);
    const docs: import("../../sync/sync-manager").RawDocument[] = [];
    for await (const doc of connector.fetchDocuments()) {
      docs.push(doc);
    }

    expect(docs.length).toBeLessThanOrEqual(11);
  });

  /**
   * The old behaviour — not yielding a page with no text — meant a page whose
   * body was *deleted* was never yielded, so its chunks stayed in the index
   * forever. Reconciliation cannot catch that: the page still exists. Yielding
   * empty content lets sync-manager's zero-chunk path clear it.
   */
  it("yields pages with empty content so their chunks can be cleared", async () => {
    mockClient.pages.retrieve.mockResolvedValue(makePage("root", "Empty Page"));
    mockClient.blocks.children.list.mockResolvedValue({
      results: [],
      has_more: false,
      next_cursor: null,
    });

    const connector = new NotionConnector("test-token", "root", 0);
    const docs: import("../../sync/sync-manager").RawDocument[] = [];
    for await (const doc of connector.fetchDocuments()) {
      docs.push(doc);
    }

    expect(docs).toHaveLength(1);
    expect(docs[0].externalId).toBe("root");
    expect(docs[0].content).toBe("");
  });

  it("skips databases with 403 permission errors", async () => {
    mockClient.pages.retrieve.mockResolvedValue(makePage("root", "Root"));
    mockClient.blocks.children.list.mockResolvedValue({
      results: [
        makeBlock("paragraph", { rich_text: makeRichText("Root content") }),
        {
          ...makeBlock("child_database", { title: "Forbidden DB" }),
          type: "child_database",
          id: "db-forbidden",
        },
      ],
      has_more: false,
      next_cursor: null,
    });

    const error403 = Object.assign(new Error("Forbidden"), { status: 403 });
    mockClient.databases.retrieve.mockRejectedValue(error403);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const connector = new NotionConnector("test-token", "root", 0);
    const docs: import("../../sync/sync-manager").RawDocument[] = [];
    for await (const doc of connector.fetchDocuments()) {
      docs.push(doc);
    }

    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe("Root");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("403"));
    warnSpy.mockRestore();
  });

  it("rethrows non-permission errors from walkDatabase", async () => {
    mockClient.pages.retrieve.mockResolvedValue(makePage("root", "Root"));
    mockClient.blocks.children.list.mockResolvedValue({
      results: [
        {
          ...makeBlock("child_database", { title: "Broken DB" }),
          type: "child_database",
          id: "db-broken",
        },
      ],
      has_more: false,
      next_cursor: null,
    });

    const networkError = Object.assign(new Error("Network error"), {
      status: 500,
    });
    mockClient.databases.retrieve.mockRejectedValue(networkError);

    const connector = new NotionConnector("test-token", "root", 0);
    await expect(async () => {
      for await (const _ of connector.fetchDocuments()) {
        // consume
      }
    }).rejects.toThrow("Network error");
  });

  it("retries on 429 rate limit errors", async () => {
    const error429 = Object.assign(new Error("Rate limited"), { status: 429 });

    mockClient.pages.retrieve
      .mockRejectedValueOnce(error429)
      .mockResolvedValueOnce(makePage("root", "Root"));

    mockClient.blocks.children.list.mockResolvedValue({
      results: [makeBlock("paragraph", { rich_text: makeRichText("Content") })],
      has_more: false,
      next_cursor: null,
    });

    const connector = new NotionConnector("test-token", "root", 0);
    const docs: import("../../sync/sync-manager").RawDocument[] = [];
    for await (const doc of connector.fetchDocuments()) {
      docs.push(doc);
    }

    expect(docs).toHaveLength(1);
    expect(mockClient.pages.retrieve).toHaveBeenCalledTimes(2);
  });

  it("walks child databases", async () => {
    mockClient.pages.retrieve
      .mockResolvedValueOnce(makePage("root", "Root"))
      .mockResolvedValueOnce(makePage("db-page-1", "DB Entry"));

    mockClient.blocks.children.list
      .mockResolvedValueOnce({
        results: [
          makeBlock("paragraph", { rich_text: makeRichText("Root content") }),
          {
            ...makeBlock("child_database", { title: "My DB" }),
            type: "child_database",
            id: "db-1",
          },
        ],
        has_more: false,
        next_cursor: null,
      })
      .mockResolvedValueOnce({
        results: [
          makeBlock("paragraph", {
            rich_text: makeRichText("DB entry content"),
          }),
        ],
        has_more: false,
        next_cursor: null,
      });

    mockClient.databases.retrieve.mockResolvedValue({
      object: "database",
      id: "db-1",
      data_sources: [{ id: "ds-1", name: "My DB" }],
    });

    mockClient.dataSources.query.mockResolvedValue({
      results: [makePage("db-page-1", "DB Entry")],
      has_more: false,
      next_cursor: null,
    });

    const connector = new NotionConnector("test-token", "root", 0);
    const docs: import("../../sync/sync-manager").RawDocument[] = [];
    for await (const doc of connector.fetchDocuments()) {
      docs.push(doc);
    }

    expect(docs).toHaveLength(2);
    expect(docs[1].title).toBe("DB Entry");
  });
});

describe("NotionConnector walk result", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("reports the ids it saw, in the same form it yields them", async () => {
    // The trap: listNotionItems strips dashes before storing root_external_id, but
    // child ids come back from the API with dashes — so documents.external_id
    // holds both forms. The seen-set must be built from the same expression that
    // becomes externalId. Normalizing here would make every child look deleted.
    const childId = "11111111-2222-3333-4444-555555555555";
    mockClient.pages.retrieve.mockImplementation(
      ({ page_id }: { page_id: string }) =>
        Promise.resolve(makePage(page_id, `Page ${page_id}`)),
    );
    mockClient.blocks.children.list.mockImplementation(
      ({ block_id }: { block_id: string }) =>
        Promise.resolve({
          results:
            block_id === "abc123"
              ? [
                  makeBlock("paragraph", { rich_text: makeRichText("Root") }),
                  {
                    ...makeBlock("child_page", { title: "Child" }),
                    type: "child_page",
                    id: childId,
                  },
                ]
              : [makeBlock("paragraph", { rich_text: makeRichText("Child") })],
          has_more: false,
          next_cursor: null,
        }),
    );

    const connector = new NotionConnector("test-token", "abc123", 0);
    const walk = await drainWalk(connector);

    expect(walk.complete).toBe(true);
    expect([...walk.seenExternalIds].sort()).toEqual(
      ["abc123", childId].sort(),
    );
  });

  it("marks the walk incomplete when a database is forbidden", async () => {
    mockClient.pages.retrieve.mockResolvedValue(makePage("root", "Root"));
    mockClient.blocks.children.list.mockResolvedValue({
      results: [
        {
          ...makeBlock("child_database", { title: "Forbidden DB" }),
          type: "child_database",
          id: "db-forbidden",
        },
      ],
      has_more: false,
      next_cursor: null,
    });
    mockClient.databases.retrieve.mockRejectedValue(
      Object.assign(new Error("Forbidden"), { status: 403 }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const walk = await drainWalk(new NotionConnector("test-token", "root", 0));

    // We could not look inside that database. Its pages are unseen, not deleted —
    // and an incomplete walk must never authorize a deletion.
    expect(walk.complete).toBe(false);
    expect(walk.seenExternalIds.has("root")).toBe(true);
  });

  it("marks the walk incomplete when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    mockClient.pages.retrieve.mockResolvedValue(makePage("root", "Root"));

    const walk = await drainWalk(
      new NotionConnector("test-token", "root", 0),
      controller.signal,
    );

    expect(walk.complete).toBe(false);
  });

  it("marks the walk incomplete when a block subtree exceeds the depth cap", async () => {
    // Every level of block_children.list returns one more toggle with
    // has_children: true, so fetchAllBlocks recurses without bound — the only
    // thing that stops it is the MAX_BLOCK_DEPTH cap. This exercises the block
    // recursion cap in fetchAllBlocks, not walkPage's page-depth (MAX_DEPTH)
    // cap: there is no child_page anywhere in this tree.
    mockClient.pages.retrieve.mockResolvedValue(makePage("root", "Root"));
    mockClient.blocks.children.list.mockImplementation(() =>
      Promise.resolve({
        results: [
          {
            ...makeBlock("toggle", { rich_text: makeRichText("Nested") }),
            has_children: true,
          },
        ],
        has_more: false,
        next_cursor: null,
      }),
    );

    const walk = await drainWalk(new NotionConnector("test-token", "root", 0));

    // The subtree below the cap was silently dropped — never added to `seen`.
    // A walk that drops nodes must never be reported complete, or
    // reconciliation will delete a page it never actually looked at.
    expect(walk.complete).toBe(false);
  });
});

describe("listNotionItems", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns all pages and databases sorted alphabetically", async () => {
    const page1 = makePage("aaa-bbb", "Zebra Page");
    const page2 = makePage("ccc-ddd", "Alpha Page");
    const nestedPage = {
      ...makePage("eee-fff", "Nested Page"),
      parent: { type: "page_id", page_id: "ccc-ddd" },
    };

    mockClient.search
      .mockResolvedValueOnce({
        results: [page1, nestedPage, page2],
        has_more: false,
        next_cursor: null,
      })
      .mockResolvedValueOnce({
        results: [
          {
            object: "data_source",
            id: "ggg-hhh",
            title: [{ plain_text: "My Database", type: "text" }],
            database_parent: { type: "workspace", workspace: true },
            icon: { type: "emoji", emoji: "📊" },
          },
        ],
        has_more: false,
        next_cursor: null,
      });

    const items = await listNotionItems("test-token");

    expect(items).toHaveLength(4);
    expect(items[0].title).toBe("Alpha Page");
    expect(items[1].title).toBe("My Database");
    expect(items[1].isDatabase).toBe(true);
    expect(items[1].icon).toBe("📊");
    expect(items[2].title).toBe("Nested Page");
    expect(items[3].title).toBe("Zebra Page");
  });

  it("paginates search results", async () => {
    const page1 = makePage("aaa-bbb", "Page A");
    const page2 = makePage("ccc-ddd", "Page B");

    mockClient.search
      .mockResolvedValueOnce({
        results: [page1],
        has_more: true,
        next_cursor: "cursor-1",
      })
      .mockResolvedValueOnce({
        results: [page2],
        has_more: false,
        next_cursor: null,
      })
      .mockResolvedValueOnce({
        results: [],
        has_more: false,
        next_cursor: null,
      });

    const items = await listNotionItems("test-token");

    expect(items).toHaveLength(2);
    expect(mockClient.search).toHaveBeenCalledTimes(3);
  });

  it("extracts emoji icon from pages", async () => {
    const page = {
      ...makePage("aaa-bbb", "Fun Page"),
      icon: { type: "emoji", emoji: "🎉" },
    };

    mockClient.search
      .mockResolvedValueOnce({
        results: [page],
        has_more: false,
        next_cursor: null,
      })
      .mockResolvedValueOnce({
        results: [],
        has_more: false,
        next_cursor: null,
      });

    const items = await listNotionItems("test-token");

    expect(items[0].icon).toBe("🎉");
  });

  it("returns empty array when no pages or databases exist", async () => {
    mockClient.search
      .mockResolvedValueOnce({
        results: [],
        has_more: false,
        next_cursor: null,
      })
      .mockResolvedValueOnce({
        results: [],
        has_more: false,
        next_cursor: null,
      });

    const items = await listNotionItems("test-token");
    expect(items).toEqual([]);
  });

  it("deduplicates pages across paginated results", async () => {
    const page = makePage("aaa-bbb", "Duplicate Page");

    mockClient.search
      .mockResolvedValueOnce({
        results: [page],
        has_more: true,
        next_cursor: "cursor-1",
      })
      .mockResolvedValueOnce({
        results: [page],
        has_more: false,
        next_cursor: null,
      })
      .mockResolvedValueOnce({
        results: [],
        has_more: false,
        next_cursor: null,
      });

    const items = await listNotionItems("test-token");

    expect(items).toHaveLength(1);
  });
});

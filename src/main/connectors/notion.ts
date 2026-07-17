import {
  Client,
  isFullPage,
  isFullDatabase,
  isFullDataSource,
  LogLevel,
} from "@notionhq/client";
import type {
  BlockObjectResponse,
  DataSourceObjectResponse,
  PageObjectResponse,
  RichTextItemResponse,
} from "@notionhq/client/build/src/api-endpoints";
import type {
  Connector,
  RawDocument,
  SyncWalkResult,
} from "../sync/sync-manager";
import type { NotionItemSummary } from "../../shared/types";

const MAX_DEPTH = 10;
const MAX_BLOCK_DEPTH = 20;
const DEFAULT_THROTTLE_MS = 334;

export class NotionConnector implements Connector {
  private client: Client;
  private rootPageId: string;
  private lastRequestTime = 0;
  private throttleMs: number;

  /** Accumulated across the whole walk and reported once, from `fetchDocuments`. */
  private seen = new Set<string>();
  private complete = true;

  constructor(
    token: string,
    rootPageId: string,
    throttleMs = DEFAULT_THROTTLE_MS,
  ) {
    this.client = new Client({ auth: token, logLevel: LogLevel.ERROR });
    this.rootPageId = rootPageId;
    this.throttleMs = throttleMs;
  }

  async *fetchDocuments(
    signal?: AbortSignal,
    knownDocs?: Map<string, string>,
  ): AsyncGenerator<RawDocument, SyncWalkResult> {
    this.seen = new Set();
    this.complete = true;
    yield* this.walkPage(this.rootPageId, 0, new Set(), knownDocs, signal);
    return { seenExternalIds: this.seen, complete: this.complete };
  }

  private async *walkPage(
    pageId: string,
    depth: number,
    visited: Set<string>,
    knownDocs?: Map<string, string>,
    signal?: AbortSignal,
  ): AsyncGenerator<RawDocument> {
    // Already walked: dedupe, not incompleteness. We have seen this page.
    if (visited.has(pageId)) return;
    if (signal?.aborted || depth > MAX_DEPTH) {
      this.complete = false;
      return;
    }
    visited.add(pageId);

    // `pageId` — the *exact* expression that becomes `externalId` below. Do not
    // normalize it. The root arrives dash-stripped (listNotionItems strips them
    // before storing sources.root_external_id) while child ids come back from the
    // API with dashes, so documents.external_id legitimately holds both forms.
    // Normalizing here would make every child look unseen, and reconciliation
    // would delete the entire corpus.
    this.seen.add(pageId);

    const page = (await this.rateLimited(() =>
      this.client.pages.retrieve({ page_id: pageId }),
    )) as PageObjectResponse;

    const title = extractPageTitle(page);
    const url = page.url ?? null;
    const unchanged = knownDocs?.get(pageId) === page.last_edited_time;

    const blocks = await this.fetchAllBlocks(pageId);

    if (!unchanged) {
      // Yield even when the body is empty. Gating on `content.trim()` meant a page
      // whose text was deleted was never yielded, so its old chunks stayed in the
      // index forever — and reconciliation cannot help, because the page is still
      // very much there. The zero-chunk path in sync-manager clears them.
      yield {
        externalId: pageId,
        title,
        url,
        mimeType: "text/plain",
        modifiedAt: page.last_edited_time ?? null,
        content: blocksToText(blocks),
      };
    }

    for (const block of blocks) {
      if (signal?.aborted) {
        this.complete = false;
        return;
      }
      if (block.type === "child_page") {
        yield* this.walkPage(block.id, depth + 1, visited, knownDocs, signal);
      }
      if (block.type === "child_database") {
        try {
          yield* this.walkDatabase(
            block.id,
            depth + 1,
            visited,
            knownDocs,
            signal,
          );
        } catch (err) {
          const status =
            err instanceof Object && "status" in err
              ? (err as { status: number }).status
              : 0;
          if (status === 403 || status === 404) {
            console.warn(
              `Skipping database ${block.id}: ${status} (not shared or not found)`,
            );
            // A subtree we could not look at. Its pages are unseen but not gone.
            this.complete = false;
            continue;
          }
          throw err;
        }
      }
    }
  }

  private async *walkDatabase(
    databaseId: string,
    depth: number,
    visited: Set<string>,
    knownDocs?: Map<string, string>,
    signal?: AbortSignal,
  ): AsyncGenerator<RawDocument> {
    if (signal?.aborted || depth > MAX_DEPTH) {
      this.complete = false;
      return;
    }

    const dataSourceId = await this.resolveDataSourceId(databaseId);

    let cursor: string | undefined;
    do {
      const response = await this.rateLimited(() =>
        this.client.dataSources.query({
          data_source_id: dataSourceId,
          start_cursor: cursor,
          page_size: 100,
        }),
      );

      for (const result of response.results) {
        if ("url" in result) {
          yield* this.walkPage(
            result.id,
            depth + 1,
            visited,
            knownDocs,
            signal,
          );
        }
      }

      cursor = response.has_more
        ? (response.next_cursor ?? undefined)
        : undefined;

      if (signal?.aborted && cursor) {
        // Pages we never paginated to are unseen, not deleted.
        this.complete = false;
        return;
      }
    } while (cursor);
  }

  private async resolveDataSourceId(databaseId: string): Promise<string> {
    const db = await this.rateLimited(() =>
      this.client.databases.retrieve({ database_id: databaseId }),
    );
    if (isFullDatabase(db) && db.data_sources.length > 0) {
      return db.data_sources[0].id;
    }
    return databaseId;
  }

  private async fetchAllBlocks(
    blockId: string,
    depth = 0,
  ): Promise<BlockObjectResponse[]> {
    // Blocks below the depth cap are unseen, not deleted — including any
    // child pages nested in them, since discovery flows through this list.
    if (depth >= MAX_BLOCK_DEPTH) {
      this.complete = false;
      return [];
    }
    const blocks: BlockObjectResponse[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.rateLimited(() =>
        this.client.blocks.children.list({
          block_id: blockId,
          start_cursor: cursor,
          page_size: 100,
        }),
      );
      for (const result of response.results) {
        if ("type" in result) {
          const block = result as BlockObjectResponse;
          blocks.push(block);
          if (
            block.has_children &&
            block.type !== "child_page" &&
            block.type !== "child_database"
          ) {
            const children = await this.fetchAllBlocks(block.id, depth + 1);
            blocks.push(...children);
          }
        }
      }
      cursor = response.has_more
        ? (response.next_cursor ?? undefined)
        : undefined;
    } while (cursor);
    return blocks;
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.throttleMs) {
      await new Promise((r) => setTimeout(r, this.throttleMs - elapsed));
    }
    this.lastRequestTime = Date.now();
  }

  private async rateLimited<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
    await this.throttle();
    try {
      return await fn();
    } catch (err: unknown) {
      const status =
        err instanceof Object && "status" in err
          ? (err as { status: number }).status
          : 0;
      if (status === 429 && retries > 0) {
        const delay = Math.pow(2, 3 - retries) * 1000;
        await new Promise((r) => setTimeout(r, delay));
        return this.rateLimited(fn, retries - 1);
      }
      throw err;
    }
  }
}

export function extractPageTitle(page: PageObjectResponse): string {
  const props = page.properties;
  for (const prop of Object.values(props)) {
    if (prop.type === "title" && prop.title.length > 0) {
      return prop.title.map((t) => t.plain_text).join("");
    }
  }
  return "Untitled";
}

function richTextToPlain(richText: RichTextItemResponse[]): string {
  return richText.map((t) => t.plain_text).join("");
}

export function blocksToText(blocks: BlockObjectResponse[]): string {
  const lines: string[] = [];

  for (const block of blocks) {
    const line = blockToLine(block);
    if (line !== null) {
      lines.push(line);
    }
  }

  return lines.join("\n");
}

function blockToLine(block: BlockObjectResponse): string | null {
  switch (block.type) {
    case "paragraph":
      return richTextToPlain(block.paragraph.rich_text);
    case "heading_1":
      return `# ${richTextToPlain(block.heading_1.rich_text)}`;
    case "heading_2":
      return `## ${richTextToPlain(block.heading_2.rich_text)}`;
    case "heading_3":
      return `### ${richTextToPlain(block.heading_3.rich_text)}`;
    case "bulleted_list_item":
      return `- ${richTextToPlain(block.bulleted_list_item.rich_text)}`;
    case "numbered_list_item":
      return `1. ${richTextToPlain(block.numbered_list_item.rich_text)}`;
    case "toggle":
      return richTextToPlain(block.toggle.rich_text);
    case "callout":
      return richTextToPlain(block.callout.rich_text);
    case "code":
      return `\`\`\`\n${richTextToPlain(block.code.rich_text)}\n\`\`\``;
    case "quote":
      return `> ${richTextToPlain(block.quote.rich_text)}`;
    case "to_do":
      return `${block.to_do.checked ? "[x]" : "[ ]"} ${richTextToPlain(block.to_do.rich_text)}`;
    case "divider":
      return "---";
    case "table_row":
      return block.table_row.cells
        .map((cell) => richTextToPlain(cell))
        .join(" | ");
    case "image":
    case "video":
    case "embed":
    case "file":
    case "bookmark":
    case "pdf":
      return null;
    default:
      return null;
  }
}

export async function listNotionItems(
  token: string,
): Promise<NotionItemSummary[]> {
  const client = new Client({ auth: token, logLevel: LogLevel.ERROR });

  const seen = new Set<string>();
  const items: NotionItemSummary[] = [];

  let pageCursor: string | undefined;
  do {
    const response = await client.search({
      filter: { property: "object", value: "page" },
      start_cursor: pageCursor,
      page_size: 100,
    });
    for (const result of response.results) {
      if (isFullPage(result) && !seen.has(result.id)) {
        seen.add(result.id);
        items.push({
          id: result.id.replace(/-/g, ""),
          title: extractPageTitle(result),
          icon: result.icon?.type === "emoji" ? result.icon.emoji : null,
        });
      }
    }
    pageCursor = response.has_more
      ? (response.next_cursor ?? undefined)
      : undefined;
  } while (pageCursor);

  let dbCursor: string | undefined;
  do {
    const response = await client.search({
      filter: { property: "object", value: "data_source" },
      start_cursor: dbCursor,
      page_size: 100,
    });
    for (const result of response.results) {
      if (isFullDataSource(result) && !seen.has(result.id)) {
        seen.add(result.id);
        const ds = result as DataSourceObjectResponse;
        const title = ds.title.map((t) => t.plain_text).join("") || "Untitled";
        items.push({
          id: result.id.replace(/-/g, ""),
          title,
          icon: ds.icon?.type === "emoji" ? ds.icon.emoji : null,
          isDatabase: true,
        });
      }
    }
    dbCursor = response.has_more
      ? (response.next_cursor ?? undefined)
      : undefined;
  } while (dbCursor);

  items.sort((a, b) => a.title.localeCompare(b.title));
  return items;
}

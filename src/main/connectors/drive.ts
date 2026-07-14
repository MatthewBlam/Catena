import { drive_v3 } from "@googleapis/drive";
import type { GoogleOAuth2Client } from "../auth/google-oauth";
import type {
  Connector,
  RawDocument,
  SyncWalkResult,
} from "../sync/sync-manager";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_PDF_PAGES = 200;
const THROTTLE_MS = 100; // ~12k requests per 100s quota
const MAX_DEPTH = 20;

let cachedPdfParse: typeof import("pdf-parse") | null = null;
let cachedMammoth: typeof import("mammoth") | null = null;

export class DriveConnector implements Connector {
  private drive: drive_v3.Drive;
  private folderId: string;
  private lastRequestTime = 0;

  /** Accumulated across the whole walk and reported once, from `fetchDocuments`. */
  private seen = new Set<string>();
  private complete = true;

  constructor(auth: GoogleOAuth2Client, folderId: string) {
    this.drive = new drive_v3.Drive({ auth });
    this.folderId = folderId;
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < THROTTLE_MS) {
      await new Promise((r) => setTimeout(r, THROTTLE_MS - elapsed));
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

  async *fetchDocuments(
    signal?: AbortSignal,
    knownDocs?: Map<string, string>,
  ): AsyncGenerator<RawDocument, SyncWalkResult> {
    this.seen = new Set();
    this.complete = true;
    if (this.folderId === SHARED_WITH_ME_ID) {
      yield* this.walkSharedWithMe(knownDocs, signal);
    } else {
      yield* this.walkFolder(this.folderId, 0, new Set(), knownDocs, signal);
    }
    return { seenExternalIds: this.seen, complete: this.complete };
  }

  private async *walkSharedWithMe(
    knownDocs?: Map<string, string>,
    signal?: AbortSignal,
  ): AsyncGenerator<RawDocument> {
    const visited = new Set<string>();
    let pageToken: string | undefined;
    do {
      if (signal?.aborted) {
        this.complete = false;
        return;
      }
      const res = await this.rateLimited(() =>
        this.drive.files.list({
          q: "sharedWithMe = true and trashed = false",
          fields:
            "nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink, size)",
          pageSize: 100,
          pageToken,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        }),
      );

      yield* this.processFiles(
        res.data.files ?? [],
        0,
        visited,
        knownDocs,
        signal,
      );
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  }

  private async *walkFolder(
    folderId: string,
    depth: number,
    visited: Set<string>,
    knownDocs?: Map<string, string>,
    signal?: AbortSignal,
  ): AsyncGenerator<RawDocument> {
    // Already walked: dedupe, not incompleteness.
    if (visited.has(folderId)) return;
    if (signal?.aborted || depth >= MAX_DEPTH) {
      this.complete = false;
      return;
    }
    visited.add(folderId);

    let pageToken: string | undefined;
    do {
      const res = await this.rateLimited(() =>
        this.drive.files.list({
          q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`,
          fields:
            "nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink, size)",
          pageSize: 100,
          pageToken,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        }),
      );

      yield* this.processFiles(
        res.data.files ?? [],
        depth,
        visited,
        knownDocs,
        signal,
      );
      pageToken = res.data.nextPageToken ?? undefined;

      if (signal?.aborted && pageToken) {
        // Files we never paginated to are unseen, not deleted.
        this.complete = false;
        return;
      }
    } while (pageToken);
  }

  private async *processFiles(
    files: drive_v3.Schema$File[],
    depth: number,
    visited: Set<string>,
    knownDocs?: Map<string, string>,
    signal?: AbortSignal,
  ): AsyncGenerator<RawDocument> {
    for (const file of files) {
      if (signal?.aborted) {
        this.complete = false;
        return;
      }
      if (!file.id) continue;

      if (file.mimeType === "application/vnd.google-apps.folder") {
        yield* this.walkFolder(file.id, depth + 1, visited, knownDocs, signal);
        continue;
      }

      // Record it here, above every skip. A file that is too big, unparseable,
      // an unsupported type, or simply unchanged since the last sync is a file
      // that demonstrably *exists* — and reconciliation deletes whatever it did
      // not see. Adding it after the skips would delete the user's 60 MB PDFs.
      this.seen.add(file.id);

      if (!file.name) continue;
      if (file.size && Number(file.size) > MAX_FILE_SIZE) continue;
      if (
        knownDocs &&
        file.modifiedTime &&
        knownDocs.get(file.id) === file.modifiedTime
      )
        continue;
      let content: string | null;
      try {
        content = await this.extractContent(file);
      } catch (err) {
        console.warn(
          `Skipping file "${file.name}" (${file.id}): ${err instanceof Error ? err.message : err}`,
        );
        continue;
      }
      if (!content) continue;
      yield {
        externalId: file.id,
        title: file.name,
        url: file.webViewLink ?? null,
        mimeType: file.mimeType ?? null,
        modifiedAt: file.modifiedTime ?? null,
        content,
      };
    }
  }

  private async extractContent(
    file: drive_v3.Schema$File,
  ): Promise<string | null> {
    const mime = file.mimeType!;

    if (mime === "application/vnd.google-apps.document") {
      const res = await this.rateLimited(() =>
        this.drive.files.export({
          fileId: file.id!,
          mimeType: "text/plain",
        }),
      );
      return (res.data as string) || null;
    }

    if (mime === "application/vnd.google-apps.spreadsheet") {
      const res = await this.rateLimited(() =>
        this.drive.files.export({
          fileId: file.id!,
          mimeType: "text/csv",
        }),
      );
      return (res.data as string) || null;
    }

    if (mime === "application/vnd.google-apps.presentation") {
      const res = await this.rateLimited(() =>
        this.drive.files.export({
          fileId: file.id!,
          mimeType: "text/plain",
        }),
      );
      return (res.data as string) || null;
    }

    if (mime === "application/pdf") {
      const res = await this.rateLimited(() =>
        this.drive.files.get(
          { fileId: file.id!, alt: "media", supportsAllDrives: true },
          { responseType: "arraybuffer" },
        ),
      );
      cachedPdfParse ??= await import("pdf-parse");
      const parser = new cachedPdfParse.PDFParse({
        data: new Uint8Array(res.data as ArrayBuffer),
      });
      const result = await parser.getText({ last: MAX_PDF_PAGES });
      await parser.destroy();
      return result.text || null;
    }

    if (
      mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      const res = await this.rateLimited(() =>
        this.drive.files.get(
          { fileId: file.id!, alt: "media", supportsAllDrives: true },
          { responseType: "arraybuffer" },
        ),
      );
      cachedMammoth ??= await import("mammoth");
      const result = await cachedMammoth.extractRawText({
        buffer: Buffer.from(res.data as ArrayBuffer),
      });
      return result.value || null;
    }

    if (mime === "text/plain" || mime === "text/markdown") {
      const res = await this.rateLimited(() =>
        this.drive.files.get({
          fileId: file.id!,
          alt: "media",
          supportsAllDrives: true,
        }),
      );
      return (res.data as string) || null;
    }

    return null;
  }
}

export function extractFolderIdFromUrl(url: string): string | null {
  const match = url.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return match?.[1] ?? null;
}

export const SHARED_WITH_ME_ID = "__shared_with_me__";

export async function listDriveItems(
  auth: GoogleOAuth2Client,
  parentId?: string,
): Promise<{ id: string; name: string; isFolder: boolean }[]> {
  const driveClient = new drive_v3.Drive({ auth });
  const items: { id: string; name: string; isFolder: boolean }[] = [];

  if (!parentId) {
    items.push({
      id: SHARED_WITH_ME_ID,
      name: "Shared with me",
      isFolder: true,
    });

    let drivesPageToken: string | undefined;
    do {
      await new Promise((r) => setTimeout(r, THROTTLE_MS));
      const drivesRes = await driveClient.drives.list({
        pageSize: 100,
        pageToken: drivesPageToken,
        fields: "nextPageToken, drives(id, name)",
      });
      for (const d of drivesRes.data.drives ?? []) {
        if (!d.id || !d.name) continue;
        items.push({ id: d.id, name: d.name, isFolder: true });
      }
      drivesPageToken = drivesRes.data.nextPageToken ?? undefined;
    } while (drivesPageToken);
  }

  if (parentId === SHARED_WITH_ME_ID) {
    let pageToken: string | undefined;
    do {
      await new Promise((r) => setTimeout(r, THROTTLE_MS));
      const res = await driveClient.files.list({
        q: "sharedWithMe = true and trashed = false",
        fields: "nextPageToken, files(id, name, mimeType)",
        pageSize: 200,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      for (const file of res.data.files ?? []) {
        if (!file.id || !file.name) continue;
        items.push({
          id: file.id,
          name: file.name,
          isFolder: file.mimeType === "application/vnd.google-apps.folder",
        });
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    items.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return items;
  }

  const parent = parentId || "root";
  let pageToken: string | undefined;

  do {
    await new Promise((r) => setTimeout(r, THROTTLE_MS));
    const res = await driveClient.files.list({
      q: `'${parent.replace(/'/g, "\\'")}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType)",
      orderBy: "folder,name",
      pageSize: 200,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    for (const file of res.data.files ?? []) {
      if (!file.id || !file.name) continue;
      items.push({
        id: file.id,
        name: file.name,
        isFolder: file.mimeType === "application/vnd.google-apps.folder",
      });
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return items;
}

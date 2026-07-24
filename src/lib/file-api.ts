/**
 * File upload + retrieval helpers for chat attachments.
 *
 * Backendless mode: files are stored in OPFS (Origin Private File System)
 * via `@/lib/storage/opfs`, and metadata is tracked in IndexedDB via
 * `fileService` from `@/lib/services`. There is no server upload —
 * `uploadFile` writes the bytes directly to OPFS, creates a metadata row in
 * Dexie, and caches a blob URL the browser can fetch.
 *
 * `getFileUrl(fileId)` is synchronous — it returns the cached blob URL for
 * files that have been uploaded (or pre-loaded via `loadFileUrl`) in this
 * session, or `""` for files that haven't been warmed yet. Callers that need
 * to render historical attachments should call `loadFileUrl(fileId)` (or
 * `loadFileUrls(ids)`) first; the cache populates and the next render returns
 * the URL.
 */

import { ApiError } from "./api-client";
import { fileService } from "@/lib/services";
import { writeFileAtPath, makeBlobURL, readFile } from "@/lib/storage/opfs";
import { db } from "@/lib/db";
import { useAuthStore } from "@/stores";

export interface FileUploadResponse {
  id: string;
  filename: string;
  mime_type: string;
  size: number;
  file_type: string;
}

// In-memory cache of fileId → blob URL. Populated by `uploadFile` and
// `loadFileUrl`. The URL is valid for the page lifetime; we don't revoke
// until the page unloads (a few hundred small images is fine — the browser
// caps object URL memory).
const blobURLCache = new Map<string, string>();

function fileTypeFromMime(mime: string): string {
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime === "application/msword"
  ) {
    return "docx";
  }
  return "text";
}

/**
 * Persist a chat attachment locally. The bytes go to OPFS at
 * `users/<userId>/files/<id>/<filename>`; the metadata row (with the OPFS
 * path) goes to IndexedDB via `fileService.create`. A blob URL is minted
 * immediately and cached so the caller can render the just-uploaded file.
 *
 * The `onProgress` callback is called with a percentage (0-100) as the
 * file is written to OPFS, so the UI can show a progress bar.
 *
 * Throws `ApiError(401, …)` if no user is signed in.
 */
export async function uploadFile(
  file: File,
  onProgress?: (percent: number) => void,
): Promise<FileUploadResponse> {
  const userId = useAuthStore.getState().user?.id;
  if (!userId) {
    throw new ApiError(401, "You must be signed in to upload files.");
  }

  // Report 0% immediately so the UI can show the progress bar.
  onProgress?.(0);

  const { nanoid } = await import("nanoid");
  const id = nanoid();
  const mimeType = file.type || "application/octet-stream";
  const fileType = fileTypeFromMime(mimeType);

  // Cache the blob URL up-front so the file card renders immediately.
  let blobUrl = blobURLCache.get(id);
  if (!blobUrl) {
    try {
      blobUrl = URL.createObjectURL(file);
      blobURLCache.set(id, blobUrl);
    } catch {
      blobUrl = "";
    }
  }

  // Report 10% after blob URL creation.
  onProgress?.(10);

  try {
    const safeName = file.name.replace(/[\\/]+/g, "_");
    const subPath = `files/${id}`;
    const dirPath = `users/${userId}/${subPath}`;

    // Report 30% before OPFS write.
    onProgress?.(30);

    // Use the EXACT SAME pattern as the skill installer:
    //   1. Read into ArrayBuffer
    //   2. Copy into a fresh ArrayBuffer (avoids the modern
    //      Uint8Array<ArrayBufferLike> shape that some OPFS impls reject)
    //   3. Wrap in a new Blob
    //   4. Write via writeFileAtPath(dirPath, filename, blob)
    // This is proven to work for skill uploads and avoids silent failures.
    const raw = new Uint8Array(await file.arrayBuffer());
    const buf = new ArrayBuffer(raw.byteLength);
    new Uint8Array(buf).set(raw);
    const blob = new Blob([buf], { type: mimeType });
    const storagePath = await writeFileAtPath(dirPath, safeName, blob);

    // ALSO copy the file to the workspace directory so it appears in the
    // file sidebar. The chat attachment path (files/<id>/) is for the
    // chat's internal use; the workspace path (workspace/) is what the
    // file sidebar lists and what the AI's file tools access.
    try {
      await writeFileAtPath(`users/${userId}/workspace`, safeName, new Blob([buf], { type: mimeType }));
    } catch {
      // best-effort — the chat attachment still works even if the workspace copy fails
    }

    // Report 70% after OPFS write, before DB insert.
    onProgress?.(70);

    await fileService.create(userId, {
      id,
      filename: file.name,
      mime_type: mimeType,
      size: file.size,
      storage_path: storagePath,
      file_type: fileType,
    });

    // Report 100% — upload complete.
    onProgress?.(100);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const message = err instanceof Error ? err.message : "Upload failed";
    throw new ApiError(500, message, err);
  }

  return {
    id,
    filename: file.name,
    mime_type: mimeType,
    size: file.size,
    file_type: fileType,
  };
}

/**
 * Build a fetchable URL for a chat attachment. Synchronous — returns the
 * cached blob URL if `uploadFile` or `loadFileUrl` has warmed the cache for
 * this id, or `""` otherwise. Callers that need to render historical
 * attachments should call `loadFileUrl(id)` (async) first to populate the
 * cache; the next render will return the URL.
 */
export function getFileUrl(fileId: string): string {
  return blobURLCache.get(fileId) ?? "";
}

/**
 * Async helper — load a file's blob URL from OPFS, cache it, and return it.
 * Safe to call repeatedly; subsequent calls return the cached URL without
 * re-reading OPFS. Returns `""` if the file metadata isn't found.
 */
export async function loadFileUrl(fileId: string): Promise<string> {
  const cached = blobURLCache.get(fileId);
  if (cached) return cached;
  const userId = useAuthStore.getState().user?.id;
  if (!userId) return "";
  const row = await fileService.get(fileId, userId);
  if (!row) return "";
  try {
    const url = await makeBlobURL(row.storage_path);
    blobURLCache.set(fileId, url);
    return url;
  } catch {
    return "";
  }
}

/**
 * Warm the cache for a batch of file ids. Useful when loading a
 * conversation's history — call this with every attached file id so the
 * subsequent `getFileUrl(id)` calls in render return the URL on the first
 * paint. Failures are swallowed (the URL just stays "").
 */
export async function loadFileUrls(fileIds: string[]): Promise<void> {
  await Promise.all(fileIds.map((id) => loadFileUrl(id).catch(() => {})));
}

/**
 * Read a file's bytes from OPFS (e.g. for sending to the agent as base64).
 * Returns null if the file isn't found or OPFS isn't available.
 */
export async function readFileBytes(fileId: string): Promise<Blob | null> {
  const userId = useAuthStore.getState().user?.id;
  if (!userId) return null;
  const row = await fileService.get(fileId, userId);
  if (!row) return null;
  try {
    return await readFile(row.storage_path);
  } catch {
    return null;
  }
}

/**
 * Upload a file to the E2B sandbox at /home/user/<filename>.
 * Only called when file_system_mode is "cloud" (cloud) — the caller checks
 * the mode before invoking this. No-op if no sandbox API key is provided.
 *
 * The file is also still stored locally in OPFS (via `uploadFile`) so it
 * persists across sessions and works in local mode.
 */
export async function uploadFileToSandbox(
  file: File,
  apiKey: string,
  conversationId?: string | null,
  sandboxMode: "shared" | "separate" = "shared",
): Promise<void> {
  if (!apiKey) return;
  try {
    const { getE2BClient } = await import("@/lib/e2b/client");
    const client = getE2BClient(apiKey, conversationId, sandboxMode);
    const safeName = file.name.replace(/[\\/]+/g, "_");
    const text = await file.text();
    await client.writeFile(`/home/user/${safeName}`, text);
  } catch (err) {
    console.warn("[file-api] sandbox upload failed:", err);
  }
}

/**
 * Direct Dexie access for components that need to list / link / delete files
 * (e.g. the FileSidebar). Kept here so the file-api module is the single
 * import point for chat-attachment code.
 */
export { fileService, db };

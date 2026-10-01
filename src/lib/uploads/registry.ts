"use client";

/**
 * Canonical uploads registry — the single source of truth for every
 * user-uploaded file (the File Persistence PRD's "canonical file record").
 *
 * ARCHITECTURE
 *   File Picker → uploadFile() [file-api.ts]
 *       ↓
 *   OPFS bytes:  users/<userId>/files/<fileId>/<filename>   (persistent)
 *       ↓ (verified — the write is read back before success is reported)
 *   Dexie record: chat_files row (fileId, name, mime, size, storage_path…)
 *       ↓
 *   ┌────────────┬───────────────────┬─────────────────┐
 *   │ Uploads UI │ Chat attachment   │ AI context      │
 *   │ (sidebar)  │ (files[] + tag)   │ (tools + tag)   │
 *   └────────────┴───────────────────┴─────────────────┘
 *       ↓ (best-effort, when a sandbox key exists)
 *   E2B sandbox mirror: uploads/<filename>  (binary-safe, base64)
 *
 * The Dexie `chat_files` row + the OPFS bytes it points at ARE the canonical
 * record. The chat message carries a structured hidden tag
 * `<user_uploaded_file file_id="…" name="…" … />` that references the record
 * by its stable fileId — never a blob URL, never a transient browser object.
 *
 * The tag is an INTERNAL representation. The UI must never render it raw:
 * `stripUploadTags()` removes it from displayed/copied text and the message
 * renderer shows the normal FileCard attachment chip instead.
 */

import { fileService } from "@/lib/services";
import { db } from "@/lib/db";
import { useAuthStore, useConversationStore } from "@/stores";
import { getE2BClient, type E2BClient } from "@/lib/e2b/client";
import { isCodeChat } from "@/lib/e2b/sandbox-rotation";
import {
  readFile as opfsReadFile,
  deleteFile as opfsDeleteFile,
  isOPFSAvailable,
} from "@/lib/storage/opfs";

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

/** One canonical uploaded-file record (a `chat_files` row). */
export interface UploadedFileRecord {
  /** Stable file identity — never changes, referenced by the hidden tag. */
  fileId: string;
  userId: string;
  /** Message the file was attached to (null until the turn is persisted). */
  messageId: string | null;
  conversationId: string | null;
  /** Original filename as chosen by the user (display name). */
  filename: string;
  mimeType: string;
  size: number;
  /** OPFS path of the persisted bytes: users/<uid>/files/<fileId>/<name>. */
  storagePath: string;
  /** "image" | "pdf" | "docx" | "text". */
  fileType: string;
  uploadedAt: string;
}

// ---------------------------------------------------------------------------
// Hidden-tag protocol.
// ---------------------------------------------------------------------------

/**
 * Build the structured hidden tag for one attached file.
 * The tag is appended to the persisted message content so that (a) the AI
 * knows the file exists and can resolve it, and (b) the renderer can
 * reconstruct the attachment after a refresh even if the chat_files row is
 * somehow missing (defense in depth — files[] hydration is the primary path).
 */
export function buildUploadTag(file: {
  id: string;
  filename: string;
  mime_type?: string;
  size?: number;
}): string {
  const name = file.filename.replace(/"/g, "&quot;");
  const mime = (file.mime_type ?? "application/octet-stream").replace(/"/g, "&quot;");
  const size = typeof file.size === "number" ? file.size : 0;
  return `<user_uploaded_file file_id="${file.id}" name="${name}" mime_type="${mime}" size="${size}" />`;
}

/** Build the full tag block appended to a user message with attachments. */
export function buildUploadTags(files: Array<{ id: string; filename: string; mime_type?: string; size?: number }>): string {
  return files.map(buildUploadTag).join("\n");
}

export interface ParsedUploadTag {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
}

const UPLOAD_TAG_RE =
  /<user_uploaded_file\s+file_id="([^"]*)"\s+name="([^"]*)"\s+mime_type="([^"]*)"\s+size="(\d+)"\s*\/>/g;

/** Legacy tag: `<@filename is uploaded check the workspace>` (pre-PRD). */
const LEGACY_TAG_RE = /<@([^>]+? is uploaded[^>]*)>/g;

/**
 * Parse every structured upload tag embedded in a message's content.
 * Accepts XML-escaped names in the tag (renders &quot; back to ").
 */
export function parseUploadTags(content: string | null | undefined): ParsedUploadTag[] {
  if (!content) return [];
  const out: ParsedUploadTag[] = [];
  const re = new RegExp(UPLOAD_TAG_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.push({
      fileId: m[1] ?? "",
      name: (m[2] ?? "").replace(/&quot;/g, '"').replace(/&amp;/g, "&"),
      mimeType: (m[3] ?? "application/octet-stream").replace(/&quot;/g, '"'),
      size: Number(m[4] ?? 0) || 0,
    });
  }
  return out;
}

/**
 * Remove every internal upload representation (structured tags AND the legacy
 * `<@… is uploaded …>` tags) from message text. Used by the renderer, the
 * clipboard copy, previews and exports — the tag must NEVER be user-visible.
 */
export function stripUploadTags(content: string | null | undefined): string {
  if (!content) return "";
  return content
    .replace(new RegExp(UPLOAD_TAG_RE.source, "g"), "")
    .replace(new RegExp(LEGACY_TAG_RE.source, "g"), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** True when a message carries at least one upload tag (new or legacy). */
export function hasUploadTags(content: string | null | undefined): boolean {
  if (!content) return false;
  return new RegExp(UPLOAD_TAG_RE.source).test(content) || LEGACY_TAG_RE.test(content);
}

// ---------------------------------------------------------------------------
// Registry reads.
// ---------------------------------------------------------------------------

function rowToRecord(row: {
  id: string;
  user_id: string;
  message_id?: string | null;
  conversation_id?: string | null;
  filename: string;
  mime_type: string;
  size: number;
  storage_path: string;
  file_type: string;
  created_at: string;
}): UploadedFileRecord {
  return {
    fileId: row.id,
    userId: row.user_id,
    messageId: row.message_id ?? null,
    conversationId: row.conversation_id ?? null,
    filename: row.filename,
    mimeType: row.mime_type,
    size: row.size,
    storagePath: row.storage_path,
    fileType: row.file_type,
    uploadedAt: row.created_at,
  };
}

/** List ALL uploaded files in the registry (newest first). */
export async function listUploads(userId: string): Promise<UploadedFileRecord[]> {
  try {
    const rows = await db.chat_files.where("user_id").equals(userId).toArray();
    return rows
      .map(rowToRecord)
      .sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
  } catch {
    return [];
  }
}

/** Resolve one record by its stable fileId. */
export async function getUpload(fileId: string, userId: string): Promise<UploadedFileRecord | null> {
  const row = await fileService.get(fileId, userId);
  return row ? rowToRecord(row) : null;
}

/** Resolve a record by its (case-insensitive) filename — newest match wins. */
export async function getUploadByName(
  name: string,
  userId: string,
): Promise<UploadedFileRecord | null> {
  const all = await listUploads(userId);
  const needle = name.trim().toLowerCase();
  return all.find((f) => f.filename.toLowerCase() === needle) ?? null;
}

// ---------------------------------------------------------------------------
// Registry reads for the AI (bytes access).
// ---------------------------------------------------------------------------

/** Read the persisted bytes of an upload. Null when missing/unavailable. */
export async function readUploadBytes(record: UploadedFileRecord): Promise<Blob | null> {
  if (!isOPFSAvailable()) return null;
  try {
    return await opfsReadFile(record.storagePath);
  } catch {
    return null;
  }
}

/** Read an upload as UTF-8 text (with a size guard). Null when unavailable. */
export async function readUploadText(
  record: UploadedFileRecord,
  maxBytes = 256 * 1024,
): Promise<{ text: string; truncated: boolean; totalSize: number } | null> {
  const blob = await readUploadBytes(record);
  if (!blob) return null;
  const slice = blob.size > maxBytes ? blob.slice(0, maxBytes) : blob;
  const text = await slice.text();
  return { text, truncated: blob.size > maxBytes, totalSize: blob.size };
}

/** Is this MIME type readable as text (code/config/data)? */
export function isTextLikeMime(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/javascript" ||
    mime === "application/typescript" ||
    mime === "application/x-yaml" ||
    mime === "application/yaml" ||
    mime === "application/sql" ||
    mime === "application/csv" ||
    mime === "image/svg+xml" ||
    mime === "application/x-sh" ||
    mime === "application/shell-script"
  );
}

// ---------------------------------------------------------------------------
// Registry writes.
// ---------------------------------------------------------------------------

/**
 * Delete an upload everywhere it lives (registry row + OPFS bytes + the
 * sandbox mirror when a key exists — best-effort). Returns true when the
 * record was found and removed.
 */
export async function deleteUpload(fileId: string, userId: string): Promise<boolean> {
  const record = await getUpload(fileId, userId);
  if (!record) return false;
  // 1. Registry row.
  await fileService.delete(fileId, userId);
  // 2. OPFS bytes (the canonical copy + the workspace/uploads copy).
  try {
    await opfsDeleteFile(record.storagePath);
  } catch {
    /* best-effort */
  }
  if (typeof window !== "undefined") {
    try {
      const { deleteFile: wsDelete } = await import("@/lib/storage/opfs");
      await wsDelete(`users/${userId}/workspace/uploads/${record.filename}`);
    } catch {
      /* best-effort */
    }
    // 3. Sandbox mirror (only when a sandbox key is configured) — the same
    //    chat-aware target the mirror write used, so the copy is removed
    //    from the sandbox it actually lives in (best-effort).
    try {
      const { settingsService } = await import("@/lib/services");
      const apiKey = await settingsService.getDecryptedSandboxKey(userId);
      if (apiKey) {
        const client = await mirrorSandboxClient(apiKey);
        await client.deleteFile(`uploads/${record.filename}`).catch(() => {});
      }
    } catch {
      /* best-effort */
    }
  }
  notifyUploadsChanged();
  return true;
}

// ---------------------------------------------------------------------------
// Sandbox mirror target (Code Mode: one chat = one app).
// ---------------------------------------------------------------------------

/**
 * Which sandbox an upload mirrors into (and deletes from). A Code Mode chat
 * mirrors into THAT chat's OWN app sandbox (per-chat "separate" mode — the
 * attachment lands in the app's isolated filesystem, next to the project
 * files the Code tools wrote); an agent chat (or an unknown conversation)
 * keeps the legacy user-level shared workspace, exactly as before.
 *
 * `conversationId` wins when given (the chat-input path); otherwise the
 * ACTIVE conversation decides (both callers fire inside the chat the user
 * is typing in / uploading from).
 */
async function mirrorSandboxClient(
  apiKey: string,
  conversationId?: string | null,
): Promise<E2BClient> {
  const convId =
    conversationId ?? useConversationStore.getState().currentConversationId ?? null;
  if (convId && (await isCodeChat(convId))) {
    return getE2BClient(apiKey, convId, "separate");
  }
  // Agent chat / unknown conversation — the legacy shared workspace.
  return getE2BClient(apiKey, null, "shared");
}

// ---------------------------------------------------------------------------
// Sandbox mirror (binary-safe).
// ---------------------------------------------------------------------------

/**
 * Mirror an upload into the E2B sandbox at `uploads/<filename>` so the AI's
 * native file tools can see it. In a Code Mode chat the mirror lands in
 * THAT chat's own app sandbox (one chat = one app = its own files); in an
 * agent chat it lands in the shared workspace (unchanged). Binary-safe: the
 * bytes go over as base64 and are decoded server-side. Collision-safe: the
 * local registry fileId is the identity — the mirror is just a convenience
 * copy for the sandbox-native tools.
 *
 * No-op (returns false) when no sandbox key is configured — the canonical
 * registry remains the AI's access path via read_uploaded_file.
 */
export async function mirrorUploadToSandbox(
  record: UploadedFileRecord,
  apiKey: string,
  conversationId?: string | null,
): Promise<boolean> {
  if (!apiKey) return false;
  try {
    const blob = await readUploadBytes(record);
    if (!blob) return false;
    const client = await mirrorSandboxClient(apiKey, conversationId);
    // base64 encode without stack-overflow on big files (chunked).
    const buf = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) {
      binary += String.fromCharCode(...buf.subarray(i, i + CHUNK));
    }
    const b64 = btoa(binary);
    const res = await client.batchWriteBytes([
      { path: `uploads/${record.filename}`, base64: b64 },
    ]);
    return res.errors.length === 0;
  } catch (err) {
    console.warn("[uploads] sandbox mirror failed for", record.filename, err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Change notification (UI sync).
// ---------------------------------------------------------------------------

/**
 * Window event fired whenever the uploads registry changes (file added or
 * deleted). The Files sidebar listens and refreshes its Uploads section, so
 * the folder reflects the persistent registry at all times.
 */
export const UPLOADS_CHANGED_EVENT = "onyx:uploads-changed";

export function notifyUploadsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(UPLOADS_CHANGED_EVENT));
}

/** Current user id (registry scope) — empty string when signed out. */
export function currentUserId(): string {
  return useAuthStore.getState().user?.id ?? "";
}

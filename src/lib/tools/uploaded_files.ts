"use client";

/**
 * Uploaded-file tools — the AI's structured access path to the canonical
 * uploads registry (File Persistence PRD §10–§13).
 *
 * Uploading a file NEVER injects its content into the model context. The
 * message carries a hidden `<user_uploaded_file file_id="…" name="…" />` tag
 * and these tools let the model DISCOVER and READ the referenced file on
 * demand through the persistent registry (Dexie record + OPFS bytes):
 *
 *   list_uploaded_files  → the full registry (id, name, mime, size, date)
 *   read_uploaded_file   → contents by name OR file_id (text-like files are
 *                          returned as text; binaries return metadata +
 *                          base64 preview with an explicit size guard)
 *
 * This works in EVERY mode — with or without an E2B sandbox key — so the AI
 * can always see the user's uploads (the sandbox mirror at `uploads/` is a
 * best-effort convenience for the sandbox-native file tools, not the source
 * of truth).
 */

import { registerTool } from "./registry";
import {
  getUpload,
  getUploadByName,
  listUploads,
  readUploadBytes,
  readUploadText,
  isTextLikeMime,
  type UploadedFileRecord,
} from "@/lib/uploads/registry";
import type { ToolContext } from "./registry";

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function recordSummary(f: UploadedFileRecord) {
  return {
    file_id: f.fileId,
    name: f.filename,
    mime_type: f.mimeType,
    size: f.size,
    size_human: humanSize(f.size),
    uploaded_at: f.uploadedAt,
    conversation_id: f.conversationId,
  };
}

// ---------------------------------------------------------------------------
// Tool: list_uploaded_files.
// ---------------------------------------------------------------------------

registerTool(
  "list_uploaded_files",
  "List every file the user has uploaded (the persistent uploads registry). Each entry has a stable file_id, name, mime type and size. Use read_uploaded_file to read one by file_id or name. This works even without a sandbox.",
  {
    type: "object",
    properties: {
      filter: {
        type: "string",
        description: "Optional case-insensitive substring to filter file names by.",
      },
    },
    additionalProperties: false,
  },
  async (args, ctx: ToolContext) => {
    const userId = ctx.userId;
    if (!userId) return { error: "No authenticated user." };
    try {
      let files = await listUploads(userId);
      const filter = typeof args.filter === "string" ? args.filter.trim().toLowerCase() : "";
      if (filter) {
        files = files.filter((f) => f.filename.toLowerCase().includes(filter));
      }
      return {
        count: files.length,
        files: files.map(recordSummary),
        hint:
          files.length > 0
            ? "Read one with read_uploaded_file (name or file_id)."
            : undefined,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `Failed to list uploaded files: ${msg}` };
    }
  },
  false,
  "files",
);

// ---------------------------------------------------------------------------
// Tool: read_uploaded_file.
// ---------------------------------------------------------------------------

registerTool(
  "read_uploaded_file",
  "Read a file the user uploaded, by name or file_id, from the persistent uploads registry. Text-like files (txt, md, json, xml, csv, source code, config…) return their UTF-8 contents (truncated at 256 KB with a `truncated` flag). Binary files (images, zips, pdfs…) return metadata plus a base64 preview (first 64 KB) — do not treat binary base64 as text. The file keeps its stable file_id across refreshes.",
  {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "File name as shown in the upload tag (e.g. example.xml).",
      },
      file_id: {
        type: "string",
        description: "Stable file id from the upload tag (preferred — exact match).",
      },
    },
    additionalProperties: false,
  },
  async (args, ctx: ToolContext) => {
    const userId = ctx.userId;
    if (!userId) return { error: "No authenticated user." };
    const fileId = typeof args.file_id === "string" ? args.file_id.trim() : "";
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!fileId && !name) {
      return { error: "Provide `name` or `file_id`." };
    }
    try {
      let record: UploadedFileRecord | null = null;
      if (fileId) record = await getUpload(fileId, userId);
      if (!record && name) record = await getUploadByName(name, userId);
      if (!record) {
        return {
          error: `Uploaded file not found: ${fileId || name}. Call list_uploaded_files to see the registry.`,
        };
      }

      // Text-like files → full contents (with the size guard).
      if (isTextLikeMime(record.mimeType)) {
        const res = await readUploadText(record, 256 * 1024);
        if (!res) {
          return {
            error: `The uploaded file "${record.filename}" is registered but its stored bytes could not be read (it may have been deleted from this device).`,
            file: recordSummary(record),
          };
        }
        return {
          file: recordSummary(record),
          content: res.text,
          truncated: res.truncated,
          total_size: res.totalSize,
        };
      }

      // Binary files → metadata + bounded base64 preview.
      const blob = await readUploadBytes(record);
      if (!blob) {
        return {
          error: `The uploaded file "${record.filename}" is registered but its stored bytes could not be read (it may have been deleted from this device).`,
          file: recordSummary(record),
        };
      }
      const PREVIEW = 64 * 1024;
      const slice = blob.size > PREVIEW ? blob.slice(0, PREVIEW) : blob;
      const buf = new Uint8Array(await slice.arrayBuffer());
      let binary = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < buf.length; i += CHUNK) {
        binary += String.fromCharCode(...buf.subarray(i, i + CHUNK));
      }
      return {
        file: recordSummary(record),
        encoding: "base64",
        binary: true,
        base64_preview: btoa(binary),
        preview_size: slice.size,
        total_size: blob.size,
        truncated: blob.size > PREVIEW,
        note: "Binary file — base64 preview only. The full file is also mirrored at uploads/<name> in the sandbox when one is configured (use list_folder/read_file there for sandbox-side work).",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `Failed to read uploaded file: ${msg}` };
    }
  },
  false,
  "files",
);

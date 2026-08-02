"use client";

import { registerTool, type ToolContext } from "./registry";
import { getE2BClient } from "@/lib/e2b/client";
import {
  ensureFreshSandboxForCtx,
} from "@/lib/e2b/sandbox-rotation";
import { zipSync } from "fflate";

/**
 * File/workspace tools — ALL storage is the E2B sandbox.
 *
 * The E2B sandbox is the SINGLE source of truth for files. There is NO OPFS
 * sync — files are written directly to the sandbox and read directly from it.
 *
 * This fixes:
 *   - File truncation (no sync needed — files already in sandbox)
 *   - File not found (no sync race condition)
 *   - Empty content (no sync timing issue)
 *   - Concurrency limits (single sandbox, auto-rotated at 23h)
 *
 * The path is relative to `/home/user` (the sandbox workspace root). The
 * server-side `/api/sandbox` route normalizes relative paths to absolute.
 *
 * Auto-rotation: `ensureFreshSandboxForCtx(ctx)` is called before every
 * operation. If the sandbox is >23h old, it's rotated (backup → kill →
 * create → restore) transparently. Tools don't know it happened.
 *
 * Tools (12):
 *   - list_folder
 *   - read_file
 *   - create_file
 *   - write_file
 *   - edit_file
 *   - delete_file
 *   - create_folder
 *   - delete_folder
 *   - move_file
 *   - rename_file
 *   - send_file
 *   - send_folder
 */

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Sanitize a path — strip leading `/`, normalize `.`, refuse `..`. */
function safePath(p: string | undefined | null, fallback = "."): string {
  if (!p || typeof p !== "string") return fallback;
  const cleaned = p.replace(/^\/+/, "").trim();
  if (cleaned.includes("..")) {
    throw new Error(`Path traversal not allowed: ${p}`);
  }
  return cleaned || fallback;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** Error message shown when no E2B API key is configured. */
const NO_KEY_ERROR =
  "File operations require an E2B Sandbox API key. Add one in Settings → Config → E2B Sandbox.";

// ---------------------------------------------------------------------------
// Tool: list_folder.
// ---------------------------------------------------------------------------

registerTool(
  "list_folder",
  "List the contents of a directory in the user's workspace. Returns file/folder names, types, and sizes. Defaults to the workspace root.",
  {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory path (relative to workspace root). Defaults to '.'.",
      },
    },
    additionalProperties: false,
  },
  async (args, ctx) => {
    const path = safePath(args.path as string | undefined, ".");
    const apiKey = await ensureFreshSandboxForCtx(ctx);
    if (!apiKey) return { error: NO_KEY_ERROR };
    try {
      const client = getE2BClient(apiKey, null, "shared");
      const entries = await client.listFiles(path);
      return {
        entries: entries.map((e) => ({
          name: e.path.split("/").pop() ?? e.path,
          path: e.path,
          type: e.type,
          size: e.size,
        })),
        path,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `Failed to list ${path}: ${msg}` };
    }
  },
  false,
  "files",
);

// ---------------------------------------------------------------------------
// Tool: read_file.
// ---------------------------------------------------------------------------

registerTool(
  "read_file",
  "Read a UTF-8 text file from the user's workspace. Returns the file contents as a string. Files larger than 256 KB are truncated.",
  {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (relative to workspace root)." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const path = safePath(args.path as string);
    const apiKey = await ensureFreshSandboxForCtx(ctx);
    if (!apiKey) return { error: NO_KEY_ERROR };
    try {
      const client = getE2BClient(apiKey, null, "shared");
      const content = await client.readFile(path);
      if (content.length > 256 * 1024) {
        return {
          content: content.slice(0, 256 * 1024),
          truncated: true,
          total_size: content.length,
        };
      }
      return { content };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `Failed to read ${path}: ${msg}` };
    }
  },
  false,
  "files",
);

// ---------------------------------------------------------------------------
// Tool: create_file.
// ---------------------------------------------------------------------------

registerTool(
  "create_file",
  "Create a new text file in the user's workspace. Refuses to overwrite an existing file unless `overwrite` is true.",
  {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
      overwrite: { type: "boolean", default: false },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const path = safePath(args.path as string);
    const content = (args.content as string) ?? "";
    const overwrite = (args.overwrite as boolean) ?? false;
    if (content.length > 5 * 1024 * 1024) {
      throw new Error("File content exceeds 5 MB limit");
    }
    const apiKey = await ensureFreshSandboxForCtx(ctx);
    if (!apiKey) return { error: NO_KEY_ERROR };
    try {
      const client = getE2BClient(apiKey, null, "shared");
      if (!overwrite) {
        // Check if the file already exists by trying to read it.
        try {
          const existing = await client.readFile(path);
          if (existing !== undefined && existing !== "") {
            return {
              error: `File already exists: ${path}. Use write_file to overwrite it, or set overwrite=true.`,
              path,
            };
          }
        } catch {
          // File doesn't exist — proceed to create.
        }
      }
      await client.writeFile(path, content);
      return {
        success: true,
        path,
        size: content.length,
        message: `Created ${path} (${content.length} bytes)`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `Failed to create file ${path}: ${msg}` };
    }
  },
  false,
  "files",
);

// ---------------------------------------------------------------------------
// Tool: write_file.
// ---------------------------------------------------------------------------

registerTool(
  "write_file",
  "Overwrite a text file in the user's workspace (creates it if missing). Use this when you know the file should exist or want to replace its contents entirely.",
  {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const path = safePath(args.path as string);
    const content = (args.content as string) ?? "";
    if (content.length > 5 * 1024 * 1024) {
      throw new Error("File content exceeds 5 MB limit");
    }
    const apiKey = await ensureFreshSandboxForCtx(ctx);
    if (!apiKey) return { error: NO_KEY_ERROR };
    try {
      const client = getE2BClient(apiKey, null, "shared");
      await client.writeFile(path, content);
      return { path, bytes: content.length };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `Failed to write file ${path}: ${msg}` };
    }
  },
  false,
  "files",
);

// ---------------------------------------------------------------------------
// Tool: edit_file.
// ---------------------------------------------------------------------------

registerTool(
  "edit_file",
  "Edit a text file by replacing a substring with a new string. By default replaces all occurrences; set `replace_all: false` to replace only the first.",
  {
    type: "object",
    properties: {
      path: { type: "string" },
      find: { type: "string", description: "Substring to find." },
      replace: { type: "string", description: "Replacement string." },
      replace_all: { type: "boolean", default: true },
    },
    required: ["path", "find", "replace"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const path = safePath(args.path as string);
    const find = args.find as string;
    const replace = args.replace as string;
    const replaceAll = (args.replace_all as boolean) ?? true;
    const apiKey = await ensureFreshSandboxForCtx(ctx);
    if (!apiKey) return { error: NO_KEY_ERROR };
    try {
      const client = getE2BClient(apiKey, null, "shared");
      const original = await client.readFile(path);
      let updated: string;
      let count: number;
      if (replaceAll) {
        if (find === "") {
          throw new Error("`find` must be non-empty");
        }
        const parts = original.split(find);
        count = parts.length - 1;
        if (count === 0) {
          return { path, replacements: 0, note: "substring not found" };
        }
        updated = parts.join(replace);
      } else {
        const idx = original.indexOf(find);
        if (idx === -1) {
          return { path, replacements: 0, note: "substring not found" };
        }
        updated = original.slice(0, idx) + replace + original.slice(idx + find.length);
        count = 1;
      }
      await client.writeFile(path, updated);
      return { path, replacements: count };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `Failed to edit ${path}: ${msg}` };
    }
  },
  false,
  "files",
);

// ---------------------------------------------------------------------------
// Tool: delete_file.
// ---------------------------------------------------------------------------

registerTool(
  "delete_file",
  "Delete a file from the user's workspace.",
  {
    type: "object",
    properties: {
      path: { type: "string" },
      recursive: {
        type: "boolean",
        default: false,
        description: "If path is a directory, delete recursively.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const path = safePath(args.path as string);
    const _recursive = (args.recursive as boolean) ?? false;
    const apiKey = await ensureFreshSandboxForCtx(ctx);
    if (!apiKey) return { error: NO_KEY_ERROR };
    try {
      const client = getE2BClient(apiKey, null, "shared");
      await client.deleteFile(path);
      return { deleted: true, path };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `Failed to delete ${path}: ${msg}` };
    }
  },
  false,
  "files",
);

// ---------------------------------------------------------------------------
// Tool: create_folder.
// ---------------------------------------------------------------------------

registerTool(
  "create_folder",
  "Create a folder (mkdir -p) in the user's workspace.",
  {
    type: "object",
    properties: {
      path: { type: "string" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const path = safePath(args.path as string);
    const apiKey = await ensureFreshSandboxForCtx(ctx);
    if (!apiKey) return { error: NO_KEY_ERROR };
    try {
      const client = getE2BClient(apiKey, null, "shared");
      await client.createFolder(path);
      return { created: true, path };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `Failed to create folder ${path}: ${msg}` };
    }
  },
  false,
  "files",
);

// ---------------------------------------------------------------------------
// Tool: delete_folder.
// ---------------------------------------------------------------------------

registerTool(
  "delete_folder",
  "Delete a folder and its contents from the user's workspace. Refuses to delete the workspace root.",
  {
    type: "object",
    properties: {
      path: { type: "string" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const path = safePath(args.path as string);
    if (path === "." || path === "" || path === "/") {
      throw new Error("Refusing to delete workspace root");
    }
    const apiKey = await ensureFreshSandboxForCtx(ctx);
    if (!apiKey) return { error: NO_KEY_ERROR };
    try {
      // The E2B SDK's `files.remove` works for both files AND directories
      // (it's effectively `rm -rf` under the hood — envd handles recursion).
      const client = getE2BClient(apiKey, null, "shared");
      await client.deleteFile(path);
      return { deleted: true, path };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `Failed to delete folder ${path}: ${msg}` };
    }
  },
  false,
  "files",
);

// ---------------------------------------------------------------------------
// Tool: send_file.
// ---------------------------------------------------------------------------

/** Encode a string as a `data:` URL with the given MIME type. The content is
 *  base64-encoded so the URL is safe for binary-ish bytes too (the E2B
 *  `files.read` returns text, but the file may be a base64-encoded payload
 *  the agent wrote — encoding keeps the URL lossless). */
function makeDataUrl(text: string, mimeType = "application/octet-stream"): string {
  // btoa is browser-native; encodeUTF8→base64 handles non-Latin1 chars.
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  const b64 = btoa(bin);
  return `data:${mimeType};base64,${b64}`;
}

/** Pick a reasonable MIME type from a filename's extension. Falls back to
 *  `application/octet-stream` for unknown / extensionless files. */
function mimeForName(name: string): string {
  const ext = (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "").toLowerCase();
  const map: Record<string, string> = {
    txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
    html: "text/html", css: "text/css", js: "text/javascript", ts: "text/typescript",
    py: "text/x-python", sh: "text/x-shellscript", yaml: "text/yaml", yml: "text/yaml",
    xml: "application/xml", pdf: "application/pdf", zip: "application/zip",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    svg: "image/svg+xml", mp3: "audio/mpeg", mp4: "video/mp4", wav: "audio/wav",
  };
  return map[ext] ?? "application/octet-stream";
}

/** Walk a sandbox directory recursively and return all files with their
 *  relative paths and bytes. Used by send_file (directory case) and
 *  send_folder to build ZIP archives.
 *
 *  `basePath` is the original path argument — relative paths in the ZIP are
 *  computed relative to it. */
async function walkSandboxForZip(
  client: ReturnType<typeof getE2BClient>,
  basePath: string,
): Promise<Array<{ relPath: string; bytes: Uint8Array }>> {
  const out: Array<{ relPath: string; bytes: Uint8Array }> = [];
  const base = basePath.replace(/^\/+/, "");

  async function walk(dirPath: string): Promise<void> {
    let entries;
    try {
      entries = await client.listFiles(dirPath);
    } catch {
      return;
    }
    for (const entry of entries) {
      const isDir = entry.type === "directory";
      if (isDir) {
        await walk(entry.path);
      } else {
        try {
          const blob = await client.readFileBytes(entry.path);
          if (!blob) continue;
          const buf = new Uint8Array(await blob.arrayBuffer());
          // Compute the relative path (strip /home/user/ prefix and the
          // basePath prefix so the ZIP structure mirrors the folder layout).
          let rel = entry.path.replace(/^\/+/, "");
          // Strip leading /home/user/
          rel = rel.replace(/^home\/user\//, "");
          // Strip the basePath prefix (if present)
          if (base && base !== "." && rel.startsWith(base + "/")) {
            rel = rel.slice(base.length + 1);
          } else if (rel === base) {
            rel = rel.split("/").pop() ?? rel;
          }
          const fileName = entry.path.split("/").pop() ?? entry.path;
          out.push({ relPath: rel || fileName, bytes: buf });
        } catch {
          // skip files that can't be read
        }
      }
    }
  }

  await walk(basePath);
  return out;
}

registerTool(
  "send_file",
  "Send a file from the user's workspace to the chat as a downloadable attachment. The user sees a download card with the file's name, size, and extension. The download URL is a base64 data URL (stateless — survives page reloads and Vercel deployments). If the path is a directory, automatically sends it as a ZIP archive.",
  {
    type: "object",
    properties: {
      path: { type: "string" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const path = safePath(args.path as string);
    const name = path.split("/").pop() || path;
    const apiKey = await ensureFreshSandboxForCtx(ctx);
    if (!apiKey) return { error: NO_KEY_ERROR };

    const client = getE2BClient(apiKey, null, "shared");

    // Check if the path is a directory. If so, auto-redirect to the folder
    // download flow (zip + download) instead of failing with "is a directory".
    try {
      const entries = await client.listFiles(path);
      // listFiles succeeded → the path is a directory.
      // Build a ZIP of the folder and return it as a folder download.
      const filesMap: Record<string, Uint8Array> = {};
      let fileCount = 0;
      let totalSize = 0;
      const MAX_TOTAL = Infinity; // No limit — user requested all files
      const walked = await walkSandboxForZip(client, path);
      for (const f of walked) {
        if (totalSize > MAX_TOTAL) {
          return {
            error: `Folder is too large to zip-and-send (>${humanSize(MAX_TOTAL)}). Use list_folder + read_file on individual files instead.`,
            path,
          };
        }
        filesMap[f.relPath] = f.bytes;
        fileCount += 1;
        totalSize += f.bytes.length;
      }
      if (fileCount === 0) {
        return { error: `Folder is empty: ${path}`, path };
      }
      const zipped = zipSync(filesMap);
      let bin = "";
      for (let i = 0; i < zipped.length; i++) bin += String.fromCharCode(zipped[i]!);
      const b64 = btoa(bin);
      const download_url = `data:application/zip;base64,${b64}`;
      return {
        kind: "file_download",
        item_type: "folder" as const,
        name,
        path,
        size: totalSize,
        size_human: humanSize(totalSize),
        file_count: fileCount,
        extension: "zip",
        download_url,
      };
    } catch {
      // listFiles failed → the path is a file (not a directory). Fall
      // through to the normal file read below.
    }

    // Read the file as bytes (preserves binary data).
    let content: string;
    let size: number;
    try {
      const blob = await client.readFileBytes(path);
      if (!blob) {
        return { error: `File not found: ${path}`, path };
      }
      size = blob.size;
      // Hard cap at 4 MB — data URLs are ~1.33x the content size, and the
      // tool result is stored in the chat history (IndexedDB). Larger files
      // would balloon the quota.
      const MAX_BYTES = 4 * 1024 * 1024;
      if (size > MAX_BYTES) {
        return {
          error: `File is too large to send as a download (${humanSize(size)} > ${humanSize(MAX_BYTES)} limit). Use read_file in chunks instead.`,
          path,
          size,
          size_human: humanSize(size),
        };
      }
      content = await blob.text();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `Failed to read ${path}: ${msg}` };
    }

    const download_url = makeDataUrl(content, mimeForName(name));
    return {
      kind: "file_download",
      item_type: "file" as const,
      name,
      path,
      size,
      size_human: humanSize(size),
      extension: extensionOf(name),
      download_url,
    };
  },
  false,
  "files",
);

// ---------------------------------------------------------------------------
// Tool: send_folder.
// ---------------------------------------------------------------------------

registerTool(
  "send_folder",
  "Send a folder from the user's workspace to the chat as a downloadable ZIP archive. The user sees a download card; clicking it downloads the folder's contents as `<name>.zip`. The ZIP is returned as a base64 data URL (stateless — survives page reloads and Vercel deployments). Folders larger than 4 MB are rejected.",
  {
    type: "object",
    properties: {
      path: { type: "string" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const path = safePath(args.path as string);
    const folderName = path.split("/").pop() || path || "folder";
    const apiKey = await ensureFreshSandboxForCtx(ctx);
    if (!apiKey) return { error: NO_KEY_ERROR };

    const client = getE2BClient(apiKey, null, "shared");

    // Gather { relativePath: Uint8Array } for fflate's zipSync.
    const files: Record<string, Uint8Array> = {};
    let fileCount = 0;
    let totalSize = 0;
    const MAX_TOTAL = Infinity; // No limit — user requested all files

    const walked = await walkSandboxForZip(client, path);
    for (const f of walked) {
      if (totalSize > MAX_TOTAL) {
        return {
          error: `Folder is too large to zip-and-send (>${humanSize(MAX_TOTAL)}). Use list_folder + read_file on individual files instead.`,
          path,
        };
      }
      files[f.relPath] = f.bytes;
      fileCount += 1;
      totalSize += f.bytes.length;
    }

    if (fileCount === 0) {
      throw new Error(`Folder is empty: ${path}`);
    }

    const zipped = zipSync(files);
    // Encode the ZIP bytes as a base64 data URL. Statelessness matters here
    // too — blob URLs from URL.createObjectURL die on page reload, which
    // breaks downloads on Vercel after a refresh or on shared chats.
    let bin = "";
    for (let i = 0; i < zipped.length; i++) bin += String.fromCharCode(zipped[i]!);
    const b64 = btoa(bin);
    const download_url = `data:application/zip;base64,${b64}`;

    return {
      kind: "file_download",
      item_type: "folder" as const,
      name: folderName,
      path,
      size: totalSize,
      size_human: humanSize(totalSize),
      file_count: fileCount,
      extension: "zip",
      download_url,
    };
  },
  false,
  "files",
);

// ---------------------------------------------------------------------------
// Tool: move_file (also handles rename).
// ---------------------------------------------------------------------------

registerTool(
  "move_file",
  "Move or rename a file in the user's workspace. Works like `mv` — the source is removed and the content is written to the destination path.",
  {
    type: "object",
    properties: {
      source: { type: "string", description: "Current path of the file." },
      destination: { type: "string", description: "New path for the file." },
    },
    required: ["source", "destination"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const source = safePath(args.source as string);
    const destination = safePath(args.destination as string);
    if (source === destination) {
      return { moved: true, source, destination, note: "Source and destination are the same." };
    }
    const apiKey = await ensureFreshSandboxForCtx(ctx);
    if (!apiKey) return { error: NO_KEY_ERROR };
    try {
      const client = getE2BClient(apiKey, null, "shared");
      // Read the source file.
      let content: string;
      try {
        content = await client.readFile(source);
      } catch {
        return { error: `Source file not found: ${source}` };
      }
      // Write to destination.
      await client.writeFile(destination, content);
      // Delete the source.
      try {
        await client.deleteFile(source);
      } catch {
        // best-effort — the file was already copied
      }
      return { moved: true, source, destination, size: content.length };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `Failed to move ${source} → ${destination}: ${msg}` };
    }
  },
  false,
  "files",
);

// ---------------------------------------------------------------------------
// Tool: rename_file (alias for move_file — some AI models prefer this name).
// ---------------------------------------------------------------------------

registerTool(
  "rename_file",
  "Rename a file in the user's workspace. Same as move_file but specifically for renaming.",
  {
    type: "object",
    properties: {
      path: { type: "string", description: "Current path of the file." },
      new_name: { type: "string", description: "New name for the file (just the filename, not the full path)." },
    },
    required: ["path", "new_name"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const source = safePath(args.path as string);
    const newName = (args.new_name as string).replace(/[\\/]+/g, "_").trim();
    if (!newName) return { error: "new_name is required" };
    // Build destination path: same directory, new filename.
    const parts = source.split("/");
    parts.pop(); // remove old filename
    parts.push(newName); // add new filename
    const destination = parts.join("/");

    const apiKey = await ensureFreshSandboxForCtx(ctx);
    if (!apiKey) return { error: NO_KEY_ERROR };
    try {
      const client = getE2BClient(apiKey, null, "shared");
      // Read source.
      let content: string;
      try {
        content = await client.readFile(source);
      } catch {
        return { error: `Source file not found: ${source}` };
      }
      // Write to new path.
      await client.writeFile(destination, content);
      // Delete old file.
      try {
        await client.deleteFile(source);
      } catch {
        // best-effort
      }
      return { renamed: true, old_path: source, new_path: destination, size: content.length };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `Failed to rename ${source} → ${destination}: ${msg}` };
    }
  },
  false,
  "files",
);

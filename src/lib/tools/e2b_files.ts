"use client";

import { registerTool, type ToolContext } from "./registry";
import * as opfs from "@/lib/storage/opfs";
import { zipSync, strToU8 } from "fflate";

/**
 * File/workspace tools — ALL storage is local (OPFS).
 *
 * The E2B sandbox is used ONLY as a code runner (run_python, run_terminal).
 * File operations (create, read, write, delete, list) ALWAYS use OPFS
 * (Origin Private File System) — the sandbox is never used for file storage.
 *
 * When the AI runs code via run_python/run_terminal, the runtime auto-syncs
 * OPFS files to the sandbox before execution so the code can access them.
 * This is fully automatic — no backup/restore needed.
 *
 * Tools (10):
 *   - list_files
 *   - read_file
 *   - create_file
 *   - write_file
 *   - edit_file
 *   - delete_file
 *   - create_folder
 *   - delete_folder
 *   - send_file
 *   - send_folder
 */

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Always returns null — files ALWAYS use OPFS. The sandbox is code-runner only. */
function assertE2BKey(_ctx: ToolContext): string | null {
  return null;
}

/** Sanitize a sandbox path — strip leading `/`, normalize `.`, refuse `..`. */
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

/** Build the OPFS workspace path for a user. */
function opfsWorkspacePath(userId: string, sub = ""): string {
  return `users/${userId}/workspace${sub ? `/${sub}` : ""}`;
}

// ---------------------------------------------------------------------------
// Tool: list_files.
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
    const key = assertE2BKey(ctx);
    if (key) {
      const client = getE2BClient(key, ctx.conversationId, ctx.sandboxMode ?? "shared");
      const files = await client.listFiles(path);
      return { entries: files, path };
    }
    // OPFS fallback.
    const entries = await opfs.listDir(ctx.userId, `workspace/${path === "." ? "" : path}`);
    return {
      entries: entries.map((e) => ({
        name: e.name,
        path: e.path,
        type: e.kind,
        size: e.size,
      })),
      path,
    };
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
    let content: string;
    const key = assertE2BKey(ctx);
    if (key) {
      const client = getE2BClient(key, ctx.conversationId, ctx.sandboxMode ?? "shared");
      content = await client.readFile(path);
    } else {
      content = await opfs.readTextFile(opfsWorkspacePath(ctx.userId, path));
    }
    if (content.length > 256 * 1024) {
      return {
        content: content.slice(0, 256 * 1024),
        truncated: true,
        total_size: content.length,
      };
    }
    return { content };
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
    const key = assertE2BKey(ctx);
    if (key) {
      // Sandbox branch (dead code — key is always null, but kept for safety)
      const client = getE2BClient(key, ctx.conversationId, ctx.sandboxMode ?? "shared");
      if (!overwrite) {
        try {
          const existing = await client.readFile(path);
          if (existing !== undefined && existing !== "") {
            throw new Error(`File already exists: ${path} (use overwrite=true to replace it)`);
          }
        } catch (err) {
          if (err instanceof Error && /already exists/.test(err.message)) {
            throw err;
          }
          // Other errors (file not found, etc.) — continue to create.
        }
      }
      try {
        await client.writeFile(path, content);
        return {
          success: true,
          path,
          size: content.length,
          message: `Created ${path} (${content.length} bytes)`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          error: `Failed to create file ${path}: ${msg}`,
        };
      }
    } else {
      // OPFS branch — this is the one that actually runs
      const opfsPath = opfsWorkspacePath(ctx.userId, path);
      const parts = path.split("/");
      const filename = parts.pop()!;
      const subdir = parts.join("/");
      if (!overwrite) {
        // Check if the file already exists by trying to read it.
        // opfs.readFile returns a Blob if the file exists, or throws if it doesn't.
        let fileExists = false;
        try {
          const blob = await opfs.readFile(opfsPath);
          // If we got here, the file exists — check if it has content
          if (blob && blob.size > 0) {
            fileExists = true;
          }
        } catch {
          // File doesn't exist — proceed to create
        }
        if (fileExists) {
          return {
            error: `File already exists: ${path}. Use write_file to overwrite it, or set overwrite=true.`,
            path,
          };
        }
      }
      try {
        // CRITICAL: when subdir is empty, pass "workspace" (no trailing slash).
        // A trailing slash causes OPFS ensurePath to create a directory with
        // an empty name, which makes the file appear as a folder.
        const subPath = subdir ? `workspace/${subdir}` : "workspace";
        await opfs.writeFile(ctx.userId, subPath, filename, content);
        return {
          success: true,
          path,
          size: content.length,
          message: `Created ${path} (${content.length} bytes)`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          error: `Failed to create file ${path}: ${msg}`,
        };
      }
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
    const key = assertE2BKey(ctx);
    if (key) {
      const client = getE2BClient(key, ctx.conversationId, ctx.sandboxMode ?? "shared");
      try {
        await client.writeFile(path, content);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `Failed to write file ${path}: ${msg}` };
      }
    } else {
      const parts = path.split("/");
      const filename = parts.pop()!;
      const subdir = parts.join("/");
      const subPath = subdir ? `workspace/${subdir}` : "workspace";
      await opfs.writeFile(ctx.userId, subPath, filename, content);
    }
    return { path, bytes: content.length };
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
    let original: string;
    const key = assertE2BKey(ctx);
    if (key) {
      const client = getE2BClient(key, ctx.conversationId, ctx.sandboxMode ?? "shared");
      original = await client.readFile(path);
      let updated: string;
      let count: number;
      if (replaceAll) {
        if (find === "") {
          throw new Error("`find` must be non-empty");
        }
        const parts = original.split(find);
        count = parts.length - 1;
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
    } else {
      const opfsPath = opfsWorkspacePath(ctx.userId, path);
      original = await opfs.readTextFile(opfsPath);
      let updated: string;
      let count: number;
      if (replaceAll) {
        const parts = original.split(find);
        count = parts.length - 1;
        updated = parts.join(replace);
      } else {
        const idx = original.indexOf(find);
        if (idx === -1) {
          return { path, replacements: 0, note: "substring not found" };
        }
        updated = original.slice(0, idx) + replace + original.slice(idx + find.length);
        count = 1;
      }
      const parts = path.split("/");
      const filename = parts.pop()!;
      const subdir = parts.join("/");
      const subPath = subdir ? `workspace/${subdir}` : "workspace";
      await opfs.writeFile(ctx.userId, subPath, filename, updated);
      return { path, replacements: count };
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
    const recursive = (args.recursive as boolean) ?? false;
    const key = assertE2BKey(ctx);
    if (key) {
      const client = getE2BClient(key, ctx.conversationId, ctx.sandboxMode ?? "shared");
      await client.deleteFile(path, recursive);
    } else {
      await opfs.deleteFile(opfsWorkspacePath(ctx.userId, path));
    }
    return { deleted: true, path };
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
    const key = assertE2BKey(ctx);
    if (key) {
      const client = getE2BClient(key, ctx.conversationId, ctx.sandboxMode ?? "shared");
      await client.createFolder(path);
    } else {
      await opfs.ensurePath(ctx.userId, `workspace/${path}`);
    }
    return { created: true, path };
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
    const key = assertE2BKey(ctx);
    if (key) {
      const client = getE2BClient(key, ctx.conversationId, ctx.sandboxMode ?? "shared");
      await client.deleteFile(path, true);
    } else {
      // OPFS doesn't have a direct recursive-delete on a directory handle —
      // walk it and remove each entry.
      const dir = await opfs.ensurePath(ctx.userId, `workspace/${path}`);
      // Best-effort recursive delete via removeEntry (supported in modern browsers).
      await (dir as unknown as {
        removeEntry: (name: string, opts?: { recursive?: boolean }) => Promise<void>;
      })
        .removeEntry(".", { recursive: true })
        .catch(() => undefined);
      // Fallback: list + remove.
      try {
        const entries = await opfs.listDir(ctx.userId, `workspace/${path}`);
        for (const e of entries) {
          await opfs.deleteFile(e.path);
        }
      } catch {
        // ignore
      }
    }
    return { deleted: true, path };
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

registerTool(
  "send_file",
  "Send a file from the user's workspace to the chat as a downloadable attachment. The user sees a download card with the file's name, size, and extension. The download URL is a base64 data URL (stateless — survives page reloads and Vercel deployments).",
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
    let content: string;
    let size: number;

    const key = assertE2BKey(ctx);
    if (key) {
      const client = getE2BClient(key, ctx.conversationId, ctx.sandboxMode ?? "shared");

      // Check if the path is a directory. If so, auto-redirect to the folder
      // download flow (zip + download) instead of failing with "is a directory".
      try {
        const entries = await client.listFiles(path);
        // If listFiles succeeded and returned entries, the path is a directory.
        // Build a ZIP of the folder and return it as a folder download.
        if (entries.length >= 0) {
          const filesMap: Record<string, Uint8Array> = {};
          let fileCount = 0;
          let totalSize = 0;
          const MAX_TOTAL = 4 * 1024 * 1024;
          for (const entry of entries) {
            if (entry.type !== "file") continue;
            if (totalSize > MAX_TOTAL) {
              return {
                error: `Folder is too large to zip-and-send (>${humanSize(MAX_TOTAL)}). Use list_folder + read_file on individual files instead.`,
                path,
              };
            }
            try {
              const fileContent = await client.readFile(entry.path);
              const bytes = strToU8(fileContent);
              const rel = entry.path.replace(/^\/+/, "").replace(new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\/?`), "");
              const fileName = entry.name ?? entry.path.split("/").pop() ?? entry.path;
              filesMap[rel || fileName] = bytes;
              fileCount += 1;
              totalSize += bytes.length;
            } catch {
              // skip individual file failures
            }
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
        }
      } catch {
        // listFiles failed → the path is a file (not a directory). Fall
        // through to the normal file read below.
      }

      content = await client.readFile(path);
      size = content.length;
    } else {
      // OPFS mode — check if the path is a directory first.
      try {
        const dir = await opfs.ensurePath(ctx.userId, `workspace/${path}`);
        const walked = await opfs.walkFiles(dir);
        if (walked.length >= 0) {
          // It's a directory — build a ZIP.
          const filesMap: Record<string, Uint8Array> = {};
          let fileCount = 0;
          let totalSize = 0;
          const MAX_TOTAL = 4 * 1024 * 1024;
          for (const f of walked) {
            if (totalSize > MAX_TOTAL) {
              return {
                error: `Folder is too large to zip-and-send (>${humanSize(MAX_TOTAL)}). Use list_folder + read_file on individual files instead.`,
                path,
              };
            }
            const file = await f.handle.getFile();
            const buf = new Uint8Array(await file.arrayBuffer());
            filesMap[f.path] = buf;
            fileCount += 1;
            totalSize += buf.length;
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
        }
      } catch {
        // Not a directory — fall through to file read.
      }

      const blob = await opfs.readFile(opfsWorkspacePath(ctx.userId, path));
      content = await blob.text();
      size = blob.size;
    }
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

    // Gather { relativePath: Uint8Array } for fflate's zipSync.
    const files: Record<string, Uint8Array> = {};
    let fileCount = 0;
    let totalSize = 0;
    const MAX_TOTAL = 4 * 1024 * 1024;

    const key = assertE2BKey(ctx);
    if (key) {
      const client = getE2BClient(key, ctx.conversationId, ctx.sandboxMode ?? "shared");
      const all = await client.listFiles(path);
      for (const entry of all) {
        if (entry.type !== "file") continue;
        if (totalSize > MAX_TOTAL) {
          return {
            error: `Folder is too large to zip-and-send (>${humanSize(MAX_TOTAL)}). Use list_folder + read_file on individual files instead.`,
            path,
          };
        }
        const content = await client.readFile(entry.path);
        const bytes = strToU8(content);
        const rel = entry.path.replace(/^\/+/, "").replace(new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\/?`), "");
        const fileName = entry.name ?? entry.path.split("/").pop() ?? entry.path;
        files[rel || fileName] = bytes;
        fileCount += 1;
        totalSize += bytes.length;
      }
    } else {
      const dir = await opfs.ensurePath(ctx.userId, `workspace/${path}`);
      const walked = await opfs.walkFiles(dir);
      for (const f of walked) {
        if (totalSize > MAX_TOTAL) {
          return {
            error: `Folder is too large to zip-and-send (>${humanSize(MAX_TOTAL)}). Use list_folder + read_file on individual files instead.`,
            path,
          };
        }
        const file = await f.handle.getFile();
        const buf = new Uint8Array(await file.arrayBuffer());
        files[f.path] = buf;
        fileCount += 1;
        totalSize += buf.length;
      }
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

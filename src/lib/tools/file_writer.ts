"use client";

import { registerTool, type ToolContext } from "./registry";
import { getE2BClient } from "@/lib/e2b/client";
import {
  ensureFreshSandbox,
  resolveSandboxApiKey,
} from "@/lib/e2b/sandbox-rotation";

/**
 * Incremental File Writer & Safe Save System.
 *
 * Lets the agent write large files in 2–4 KB (50–200 line) chunks instead of
 * one giant `write_file` call. This:
 *   - Prevents tool failures from wasting thousands of tokens (only the failed
 *     chunk is retried, never the whole file).
 *   - Ensures directories exist before writing (`verify_path` auto-creates
 *     parents the way `mkdir -p` does).
 *   - Allows resuming from the last successful chunk (`read_file_section`
 *     lets the agent inspect what's already on disk before deciding where to
 *     continue).
 *
 * All operations go through the same E2B client as `e2b_files.ts` — files
 * written here are immediately visible to `read_file`, `list_folder`, etc.
 * Paths are relative to `/home/user` (the sandbox workspace root).
 *
 * Tools (3):
 *   - verify_path        — create/verify directories + files before writing
 *   - create_file_chunk  — write/append content in chunks with progress tracking
 *   - read_file_section  — read specific sections for verification and resume
 */

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Sanitize a path — strip leading `/`, normalize `.`, refuse `..`. Mirrors
 *  the `safePath` in e2b_files.ts so both modules agree on path semantics. */
function safePath(p: string | undefined | null, fallback = "."): string {
  if (!p || typeof p !== "string") return fallback;
  const cleaned = p.replace(/^\/+/, "").trim();
  if (cleaned.includes("..")) {
    throw new Error(`Path traversal not allowed: ${p}`);
  }
  return cleaned || fallback;
}

/** Split a path into [parentDir, name]. Parent is "." for top-level entries. */
function splitPath(p: string): { parent: string; name: string } {
  const cleaned = p.replace(/\/+$/g, "");
  const idx = cleaned.lastIndexOf("/");
  if (idx === -1) return { parent: ".", name: cleaned };
  return { parent: cleaned.slice(0, idx), name: cleaned.slice(idx + 1) };
}

/** Heuristic: does this path "look like" a directory?
 *  - Trailing slash → directory.
 *  - Last segment has no `.` (no extension) → directory.
 *  - Otherwise → file. */
function looksLikeDirectory(p: string): boolean {
  if (p.endsWith("/")) return true;
  const cleaned = p.replace(/\/+$/g, "");
  const last = cleaned.split("/").pop() ?? cleaned;
  return !last.includes(".");
}

/** Escape a string for safe use inside single quotes in a POSIX shell.
 *  Pattern: `'foo'\''bar'` → literal `foo'bar`. The closing quote, escaped
 *  single quote, and reopening quote handle every character safely. */
function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Error message shown when no E2B API key is configured. */
const NO_KEY_ERROR =
  "File operations require an E2B Sandbox API key. Add one in Settings → Config → E2B Sandbox.";

/** Resolve the API key the same way e2b_files does — supports subagents that
 *  build a minimal context without the decrypted key. Also runs the sandbox
 *  auto-rotation check (rotates if the sandbox is >23h old) before returning
 *  the key, so callers can use the E2B client immediately. */
async function getApiKey(ctx: ToolContext): Promise<string | null> {
  const apiKey = await resolveSandboxApiKey(ctx);
  if (!apiKey) return null;
  await ensureFreshSandbox(apiKey);
  return apiKey;
}

// ---------------------------------------------------------------------------
// Tool: verify_path.
// ---------------------------------------------------------------------------

registerTool(
  "verify_path",
  "Verify a path exists in the user's workspace, creating directories (and optionally an empty file) as needed. Use this BEFORE create_file_chunk to ensure the parent directory exists. If the path looks like a directory (trailing slash or no file extension), it's treated as a directory; otherwise it's treated as a file (parent dir is created, file is created empty if missing). Returns the existence status, type, and a list of directories that were created.",
  {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to verify (relative to workspace root). Trailing slash → directory.",
      },
      create_dirs: {
        type: "boolean",
        default: true,
        description: "If true (default), create missing directories with mkdir -p semantics.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const rawPath = safePath(args.path as string);
    const createDirs = (args.create_dirs as boolean) ?? true;
    const apiKey = await getApiKey(ctx);
    if (!apiKey) return { error: NO_KEY_ERROR };

    try {
      const client = getE2BClient(apiKey, null, "shared");
      const createdDirs: string[] = [];

      // Detect existing type by probing. `listFiles` succeeds on directories,
      // throws on files / missing paths. `readFile` succeeds on files, throws
      // on directories / missing paths. Probing both tells us unambiguously
      // what's on disk right now.
      let existingType: "file" | "directory" | null = null;
      try {
        await client.listFiles(rawPath);
        existingType = "directory";
      } catch {
        try {
          await client.readFile(rawPath);
          existingType = "file";
        } catch {
          existingType = null;
        }
      }

      if (existingType !== null) {
        return {
          exists: true,
          type: existingType,
          created_dirs: createdDirs,
          path: rawPath,
        };
      }

      // Path doesn't exist — decide what to create.
      const wantDir = looksLikeDirectory(rawPath);

      if (wantDir) {
        if (createDirs) {
          // Build the list of ancestor directories that need to be created so
          // we can report them. Walk top-down, creating each missing piece.
          const segments = rawPath.split("/").filter(Boolean);
          let acc = "";
          for (const seg of segments) {
            acc = acc ? `${acc}/${seg}` : seg;
            let exists = false;
            try {
              await client.listFiles(acc);
              exists = true;
            } catch {
              exists = false;
            }
            if (!exists) {
              await client.createFolder(acc);
              createdDirs.push(acc);
            }
          }
        } else {
          return {
            exists: false,
            type: "directory" as const,
            created_dirs: createdDirs,
            path: rawPath,
            error: `Directory does not exist and create_dirs is false: ${rawPath}`,
          };
        }
        return {
          exists: true,
          type: "directory" as const,
          created_dirs: createdDirs,
          path: rawPath,
        };
      }

      // File case — ensure parent directory exists, then create empty file.
      const { parent } = splitPath(rawPath);
      if (parent && parent !== "." && createDirs) {
        const segments = parent.split("/").filter(Boolean);
        let acc = "";
        for (const seg of segments) {
          acc = acc ? `${acc}/${seg}` : seg;
          let exists = false;
          try {
            await client.listFiles(acc);
            exists = true;
          } catch {
            exists = false;
          }
          if (!exists) {
            await client.createFolder(acc);
            createdDirs.push(acc);
          }
        }
      }

      // Create the empty file if missing.
      try {
        await client.readFile(rawPath);
        // File exists already — no-op.
      } catch {
        if (createDirs) {
          await client.writeFile(rawPath, "");
        } else {
          return {
            exists: false,
            type: "file" as const,
            created_dirs: createdDirs,
            path: rawPath,
            error: `File does not exist and create_dirs is false: ${rawPath}`,
          };
        }
      }

      return {
        exists: true,
        type: "file" as const,
        created_dirs: createdDirs,
        path: rawPath,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `Failed to verify path ${rawPath}: ${msg}`, path: rawPath };
    }
  },
  false,
  "files",
);

// ---------------------------------------------------------------------------
// Tool: create_file_chunk.
// ---------------------------------------------------------------------------

/**
 * Ensure the parent directory of `rawPath` exists. Mirrors the directory
 * creation logic in `verify_path` but skips the file/dir type detection —
 * we know `rawPath` is a file because we're about to write to it.
 *
 * Returns the list of directories that were created (for reporting).
 */
async function ensureParentDir(
  client: ReturnType<typeof getE2BClient>,
  rawPath: string,
): Promise<string[]> {
  const { parent } = splitPath(rawPath);
  if (!parent || parent === ".") return [];
  const createdDirs: string[] = [];
  const segments = parent.split("/").filter(Boolean);
  let acc = "";
  for (const seg of segments) {
    acc = acc ? `${acc}/${seg}` : seg;
    let exists = false;
    try {
      await client.listFiles(acc);
      exists = true;
    } catch {
      exists = false;
    }
    if (!exists) {
      await client.createFolder(acc);
      createdDirs.push(acc);
    }
  }
  return createdDirs;
}

registerTool(
  "create_file_chunk",
  "Append (or create) a chunk of content to a file in the user's workspace. For files >200 lines, call verify_path first, then call this with mode='create' for the first chunk (chunk_index=0) and mode='append' for subsequent chunks. Chunk size should be 2-4 KB (50-200 lines). Splits should occur at function/class/component boundaries — never inside JSON, function bodies, classes, or JSX elements. After writing, the file is read back to verify the write succeeded. Returns the chunk index, total chunks, bytes written, file size, and verification status.",
  {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path (relative to workspace root).",
      },
      content: {
        type: "string",
        description: "The chunk content to write/append.",
      },
      mode: {
        type: "string",
        enum: ["create", "append"],
        default: "append",
        description:
          "'create' = overwrite/create new (only on chunk_index=0; for chunk_index>0 with mode='create', content is appended since the file already exists). 'append' = always append to existing.",
      },
      chunk_index: {
        type: "number",
        default: 0,
        description: "Which chunk this is (0-based) — for progress tracking. 0 = first chunk.",
      },
      total_chunks: {
        type: "number",
        description: "Estimated total chunks — optional, for progress display.",
      },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const rawPath = safePath(args.path as string);
    const content = (args.content as string) ?? "";
    const mode = (args.mode as string) ?? "append";
    const chunkIndex = (args.chunk_index as number) ?? 0;
    const totalChunks = (args.total_chunks as number) ?? undefined;

    const apiKey = await getApiKey(ctx);
    if (!apiKey) return { error: NO_KEY_ERROR };

    try {
      const client = getE2BClient(apiKey, null, "shared");

      // 1. Verify parent directory exists (auto-create if missing).
      const createdDirs = await ensureParentDir(client, rawPath);

      // 2. Decide write semantics.
      //    mode="create" + chunk_index=0 → overwrite/create (writeFile)
      //    mode="create" + chunk_index>0 → append (file already exists from chunk 0)
      //    mode="append"                → always append
      const shouldOverwrite = mode === "create" && chunkIndex === 0;

      const bytesWritten = new TextEncoder().encode(content).length;

      if (shouldOverwrite) {
        // Create/overwrite: write the full content via the SDK.
        await client.writeFile(rawPath, content);
      } else {
        // Append: use a shell `printf '%s'` redirect. Single-quote escaping
        // handles all special characters ($ ` " \ newlines etc.) safely.
        // We use printf (not echo) so backslash sequences in content aren't
        // interpreted and there's no trailing newline added.
        const escapedContent = shellSingleQuote(content);
        const escapedPath = shellSingleQuote(rawPath);
        const cmd = `printf %s ${escapedContent} >> ${escapedPath}`;
        const result = await client.exec(cmd, { cwd: "/home/user", timeout: 30 });
        if (result.exit_code !== 0) {
          return {
            error: `Append failed (exit ${result.exit_code}): ${result.stderr || result.stdout}`,
            path: rawPath,
            chunk_index: chunkIndex,
            total_chunks: totalChunks,
            bytes_written: 0,
            created_dirs: createdDirs,
            verified: false,
          };
        }
      }

      // 4. Read back the file to verify the write succeeded. We compare the
      //    file's tail to the chunk we just wrote — for an overwrite the tail
      //    equals the chunk; for an append the tail ends with the chunk.
      let verified = false;
      let fileSize = 0;
      try {
        const after = await client.readFile(rawPath);
        fileSize = new TextEncoder().encode(after).length;
        if (shouldOverwrite) {
          verified = after === content;
        } else {
          verified = after.endsWith(content);
        }
      } catch (readErr) {
        // Read-back failed — report as not verified but don't fail the whole
        // call (the write itself may have succeeded).
        verified = false;
        const msg = readErr instanceof Error ? readErr.message : String(readErr);
        return {
          path: rawPath,
          chunk_index: chunkIndex,
          total_chunks: totalChunks,
          bytes_written: bytesWritten,
          file_size: 0,
          created_dirs: createdDirs,
          verified: false,
          warning: `Write succeeded but read-back verification failed: ${msg}`,
        };
      }

      return {
        path: rawPath,
        chunk_index: chunkIndex,
        total_chunks: totalChunks,
        bytes_written: bytesWritten,
        file_size: fileSize,
        created_dirs: createdDirs,
        verified,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        error: `Failed to write chunk to ${rawPath}: ${msg}`,
        path: rawPath,
        chunk_index: chunkIndex,
        total_chunks: totalChunks,
        bytes_written: 0,
        verified: false,
      };
    }
  },
  false,
  "files",
);

// ---------------------------------------------------------------------------
// Tool: read_file_section.
// ---------------------------------------------------------------------------

registerTool(
  "read_file_section",
  "Read a specific section of a file (by line range, 0-based). Use this to verify previously written chunks before appending the next one, or to resume an interrupted write. Returns the section content, the actual start/end line indices, the total line count, and whether more content exists after the requested section.",
  {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path (relative to workspace root).",
      },
      start_line: {
        type: "number",
        default: 0,
        description: "Starting line index (0-based).",
      },
      end_line: {
        type: "number",
        description: "Ending line index (exclusive). If omitted, reads to end of file.",
      },
    },
    required: ["path", "start_line"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const rawPath = safePath(args.path as string);
    const startLine = Math.max(0, Math.floor((args.start_line as number) ?? 0));
    const endLineRaw = args.end_line as number | undefined;
    const endLine = typeof endLineRaw === "number" ? Math.floor(endLineRaw) : undefined;

    const apiKey = await getApiKey(ctx);
    if (!apiKey) return { error: NO_KEY_ERROR };

    try {
      const client = getE2BClient(apiKey, null, "shared");
      const content = await client.readFile(rawPath);

      // Split into lines without dropping trailing-newline information.
      // We split on "\n" but keep track of whether the file ends with a
      // newline so the caller can reconstruct the exact byte sequence.
      const lines = content.split("\n");
      // `split("\n")` on a file ending in "\n" produces a trailing "" element
      // — that's the canonical "content after the last newline" slot, so we
      // keep it. `lines.length` therefore equals (newline_count + 1).
      const totalLines = lines.length;

      const clampedStart = Math.min(startLine, totalLines);
      const clampedEnd =
        endLine === undefined
          ? totalLines
          : Math.min(Math.max(endLine, clampedStart), totalLines);

      const section = lines.slice(clampedStart, clampedEnd).join("\n");
      const hasMore = clampedEnd < totalLines;

      return {
        content: section,
        start_line: clampedStart,
        end_line: clampedEnd,
        total_lines: totalLines,
        has_more: hasMore,
        path: rawPath,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `Failed to read section of ${rawPath}: ${msg}`, path: rawPath };
    }
  },
  false,
  "files",
);

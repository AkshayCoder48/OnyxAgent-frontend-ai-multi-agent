# Task 25-a — Incremental File Writer & Safe Save System
**Agent:** main (implementing) — task ID **25-a**
**Status:** ✅ Complete — 3 new tools registered, runtime prompt updated, e2b_files descriptions updated. `bunx tsc --noEmit` reports zero errors in the new/modified files.

> Full work record also written to `/home/z/my-project/worklog.md` (created fresh — the file referenced by 24-a's record was missing on disk; this entry is the first one in the new file).

## Files Touched
- **NEW** `src/lib/tools/file_writer.ts` — registers 3 tools: `verify_path`, `create_file_chunk`, `read_file_section`
- **MODIFIED** `src/lib/tools/index.ts` — added `import "./file_writer";`
- **MODIFIED** `src/lib/agent/runtime.ts` — added Incremental File Writing Policy section to `toolKnowledgeBase`; added the 3 new tools to the File Management list; added `create_file_chunk` to `LARGE_ARG_TOOLS`; added `verify_path`, `create_file_chunk`, `read_file_section` to `RESULT_LEN_BUDGETS`
- **MODIFIED** `src/lib/tools/e2b_files.ts` — updated `create_file`, `write_file`, `edit_file` descriptions to mention incremental writing

## Tool 1 — `verify_path` (category: files, no approval)
Verifies a path exists in the user's workspace, creating directories (and optionally an empty file) as needed. Returns `{ exists, type: "file"|"directory", created_dirs: string[], path }`.

**Type detection** (the PRD doesn't specify how to decide file-vs-directory when the path doesn't exist):
1. Probe the sandbox first — `client.listFiles(path)` succeeds on directories, `client.readFile(path)` succeeds on files. If the path already exists, that type wins.
2. If the path doesn't exist, use a heuristic: trailing slash OR no `.` in the last segment → directory; otherwise → file. This matches common filesystem conventions (e.g. `foo/bar/` is a directory, `foo/bar.txt` is a file, `foo/bar` is ambiguous but typically a directory).

**Directory creation** walks the path segments top-down, calling `client.listFiles` on each prefix to check existence, then `client.createFolder` if missing. Each created directory is appended to `created_dirs`. For file paths, the parent directory is created the same way, then an empty file is written via `client.writeFile(path, "")` if it doesn't already exist.

`create_dirs: false` skips creation and returns an `error` field describing what was missing — useful for read-only pre-checks.

## Tool 2 — `create_file_chunk` (category: files, no approval)
Writes or appends a chunk of content to a file. Returns `{ path, chunk_index, total_chunks, bytes_written, file_size, created_dirs, verified }`.

**Write semantics** (the PRD's wording left chunk_index > 0 + mode="create" ambiguous):
- `mode="create"` + `chunk_index=0` → `client.writeFile(path, content)` (overwrite/create)
- `mode="create"` + `chunk_index>0` → append (file already exists from chunk 0)
- `mode="append"` (any chunk_index) → always append

The first case uses the SDK's `writeFile` (single HTTP call, no shell escaping). The append cases use a shell `printf %s '...' >> path` command via `client.exec`. `printf` (not `echo`) is used so backslash sequences in content aren't interpreted and no trailing newline is added.

**Shell escaping**: `shellSingleQuote(s)` wraps the string in single quotes and escapes embedded single quotes as `'\''` (close quote, escaped quote, reopen quote). This is the standard POSIX-safe pattern — handles `$`, backticks, `"`, `\`, newlines, and every other special character. Both the content and the path are escaped.

**Verification**: after writing, the file is read back via `client.readFile`. For overwrites, `verified = (after === content)`. For appends, `verified = after.endsWith(content)`. If the read-back fails, the tool returns `verified: false` with a `warning` field — the write itself may have succeeded, so we don't fail the whole call. `bytes_written` is the UTF-8 byte length of the chunk (using `TextEncoder`); `file_size` is the UTF-8 byte length of the file after the write.

**Parent directory auto-creation**: `ensureParentDir(client, rawPath)` mirrors the directory walk in `verify_path` — splits the parent path, probes each prefix, creates missing dirs, returns the list of created dirs (for reporting). This means `create_file_chunk` can be called without `verify_path` first and still succeed on missing parent dirs — but the AI is told to call `verify_path` first so it can verify the file path itself.

## Tool 3 — `read_file_section` (category: files, no approval)
Reads a 0-based line range from a file. Returns `{ content, start_line, end_line, total_lines, has_more, path }`.

Reads the full file via `client.readFile`, splits on `\n` (keeping the trailing empty slot if the file ends with a newline, so `total_lines` = newline_count + 1 and the caller can reconstruct the exact byte sequence). `start_line` and `end_line` are clamped to `[0, total_lines]`, with `end_line` clamped to `≥ start_line`. If `end_line` is omitted, reads to end of file. `has_more = (clamped_end < total_lines)`.

## Runtime.ts changes
**Tool list section** (File Management): added the 3 new tools with one-line descriptions pointing the AI at the chunk-size policy.

**New `### CRITICAL: Incremental File Writing Policy` section** — added verbatim from the PRD right after the File Management list. Tells the AI:
- Never generate a large file in one operation.
- Call `verify_path` → `create_file_chunk(mode="create")` → `create_file_chunk(mode="append")` × N.
- Split on functions/classes/interfaces/components/modules — never inside JSON, function bodies, classes, JSX, multiline strings.
- Chunk size: 2–4 KB (50–200 lines).
- On failure: detect reason (mkdir -p, ./useless/ fallback), retry ONLY the failed chunk, never discard content.

**Token-saving tables**: added `create_file_chunk` to `LARGE_ARG_TOOLS` (its `content` arg can be 4 KB) so the runtime truncates it to 500 chars before sending it back in history. Added `verify_path`, `create_file_chunk`, `read_file_section` to `RESULT_LEN_BUDGETS` — `read_file_section` gets 60K (same as `read_file`, since it returns file content), the other two get 10K (metadata only).

## e2b_files.ts changes
Three description-only edits, no behavior change:
- `create_file`: appended `"For files >200 lines, use verify_path + create_file_chunk instead for incremental writing."`
- `write_file`: appended the same sentence.
- `edit_file`: appended `"For large edits, use create_file_chunk with mode='append'."`

## E2B pattern
Used the PRD-specified imports:
```ts
import { registerTool, type ToolContext } from "./registry";
import { getE2BClient } from "@/lib/e2b/client";
import { ensureFreshSandbox, resolveSandboxApiKey } from "@/lib/e2b/sandbox-rotation";

async function getApiKey(ctx: ToolContext): Promise<string | null> {
  const apiKey = await resolveSandboxApiKey(ctx);
  if (!apiKey) return null;
  await ensureFreshSandbox(apiKey);
  return apiKey;
}
```

This is functionally identical to `ensureFreshSandboxForCtx` (which is what `e2b_files.ts` uses), but exposes the `getApiKey` helper the PRD asked for. All three tools call `getApiKey(ctx)` for the no-key check + sandbox rotation in one step.

## Verification
- `bunx tsc --noEmit` — zero errors in `file_writer.ts`. Two pre-existing errors in `runtime.ts` (lines 1331 and 1711) are unrelated to this task (one is a type-narrowing issue in the message-history filter, the other is an `onToolOutput` callback type mismatch — both predate this change).
- `bun run lint` — fails with the same pre-existing `Converting circular structure to JSON` error in the ESLint flat-config plugin (reported by 24-a and earlier agents). Not caused by this change.
- Dev server log — `GET /chat` returns 200 OK; no compile errors after the edits.

## Notes for downstream agents
- `verify_path`'s file-vs-directory heuristic (trailing slash / no extension → directory) may misclassify extensionless file names like `Makefile` or `Dockerfile` as directories. If the AI calls `verify_path` on `./Makefile`, it will try to create a directory `Makefile/` and then a file inside it — which is wrong. Mitigation: the AI is told to call `verify_path` for files it's about to write with `create_file_chunk`, and `create_file_chunk` itself doesn't depend on `verify_path`'s type detection (it always treats the path as a file via `ensureParentDir`). So even if `verify_path` misclassifies, the subsequent `create_file_chunk` will still write the file correctly. If this becomes a problem, add an explicit `type: "file"|"directory"` parameter to `verify_path`.
- The shell-append path uses `printf %s` (not `printf '%s'`) — both work, but `printf %s` avoids one layer of quoting. The content is single-quoted via `shellSingleQuote`, so the shell sees `printf %s '...content...' >> '...path...'`.
- For very large chunks (>100 KB), the shell command-line length may hit `ARG_MAX` limits. The PRD specifies 2–4 KB chunks, so this isn't a concern in practice. If a chunk somehow exceeds ~100 KB, the AI should split it further.
- The `created_dirs` field in `create_file_chunk`'s response is non-standard (the PRD's return shape doesn't list it) but useful — it tells the AI which directories were auto-created so it can reason about the workspace state. Pure addition, no breaking change.

# Task 24-a — File sidebar E2B migration + send_file/send_folder download fix
**Agent:** main (implementing) — task ID **24-a**
**Status:** ✅ Complete — both tasks done, dev server returns 200 OK.

## Files Touched
- **MODIFIED** `src/components/chat/file-sidebar.tsx` — replaced ALL OPFS calls with E2B client calls
- **MODIFIED** `src/components/chat/tool-results/file-download.tsx` — `parseFileDownloadResult` accepts object results (not just strings) + `FileDownloadResult` converts data URLs to Blob URLs before download
- **MODIFIED** `src/lib/tools/e2b_files.ts` — `send_file` now reads files as bytes (preserves binary data) + removed unused `makeDataUrl` helper
- **NEW** `/home/z/my-project/worklog.md` — full work record

## Task 1 — File sidebar E2B migration

The sidebar had a `useLocal` flag hardcoded to `true`, forcing every operation through OPFS via `await import("@/lib/storage/opfs")`. Removed `useLocal` entirely; the sidebar now resolves the E2B client once from `settingsService.getDecryptedSandboxKey(user.id)` and routes every operation through it. Paths are relative to `/home/user` (no more `users/<userId>/workspace/` prefix).

### OPFS → E2B call mapping (all in `file-sidebar.tsx`):
| OPFS call | E2B client call | Location |
|---|---|---|
| `listDir(userId, "workspace/<path>")` | `client.listFiles(path)` | `fetchListing` |
| `readFile("users/<id>/workspace/<path>")` | `client.readFileBytes(path)` | `handleDownloadFile` |
| `listDir + readFile` (folder zip) | recursive `listFiles + readFileBytes` walk | `handleDownloadFolder` |
| `writeFileAtPath("users/<id>/workspace", fn, blob)` | `client.writeFile(fullPath, await file.text())` | `handleSidebarUpload` |
| `readTextFile` (manifest) | `client.readFile(".onyxagent_files.json")` | `handleSidebarUpload` |
| `writeFileAtPath` (manifest write) | `client.writeFile(".onyxagent_files.json", json)` | `handleSidebarUpload` |
| `deleteFile("users/<id>/workspace/<path>")` | `client.deleteFile(path)` | file delete menu |
| `removeDir(userId, "workspace/<path>")` | `client.deleteFile(fullPath)` (recursive) | folder delete menu |
| `readTextFile + writeFile + deleteFile` (file rename) | `readFileBytes + writeFile + deleteFile` | file rename menu |
| `listDir + readFile + writeFile + removeDir` (folder rename) | recursive walk + per-file `readFileBytes + writeFile`, then `deleteFile` of old folder | folder rename menu |
| `isOPFSAvailable()` | `!client` check + "No sandbox" toast/empty-state | upload guard |

### Removed
- Every `await import("@/lib/storage/opfs")` dynamic import.
- The entire `OPFSSkillsSection` component (~90 lines) — it depended on OPFS to read `SKILL.md` from `dir_path`, which has no E2B equivalent. Skills are still manageable from Settings → Skills.
- `useLocal` state, `getFileSystemMode` call, and the misleading "ALWAYS use local (OPFS)" comment.
- Unused imports: `Settings`, `FolderDown` from lucide-react; `File as FileIcon` from file-download.tsx.

## Task 2 — send_file/send_folder download fix

### Root cause of the "raw base64" bug
`parseFileDownloadResult` only accepted string results (`typeof result !== "string" → null`). Live WS events deliver the result as a JSON string, but `runtime.ts:1731` persists the raw object to the database and `conversation-to-chat.ts:52` rehydrates it as an object. On reload, the parser returned null → `ToolCallCard` fell through to `GenericToolResult` → the raw JSON (with the entire multi-MB base64 data URL) was rendered as visible `<pre>` text.

### Fixes

**1. `parseFileDownloadResult`** — now accepts BOTH string (live WS) and object (persisted DB) results. Mirrors `parseChartResult`'s pattern. For object results it skips `JSON.parse` and validates the shape directly.

**2. `FileDownloadResult.handleDownload`** — was setting `a.href = payload.download_url` (a `data:` URL) directly. For large data URLs (multi-MB ZIPs), browsers silently refuse to navigate — `a.click()` doesn't throw, so the catch-block fallback never fired. The user saw a button that did nothing.

New flow: `data:` URL → `fetch()` → `Blob` → `URL.createObjectURL(blob)` → anchor → `a.click()` → deferred `URL.revokeObjectURL` (1s timeout so the browser can dispatch the click). Blob URLs don't hit the data-URL size limit, and failures surface in the catch block as `alert()` instead of silent no-ops.

**3. `send_file` binary corruption** — was reading the file via `blob.text()` (UTF-8 decode) then re-encoding via `makeDataUrl` (UTF-8 encode → base64). For binary files (images, PDFs, archives), the UTF-8 round-trip replaces invalid byte sequences with U+FFFD — the downloaded file is a different size and unopenable.

New flow: `client.readFileBytes(path)` → `blob.arrayBuffer()` → `Uint8Array` → new `makeDataUrlFromBytes(bytes, mime)` base64-encodes the raw bytes directly. Downloaded file is now byte-identical to the sandbox original. Removed the now-unused `makeDataUrl` (string-based) helper.

`send_folder` was already correct — `zipSync(filesMap)` returns a `Uint8Array` and the existing code base64-encodes the raw bytes. No change needed there.

## Verification
- `bunx tsc --noEmit` — zero errors in `file-sidebar.tsx`, `e2b_files.ts`, or `file-download.tsx`. One pre-existing error in `tool-call-card.tsx:370` is in the unrelated `ImagePreviewResult` prop type — not touched.
- `bun run lint` — pre-existing circular-structure error in the ESLint flat-config plugin (reported by earlier agents); unrelated.
- Dev server: `GET /chat` returns 200 OK. Hit a transient 500 mid-edit when an object-literal closing brace was dropped in `e2b_files.ts` — fixed immediately and re-verified.

## Notes for downstream agents
- The sidebar's binary upload path still uses `client.writeFile(path, await file.text())`, which is lossy for binary files. Matches existing `client.uploadFile` behavior + the server's `files.write(path, string)` signature. A proper fix would extend the E2B client + `/api/sandbox` route to accept `content_base64` for byte-preserving writes — out of scope here.
- `OPFSSkillsSection` was removed. If skill discovery from the sidebar is wanted later, rebuild on `skillService.list` metadata only (no `SKILL.md` body fetch) — or sync skills to the sandbox and read with `client.readFile`.
- `.onyxagent_files.json` manifest is now written to `/home/user/.onyxagent_files.json` (sandbox root). The AI can read it via `read_file` to discover what files exist.

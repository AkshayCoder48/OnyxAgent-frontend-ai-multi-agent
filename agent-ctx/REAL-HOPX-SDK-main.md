# REAL-HOPX-SDK — main (Z.ai Code orchestrator)

## Task
Rewrite the Hopx client at `/home/z/my-project` to use the real `@hopx-ai/sdk` package instead of the fake REST client. Plus six auxiliary fixes: stream tool output in real time, remove tool approval, fix max-rounds error, remove question limit, fix blob-URL download issue, and surface live output in the tool-call card.

## Files edited (12 total)

1. `src/lib/hopx/client.ts` — **full rewrite**. Dynamic `import("@hopx-ai/sdk")` cached via `loadSdk()`. `HopxClient` keeps the same public surface so `hopx_exec`/`hopx_files`/`hopx_rag`/`file-sidebar.tsx` work unchanged. Per-key sandbox cache (1-hour TTL, `SANDBOX_TTL_MS`). `runPythonStream` uses `sandbox.runCodeStream` (with non-streaming fallback if the SDK's WebSocket transport fails in the browser). `runCommandStream` uses `commands.run` (no streaming shell API in the SDK). `searchFiles` shells out to `grep -rni`. `uploadFile` accepts `File|Blob|Uint8Array|ArrayBuffer` and prefers `files.writeBytes`.

2. `src/lib/hopx/empty-stub.cjs` — **NEW**. CJS stub module that aliases Node-only packages (`http`, `https`, `crypto`, `fs`, `fs/promises`, `path`, `os`, `tar`, `glob`, `ws`, `form-data`, etc.) for the browser bundle. Returns a `Proxy` whose `get` returns a throwing function for any property access. Inert for our browser code path (axios XHR adapter) — only fires if a Node-only feature (Template building, `files.upload(localPath)`, `runCodeStream` via `ws`) is invoked.

3. `next.config.ts` — added `transpilePackages: ["@hopx-ai/sdk"]` + a `webpack` config block (`resolve.fallback` stubs for `next build`) + a `turbopack.resolveAlias` block (for `next dev` — Next.js 16 uses Turbopack by default and ignores `webpack.resolve.fallback`). Each Node-only module is aliased to `./src/lib/hopx/empty-stub.cjs` for browser builds.

4. `src/lib/tools/registry.ts` — added `onToolOutput?: (toolCallId: string, output: string, type: "stdout"|"stderr") => void` to `ToolContext`.

5. `src/lib/tools/hopx_exec.ts` — `run_python` calls `client.runPythonStream(code, onOutput, opts)`; `run_terminal` calls `client.runCommandStream(command, onOutput, opts)`. Each pipes chunks through `ctx.onToolOutput`. `requires_approval` flag is now `false` on both. Output cap raised from 64 KB → 256 KB. Shell-operator regex check was relaxed (the SDK wraps commands in `bash -c`).

6. `src/lib/tools/hopx_files.ts` — `send_file` and `send_folder` now return base64 **data URLs** (`data:<mime>;base64,<b64>`) instead of `URL.createObjectURL(blob)`. Data URLs are stateless — they survive page reloads and Vercel deployments. 4 MB cap on files and folders (returns a structured `{error}` instead of a `file_download` payload if exceeded). `send_file` picks a MIME type from the filename extension; `send_folder` zips with `fflate.zipSync` then base64-encodes the bytes.

7. `src/lib/tools/ask_user.ts` — removed `maxItems: 10` from the JSON Schema and the runtime `length > 10` check. Updated the tool description. The `QuestionPrompt` UI already steps through questions one at a time, so no other limit existed.

8. `src/lib/agent/runtime.ts` — three changes:
   - **Removed tool approval**: deleted `waitForApproval()` and the `if (toolDef.requires_approval && !opts.autoApproveTools)` branch. Every tool now executes immediately when the model invokes it. `opts.autoApproveTools` is kept for back-compat but documented as deprecated/no-op.
   - **MAX_ROUNDS 10 → 50**: when max rounds is reached, persist whatever content was generated (no `error` event) and emit `final_result` + `message_saved` + `complete` like a normal completion.
   - **Streaming output**: for each tool call, the runtime builds a per-call `streamingToolCtx` whose `onToolOutput` callback emits `{type: "tool_output", data: {tool_call_id, content, type}}`. The empty `toolCallId` passed by `hopx_exec` is replaced with the real `tc.id`.

9. `src/types/chat.ts` — added `"tool_output"` to `WSEventType`. Extended `ToolCall` with `streamingOutput?: string` and `streamingError?: string` (populated by `tool_output` events; replaced by `result` when `tool_result` arrives).

10. `src/stores/chat-store.ts` — added `appendToolStreamingOutput(messageId, toolCallId, text, type)` store action. Updates both the `parts` array and the flat `toolCalls` array (same pattern as `updateToolCallPart`).

11. `src/hooks/use-chat.ts` — added `case "tool_output"` to the WSEvent handler. Calls `appendToolStreamingOutput(currentMessageId, tool_call_id, content, type)`. Added `appendToolStreamingOutput` to the destructured store actions + the handler's `useCallback` deps.

12. `src/components/chat/tool-call-card.tsx` — `RunningToolPanel` now reads `toolCall.streamingOutput` / `toolCall.streamingError` and renders them in a `Live output` pane (pulsing dot + total byte count, stderr colored `text-destructive`). Output is tail-capped to 6 KB so huge logs don't choke the DOM. Added `STREAM_TAIL_BYTES` constant + `tailText()` helper.

13. `src/components/ui/question-prompt.tsx` — added `max-h-80 overflow-y-auto scrollbar-thin` to the options `<ul>` so very long option lists scroll instead of pushing the card off-screen.

## Key design decisions

- **Dynamic import + Turbopack stubs**: The `@hopx-ai/sdk` ESM bundle imports Node-only modules (`http`, `https`, `crypto`, `fs`, `fs/promises`, `path`, `os`, `tar`, `glob`, `ws`, `form-data`) at the top level. Bundling it for the browser requires stubbing every one. Turbopack (Next.js 16's default dev bundler) doesn't honor webpack's `resolve.fallback`, so I added a parallel `turbopack.resolveAlias` block. Both alias to the same CJS stub (`src/lib/hopx/empty-stub.cjs`) — a `Proxy` that throws `"<module> is not available in the browser"` for any property access. Axios's browser (XHR) adapter ignores `httpAgent`/`httpsAgent`, so the SDK's HTTP calls (Sandbox.create, files.read/write, commands.run, runCode) all work via fetch/XHR. The stub only fires if a Node-only feature is actually invoked — which our browser code path never does.
- **Streaming fallback**: The SDK's `runCodeStream` uses the `ws` package internally (stubbed). When `runPythonStream` catches a stream-init error, it transparently falls back to non-streaming `runCode` and emits the full result as one stdout chunk. The UI still updates — it just shows the complete output at once instead of per-line. `runCommandStream` is non-streaming at the SDK level (no shell-streaming API exposed) — same one-chunk behaviour.
- **Stateless data URLs**: Blob URLs (`URL.createObjectURL`) die on page reload, breaking downloads on Vercel after a refresh and on shared chats. Data URLs are stateless — `fetch("data:...")` returns the bytes in any browser, any time. The 4 MB cap protects the IndexedDB quota (data URLs are ~1.33x the content size; the tool result is stored in the chat history). For larger files, the agent can fall back to `read_file` in chunks.
- **Approval removal**: Tools execute immediately when the model invokes them. The `tool_call` event still fires before execution so the UI shows a running card. The `autoApproveTools` setting in Settings → Config is preserved for back-compat (users don't lose their stored preference) but has no effect — documented as deprecated in the `AgentTurnOptions` interface comment.
- **Max rounds handling**: Previously the runtime emitted `error: "Reached max rounds (10) without a final answer"` and discarded the assistant's progress. Now it persists whatever content was generated (`lastAssistantContent || "(reached max rounds...)"`), emits `final_result` + `message_saved` + `complete` like a normal completion, and returns `stopReason: "max_rounds"`. Raised MAX_ROUNDS to 50 — long tool chains (build → test → iterate) no longer hit the wall.

## Verification

- `bunx tsc --noEmit --skipLibCheck` — ZERO errors in any of the 12 edited files. All remaining errors are pre-existing (`skills/`, `examples/`, `components/settings/section-*.tsx`, `src/lib/tools/dynamic_tools.ts` `ToolResult` import, etc. — none touched by this task).
- `bun run lint` — still broken in the repo itself (circular-structure error in the flat-config plugin — pre-existing, unrelated).
- Dev server logs (`tail dev.log`):
  - `GET /chat 200 in 16.1s (compile: 15.5s, ...)` — first compile (SDK chunk cached)
  - `GET /chat 200 in 473ms` — subsequent loads
  - `GET /settings/config 200 in 3.6s`
  - `GET /settings/tools 200 in 2.5s`
  - `GET / 307 in 1.5s` (locale redirect)
- No new errors / exceptions in `dev.log` after the edits.

## Known limitations

- The SDK's `runCodeStream` uses the `ws` package internally, which is stubbed in the browser. Streaming Python falls back to non-streaming `runCode` in that case — the full output arrives as one chunk when the code finishes. The UI still updates, just not per-line for Python.
- The SDK's `files.upload(localPath)` requires a Node filesystem path — in the browser we use `files.writeBytes` instead. This works for our use case (the chat never uploads from local disk directly via the SDK).
- The 4 MB cap on `send_file` / `send_folder` is intentional — without it, base64 data URLs would balloon the IndexedDB quota. The agent can fall back to `read_file` in chunks for larger files.

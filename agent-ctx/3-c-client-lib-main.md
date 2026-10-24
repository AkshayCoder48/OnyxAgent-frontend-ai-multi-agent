# 3-c — Background Task Execution Framework: CLIENT LIBRARY

Task ID: 3-c
Agent: client-lib subagent (Z.ai Code)
Full work log: /home/z/my-project/worklog.md → "Task ID: 3-c" section.

## Files CREATED
- `src/lib/tasks/serialize.ts` — FR-1.1 payload pipeline: `buildTaskPayload({userId, conversationId?, includeWorkspace?, maxFiles?})` → `TaskPayload`. Conversation slice (last 30 msgs, `stripUploadTags`, system kept only as message #1, 12k-char/msg cap mirroring detached-run precedent). Workspace manifest via a BOUNDED recursive OPFS walk of `users/<uid>/workspace/**` (walk paths are already workspace-relative → they mount at `/home/user/<relative>`); text exts → utf8, else base64 (`bytesToBase64`, chunk-safe); `sha256Hex` via crypto.subtle. Budgets enforced as silent guards: maxFiles, maxFileBytes, maxTotalFileBytes, and an ENCODED-size ceiling (maxBytes − 512KB headroom, conversation text counted).
- `src/lib/tasks/key-pool.ts` — FR-1.3: `buildKeyPool({userId, preferredProviderId?})` → `{pool, rotated}`. Best-effort session vault restore → `aiProviderService.list(userId, true)` → `getDecryptedApiKey` per provider (throws = skip silently, e.g. locked vault → empty pool = keyless-bridge fallback by design). Preferred provider first, dedupe, cap maxKeyPool. Round-robin: localStorage `onyx:key-rotation` int, rotate start by index%len then index++ (spreads rate limits ACROSS triggers).
- `src/lib/tasks/client.ts` — the client API ("use client"). Exports: `triggerBackgroundTask(input)` (mint taskId+64-hex taskToken → buildTaskPayload+buildKeyPool in parallel → POST /api/tasks/trigger → persist BackgroundTaskRow "queued"), `pollTaskStatus(runId,cursor)`, `listTaskRuns(userId)`, `cancelTask(runId)` (token from the Dexie row), `fetchArtifact(artifactId,taskToken)`, `syncRunToConversation(runId,userId)` → "synced"|"conflicted"|"none" (PRD §4.1: conflict = any local msg created_at > row.started_at → POST sync {conflicted}; else message/report artifacts → ONE assistant ConversationMessage, file/attachment artifacts → OPFS `users/<uid>/workspace/<sanitized path>` + markdown bullet list; addMessage → live-store hydration → POST sync {synced} → settle row), `refreshRunRow(runId)`, `reconcileRunRows(runs,userId?)` (server fields refresh; task_token/sync_state/conversation_id/artifact_ids NEVER clobbered), `backgroundTaskService` (Dexie wrapper: list/get/put/update/delete/clearSynced), schedule API wrappers (`listTaskSchedules`/`createTaskSchedule`/`updateTaskSchedule`/`deleteTaskSchedule`).
- `src/hooks/use-background-tasks.ts` — `useBackgroundTasks()` (list query, refetchInterval 4s while queued/running else 15s, staleTime 2s, fire-and-forget Dexie mirror reconcile in queryFn), `useBackgroundTask(runId)` (single-run query; cursor = max(prev run.cursor, max chunk seq) read from cached query data; merges new chunks deduped by seq; 3s poll while live, false on terminal), `useTaskSchedules()` (staleTime 30s + create/update/remove mutations with invalidation), `useTriggerBackgroundTask()` (mutationFn resolves userId LIVE from the auth store — use-data resilient pattern; sonner toasts; invalidates qk.tasks.all()).

## Files MODIFIED (surgical, as permitted)
- `src/lib/db/index.ts` — Dexie **version(7)**: `background_tasks: "&id, user_id, status, updated_at"`; `BackgroundTaskRow` type export (id=server runId, task_token client-only secret, cursor, artifact_ids, sync_state); `background_tasks` table field; added to `wipeAllData` + `wipeUserData` cascades (tokens must not outlive the account).
- `src/lib/query-keys.ts` — added `qk.tasks = { all, list(userId?), detail(runId), schedules() }`.
- `src/hooks/index.ts` — re-exported the four new hooks.

## Contract notes for 3-a (server) / 3-d (UI)
- `/api/tasks/schedules` assumed REST surface (protocol.ts pins no list/CRUD response types): GET → `{schedules: TaskScheduleRecord[]}`, POST body TaskScheduleInput → `{schedule}`, PATCH/DELETE `/api/tasks/schedules/[id]`. `fetchArtifact` accepts both the bare artifact object and `{ok, artifact}` frames.
- syncRunToConversation returns "none" for: missing row/run, non-terminal run, no conversation_id, missing conversation, or token-less mirror rows (schedule/other-browser fired — token never left the triggering browser). Idempotent ("synced" short-circuits); one-sync-at-a-time per runId (module Set).
- `triggerBackgroundTask` accepts an extra optional `scheduleId` (pass-through to TaskTriggerRequest.scheduleId) beyond the specified signature.

## Verification
- `bunx tsc --noEmit`: 0 errors in all owned/edited files; diff vs HEAD baseline shows ZERO new errors project-wide (16 baseline errors that appear when only my tracked edits are stashed are all in MY files referencing my own additions).
- `bun run lint`: 0 errors / 0 warnings in my files (52 pre-existing warnings elsewhere, untouched).
- Browser smoke (agent-browser, dev server): /chat 200, ZERO page errors; IndexedDB "agent-chat-app" upgraded to **version 70 (schema v7)** with `background_tasks` store present (31 stores). Screenshot: `agent-ctx/3c-smoke-chat-v7.png`.
- Dev server had died mid-task; restarted detached via the same `bun run dev` (port 3000, dev.log tee) — healthy at hand-off.

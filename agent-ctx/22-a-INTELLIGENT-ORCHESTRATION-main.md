# Task 22-a — Intelligent Workspace Analysis & Dynamic Sub-Agent Orchestration

## Agent
main (orchestrator) — implementing agent for task ID **22-a**

## Status
✅ Complete — all 4 PRD deliverables implemented + worklog appended.

## Files Touched
- **NEW** `src/lib/tools/workspace_analysis.ts` — `analyze_workspace` tool
- **MODIFIED** `src/stores/subagent-store.ts` — lifecycle fields + 2 new store methods
- **MODIFIED** `src/lib/tools/subagents.ts` — `disposable` / `role` params + auto-dispose
- **MODIFIED** `src/lib/tools/index.ts` — register new tool
- **MODIFIED** `src/lib/agent/runtime.ts` — Intelligent Planning Pipeline system prompt

## Key Implementation Details

### `analyze_workspace` tool
- Registered with `registerTool("analyze_workspace", ..., false, "orchestration")`.
- Walks E2B sandbox recursively from `/home/user` (cap 500 files).
- Reads README, package.json, Dockerfile, tsconfig, next.config, vite.config, tailwind, postcss, docker-compose, .env files (values masked for security).
- Aggregates: skills (`skillService.list`), MCP servers (`mcpService.list`), available tools (`listTools(ctx)`), env vars (`settingsService.getDecryptedEnvVars` + `is_secret` flag), existing subagents (`useSubagentStore.getState().subagents`), memories (OPFS `users/<userId>/memory/`).
- Each section wrapped in try/catch; partial failures appended to `errors[]`.
- Returns `{ files, file_count, total_size_bytes, key_files, skills, mcp_servers, available_tools, env_vars, existing_subagents, memories, summary, errors }`.

### `SubagentConfig` lifecycle
- New fields: `disposable?`, `role?`, `lifecycle_status?` (`"idle" | "planning" | "working" | "waiting" | "reviewing" | "completed" | "disposed"`), `parent_task?`, `last_activity?`.
- New store methods:
  - `updateLifecycleStatus(id, status)` — updates status + `last_activity` timestamp.
  - `disposeAgent(id)` — sets `lifecycle_status="disposed"`, `enabled=false`, updates `last_activity`.

### `spawn_subagent` updates
- New params: `disposable` (default false), `role` (string), `parent_task_id` (optional).
- `SubagentTask` interface extended with `disposable`, `role`, `parent_task`.
- Existing subagent reuse path also updates the new fields.
- `emitStatus` now includes `subagent_id`, `disposable`, `role`, `parent_task`.

### `complete_subagent` auto-dispose
- Reads the live `disposable` flag from the store (preferring persisted value).
- If disposable:
  - Sets `task.status = "disposed"`.
  - Calls `store.disposeAgent(subagent_id)` → `enabled=false`, `lifecycle_status="disposed"`.
  - Emits "disposed" status event + info message.
  - Removes from `taskStore` immediately.
- If not disposable:
  - Same as before (status="completed", auto-removed after 30s, agent stays in sidebar).

### `query_subagent` lifecycle hooks
- On entry: `store.updateLifecycleStatus(subagentId, "working")`.
- On success: `updateLifecycleStatus(subagentId, "completed")`.
- On failure: `updateLifecycleStatus(subagentId, "idle")`.

### System prompt (runtime.ts)
- Prepended 4 new sections to `toolKnowledgeBase`:
  1. **CRITICAL: Pre-Execution Workspace Analysis**
  2. **Automatic Task Complexity Detection** (Tiny/Small/Medium/Large/Massive)
  3. **Dynamic Sub-Agent Decision** (roles + disposable guidance)
  4. **Execution Pipeline** (12-step flow)
  5. **Agent Lifecycle Status** (state diagram)
- Added new "Workspace Analysis (run FIRST)" section in the per-tool guide.
- Added `analyze_workspace` entry under "Subagent Orchestration".
- Updated `complete_subagent` description to mention auto-dispose.

## Verification
- `bunx tsc --noEmit` — no new errors (pre-existing loose-typing errors in untouched files remain).
- `bun run lint` — ESLint has a pre-existing circular-plugin config error (unrelated).
- Dev server compiles + serves `/chat` 200 OK.

## Patterns Reused
- `ensureFreshSandboxForCtx(ctx)` + `getE2BClient(apiKey, null, "shared")` (from `e2b_files.ts`).
- Dynamic `import("@/lib/services")` / `import("@/stores/subagent-store")` (avoids circular deps).
- `opfs.ensurePath` + `opfs.walkFiles` (from `memory_list` tool).
- `registerTool(..., false, "orchestration")` (matches sibling orchestration tools).

## Downstream Notes
- Disposable agents are NOT hard-deleted — only `enabled=false` + `lifecycle_status="disposed"`. Chat session history is preserved for audit.
- `analyze_workspace` caps file count at 500 by default; pass `max_files` to override.
- `.env` values are masked in the `key_files.env` section; `env_vars[]` returns `value_length` only (never the value).
- The full work record is in `/home/z/my-project/worklog.md`.

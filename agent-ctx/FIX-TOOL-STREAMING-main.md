# FIX-TOOL-STREAMING — main (Z.ai Code orchestrator)

## Task
Two problems to fix in the agent-chat-app at `/home/z/my-project`:
1. **Tool calls don't show real-time output** — long-running tools (e.g. `run_terminal` installing playwright) appear blank during execution, then dump all output at once after completion. Add a "running" indicator and a tool approval auto-approve toggle.
2. **Built-in tools missing from settings/tools page** — only custom tools are listed; the user wants to see all registered built-in tools too.

## Files edited
1. `src/lib/services/index.ts` — added `getAutoApproveTools` / `setAutoApproveTools` to `settingsService`; extended `UserSettings` interface with `auto_approve_tools: boolean` (read from `extra`).
2. `src/lib/agent/runtime.ts` — added `autoApproveTools?: boolean` to `AgentTurnOptions`; the HITL approval gate now reads `if (toolDef.requires_approval && !opts.autoApproveTools)` and skips `waitForApproval` entirely when auto-approve is on. The `tool_call` event still fires immediately so the UI shows a "running" card.
3. `src/components/chat/tool-call-card.tsx` — auto-expand the card on the idle→running transition (new `useEffect` + `wasRunningRef`); added a new `RunningToolPanel` component that renders a spinner + the live caption + the most relevant arg (command / code / url / query) + an "agent is waiting" hint while a tool is running. Imported `useRef`.
4. `src/app/[locale]/(dashboard)/settings/tools/page.tsx` — added a "Built-in tools" section above "Your tools"; uses `listTools()` from `@/lib/tools/registry` plus the side-effect import `@/lib/tools` so the registry is populated. Built-in tool rows show name, category, description, a `built-in` badge, and an amber `approval` badge when `requires_approval` is set. Read-only (no edit/delete buttons). The list is bounded to `max-h-96` with `overflow-y-auto` + `scrollbar-thin` so the catalog doesn't dominate the page. The existing search input filters both lists in parallel.
5. `src/app/[locale]/(dashboard)/settings/config/page.tsx` — added a new "Tool approval" `SectionCard` between the Hopx sandbox and System prompt sections. The new `ToolApprovalSection` component loads `settingsService.getAutoApproveTools(user.id)` on mount, renders a `Switch` ("Auto-approve tool calls") with a description matching the task spec ("Skip the approval dialog for tools like run_terminal. Faster but less secure."), and an amber warning banner when the toggle is on. Reverts the toggle state on save error.
6. `src/hooks/use-chat.ts` — `buildTurnOptions` now reads `settings.auto_approve_tools` (already loaded alongside the system prompt) and passes it as `autoApproveTools` to `runAgentTurn`. No new service call needed since `settingsService.get()` now returns the field.

## Key design decisions
- **Storage**: `auto_approve_tools` lives in `user_settings.extra` (already a catch-all JSON column on `UserSettingsRow`). No Dexie schema migration needed. `settingsService.get()` reads it back as a boolean (default false) so callers don't need a second round-trip.
- **No streaming of terminal output**: as the task notes, the Hopx REST API blocks until the tool returns — there's no way to stream stdout/stderr in real time. The fix is purely UX: surface the "running" state prominently (spinner + caption + the command being run) so the user knows the agent hasn't hung. The `tool_call` event was already firing before execution at runtime.ts line ~909; the bug was that the card was collapsed by default and the generic "Running…" text was visually thin.
- **Auto-expand on running transition**: I used a `wasRunningRef` so the auto-expand only fires on the idle→running edge. If the user manually collapses the card mid-run, the effect won't fight them on the next render (since `isRunning` is still true and `wasRunningRef.current` is already true). The card does NOT auto-collapse when the tool completes — that would override any manual expansion the user did mid-run. The default-collapsed-on-completion behavior is preserved for the common case (tool starts collapsed → runs → completes → stays collapsed summary bar).
- **Built-in tools are read-only**: the task spec says so. The rows have no Switch, edit, or delete buttons — just a `built-in` badge on the right. They share the same search box as custom tools so the user can find any tool by name.
- **`approval` badge**: built-in tools flagged `requires_approval` get an amber `approval` badge so users can tell which ones the auto-approve toggle affects.

## Verification
- `bunx tsc --noEmit --skipLibCheck` reports ZERO errors in any of the 6 edited files. All remaining `tsc` errors are pre-existing (vitest types missing in 3 test files, `examples/` + `skills/` standalone scripts, and legacy `section-*.tsx` settings components that were already broken before this task — none touched).
- Dev server (`tail dev.log`) shows the settings pages compile cleanly:
  - `GET /settings/tools 200 in 2.0s (compile: 1932ms)`
  - `GET /settings/config 200 in 2.1s (compile: 1856ms)`
- No new errors / exceptions in `dev.log` after the edits.

## Notes for orchestrator
- The auto-approve toggle is OFF by default (secure-by-default). Users have to opt in via Settings → Config → "Tool approval".
- The new "Built-in tools" section appears ABOVE "Your tools" so users see the catalog first; if a user has many custom tools, the built-in list is scroll-bounded (`max-h-96`) so it doesn't push the custom tools below the fold.
- The runtime change is backward-compatible: if `autoApproveTools` is `undefined` (e.g. an older caller that doesn't pass it), the `!opts.autoApproveTools` check is truthy and the approval gate fires as before.

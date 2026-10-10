# UI SPEC — Scheduled Tasks & Telegram (OnyxAgent)

Repo: /home/z/onyxagent (Next.js 16 App Router, [locale] routes, Tailwind v4 + shadcn/ui New York, next-intl with messages/en.json + messages/pl.json, Terra editorial theme: cream/ink/terracotta, sidebar paper #F4ECE1).

Read `/home/z/my-project/worklog.md` FIRST (sections sched-0 + onyxbase-cloud-workspace-1 explain the architecture + design tokens). Then study these reference files:
- `src/app/[locale]/(dashboard)/settings/cloud/page.tsx` + `src/components/settings/section-cloud-workspace.tsx` — THE pattern for vault-key-authorized API calls + settings sections (useAuth + useSettings hooks, toast feedback, loading states).
- `src/components/chat/conversation-sidebar.tsx` — where the "New conversation" button lives (line ~284 comment "Full-width terracotta New conversation button"); add the Scheduled Tasks item DIRECTLY BELOW it (desktop expanded + collapsed rail + mobile Sheet all get it).
- `src/components/chat/tool-call-card.tsx` — tool result card dispatch (see `isWorkspaceSyncTool` + line 46 import + lines 198/270/307/789 wiring for BOTH simple + technical display modes).
- `src/components/chat/tool-results/workspace-sync.tsx` — the glassmorphic card pattern to imitate.
- `src/lib/constants.ts` — ROUTES constant (add SCHEDULED_TASKS + SETTINGS_INTEGRATIONS).
- `src/app/[locale]/(dashboard)/settings/layout.tsx` — settings nav (add Integrations entry).
- `src/hooks/use-data.ts` (useSettings/useAuth) + `src/lib/services/index.ts` (settingsService: getDecryptedOnyxBaseApiKey, getDecryptedTelegramBotToken, setTelegramBotToken, getTelegramChatId, setTelegramChatId).

## BACKEND API (ALREADY BUILT — do not modify server code)

All calls POST `/api/scheduler/tasks` with header `X-OnyxBase-Key: <key>` (resolve via `settingsService.getDecryptedOnyxBaseApiKey(userId)` at call time — same as SectionCloudWorkspace resolves its key; NEVER store the key in React state longer than the request) and JSON body `{ action, ...payload }`:

- `{ action: "list" }` → `{ ok, tasks: SafeScheduledTask[] }`
- `{ action: "create", name, description?, instructions, schedule: { type, expression?, time?, timezone, startAt?, endAt? }, enabled?, notifyTelegram? }` → `{ ok, task }` (server snapshots provider+telegram config itself; client does NOT pass credentials)
- `{ action: "update", id, ...fields }` → `{ ok, task }` (fields: name, description, instructions, schedule, enabled, notifyTelegram)
- `{ action: "delete", id }` → `{ ok }`
- `{ action: "pause" | "resume", id }` → `{ ok, task }`
- `{ action: "run_now", id }` → `{ ok, run }`
- `{ action: "get_history", id, limit? }` → `{ ok, runs: ScheduledTaskRun[] }` (newest first)
- `{ action: "get_run", id, runId }` → `{ ok, run }`
- `{ action: "status" }` → `{ ok, tasks: number, tick: { lastTickAt, trigger, fired, finalized, tasks, running, nextDueAt } | null }`
- 503 `{ ok: false, error: "NOT_CONFIGURED" }` when no key → show "Add your OnyxBase API key in Settings → Cloud Workspace" empty-state with link.

POST `/api/scheduler/telegram` (same header) `{ action: "connect", botToken }` → validates via Telegram getMe → `{ ok, telegram, message }`; `{ action: "discover" }` → finds the user's chat (they must send /start to the bot first) → `{ ok, telegram, message }`; `{ action: "test" }` → sends test message; `{ action: "disconnect" }`. GET `/api/scheduler/telegram` (same header) → `{ ok, telegram: { connected, botName, botUsername, chatId, chatName, connectedAt } }` (token NEVER returned).

POST `/api/scheduler/tick` (same header) `{ trigger: "heartbeat" }` → `{ ok, ticked, fired, finalized, tasks, running, nextDueAt, lastTickAt, skipped }` — fire-and-forget.

Types: import from `@/lib/scheduler/types` (SafeScheduledTask, ScheduledTaskRun, TaskSchedule, ScheduleType) and `@/lib/scheduler/tz-cron` (describeSchedule(task) → "Every day · 09:00" etc — pass the task object cast as never if types mismatch).

SafeScheduledTask fields: id, name, description, instructions, scheduleType, scheduleExpression, scheduleMeta {time?, weekdays?, dayOfMonth?, intervalSec?}, timezone, startAt?, endAt?, enabled, workspaceId, notificationConfig {telegram, inApp}, runtime {hasProvider, providerModel, hasTelegram}, createdAt, updatedAt, nextRunAt (epoch ms), lastRunAt, lastRunStatus, runCount, failureStreak.
ScheduledTaskRun fields: id, taskId, scheduledFor (epoch), startedAt, completedAt, status ("pending"|"running"|"completed"|"failed"|"skipped"), trigger, sandboxId, e2bRunId, result, error, durationMs, filesChanged: string[], toolCalls, logs: string[], notifyStatus.

## FILES TO CREATE

1. `src/lib/scheduler/client.ts` — "use client" helper: `schedulerApi(userId, action, payload)` (resolves key via settingsService, fetches, returns {ok,...}|{error:"NOT_CONFIGURED"}), plus `useSchedulerKey()` hook wrapper. Include `telegramApi(userId, action, payload)` for the telegram route + `tickHeartbeat(userId)`.

2. `src/app/[locale]/(dashboard)/scheduled-tasks/page.tsx` — the management view (client page, follows the settings page wrapper style). Route "/scheduled-tasks" (ROUTES.SCHEDULED_TASKS = "/scheduled-tasks" in constants).

3. `src/components/scheduled/` — the components:
   - `scheduled-tasks-view.tsx` — main view: header ("Scheduled Tasks" + "New Task" button + scheduler status chip), task list (cards per spec §1), create/edit dialog, empty state. Polls `status` + `list` on mount + every 30s.
   - `task-card.tsx` — per spec: task name, description, status dot+badge (Active=green dot, Paused=amber, Running=blue pulse, Failed=red, Completed=muted), schedule description (describeSchedule), next run ("Next run: Tomorrow, 09:00" relative formatting), timezone badge (e.g. "Asia/Kolkata"), last run + status, created date, workspace id, telegram notify indicator. Action row: Edit / Pause⇄Resume / Run now / Delete (with AlertDialog confirm) / History.
   - `task-form-dialog.tsx` — create/edit: name, description, instructions (Textarea, tall), schedule type Select (once/interval/daily/weekly/monthly/cron) with dynamic fields:
     - once: datetime-local input (converts to ISO)
     - interval: number input minutes (store seconds)
     - daily: time input (HH:MM)
     - weekly: weekday toggle chips (S M T W T F S) + time input
     - monthly: day-of-month number (1-31) + time input
     - cron: text input with placeholder "30 9 * * 1-5" + validation hint
     - timezone: Select with common IANA zones (Asia/Kolkata FIRST/default = browser tz, UTC, America/New_York, America/Los_Angeles, Europe/London, Europe/Berlin, Asia/Tokyo, Asia/Singapore, Asia/Dubai, Australia/Sydney) + "browser default" auto-selected
     - enabled Switch, telegram notifications Switch (shows "connected/disconnected" hint via GET telegram status)
     - PREVIEW line: "Next run: <computed>" — compute via `computeNextRun` from `@/lib/scheduler/tz-cron` (import { computeNextRun, normalizeSchedule } — feed normalizeSchedule(schedulePayload) then computeNextRun(norm, norm.meta, Date.now())).
   - `run-history-panel.tsx` — per task (opens inline under the card or as Sheet): runs list (✓/✕ icon, date time, duration, tool calls, status, trigger badge); clicking a run expands run detail: result text (pre-wrap), error, filesChanged chips, logs list (mono), notifyStatus. Polls get_history every 10s while any run is running; get_run for live updates.
   - `scheduler-status.tsx` — small status card: last tick (relative), next due (relative + absolute), running count, trigger sources explanation + collapsible "How triggering works" (heartbeat while app open + daily Vercel cron + optional external pinger: "Point any 1-minute cron service (e.g. cron-job.org, free) at <origin>/api/scheduler/tick — GET works" + a copyable URL field) + "Run tick now" button.

4. `src/components/settings/section-integrations-telegram.tsx` + `src/app/[locale]/(dashboard)/settings/integrations/page.tsx` — Settings → Integrations page (nav entry in settings/layout.tsx between Cloud and the end, icon `Blocks` or `Plug`). Telegram section per spec §15: Not connected state [Connect Telegram]; connected state (bot name, @username, chat id + chat name, connected date) with [Test Connection] [Discover Chat] [Disconnect]; connect dialog: bot token Input (password type w/ eye toggle) + link hint to @BotFather + step instructions (1. message @BotFather /newbot → 2. paste token → 3. send /start to your bot → 4. Discover). After connect: ALSO store the token in the local vault via settingsService.setTelegramBotToken(userId, token) + setTelegramChatId on discover (so in-browser agent tools work). On disconnect: clear vault (setTelegramBotToken(userId, null), setTelegramChatId(userId, null)) + server disconnect. Use useAuth() for userId (the SectionCloudWorkspace comment about useAuth matters — read it).

5. `src/components/chat/tool-results/scheduled-task.tsx` — tool result cards for the 8 scheduling tools (export `ScheduledTaskResult({ toolCall })` + `isScheduledTaskTool(name)`):
   - create → confirmation card per spec §18: "Scheduled Task Created" header, task name, schedule line (describeSchedule), timezone, next run, status dot "● Active", subtle footer actions hint ("Edit in Scheduled Tasks"). Warm glass style like workspace-sync card.
   - list → compact task rows (name, schedule, status, next run).
   - get_history → run rows (status icon, time, duration).
   - update/pause/resume/run_now/delete → slim status cards ("Task paused", "Run started — it continues in the background", etc).
   - Read args/result from toolCall (the tool result JSON has {ok, task?, tasks?, runs?, run?, message?, error?}).

6. `src/components/scheduled/scheduler-heartbeat.tsx` — mounted in `src/app/[locale]/(dashboard)/layout.tsx` (or the chat page): on mount + every 60s → tickHeartbeat(userId) (fire and forget, silent). When a tick response has finalized > 0 → toast(`Scheduled task finished — view it in Scheduled Tasks`) with action button navigating to /scheduled-tasks; when fired > 0 → toast("A scheduled task just started"). Never throws. Also expose nothing — invisible component (returns null).

## FILES TO MODIFY
- `src/lib/constants.ts` — ROUTES.SCHEDULED_TASKS = "/scheduled-tasks"; ROUTES.SETTINGS_INTEGRATIONS = "/settings/integrations".
- `src/components/chat/conversation-sidebar.tsx` — Scheduled Tasks button directly below the New conversation button (same visual weight as history rows: CalendarClock icon, "Scheduled Tasks" label; on ALL three sidebar variants — expanded, collapsed rail (icon-only), mobile Sheet). Router push to ROUTES.SCHEDULED_TASKS. Keep it above the search field + history groups.
- `src/app/[locale]/(dashboard)/settings/layout.tsx` — nav entry "Integrations" (Plug icon) → ROUTES.SETTINGS_INTEGRATIONS (place after Cloud).
- `src/components/chat/tool-call-card.tsx` — import + wire ScheduledTaskResult for BOTH display modes exactly like WorkspaceSyncResult (add `isSched = isScheduledTaskTool(toolCall.name)` and render `<ScheduledTaskResult toolCall={toolCall} />` at the same spots).
- `src/app/[locale]/(dashboard)/layout.tsx` — render <SchedulerHeartbeat /> once (guard: only when a user exists).
- `messages/en.json` + `messages/pl.json` — add "scheduled" namespace keys used by the sidebar + page titles (e.g. scheduled.title, scheduled.newTask, scheduled.nextRun, scheduled.status.active/paused/running/failed/completed, telegram section labels). Match existing JSON structure (inspect top-level keys first!). JSON must stay valid — validate with `python3 -m json.tool` after editing.

## STYLE RULES
- Terra editorial tokens (bg-background, text-foreground, border-border, bg-secondary paper, text-primary terracotta accents, font-display Fraunces for headers). Cards: rounded-lg border bg-card with p-4/p-6, gap-4. NO indigo/blue as accents (status Running may use a blue-ish dot ONLY as semantic status color, or use terracotta/amber instead — prefer amber for running).
- Responsive: mobile-first; task cards stack; action rows wrap; dialogs scrollable (max-h-[85vh] overflow-y-auto on content).
- Loading skeletons (Skeleton component) while fetching; empty states with icon + CTA; all buttons ≥44px touch targets; AlertDialog for destructive delete; toasts for every mutation result.
- Relative time formatting helper (seconds/minutes/hours/days ago, "Tomorrow, 09:00" for next run when within 2 days — show the time in the TASK's timezone: use `Intl.DateTimeFormat(undefined, { timeZone: task.timezone, ... })`).

## VERIFICATION (before reporting done)
- `npx tsc --noEmit` exit 0.
- `bun run lint` on changed files (0 errors).
- Valid JSON in both message files.
- No secrets in any rendered UI (never render botToken).
- Report every file created/modified with a one-line description.

## HARD CONSTRAINTS
- Route ONLY /scheduled-tasks + /settings/integrations as new pages (the app's other routes exist already; don't restructure them).
- Do NOT touch: src/lib/scheduler/engine.ts, server-kv.ts, ws-sync.ts, telegram.ts, tz-cron.ts, types.ts, src/app/api/** (server code is DONE), bg-agent-script.ts, background-*.ts.
- Do NOT introduce new npm packages (all shadcn/ui components exist in src/components/ui).
- The OnyxBase key + bot token NEVER appear in component state that gets rendered, console.log, or localStorage copies — resolve at call time, use transiently.

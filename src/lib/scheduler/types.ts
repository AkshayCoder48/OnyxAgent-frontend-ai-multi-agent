/**
 * Scheduled Tasks — shared types (client + server safe).
 *
 * The scheduler is SERVER-SIDE and persistent: task definitions, execution
 * history, telegram credentials and tick state live in OnyxBase KV under the
 * user's account (collection "onyxagent"), so schedules survive application
 * restarts, browser closure and device switches. The browser is only a
 * trigger source (heartbeat) + a management UI — never the source of truth.
 *
 * SECURITY: `task.runtime` carries execution credentials (provider key,
 * telegram bot token) so unattended runs work with the browser closed. That
 * record lives in the user's own OnyxBase KV (readable only with the user's
 * key) and is NEVER rendered to the model — it is not part of any tool
 * schema, tool arguments, system prompt or run logs. API responses strip or
 * mask every credential field before sending anything to a client.
 */

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

export type ScheduleType = "once" | "interval" | "daily" | "weekly" | "monthly" | "cron";

export type TaskStatus = "active" | "paused" | "running" | "failed" | "completed";

export interface TaskSchedule {
  type: ScheduleType;
  /**
   * Type-specific expression:
   *  - once:     ISO timestamp (startAt fallback)
   *  - daily:    "HH:MM" wall-clock time
   *  - weekly:   comma list of weekday numbers 0-6 (0=Sunday)
   *  - monthly:  day-of-month 1-31
   *  - interval: seconds between runs (>= 60)
   *  - cron:     standard 5-field cron expression
   */
  expression?: string;
  /** Wall-clock "HH:MM" for weekly + monthly (daily uses `expression`). */
  time?: string;
  timezone: string;
  /** Earliest allowed run (ISO). Schedule occurrences before it are skipped. */
  startAt?: string;
  /** Latest allowed run (ISO). Task auto-completes after it. */
  endAt?: string;
}

export interface TaskScheduleMeta {
  /** Wall-clock "HH:MM" for daily/weekly/monthly. */
  time?: string;
  /** Weekday numbers 0-6 (0=Sunday) for weekly. */
  weekdays?: number[];
  /** Day of month 1-31 for monthly. */
  dayOfMonth?: number;
  /** Interval seconds for interval schedules. */
  intervalSec?: number;
}

/** Extract the normalized meta from a TaskSchedule payload. */
export function scheduleMetaOf(s: TaskSchedule): TaskScheduleMeta {
  const meta: TaskScheduleMeta = {};
  if (s.type === "weekly") {
    meta.weekdays = (s.expression ?? "1")
      .split(",")
      .map((v) => parseInt(v.trim(), 10))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 6);
    if (!meta.weekdays.length) meta.weekdays = [1];
    meta.time = s.time ?? "09:00";
  } else if (s.type === "monthly") {
    meta.dayOfMonth = Math.min(31, Math.max(1, parseInt(s.expression || "1", 10) || 1));
    meta.time = s.time ?? "09:00";
  } else if (s.type === "interval") {
    meta.intervalSec = Math.max(60, parseInt(s.expression || "3600", 10) || 3600);
  } else if (s.type === "daily") {
    meta.time = s.expression ?? s.time ?? "09:00";
  }
  return meta;
}

export interface ProviderSnapshot {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  toolsEnabled?: boolean;
  noPrefix?: boolean;
  disabledParams?: string[];
}

export interface TelegramCreds {
  botToken: string;
  chatId: string;
}

/** One turn of a chat's history as consumed by the agent runtime (the
 *  unified chat-execution context — see chat-store.ts). Defined here so the
 *  shared client/server payloads can reference it without cycles. */
export interface ChatTurnMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface ScheduledTask {
  id: string;
  userId: string;
  name: string;
  description: string;
  /** The COMPLETE agent job, preserved verbatim (never reduced to an action). */
  instructions: string;
  /** UNIFIED CHAT MODE: the task runs INSIDE this conversation — the agent
   *  gets the chat's history as context and its result is appended back into
   *  the chat as a server message. Absent/null = LEGACY standalone mode. */
  chatId?: string | null;
  scheduleType: ScheduleType;
  scheduleExpression: string;
  scheduleMeta: TaskScheduleMeta;
  timezone: string;
  startAt?: string;
  endAt?: string;
  enabled: boolean;
  workspaceId: string;
  notificationConfig: {
    telegram: boolean;
    inApp: boolean;
  };
  /** Execution snapshot for unattended runs (credentials — masked on read). */
  runtime: {
    provider: ProviderSnapshot | null;
    telegram: TelegramCreds | null;
  };
  createdAt: string;
  updatedAt: string;
  nextRunAt: number | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  runCount: number;
  failureStreak: number;
  /** Retry backoff for transient launch failures (epoch ms). */
  nextRetryAt?: number;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export type RunStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface ScheduledTaskRun {
  /** Deterministic: run_<taskId8>_<occurrenceEpochMs> — the idempotency key. */
  id: string;
  taskId: string;
  /** The scheduled occurrence (epoch ms) this run executes. */
  scheduledFor: number;
  startedAt: string;
  completedAt: string | null;
  status: RunStatus;
  trigger: "schedule" | "manual" | "retry";
  sandboxId: string | null;
  /** E2B run id (the .onyx/runs/<runId> dir) — live event polling. */
  e2bRunId: string | null;
  /** Link to the unified chat execution (chat:<chatId> records) when the run
   *  is attached to a conversation (chat-mode tasks). */
  execId?: string | null;
  /** Final agent response (capped, for notifications + history). */
  result: string | null;
  error: string | null;
  durationMs: number | null;
  filesChanged: string[];
  toolCalls: number;
  /** Compact execution timeline lines (tool calls + milestones). */
  logs: string[];
  /** Notification delivery status. */
  notifyStatus?: string;
  /** Consecutive unreachable checks while running (crash detection). */
  unreachableChecks?: number;
}

// ---------------------------------------------------------------------------
// KV storage layout (OnyxBase, collection "onyxagent")
// ---------------------------------------------------------------------------

/** All task definitions in one record (single read per tick). */
export const SCHED_TASKS_KEY = "schedule:tasks";
/** Per-task run history: schedule:runs:<taskId> (capped array, newest last). */
export const SCHED_RUNS_PREFIX = "schedule:runs:";
/** Telegram connection: { botToken, chatId, … } (masked on read-back). */
export const SCHED_TELEGRAM_KEY = "schedule:telegram";
/** Scheduler status + tick lock: { lastTickAt, … }. */
export const SCHED_TICK_KEY = "schedule:tick";

/**
 * The FULL telegram connection record stored at SCHED_TELEGRAM_KEY
 * ("schedule:telegram") — SERVER-side shape (carries the bot token + webhook
 * secret, so it must NEVER be sent to a client; API responses project it
 * through the route's masked() view). Written by /api/scheduler/telegram
 * (connect / discover / enable_chat / disable_chat) and read by the telegram
 * webhook route + the scheduler engine.
 */
export interface TelegramConnectionConfig {
  botToken: string;
  botName: string | null;
  botUsername: string | null;
  chatId: string | null;
  chatName: string | null;
  connectedAt: string | null;
  /** REMOTE CHAT MODE (unified-3b) — present only while enabled.
   *  Travels ONLY in the setWebhook call + KV + the webhook's header check. */
  webhookSecret?: string;
  /** The public webhook URL that was registered with Telegram. */
  webhookUrl?: string;
  /** The linked chat id AS USED by the KV chat records (chat:<id>:*) —
   *  identical to chatId (kept explicit for the record's self-description). */
  conversationId?: string;
  /** Execution provider snapshot stored at enable time (null = no provider —
   *  the webhook replies with a configuration warning). */
  provider?: ProviderSnapshot | null;
  /** INFORMATIONAL mirror flag (sent in enable_chat). The RUNTIME source of
   *  truth for streaming web-app runs into Telegram is the local vault's
   *  telegram_mirror_enabled flag (settingsService). */
  mirrorRuns?: boolean;
  /** When remote chat was enabled (ISO). */
  enabledAt?: string;
  /** Dedup cursor — the highest processed Telegram update_id. Retries and
   *  redeliveries with update_id <= this value are skipped. */
  lastUpdateId?: number;
}

export const MAX_RUNS_PER_TASK = 25;
export const MAX_TASK_INSTRUCTIONS = 24_000;
export const MAX_RUN_RESULT = 8_000;
export const MAX_RUN_LOG_LINES = 200;

// ---------------------------------------------------------------------------
// Safe (client-facing) shapes — credentials stripped
// ---------------------------------------------------------------------------

export interface SafeScheduledTask extends Omit<ScheduledTask, "runtime"> {
  runtime: {
    hasProvider: boolean;
    providerModel: string | null;
    hasTelegram: boolean;
  };
}

export function toSafeTask(t: ScheduledTask): SafeScheduledTask {
  const { runtime, ...rest } = t;
  return {
    ...rest,
    runtime: {
      hasProvider: !!(runtime.provider && runtime.provider.baseUrl),
      providerModel: runtime.provider?.model ?? null,
      hasTelegram: !!(runtime.telegram && runtime.telegram.botToken),
    },
  };
}

export interface TelegramStatus {
  connected: boolean;
  botName: string | null;
  botUsername: string | null;
  chatId: string | null;
  connectedAt: string | null;
}

// ---------------------------------------------------------------------------
// API contracts (browser tools + UI ⇄ /api/scheduler/*)
// ---------------------------------------------------------------------------

export interface CreateTaskPayload {
  name: string;
  description?: string;
  instructions: string;
  schedule: TaskSchedule;
  workspaceId?: string;
  enabled?: boolean;
  notifyTelegram?: boolean;
  /** UNIFIED CHAT MODE — attach the schedule to an existing conversation
   *  (runs with its history; results land in the chat). null/absent = legacy
   *  standalone instruction mode. */
  chatId?: string | null;
  /** Initial chat mirror written at create time (browser context: system
   *  prompt + recent messages) so the first run has history. */
  chatContext?: {
    systemPrompt?: string;
    title?: string;
    messages: ChatTurnMessage[];
  } | null;
  /** Resolved CLIENT-side (never model-visible): execution snapshot. */
  runtime?: {
    provider?: ProviderSnapshot | null;
    telegram?: TelegramCreds | null;
  };
}

export interface UpdateTaskPayload {
  id: string;
  name?: string;
  description?: string;
  instructions?: string;
  schedule?: TaskSchedule;
  enabled?: boolean;
  workspaceId?: string;
  notifyTelegram?: boolean;
  /** Attach/detach the task's conversation (chat mode). */
  chatId?: string | null;
  runtime?: {
    provider?: ProviderSnapshot | null;
    telegram?: TelegramCreds | null;
  };
}

export type TaskAction =
  | "create"
  | "update"
  | "delete"
  | "pause"
  | "resume"
  | "run_now"
  | "list"
  | "get_history"
  | "get_run"
  | "status"
  | "sync_chat"
  | "pull_chat";

export interface TickResult {
  ok: boolean;
  ticked: boolean;
  skipped?: string;
  fired: number;
  finalized: number;
  tasks: number;
  running: number;
  nextDueAt: number | null;
  lastTickAt: number | null;
  trigger: string;
  errors: string[];
}

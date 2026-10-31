// ============================================================================
// Background Task Execution Framework — shared protocol (PRD: Background
// Task Execution Framework for OnyxAgent).
//
// ISOMORPHIC CONTRACT MODULE — no "use client"/"use server", no runtime
// imports. Imported by: the server task lib (src/lib/tasks/*), the client
// task lib (src/lib/tasks/client.ts etc.), the API routes
// (src/app/api/tasks/**), and mirrored (by copy) in the Trigger.dev worker
// package (trigger-worker/src/protocol.ts). Any change here MUST be mirrored
// in the worker copy.
//
// Topology (direct cloud execution):
//   Browser (Dexie/OPFS) ── POST /api/tasks/trigger ──▶ TaskRun (SQLite)
//        ▲                                                  │ direct dispatch
//        │ poll /api/tasks/status (chunked, FR-3.2)         ▼
//   TanStack Query ◀──── run metadata + output ◀──── trigger.dev Cloud
//                                                        (deployed agent-run
//                                                         task, auto-bootstrapped)
//                                                              │ E2B SDK
//                                                              ▼
//                                             E2B sandbox (30-min cap, PRD §4.2)
//                                             headless runner / terminal command
//                                                              │ run OUTPUT
//                                                              ▼
//                                             task_artifacts (SQLite) ──▶ client
//                                             extraction → Dexie/OPFS sync-back
// ============================================================================

// ---------------------------------------------------------------------------
// Task kinds
// ---------------------------------------------------------------------------

/**
 * - `agent_run` — Epic 3: an asynchronous subagent chain (full headless
 *   tool-loop) executing inside an isolated sandbox.
 * - `scheduled_business` — Epic 2: a scheduled multi-agent business task
 *   fired by a TaskSchedule row (cron).
 * - `terminal_command` — FR-3.3: a single long-running terminal command that
 *   would time out in the local 120s tool budget; runs to completion inside
 *   the sandbox lifecycle managed by the orchestrator.
 */
export type BackgroundTaskType =
  | "agent_run"
  | "scheduled_business"
  | "terminal_command";

export const BACKGROUND_TASK_TYPES: readonly BackgroundTaskType[] = [
  "agent_run",
  "scheduled_business",
  "terminal_command",
];

/** Hard sandbox execution cap — PRD §4.2 ("maximum 30 minutes execution"). */
export const TASK_MAX_DURATION_MS = 2 * 60 * 60 * 1000; // PRD §4 timeout freedom: up to 2h durable windows (default stays 30min)
/** Default execution window. */
export const TASK_DEFAULT_DURATION_MS = 30 * 60 * 1000;
/** Rounds budget (USER DIRECTIVE: "remove the limit of 24 rounds") — the old
 *  24/48 caps are GONE. The only real bound is the execution window above
 *  (30 min); these numbers just stop a runaway loop from spinning forever
 *  inside it. */
export const TASK_DEFAULT_MAX_ROUNDS = 400;
export const TASK_HARD_MAX_ROUNDS = 1000;

// ---------------------------------------------------------------------------
// Payload budgets (FR-1.1 serialization guards)
// ---------------------------------------------------------------------------

export const TASK_PAYLOAD_BUDGET = {
  /** Total serialized payload ceiling. */
  maxBytes: 8 * 1024 * 1024,
  /** Max files mounted per task. */
  maxFiles: 200,
  /** Per-file ceiling (bytes, pre-encoding). */
  maxFileBytes: 1024 * 1024,
  /** Total file content ceiling (bytes, pre-encoding). */
  maxTotalFileBytes: 6 * 1024 * 1024,
  /** Max seed messages handed to the runner. */
  maxSeedMessages: 30,
  /** Max prompt length (chars). */
  maxPromptChars: 32_000,
  /** Max keys in a rotational key pool (FR-1.3). */
  maxKeyPool: 8,
  /** Max artifacts registered per run. */
  maxArtifacts: 60,
  /** Max artifact size (bytes) — larger files are listed but truncated. */
  maxArtifactBytes: 2 * 1024 * 1024,
  /** Max total artifact bytes per run. */
  maxTotalArtifactBytes: 10 * 1024 * 1024,
} as const;

// ---------------------------------------------------------------------------
// Task payload — what the client serializes (FR-1.1)
// ---------------------------------------------------------------------------

export interface TaskPayloadFile {
  /** Path relative to the sandbox workspace root (/home/user). */
  path: string;
  /** File content — utf8 text or base64 (for binary). */
  content: string;
  encoding: "utf8" | "base64";
  /** Byte size of the decoded content. */
  size: number;
  /** Hex sha256 of the decoded bytes (mount verification, FR-4.1). */
  sha256: string;
  /** Where the file came from. */
  source: "opfs" | "upload" | "inline";
  /** Original client mime type, when known. */
  mimeType?: string;
}

export interface PayloadMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface TaskPayload {
  version: 1;
  conversation: {
    id: string | null;
    title: string | null;
    /** Text-only seed history (oldest → newest), budget-capped. */
    messages: PayloadMessage[];
  };
  /** Files to mount into the sandbox before start (FR-4.1 manifest inputs). */
  files: TaskPayloadFile[];
}

// ---------------------------------------------------------------------------
// Run config
// ---------------------------------------------------------------------------

export interface TaskRunConfig {
  /**
   * OpenAI-compatible chat URL the sandbox runner should call. When omitted,
   * the orchestrator substitutes the app's own keyless bridge
   * (`/api/tasks/llm`) and the task token acts as the bearer credential.
   */
  chatUrl?: string;
  /** Model id for the runner. Omitted → bridge default. */
  model?: string;
  temperature?: number;
  maxRounds?: number;
  /** Execution window ms (default 30min, hard cap TASK_MAX_DURATION_MS). */
  timeoutMs?: number;
  systemPrompt?: string;
  /** terminal_command only: the shell command to run. */
  command?: string;
  /** terminal_command only: working directory (default /home/user). */
  cwd?: string;
  /**
   * HUMAN-IN-THE-LOOP (Trigger.dev PRD §3.3): when true the cloud task
   * suspends on a Trigger.dev WAITPOINT TOKEN before executing anything
   * sensitive and waits indefinitely for the user to Approve/Deny from the
   * web UI (`POST /api/tasks/approval`). Destructive terminal commands
   * auto-gate even without this flag.
   */
  requireApproval?: boolean;
}

// ---------------------------------------------------------------------------
// Trigger request/response (FR-1.2)
// ---------------------------------------------------------------------------

export interface TaskTriggerRequest {
  /** Client-minted task id (uuid v4). */
  taskId: string;
  /**
   * Client-minted secret (64 hex chars). Authorizes cancel / mark-synced /
   * artifact extraction and acts as the bearer token for the LLM bridge.
   * Stored ONLY as a sha256 hash server-side; the plaintext lives in the
   * in-memory keyring for the life of the run (PRD §4.2 credential
   * sandboxing — never persisted to disk or logs).
   */
  taskToken: string;
  type: BackgroundTaskType;
  prompt: string;
  config?: TaskRunConfig;
  payload: TaskPayload;
  /** FR-1.3 rotational key pool — decrypted provider keys, ordered by the
   *  client's rotation index. Held in the keyring only. */
  keyPool?: string[];
  /** Real E2B key or the "USE_SERVER_ENV" sentinel (existing convention). */
  e2bApiKey?: string;
  /** Owning user id (client-first app: the local/registered user id). */
  userId: string;
  conversationId?: string;
  /** Set when the run was fired by a schedule. */
  scheduleId?: string;
  /** Human title for UI lists. */
  title?: string;
}

export interface TaskTriggerResponse {
  ok: true;
  runId: string;
  orchestrator: "local" | "triggerdev";
}

// ---------------------------------------------------------------------------
// Status polling (FR-3.1) + chunked progress blocks (FR-3.2)
// ---------------------------------------------------------------------------

export type TaskRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskPhase =
  | "claim"
  | "init"
  | "mount"
  | "verify"
  | "start"
  | "monitor"
  | "finalize"
  | "done";

export interface TaskStatusChunk {
  /** Monotonic sequence number — clients poll with `cursor = lastSeq`. */
  seq: number;
  kind: "round" | "text" | "tool_call" | "tool_result" | "log" | "error";
  /** Agent round the chunk belongs to (0 for pre-loop events). */
  round?: number;
  /** Tool name for tool_call/tool_result chunks. */
  name?: string;
  content: string;
  ts: number;
}

export interface TaskRunProgress {
  round: number;
  totalRounds: number;
  stage: string;
  currentTool: string | null;
  /** FR-4.1 mount verification report. */
  mountReport?: {
    filesListed: number;
    filesMounted: number;
    filesVerified: number;
    missing: string[];
  };
  logTail?: string;
  lastUpdate: number;
  /**
   * HITL approval request mirror (Trigger.dev PRD §3.3): present while the
   * cloud run is SUSPENDED on a waitpoint token. Drives the PAUSED banner
   * + Approve/Deny buttons (PRD §5.1). `state` is patched by
   * /api/tasks/approval once the user decides.
   */
  approval?: {
    token: string;
    reason: string;
    createdAt: number;
    state?: "approved" | "denied";
  };
}

export interface TaskArtifactSummary {
  id: string;
  runId: string;
  kind: string;
  name: string;
  mimeType: string;
  size: number;
  truncated: boolean;
  createdAt: string;
}

export interface TaskStatusRun {
  runId: string;
  taskId: string;
  type: BackgroundTaskType;
  status: TaskRunStatus;
  phase: TaskPhase;
  orchestrator: "local" | "triggerdev";
  title: string | null;
  prompt: string;
  progress: TaskRunProgress;
  sandboxId: string | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  error: string | null;
  artifacts: TaskArtifactSummary[];
  /** Present on the single-run view. */
  chunks?: TaskStatusChunk[];
  cursor?: number;
  scheduleId?: string | null;
  /** Trigger.dev CLOUD runs only — the api.trigger.dev run id (the row's
   * externalRunId). Lets clients link straight to the cloud dashboard. */
  cloudRunId?: string;
}

export interface TaskStatusResponse {
  ok: true;
  run: TaskStatusRun;
}

export interface TaskListResponse {
  ok: true;
  runs: TaskStatusRun[];
}

// ---------------------------------------------------------------------------
// Schedules (FR-2.1)
// ---------------------------------------------------------------------------

export interface TaskScheduleInput {
  name: string;
  /** Standard 5-field cron expression or @yearly/@monthly/@weekly/@daily/@hourly. */
  cronExpr: string;
  /** IANA timezone (default: browser tz at creation). */
  timezone?: string;
  taskType: BackgroundTaskType;
  prompt: string;
  config?: TaskRunConfig;
  active?: boolean;
}

export interface TaskScheduleRecord {
  id: string;
  name: string;
  cronExpr: string;
  timezone: string;
  taskType: BackgroundTaskType;
  prompt: string;
  config: TaskRunConfig | null;
  active: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Sandbox manifest (FR-4.1) — .onyxagent_files.json written to the sandbox
// ---------------------------------------------------------------------------

export interface OnyxAgentFilesManifest {
  version: 1;
  runId: string;
  createdAt: string;
  files: Array<{
    path: string;
    size: number;
    sha256: string;
    source: string;
  }>;
}

export const MANIFEST_PATH = ".onyxagent_files.json";

/** Files/dirs excluded from artifact collection + manifest diffing. */
export const TASK_ARTIFACT_EXCLUDES: readonly string[] = [
  "skills",
  ".onyx",
  ".cache",
  ".npm",
  ".local",
  ".bashrc",
  ".bash_history",
  ".profile",
  "Onyx.md",
  "MASTER-INDEX.md",
  "headless_runner.py",
  "cron_output.log",
  MANIFEST_PATH,
];

// ---------------------------------------------------------------------------
// Cloud direct execution (app → trigger.dev Cloud → deployed agent-run task)
//
// The app POSTs the ENTIRE run (spec + credentials) to
// POST /api/v1/tasks/agent-run/trigger and never receives callbacks:
//   · live progress → run METADATA (`onyx` blob, GET /api/v3/runs/:id),
//   · final result  → run OUTPUT (status / error / artifacts).
// Mirrored in trigger-worker/src/protocol.ts — keep in sync.
// ---------------------------------------------------------------------------

/** Ceiling for the serialized app → cloud trigger payload (REST-safe). */
export const TASK_CLOUD_PAYLOAD_MAX_BYTES = 1_500_000;

/** One artifact in the cloud run output. */
export interface CloudArtifact {
  kind: "message" | "file" | "report" | "attachment";
  name: string;
  path?: string;
  mimeType?: string;
  content: string;
  encoding?: "utf8" | "base64";
  truncated?: boolean;
}

/** The metadata blob the cloud agent-run task refreshes on every poll
 *  (well under the 256KB metadata ceiling — `chunks` is a newest-only ring). */
export interface CloudRunMetadata {
  phase: "init" | "mount" | "verify" | "start" | "monitor" | "finalize" | "done";
  progress: TaskRunProgress;
  /** Monotonic chunk counter in the WORKER's seq space. */
  chunkSeq: number;
  /** Newest chunks (ring, newest last) — drained by the app each poll. */
  chunks: Array<Omit<TaskStatusChunk, "seq"> & { seq: number }>;
  /**
   * HITL approval request (Trigger.dev PRD §3.3): present while the cloud
   * run is SUSPENDED on a waitpoint token. `token` is the trigger.dev
   * waitpoint id the app completes via
   * POST /api/v1/waitpoints/tokens/:id/complete when the user decides.
   * `state` mirrors the decision once made (the app patches it locally).
   */
  approval?: {
    token: string;
    reason: string;
    createdAt: number;
    /** App-side mirror of the decision ("approved" | "denied") — the
     * worker never sets this; it only resumes from the completed token. */
    state?: "approved" | "denied";
  };
  updatedAt: number;
}

/** The cloud task's return value, read by the app from the finished run. */
export interface CloudRunOutput {
  runId: string;
  /** "cancelled" = human approval was DENIED (PRD §5.1 HITL) or the run
   *  was aborted before producing artifacts. */
  status: "completed" | "failed" | "cancelled";
  error?: string;
  sandboxId?: string;
  artifacts: CloudArtifact[];
}

/** Trigger payload for the deployed agent-run task (direct execution). */
export interface CloudAgentRunPayload {
  run: {
    runId: string;
    type: BackgroundTaskType;
    prompt: string;
    config: TaskRunConfig;
    payload: TaskPayload;
    startedAt: string;
    timeoutMs: number;
  };
  credentials: {
    e2bApiKey: string;
    chatUrl: string;
    chatToken: string;
    keyPool: string[];
  };
}

// ---------------------------------------------------------------------------
// Cancellation / sync-back
// ---------------------------------------------------------------------------

export interface TaskCancelRequest {
  runId: string;
  taskToken: string;
}

/**
 * Client sync-back states (PRD §4.1 state-conflict prevention): artifacts are
 * extracted to Dexie/OPFS ONLY when the client confirms no newer local
 * changes exist; otherwise they stay as pending attachment payloads.
 */
export type ClientSyncState = "pending" | "synced" | "conflicted";

export interface TaskSyncedRequest {
  runId: string;
  taskToken: string;
  /** "synced" after successful extraction; "conflicted" when the local
   *  conversation/workspace changed after the task started. */
  state: ClientSyncState;
}

// ---------------------------------------------------------------------------
// Cron helpers (isomorphic — used by the server scheduler AND the Schedules
// settings pane for validation + next-run preview)
// ---------------------------------------------------------------------------

/** Validate a 5-field cron expression or @shorthand. Returns error string. */
export function validateCron(expr: string): string | null {
  const shorthand: Record<string, string> = {
    "@yearly": "0 0 1 1 *",
    "@annually": "0 0 1 1 *",
    "@monthly": "0 0 1 * *",
    "@weekly": "0 0 * * 0",
    "@daily": "0 0 * * *",
    "@midnight": "0 0 * * *",
    "@hourly": "0 * * * *",
  };
  const normalized = expr.trim().toLowerCase();
  const expanded = shorthand[normalized] ?? expr.trim();
  const fields = expanded.split(/\s+/);
  if (fields.length !== 5) return "must have exactly 5 fields (min hour dom month dow)";
  const ranges: Array<[number, number]> = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ];
  for (let i = 0; i < 5; i++) {
    const field = fields[i] ?? "";
    const range = ranges[i] ?? [0, 0];
    if (!cronFieldMatches(field, range[0] ?? 0, range[1] ?? 0)) {
      return `field ${i + 1} ("${field}") is invalid`;
    }
  }
  return null;
}

function cronFieldMatches(field: string, min: number, max: number): boolean {
  if (field === "*" || field === "?") return true;
  return field.split(",").every((part) => {
    const stepMatch = part.match(/^(\*|\?|\d+-\d+|\d+)\/(\d+)$/);
    if (stepMatch) {
      if (stepMatch[1] === "*" || stepMatch[1] === "?") {
        const step = Number(stepMatch[2]);
        return step >= 1 && step <= max;
      }
      const bounds = (stepMatch[1] ?? "").split("-").map(Number);
      const lo = bounds[0] ?? 0;
      const hi = bounds[1] ?? 0;
      return lo >= min && hi <= max && lo <= hi && Number(stepMatch[2]) >= 1;
    }
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const lo = Number(rangeMatch[1]);
      const hi = Number(rangeMatch[2]);
      return lo >= min && hi <= max && lo <= hi;
    }
    if (!/^\d+$/.test(part)) return false;
    const v = Number(part);
    return v >= min && v <= max;
  });
}

/**
 * Compute the next fire time for a cron expression in an IANA timezone.
 * Field-wise next-occurrence search (bounded scan), wall-time → UTC via the
 * standard two-pass Intl offset resolution. Returns null when no occurrence
 * is found within 366 days.
 */
export function nextCronRun(
  expr: string,
  timezone: string,
  from: Date = new Date(),
): Date | null {
  const shorthand: Record<string, string> = {
    "@yearly": "0 0 1 1 *",
    "@annually": "0 0 1 1 *",
    "@monthly": "0 0 1 * *",
    "@weekly": "0 0 * * 0",
    "@daily": "0 0 * * *",
    "@midnight": "0 0 * * *",
    "@hourly": "0 * * * *",
  };
  const expanded = shorthand[expr.trim().toLowerCase()] ?? expr.trim();
  const fields = expanded.split(/\s+/);
  const minF = fields[0] ?? "*";
  const hourF = fields[1] ?? "*";
  const domF = fields[2] ?? "*";
  const monthF = fields[3] ?? "*";
  const dowF = fields[4] ?? "*";

  const expand = (field: string, lo: number, hi: number): number[] => {
    const out = new Set<number>();
    for (const part of field.split(",")) {
      // FIX (private helper): a bare "*"/"?" part means EVERY value in
      // [lo, hi] — without this, any cron with a plain "*" field (hour/dom/
      // month/dow — i.e. virtually every practical expression, e.g.
      // "*/5 * * * *") expanded to an empty set and nextCronRun returned
      // null for it.
      if (part === "*" || part === "?") {
        for (let v = lo; v <= hi; v++) out.add(v);
        continue;
      }
      const stepM = part.match(/^(\*|\?|\d+-\d+|\d+)\/(\d+)$/);
      if (stepM) {
        const step = Math.max(1, Number(stepM[2]));
        const isStar = stepM[1] === "*" || stepM[1] === "?";
        const s = isStar ? lo : 0;
        const e = isStar ? hi : Number(stepM[1]?.split("-")[1] ?? hi);
        for (let v = s; v <= e; v += step) out.add(v);
        continue;
      }
      const rangeM = part.match(/^(\d+)-(\d+)$/);
      if (rangeM) {
        for (let v = Number(rangeM[1]); v <= Number(rangeM[2]); v++) out.add(v);
        continue;
      }
      if (/^\d+$/.test(part)) out.add(Number(part));
    }
    return [...out].filter((v) => v >= lo && v <= hi).sort((a, b) => a - b);
  };

  const minutes = expand(minF, 0, 59);
  const hours = expand(hourF, 0, 23);
  const months = expand(monthF, 1, 12);
  const doms = expand(domF, 1, 31);
  const dows = expand(dowF, 0, 7);
  const domRestricted = domF !== "*" && domF !== "?";
  const dowRestricted = dowF !== "*" && dowF !== "?";
  if (!minutes.length || !hours.length || !months.length) return null;

  const fromParts = tzParts(from, timezone);
  const startYear = fromParts.y;

  for (let day = 0; day <= 366; day++) {
    const wall = addDays(fromParts, day);
    if (!months.includes(wall.mo)) continue;
    const domOk = doms.includes(wall.d);
    const dowOk = dows.includes(wall.dow);
    const dayOk =
      domRestricted && dowRestricted
        ? domOk || dowOk
        : domRestricted
          ? domOk
          : dowRestricted
            ? dowOk
            : true;
    if (!dayOk) continue;
    for (const h of hours) {
      for (const mi of minutes) {
        const candidate = wallToUtc(wall.y, wall.mo, wall.d, h, mi, timezone);
        if (!candidate) continue;
        if (candidate.getTime() > from.getTime()) return candidate;
      }
    }
    if (wall.y > startYear + 1) break;
  }
  return null;
}

/** Wall-clock date parts in a timezone. */
function tzParts(
  date: Date,
  timezone: string,
): { y: number; mo: number; d: number; h: number; mi: number; dow: number } {
  const dtf = tzFormatter(timezone);
  const parts = dtf.formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const dowMap = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const dow = Math.max(0, dowMap.findIndex((d) => weekday.startsWith(d)));
  return {
    y: get("year"),
    mo: get("month"),
    d: get("day"),
    h: get("hour") % 24,
    mi: get("minute"),
    dow,
  };
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function tzFormatter(timezone: string): Intl.DateTimeFormat {
  let f = fmtCache.get(timezone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        hour12: false,
        weekday: "short",
      });
    } catch {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        hour12: false,
        weekday: "short",
      });
    }
    fmtCache.set(timezone, f);
  }
  return f;
}

function addDays(
  p: { y: number; mo: number; d: number; h: number; mi: number; dow: number },
  days: number,
): { y: number; mo: number; d: number; h: number; mi: number; dow: number } {
  const base = Date.UTC(p.y, p.mo - 1, p.d);
  const next = new Date(base + days * 86_400_000);
  const dow = next.getUTCDay();
  return {
    y: next.getUTCFullYear(),
    mo: next.getUTCMonth() + 1,
    d: next.getUTCDate(),
    h: p.h,
    mi: p.mi,
    dow,
  };
}

/** Convert a wall time in `timezone` to a UTC instant (two-pass offsets). */
function wallToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  timezone: string,
): Date | null {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, 0, 0);
  if (!Number.isFinite(asUtc)) return null;
  const guess = tzOffsetMs(new Date(asUtc), timezone);
  const refine = tzOffsetMs(new Date(asUtc - guess), timezone);
  return new Date(asUtc - refine);
}

function tzOffsetMs(date: Date, timezone: string): number {
  try {
    const dtf = tzFormatter(timezone);
    const parts = dtf.formatToParts(date);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const asUTC = Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      date.getUTCHours() % 24,
      date.getUTCMinutes(),
    );
    const asTZ = Date.UTC(
      get("year"),
      get("month"),
      get("day"),
      get("hour") % 24,
      get("minute"),
    );
    // FIX (private helper): return the TRUE offset (local wall − UTC wall).
    // The old `asUTC - asTZ` returned the INVERTED offset while wallToUtc
    // computes `asUtc - refine` expecting the true one — every non-UTC
    // timezone shifted wall→UTC the wrong way (e.g. 10:40 Asia/Calcutta →
    // 16:10Z instead of 05:10Z).
    return asTZ - asUTC;
  } catch {
    return 0;
  }
}

/** Humanize a cron expression for UI display. */
export function describeCron(expr: string): string {
  const shorthandDesc: Record<string, string> = {
    "@yearly": "Every year (Jan 1, 00:00)",
    "@annually": "Every year (Jan 1, 00:00)",
    "@monthly": "Every month (day 1, 00:00)",
    "@weekly": "Every week (Sunday, 00:00)",
    "@daily": "Every day at 00:00",
    "@midnight": "Every day at 00:00",
    "@hourly": "Every hour at :00",
  };
  const key = expr.trim().toLowerCase();
  if (shorthandDesc[key]) return shorthandDesc[key];
  const shorthand: Record<string, string> = {
    "@yearly": "0 0 1 1 *",
    "@annually": "0 0 1 1 *",
    "@monthly": "0 0 1 * *",
    "@weekly": "0 0 * * 0",
    "@daily": "0 0 * * *",
    "@midnight": "0 0 * * *",
    "@hourly": "0 * * * *",
  };
  const expanded = shorthand[key] ?? expr.trim();
  const [minF, hourF, domF, monthF, dowF] = expanded.split(/\s+/);
  const isEvery = (f?: string) => !f || f === "*" || f === "?";
  const timeLabel = () => {
    if (hourF === "*") return minF === "*" ? "every minute" : "hourly";
    const hh = String(Number(hourF)).padStart(2, "0");
    const mm = minF === "*" ? "00" : String(Number(minF)).padStart(2, "0");
    return `at ${hh}:${mm}`;
  };
  if (isEvery(domF) && isEvery(monthF) && isEvery(dowF)) return `Every day, ${timeLabel()}`;
  if (!isEvery(dowF) && isEvery(domF) && isEvery(monthF)) {
    const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const days = (dowF ?? "").split(",").map((d) => names[Number(d) % 7] ?? d).join(", ");
    return `Weekly on ${days}, ${timeLabel()}`;
  }
  if (!isEvery(domF) && isEvery(dowF) && isEvery(monthF)) {
    return `Monthly on day ${domF}, ${timeLabel()}`;
  }
  return `${expanded}`;
}

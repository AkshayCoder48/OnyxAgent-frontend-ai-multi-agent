// ============================================================================
// Mirrored from src/lib/tasks/protocol.ts — keep in sync.
//
// The Trigger.dev worker is a SEPARATE deployable package and cannot import
// from the app's src/ tree, so the subset of the frozen contract it needs is
// copied here verbatim. Any change to the app's protocol.ts MUST be mirrored
// in this file (and vice versa) — the claim/report HTTP protocol between the
// app and the worker is only as good as this copy.
//
// Deliberately NOT mirrored: the cron helpers (validateCron/nextCronRun/
// describeCron) and the client/schedule/cancel/sync types — the worker never
// uses them.
// ============================================================================

// ---------------------------------------------------------------------------
// Task kinds
// ---------------------------------------------------------------------------

/**
 * - `agent_run` — an asynchronous subagent chain (full headless tool-loop)
 *   executing inside an isolated sandbox.
 * - `scheduled_business` — a scheduled multi-agent business task fired by a
 *   TaskSchedule row (cron).
 * - `terminal_command` — a single long-running terminal command that would
 *   time out in the local 120s tool budget.
 */
export type BackgroundTaskType =
  | "agent_run"
  | "scheduled_business"
  | "terminal_command";

/** Hard sandbox execution cap — PRD §4.2 ("maximum 30 minutes execution"). */
export const TASK_MAX_DURATION_MS = 30 * 60 * 1000;
/** Default execution window. */
export const TASK_DEFAULT_DURATION_MS = 30 * 60 * 1000;
/** Default + hard cap on agent rounds inside the sandbox runner. */
export const TASK_DEFAULT_MAX_ROUNDS = 24;
export const TASK_HARD_MAX_ROUNDS = 48;

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
}

// ---------------------------------------------------------------------------
// Status polling (FR-3.1) + chunked progress blocks (FR-3.2)
// ---------------------------------------------------------------------------

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
  /** Monotonic sequence number — clients poll with `cursor = lastSeq`.
   *  (Server-assigned: the worker sends chunks WITHOUT seq.) */
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
// Worker protocol (Trigger.dev worker ↔ app; authenticated by WORKER_TOKEN)
// ---------------------------------------------------------------------------

export interface WorkerClaimRequest {
  token: string;
  /** Max runs to claim in one tick. */
  limit: number;
}

export interface WorkerClaimedRun {
  runId: string;
  type: BackgroundTaskType;
  prompt: string;
  config: TaskRunConfig;
  payload: TaskPayload;
  /** Absolute app origin — the worker calls back over HTTP. */
  appUrl: string;
  startedAt: string;
  timeoutMs: number;
}

export interface WorkerClaimResponse {
  ok: true;
  runs: WorkerClaimedRun[];
}

export interface WorkerReportRequest {
  token: string;
  runId: string;
  phase?: TaskPhase;
  progress?: Partial<TaskRunProgress>;
  /** Chunks WITHOUT seq — the server assigns the monotonic sequence. */
  chunks?: TaskStatusChunk[];
  sandboxId?: string;
  error?: string;
  /** Terminal outcome — driver is done with the run. */
  status?: "completed" | "failed" | "cancelled";
  artifacts?: WorkerArtifactInput[];
}

export interface WorkerArtifactInput {
  kind: "message" | "file" | "report" | "attachment";
  name: string;
  path?: string;
  mimeType?: string;
  content: string;
  encoding?: "utf8" | "base64";
  truncated?: boolean;
}

export interface WorkerReportResponse {
  ok: true;
}

export interface WorkerSweepResponse {
  ok: true;
  fired: number;
}

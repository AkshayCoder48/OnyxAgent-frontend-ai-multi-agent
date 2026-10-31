// ============================================================================
// OnyxAgent cloud worker — direct-execution protocol (v2).
//
// Mirrored from the app's src/lib/tasks/protocol.ts — keep in sync. The
// worker is a SEPARATE deployable package and cannot import from the app's
// src/ tree, so the subset of the frozen contract it needs is copied here.
//
// v2 — DIRECT CLOUD EXECUTION: no claim/report HTTP protocol, no APP_URL,
// no WORKER_TOKEN. The app POSTs the entire run (spec + credentials) to
// POST /api/v1/tasks/agent-run/trigger and reads progress from run
// metadata + the final result from the run output. Everything the run
// needs rides in the payload; nothing calls back.
// ============================================================================

// ---------------------------------------------------------------------------
// Task kinds
// ---------------------------------------------------------------------------

/**
 * - `agent_run` — an asynchronous chat-agent / sub-agent chain (full
 *   headless tool-loop) executing inside an isolated E2B sandbox.
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
export const TASK_MAX_DURATION_MS = 2 * 60 * 60 * 1000; // PRD §4 timeout freedom: up to 2h durable windows (default stays 30min)
/** Default execution window. */
export const TASK_DEFAULT_DURATION_MS = 30 * 60 * 1000;
/** Default + hard cap on agent rounds inside the sandbox runner. */
export const TASK_DEFAULT_MAX_ROUNDS = 24;
export const TASK_HARD_MAX_ROUNDS = 48;

// ---------------------------------------------------------------------------
// Payload budgets (FR-1.1 serialization guards)
// ---------------------------------------------------------------------------

export const TASK_PAYLOAD_BUDGET = {
  /** Total serialized payload ceiling (client → app). */
  maxBytes: 8 * 1024 * 1024,
  /** Cloud trigger payload ceiling (app → trigger.dev REST). */
  maxCloudBytes: 1_500_000,
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
  /** Max total artifact bytes collected in the sandbox. */
  maxTotalArtifactBytes: 10 * 1024 * 1024,
  /** Max total artifact bytes in the RUN OUTPUT (cloud-safe clamp). */
  maxOutputArtifactBytes: 1_200_000,
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
   * HUMAN-IN-THE-LOOP (Trigger.dev PRD §3.3): when true the task suspends
   * on a Trigger.dev WAITPOINT TOKEN before executing anything sensitive
   * and waits indefinitely for the user's Approve/Deny (the app completes
   * the token via POST /api/v1/waitpoints/tokens/:id/complete). Destructive
   * terminal commands auto-gate even without this flag.
   */
  requireApproval?: boolean;
}

// ---------------------------------------------------------------------------
// Progress (run metadata — the app polls GET /api/v3/runs/:id)
// ---------------------------------------------------------------------------

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

/** One progress chunk. `seq` is assigned by the worker (monotonic per run);
 *  the app persists chunks with its own per-run sequence as before. */
export interface TaskStatusChunk {
  seq: number;
  kind: "round" | "text" | "tool_call" | "tool_result" | "log" | "error";
  round?: number;
  name?: string;
  content: string;
  ts: number;
}

/** The single metadata blob the task refreshes each poll (kept well under
 *  the 256KB metadata ceiling — ring holds the newest chunks only). */
export interface RunMetadataState {
  phase: "init" | "mount" | "verify" | "start" | "monitor" | "finalize" | "done";
  progress: TaskRunProgress;
  /** Monotonic chunk counter — the app tracks the last seq it stored. */
  chunkSeq: number;
  /** Newest chunks (ring, newest last). */
  chunks: TaskStatusChunk[];
  /**
   * HITL approval request (Trigger.dev PRD §3.3): present while this run is
   * SUSPENDED on a waitpoint token. The token id travels out through run
   * metadata (the app polls it), the decision travels back via the
   * waitpoint complete endpoint — the pull-only protocol stays intact.
   */
  approval?: {
    token: string;
    reason: string;
    createdAt: number;
  };
  updatedAt: number;
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
// Direct cloud execution — trigger payload + run output (v2)
// ---------------------------------------------------------------------------

/** Everything one agent-run needs, POSTed by the app to
 *  POST /api/v1/tasks/agent-run/trigger. */
export interface AgentRunPayload {
  run: {
    /** The app's TaskRun id (NOT the cloud run id). */
    runId: string;
    type: BackgroundTaskType;
    prompt: string;
    config: TaskRunConfig;
    payload: TaskPayload;
    /** ISO timestamp — the app's run start (drives the execution window). */
    startedAt: string;
    /** Execution window ms (already clamped by the app). */
    timeoutMs: number;
  };
  credentials: {
    /** E2B API key for this run (app-resolved; no server env required). */
    e2bApiKey: string;
    /** Resolved OpenAI-compatible chat endpoint for the sandbox runner. */
    chatUrl: string;
    /** Bearer for chatUrl (first pool key, or the task token for the app bridge). */
    chatToken: string;
    /** FR-1.3 rotational provider key pool (runner rotates on 429/401). */
    keyPool: string[];
  };
}

/** The task's return value — the app reads it from the finished cloud run. */
export interface AgentRunOutput {
  runId: string;
  /** "cancelled" = human approval was DENIED (PRD §5.1 HITL) or the run was
   *  aborted before producing artifacts. */
  status: "completed" | "failed" | "cancelled";
  error?: string;
  sandboxId?: string;
  artifacts: CloudArtifact[];
}

export interface CloudArtifact {
  kind: "message" | "file" | "report" | "attachment";
  name: string;
  path?: string;
  mimeType?: string;
  content: string;
  encoding?: "utf8" | "base64";
  truncated?: boolean;
}

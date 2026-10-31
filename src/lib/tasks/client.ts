"use client";

// ============================================================================
// Background Task Execution Framework — the CLIENT API (Task 3-c).
//
// One import point for everything the browser does with background tasks:
//
//   · triggerBackgroundTask  — mint (taskId, taskToken), serialize the
//     payload (FR-1.1), build the key pool (FR-1.3), POST /api/tasks/trigger
//     and persist the durable Dexie mirror row (v7 `background_tasks`).
//   · pollTaskStatus / listTaskRuns — FR-3.1 status + FR-3.2 chunked
//     progress polling (cursor-based).
//   · cancelTask / fetchArtifact — authorized by the client-minted task
//     token (PRD §4.2: the server only ever holds its sha256).
//   · syncRunToConversation — FR-2.3 / PRD §4.1 artifact extraction with the
//     state-conflict check (local messages newer than run start ⇒ conflicted,
//     artifacts stay server-side as pending payloads).
//   · backgroundTaskService — the Dexie table wrapper (mirrors the
//     aiProviderService style; lives HERE, not in services/index.ts, so the
//     framework stays self-contained).
//   · reconcileRunRows / refreshRunRow — keep the Dexie mirror fresh after
//     every poll (used fire-and-forget by the hooks).
// ============================================================================

import { nanoid } from "nanoid";
import { db, type BackgroundTaskRow } from "@/lib/db";
import { conversationService } from "@/lib/services";
import { writeFileAtPath } from "@/lib/storage/opfs";
import { notifyConversationsChanged } from "@/lib/chat-events";
import { buildTaskPayload } from "@/lib/tasks/serialize";
import { buildKeyPool } from "@/lib/tasks/key-pool";
import {
  TASK_PAYLOAD_BUDGET,
  type BackgroundTaskType,
  type ClientSyncState,
  type TaskCancelRequest,
  type TaskListResponse,
  type TaskRunConfig,
  type TaskScheduleInput,
  type TaskScheduleRecord,
  type TaskStatusResponse,
  type TaskStatusRun,
  type TaskSyncedRequest,
  type TaskTriggerRequest,
  type TaskTriggerResponse,
} from "@/lib/tasks/protocol";

// ---------------------------------------------------------------------------
// Fetch helpers.
// ---------------------------------------------------------------------------

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

/** Extract a human-readable error message from a non-2xx JSON response. */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as {
      error?: string;
      detail?: string;
      message?: string;
    };
    const msg = data.error ?? data.detail ?? data.message;
    if (typeof msg === "string" && msg) return msg;
  } catch {
    /* body wasn't JSON */
  }
  return `${fallback} (HTTP ${res.status})`;
}

/** Mint the client-side task secret: 64 hex chars (32 random bytes). */
function mintTaskToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

// ---------------------------------------------------------------------------
// backgroundTaskService — Dexie table wrapper (aiProviderService style).
// ---------------------------------------------------------------------------

export const backgroundTaskService = {
  /** All of a user's mirrored runs, newest first. */
  async list(userId: string): Promise<BackgroundTaskRow[]> {
    const rows = await db.background_tasks.where("user_id").equals(userId).toArray();
    return rows.sort((a, b) => b.updated_at - a.updated_at);
  },

  async get(runId: string): Promise<BackgroundTaskRow | null> {
    const row = await db.background_tasks.get(runId);
    return row ?? null;
  },

  async put(row: BackgroundTaskRow): Promise<void> {
    await db.background_tasks.put(row);
  },

  /** Patch a row; bumps updated_at (the mirror is always "as of last poll"). */
  async update(runId: string, patch: Partial<BackgroundTaskRow>): Promise<void> {
    await db.background_tasks.update(runId, { ...patch, updated_at: Date.now() });
  },

  async delete(runId: string): Promise<void> {
    await db.background_tasks.delete(runId);
  },

  /** Drop already-synced mirror rows (housekeeping for the tasks strip). */
  async clearSynced(userId: string): Promise<void> {
    await db.background_tasks
      .where("user_id")
      .equals(userId)
      .filter((r) => r.sync_state === "synced")
      .delete();
  },
};

// ---------------------------------------------------------------------------
// Mirror reconciliation — upsert TaskStatusRun → BackgroundTaskRow.
// ---------------------------------------------------------------------------

/**
 * Upsert polled runs into the durable Dexie mirror. Server-owned fields are
 * refreshed; CLIENT-OWNED fields (task_token, sync_state, conversation_id,
 * artifact_ids) are never clobbered — runs first seen via a list poll (fired
 * by a schedule or another browser) get a stub row with an empty token
 * (their artifacts can't be extracted here; the token never left the
 * triggering browser, by design).
 */
export async function reconcileRunRows(
  runs: TaskStatusRun[],
  userId?: string,
): Promise<void> {
  for (const run of runs) {
    try {
      const existing = await backgroundTaskService.get(run.runId);
      if (existing) {
        await backgroundTaskService.update(run.runId, {
          status: run.status,
          title: run.title,
          prompt: run.prompt,
          cursor: Math.max(existing.cursor, run.cursor ?? 0),
          finished_at: run.finishedAt ? Date.parse(run.finishedAt) : existing.finished_at,
          error: run.error,
        });
      } else {
        const now = Date.now();
        await backgroundTaskService.put({
          id: run.runId,
          task_id: run.taskId,
          user_id: userId ?? "",
          type: run.type,
          status: run.status,
          title: run.title,
          prompt: run.prompt,
          conversation_id: null,
          schedule_id: run.scheduleId ?? null,
          orchestrator: run.orchestrator,
          task_token: "",
          cursor: run.cursor ?? 0,
          artifact_ids: [],
          sync_state: "pending",
          started_at: run.startedAt ? Date.parse(run.startedAt) : now,
          updated_at: now,
          finished_at: run.finishedAt ? Date.parse(run.finishedAt) : null,
          error: run.error,
        });
      }
    } catch {
      // best-effort mirror — a failed upsert must never break a poll
    }
  }
}

/** Poll one run (cursor-aware) and refresh its Dexie mirror row. */
export async function refreshRunRow(runId: string): Promise<TaskStatusRun | null> {
  const row = await backgroundTaskService.get(runId);
  const run = await pollTaskStatus(runId, row?.cursor ?? 0);
  if (!run) return null;
  await reconcileRunRows([run], row?.user_id);
  return run;
}

// ---------------------------------------------------------------------------
// Trigger (FR-1.2).
// ---------------------------------------------------------------------------

export interface TriggerBackgroundTaskInput {
  userId: string;
  conversationId?: string | null;
  type: BackgroundTaskType;
  prompt: string;
  title?: string;
  config?: TaskRunConfig;
  includeWorkspace?: boolean;
  preferredProviderId?: string;
  /** The resolved provider's key when config.chatUrl PINS that provider's
   *   gateway — leads the key pool (the runner's bearer) and disables the
   *   pool's rotation (endpoint-migration PRD §9: background runs carry the
   *   foreground turn's effective configuration). */
  pinnedApiKey?: string;
  /** Decrypted E2B sandbox key; omitted → the "USE_SERVER_ENV" sentinel. */
  sandboxApiKey?: string;
  /** Set when the run is fired by a schedule (pass-through). */
  scheduleId?: string;
}

/**
 * Start a background task:
 *   1. mint (taskId, taskToken) client-side (no server sessions — PRD §4.2),
 *   2. buildTaskPayload (FR-1.1) + buildKeyPool (FR-1.3) in parallel,
 *   3. POST /api/tasks/trigger with the full TaskTriggerRequest,
 *   4. persist the durable BackgroundTaskRow mirror (status "queued").
 */
/** The dispatch result — the server run id for the strip plus the
 *  client-minted (taskId, taskToken) pair (the durable handoff pointer for
 *  adoption paths that need to re-discover or authorize the run later). */
export interface TriggerBackgroundTaskResult {
  runId: string;
  orchestrator: "local" | "triggerdev";
  taskId: string;
  taskToken: string;
}

export async function triggerBackgroundTask(
  input: TriggerBackgroundTaskInput,
): Promise<TriggerBackgroundTaskResult> {
  const taskId = crypto.randomUUID();
  const taskToken = mintTaskToken();

  const [payload, keyPool] = await Promise.all([
    buildTaskPayload({
      userId: input.userId,
      conversationId: input.conversationId,
      includeWorkspace: input.includeWorkspace,
    }),
    buildKeyPool({
      userId: input.userId,
      preferredProviderId: input.preferredProviderId,
      pinnedApiKey: input.pinnedApiKey,
    }),
  ]);

  const request: TaskTriggerRequest = {
    taskId,
    taskToken,
    type: input.type,
    prompt: input.prompt.slice(0, TASK_PAYLOAD_BUDGET.maxPromptChars),
    ...(input.config ? { config: input.config } : {}),
    payload,
    ...(keyPool.pool.length > 0 ? { keyPool: keyPool.pool } : {}),
    e2bApiKey: input.sandboxApiKey ?? "USE_SERVER_ENV",
    userId: input.userId,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
    ...(input.title ? { title: input.title } : {}),
  };

  const res = await fetch("/api/tasks/trigger", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to start the background task"));
  }
  const data = (await res.json()) as TaskTriggerResponse;

  const now = Date.now();
  await backgroundTaskService.put({
    id: data.runId,
    task_id: taskId,
    user_id: input.userId,
    type: input.type,
    status: "queued",
    title: input.title ?? null,
    prompt: request.prompt,
    conversation_id: input.conversationId ?? null,
    schedule_id: input.scheduleId ?? null,
    orchestrator: data.orchestrator,
    task_token: taskToken,
    cursor: 0,
    artifact_ids: [],
    sync_state: "pending",
    started_at: now,
    updated_at: now,
    finished_at: null,
    error: null,
  });

  return { runId: data.runId, orchestrator: data.orchestrator, taskId, taskToken };
}

// ---------------------------------------------------------------------------
// Status polling (FR-3.1 + FR-3.2 chunked progress).
// ---------------------------------------------------------------------------

/** Poll one run with a chunk cursor. Null on any non-ok response. */
export async function pollTaskStatus(
  runId: string,
  cursor: number,
): Promise<TaskStatusRun | null> {
  try {
    const res = await fetch(
      `/api/tasks/status?runId=${encodeURIComponent(runId)}&cursor=${cursor}`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as TaskStatusResponse;
    return data.run ?? null;
  } catch {
    return null;
  }
}

/** List all of a user's runs (single-run view fields; no chunks). */
export async function listTaskRuns(userId: string): Promise<TaskStatusRun[]> {
  const res = await fetch(
    `/api/tasks/status?list=1&userId=${encodeURIComponent(userId)}`,
  );
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to list background tasks"));
  }
  const data = (await res.json()) as TaskListResponse;
  return data.runs ?? [];
}

// ---------------------------------------------------------------------------
// Cancel + artifacts (task-token authorized).
// ---------------------------------------------------------------------------

/** Cancel a run. Requires the local task token (only the triggering browser
 *  holds it — by design). */
export async function cancelTask(runId: string): Promise<void> {
  const row = await backgroundTaskService.get(runId);
  if (!row || !row.task_token) {
    throw new Error(
      "No local task token for this run — it was not triggered from this browser, so it cannot be cancelled here.",
    );
  }
  const res = await fetch("/api/tasks/cancel", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ runId, taskToken: row.task_token } satisfies TaskCancelRequest),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to cancel the background task"));
  }
}

// ---------------------------------------------------------------------------
// HITL approval (Trigger.dev PRD §3.3 — Approve/Deny a suspended cloud run).
// ---------------------------------------------------------------------------

/** Approve or deny a run suspended on a Trigger.dev waitpoint token.
 * Requires the local task token (only the triggering browser holds it —
 * same authorization lane as cancel). */
export async function decideTaskApproval(runId: string, approved: boolean): Promise<void> {
  const row = await backgroundTaskService.get(runId);
  if (!row || !row.task_token) {
    throw new Error(
      "No local task token for this run — it was not triggered from this browser, so it cannot be approved here.",
    );
  }
  const res = await fetch("/api/tasks/approval", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ runId, taskToken: row.task_token, approved }),
  });
  if (!res.ok) {
    throw new Error(
      await errorMessage(res, approved ? "Failed to approve the task" : "Failed to deny the task"),
    );
  }
}

/** One extracted artifact's content (fetch is authorized by the task token). */
export interface TaskArtifactContent {
  name: string;
  mimeType: string;
  content: string;
  encoding: "utf8" | "base64";
}

/** Fetch one artifact's content by id. */
export async function fetchArtifact(
  artifactId: string,
  taskToken: string,
): Promise<TaskArtifactContent> {
  const res = await fetch(
    `/api/tasks/artifact/${encodeURIComponent(artifactId)}?token=${encodeURIComponent(taskToken)}`,
  );
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to fetch the artifact"));
  }
  // Accept both `{...artifact}` and `{ ok, artifact: {...} }` frames.
  const data = (await res.json()) as TaskArtifactContent & {
    artifact?: TaskArtifactContent;
  };
  return data.artifact ?? data;
}

// ---------------------------------------------------------------------------
// Sync-back (FR-2.3 + PRD §4.1 state-conflict prevention).
// ---------------------------------------------------------------------------

/** One sync at a time per run (poll loops + strip + focus handlers can all
 *  race — mirrors the syncDetachedRun guard). */
const syncingRuns = new Set<string>();

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function base64ToBlob(b64: string, mimeType: string): Blob {
  const bytes = base64ToBytes(b64);
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return new Blob([buf], { type: mimeType || "application/octet-stream" });
}

function base64ToUtf8(b64: string): string {
  try {
    return new TextDecoder().decode(base64ToBytes(b64));
  } catch {
    return b64;
  }
}

/** Sanitize an artifact path: strip `..`, leading `/` and empty segments so
 *  the file can only land INSIDE users/<uid>/workspace. */
function sanitizeArtifactSegments(name: string): string[] {
  const segs = name
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "." && s !== "..")
    .map((s) => s.replace(/[\\/]+/g, "_"));
  return segs.length > 0 ? segs : ["artifact.bin"];
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Extract a finished run's artifacts back into the app (PRD §4.1):
 *
 *  1. Load the mirror row + poll the run once. Non-terminal runs, missing
 *     rows, missing conversations and token-less (schedule/other-browser)
 *     rows → "none".
 *  2. CONFLICT CHECK — if any local message is NEWER than the run's start
 *     (the user chatted while it ran), report "conflicted": artifacts stay
 *     server-side as pending payloads for manual extraction.
 *  3. Extract: message/report artifacts → one assistant ConversationMessage
 *     (summary + text); file/attachment artifacts → OPFS
 *     users/<uid>/workspace/<name> (+ a bullet list of saved paths in the
 *     message).
 *  4. conversationService.addMessage + live-store hydration when the user
 *     is viewing the conversation.
 *  5. POST /api/tasks/sync {state:"synced"} and settle the Dexie row.
 */
export async function syncRunToConversation(
  runId: string,
  userId: string,
): Promise<"synced" | "conflicted" | "none"> {
  const row = await backgroundTaskService.get(runId);
  if (!row) return "none";
  if (row.sync_state === "synced") return "synced"; // idempotent
  if (!row.conversation_id) return "none";
  if (!row.task_token) return "none"; // token never left the triggering browser

  if (syncingRuns.has(runId)) return "none";
  syncingRuns.add(runId);
  try {
    return await syncRunToConversationInner(row, userId);
  } finally {
    syncingRuns.delete(runId);
  }
}

async function syncRunToConversationInner(
  row: BackgroundTaskRow,
  userId: string,
): Promise<"synced" | "conflicted" | "none"> {
  const conversationId = row.conversation_id!;

  const run = await pollTaskStatus(row.id, 0);
  if (!run) return "none";
  if (run.status === "queued" || run.status === "running") return "none";

  // Persist the terminal status on the mirror first (crash-friendly).
  await backgroundTaskService.update(row.id, {
    status: run.status,
    finished_at: run.finishedAt ? Date.parse(run.finishedAt) : Date.now(),
    error: run.error,
  });

  const conversation = await conversationService.get(conversationId, userId);
  if (!conversation) return "none"; // deleted while running — nothing to sync into

  // ── CONFLICT CHECK (PRD §4.1) ─────────────────────────────────────────────
  const messages = await conversationService.getMessages(conversationId, userId);
  const userChattedDuringRun = messages.some(
    (m) => Date.parse(m.created_at) > row.started_at,
  );
  if (userChattedDuringRun) {
    await postSyncState(row, "conflicted");
    await backgroundTaskService.update(row.id, { sync_state: "conflicted" });
    return "conflicted";
  }

  // ── EXTRACT ───────────────────────────────────────────────────────────────
  const messageTexts: string[] = [];
  const savedFiles: Array<{ path: string; size: number }> = [];
  const artifactIds: string[] = [];
  const artifacts = (run.artifacts ?? []).slice(0, TASK_PAYLOAD_BUDGET.maxArtifacts);

  for (const summary of artifacts) {
    artifactIds.push(summary.id);
    let art: TaskArtifactContent;
    try {
      art = await fetchArtifact(summary.id, row.task_token);
    } catch {
      continue; // unavailable artifact — the summary message still lands
    }
    const text =
      art.encoding === "base64" ? base64ToUtf8(art.content) : art.content;

    if (summary.kind === "message" || summary.kind === "report") {
      if (text.trim()) messageTexts.push(text.trim());
      continue;
    }

    // file / attachment (anything else with bytes): → OPFS workspace.
    try {
      const segs = sanitizeArtifactSegments(art.name || summary.name);
      const filename = segs[segs.length - 1]!;
      const dirSegs = segs.slice(0, -1);
      const blob =
        art.encoding === "base64"
          ? base64ToBlob(art.content, art.mimeType || summary.mimeType)
          : new Blob([text], { type: art.mimeType || "text/plain" });
      await writeFileAtPath(
        ["users", userId, "workspace", ...dirSegs].join("/"),
        filename,
        blob,
      );
      savedFiles.push({
        path: [...dirSegs, filename].join("/"),
        size: blob.size,
      });
    } catch {
      // unwritable file — the path is still listed below (honest inventory)
      savedFiles.push({ path: art.name || summary.name, size: summary.size });
    }
  }

  // ── ONE assistant message ─────────────────────────────────────────────────
  const label = row.title ?? run.title ?? "Background task";
  const header =
    run.status === "failed"
      ? `The background task failed: ${run.error ?? "unknown error"}`
      : run.status === "cancelled"
        ? `The background task was cancelled — partial results:`
        : messageTexts.length > 0
          ? `Background task completed — ${label}:`
          : `Background task completed — ${label}.`;

  const sections: string[] = [header];
  if (messageTexts.length > 0) {
    sections.push(messageTexts.join("\n\n---\n\n"));
  }
  if (savedFiles.length > 0) {
    sections.push(
      `Files saved to your workspace:\n${savedFiles
        .map((f) => `- \`${f.path}\` (${formatBytes(f.size)})`)
        .join("\n")}`,
    );
  }
  const content = sections.join("\n\n");
  const finishedAt = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();

  try {
    const saved = await conversationService.addMessage(conversationId, userId, {
      role: "assistant",
      content,
      parts: [{ id: `part_${nanoid(8)}`, type: "text", content }],
      generation: {
        startedAt: row.started_at,
        completedAt: finishedAt,
        durationMs: Math.max(0, finishedAt - row.started_at),
        failed: run.status === "failed",
        stopped: run.status === "cancelled",
      },
    });

    // Live-store hydration when the user is viewing this conversation
    // (same pattern as the detached-run sync path).
    try {
      const { useConversationStore, useChatStore } = await import("@/stores");
      if ((useConversationStore.getState().currentConversationId ?? null) === conversationId) {
        const { conversationMessageToChatMessage } = await import("@/lib/conversation-to-chat");
        useChatStore
          .getState()
          .addMessage(
            conversationMessageToChatMessage(
              saved as Parameters<typeof conversationMessageToChatMessage>[0],
            ),
          );
      }
    } catch {
      /* best-effort live hydration */
    }
    notifyConversationsChanged();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to write the background task result into the chat: ${message}`);
  }

  // ── SETTLE ────────────────────────────────────────────────────────────────
  await postSyncState(row, "synced");
  await backgroundTaskService.update(row.id, {
    sync_state: "synced",
    artifact_ids: artifactIds,
    status: run.status,
    finished_at: finishedAt,
    error: run.error,
  });
  return "synced";
}

/** Best-effort server-side sync-state report (local Dexie is the source of
 *  truth for the client state machine; the server marks bookkeeping only). */
async function postSyncState(row: BackgroundTaskRow, state: ClientSyncState): Promise<void> {
  try {
    const body: TaskSyncedRequest = { runId: row.id, taskToken: row.task_token, state };
    await fetch("/api/tasks/sync", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
  } catch {
    /* best-effort — the local row still settles */
  }
}

// ---------------------------------------------------------------------------
// Schedules (FR-2.1) — thin API wrappers used by useTaskSchedules.
// ---------------------------------------------------------------------------

export async function listTaskSchedules(): Promise<TaskScheduleRecord[]> {
  const res = await fetch("/api/tasks/schedules");
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to list schedules"));
  }
  const data = (await res.json()) as { schedules?: TaskScheduleRecord[] };
  return data.schedules ?? [];
}

export async function createTaskSchedule(
  input: TaskScheduleInput,
): Promise<TaskScheduleRecord> {
  const res = await fetch("/api/tasks/schedules", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to create the schedule"));
  }
  const data = (await res.json()) as { schedule?: TaskScheduleRecord };
  if (!data.schedule) throw new Error("Malformed schedule response (missing record)");
  return data.schedule;
}

export async function updateTaskSchedule(
  id: string,
  patch: Partial<TaskScheduleInput>,
): Promise<TaskScheduleRecord> {
  const res = await fetch(`/api/tasks/schedules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to update the schedule"));
  }
  const data = (await res.json()) as { schedule?: TaskScheduleRecord };
  if (!data.schedule) throw new Error("Malformed schedule response (missing record)");
  return data.schedule;
}

export async function deleteTaskSchedule(id: string): Promise<void> {
  const res = await fetch(`/api/tasks/schedules/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw new Error(await errorMessage(res, "Failed to delete the schedule"));
  }
}

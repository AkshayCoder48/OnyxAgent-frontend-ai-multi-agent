"use client";

// ============================================================================
// TURN → TRIGGER.DEV CLOUD HANDOFF — the durability lane for agent turns.
//
// Trigger.dev Cloud is the background job execution system (NOT a sandbox —
// browser automation and code sandboxes are TOOLS a task may use). When the
// app closes while an agent turn is running — reload, tab close, navigate
// away — the in-browser loop dies with the document. That browser event is
// NOT a cancellation: with a Trigger.dev Cloud key connected, the closing
// app DISPATCHES the in-flight turn to the cloud (a tiny beacon to
// /api/tasks/trigger → durable agent_run) and the work continues server-side,
// fully decoupled from the browser:
//
//   send time:  registerChatTurnHandoff is called by use-chat (turn-handoff
//               already owns that registry); business turns register HERE
//               (registerBusinessTurnHandoff) from the orchestrator.
//   pagehide:   turn-handoff.ts → dispatchCloudAgentRunBeacon(...) for the
//               newest running chat turns + dispatchBusinessTurnHandoffs()
//               for running business turns. Each beacon carries: prompt,
//               system prompt, budget-clamped history seed, provider config,
//               rotational key pool, E2B key (or the USE_SERVER_ENV sentinel).
//               A localStorage meta (taskId + taskToken) is the durable
//               pointer for the return path.
//   return:     adoptCloudHandoffRun / adoptBusinessCloudHandoff resolve the
//               server run by the self-minted taskId (?taskId= lookup), write
//               the Dexie mirror row WITH the task token (so cancel/sync are
//               authorized), and the existing background-tasks machinery
//               takes over: the strip polls progress and syncRunToConversation
//               lands the finished result in the owning conversation/business
//               chat.
//
// The cloud runner re-executes the turn from the seed (the in-flight partial
// output is dropped) — identical semantics to the legacy E2B handoff, but
// the execution lifecycle is owned by Trigger.dev Cloud, not by a sandbox
// the browser has to keep alive.
//
// Precedence: CLOUD wins over the legacy E2B beacon when a key is connected;
// the E2B lane remains the fallback for users without one.
// ============================================================================

import { buildKeyPool } from "@/lib/tasks/key-pool";
import {
  backgroundTaskService,
  fetchArtifact,
  pollTaskStatus,
  syncRunToConversation,
} from "@/lib/tasks/client";
import type { TaskStatusRun } from "@/lib/tasks/protocol";

// ---------------------------------------------------------------------------
// Prewarm — cloud mode + key pool, cached while the page is visible.
// ---------------------------------------------------------------------------

interface CloudPrewarmState {
  cloudOn: boolean;
  keyPool: string[];
  checkedAt: number;
}

const g = globalThis as unknown as { __onyxCloudHandoffPrewarm?: CloudPrewarmState | null };

/** Refresh the cached cloud-mode flag + rotational key pool. Called while
 *  visible (mount + visibilitychange) so pagehide never has to await. */
export async function prewarmCloudHandoff(userId?: string): Promise<void> {
  try {
    const res = await fetch("/api/tasks/cloud", { cache: "no-store" });
    const data = (res.ok ? await res.json() : null) as { mode?: string } | null;
    const cloudOn = data?.mode === "cloud";
    let pool: string[] = [];
    if (cloudOn && userId) {
      try {
        pool = (await buildKeyPool({ userId })).pool;
      } catch {
        pool = [];
      }
    }
    g.__onyxCloudHandoffPrewarm = { cloudOn, keyPool: pool, checkedAt: Date.now() };
  } catch {
    // offline/unreachable — keep the last cached value (null-safe)
    if (!g.__onyxCloudHandoffPrewarm) {
      g.__onyxCloudHandoffPrewarm = { cloudOn: false, keyPool: [], checkedAt: Date.now() };
    }
  }
}

/** True when a Trigger.dev Cloud key is connected (last prewarm). */
export function cloudHandoffActive(): boolean {
  return g.__onyxCloudHandoffPrewarm?.cloudOn === true;
}

/** The prewarmed rotational key pool (may be empty → LLM-bridge fallback). */
export function prewarmedKeyPool(): string[] {
  return g.__onyxCloudHandoffPrewarm?.keyPool ?? [];
}

// ---------------------------------------------------------------------------
// Beacon dispatch — pagehide-safe (fully synchronous).
// ---------------------------------------------------------------------------

export interface CloudBeaconInput {
  userId: string;
  prompt: string;
  systemPrompt: string;
  /** Conversation history BEFORE this turn's user message (no system row —
   *  the system prompt travels in config.systemPrompt). */
  history: Array<{ role: "user" | "assistant"; content: string }>;
  /** Absolute provider chat URL. Empty/relative → the keyless LLM bridge. */
  chatUrl: string;
  /** Provider API key (leads the key pool as the runner's bearer). */
  apiKey: string;
  model: string;
  temperature: number | null;
  conversationId?: string | null;
  title?: string;
  /** Decrypted E2B key, when one was prewarmed (else the server env). */
  e2bApiKey?: string | null;
}

/** Beacon body budget — sendBeacon reliably delivers ~64KB; stay under. */
const BEACON_BODY_BUDGET = 56_000;
const BEACON_HISTORY_MAX_MESSAGES = 12;
const BEACON_HISTORY_MAX_CHARS = 2_600;
const BEACON_SYSTEM_MAX_CHARS = 8_000;
const BEACON_PROMPT_MAX_CHARS = 8_000;

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

/** Clamp the beacon payload under budget by trimming oldest history first. */
function clampBeaconMessages(
  history: Array<{ role: "user" | "assistant"; content: string }>,
  prompt: string,
  budgetLeft: number,
): Array<{ role: "user" | "assistant"; content: string }> {
  const capped = history.slice(-BEACON_HISTORY_MAX_MESSAGES).map((m) => ({
    role: m.role,
    content: cap(m.content ?? "", BEACON_HISTORY_MAX_CHARS),
  }));
  const promptCapped = cap(prompt, BEACON_PROMPT_MAX_CHARS);
  // Drop oldest entries until history + prompt fit the remaining budget.
  let entries = [...capped];
  while (
    entries.length > 0 &&
    entries.reduce((n, m) => n + m.content.length, 0) + promptCapped.length > budgetLeft
  ) {
    entries = entries.slice(1);
  }
  entries.push({ role: "user", content: promptCapped });
  return entries;
}

/** Mint the client-side task secret: 64 hex chars (sync — pagehide-safe). */
function mintTaskToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function isAbsoluteHttp(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/**
 * Dispatch ONE in-flight turn to Trigger.dev Cloud during pagehide.
 * Returns the meta when the beacon was fired (null when nothing was sent —
 * e.g. no userId). Synchronous by contract: called from unload handlers.
 */
export function dispatchCloudAgentRunBeacon(input: CloudBeaconInput): {
  taskId: string;
  taskToken: string;
} | null {
  try {
    if (!input.userId || !input.prompt.trim()) return null;

    const taskId = crypto.randomUUID();
    const taskToken = mintTaskToken();

    const systemPrompt = cap(input.systemPrompt ?? "", BEACON_SYSTEM_MAX_CHARS);
    const messages = clampBeaconMessages(
      input.history ?? [],
      input.prompt,
      BEACON_BODY_BUDGET - systemPrompt.length - 2_500, // JSON frame headroom
    );

    // Key pool: the turn's own provider key first (the runner's bearer when
    // a pinned chatUrl is set), then the prewarmed rotational pool.
    const pool: string[] = [];
    if (input.apiKey?.trim()) pool.push(input.apiKey.trim());
    for (const k of prewarmedKeyPool()) {
      if (pool.length >= 8) break;
      if (k && !pool.includes(k)) pool.push(k);
    }

    const config: Record<string, unknown> = {
      systemPrompt,
      model: input.model || undefined,
      maxRounds: 24,
      ...(typeof input.temperature === "number" ? { temperature: input.temperature } : {}),
      ...(isAbsoluteHttp(input.chatUrl) ? { chatUrl: input.chatUrl.trim() } : {}),
    };

    const body = JSON.stringify({
      taskId,
      taskToken,
      type: "agent_run",
      prompt: cap(input.prompt, 32_000),
      config,
      payload: {
        version: 1,
        conversation: {
          id: input.conversationId ?? null,
          title: input.title ?? null,
          messages,
        },
        files: [],
      },
      ...(pool.length > 0 ? { keyPool: pool } : {}),
      e2bApiKey: input.e2bApiKey?.trim() || "USE_SERVER_ENV",
      userId: input.userId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.title ? { title: input.title } : {}),
    });
    // Final guard — if even the clamped body overflows, drop history to the
    // bare prompt (the durable lane must always be able to fire).
    if (body.length > BEACON_BODY_BUDGET) {
      return dispatchCloudAgentRunBeacon({
        ...input,
        history: [],
      });
    }

    // Blob with a non-JSON type avoids a preflight the beacon cannot do; the
    // route parses the raw body regardless (same convention as /api/sandbox).
    navigator.sendBeacon("/api/tasks/trigger", new Blob([body], { type: "text/plain" }));
    return { taskId, taskToken };
  } catch {
    // never break the unload path — the return path reports the loss honestly
    return null;
  }
}

// ---------------------------------------------------------------------------
// Handoff meta — the durable "a cloud run is out there" pointer.
// ---------------------------------------------------------------------------

export interface CloudHandoffMeta {
  taskId: string;
  taskToken: string;
  kind: "chat" | "business";
  conversationId: string | null;
  businessId: string | null;
  startedAt: number;
  promptPreview: string;
}

const CHAT_META_PREFIX = "onyx-turn-cloud-handoff:";
const BUSINESS_META_PREFIX = "onyx-turn-cloud-handoff:business:";
/** Stale metas older than this are dropped on read (runs cap at ~35 min). */
const META_STALE_MS = 12 * 60 * 60 * 1000;

function readMeta(key: string): CloudHandoffMeta | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CloudHandoffMeta;
    if (
      typeof parsed?.taskId !== "string" ||
      typeof parsed?.taskToken !== "string" ||
      typeof parsed?.startedAt !== "number"
    ) {
      return null;
    }
    if (Date.now() - parsed.startedAt > META_STALE_MS) {
      window.localStorage.removeItem(key);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeMeta(key: string, meta: CloudHandoffMeta): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(meta));
    return true;
  } catch {
    return false;
  }
}

function clearMeta(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** Read the pending CLOUD handoff for a chat conversation (null when none). */
export function readCloudHandoffMeta(conversationId: string): CloudHandoffMeta | null {
  return readMeta(CHAT_META_PREFIX + conversationId);
}

/** Persist the chat-turn handoff meta after a pagehide dispatch (sync —
 *  unload-safe; the returning app consumes it exactly once). */
export function writeChatHandoffMeta(
  conversationId: string,
  dispatched: { taskId: string; taskToken: string },
  prompt: string,
): void {
  writeMeta(CHAT_META_PREFIX + conversationId, {
    taskId: dispatched.taskId,
    taskToken: dispatched.taskToken,
    kind: "chat",
    conversationId,
    businessId: null,
    startedAt: Date.now(),
    promptPreview: prompt.slice(0, 400),
  });
}

/** Clear a spent chat-turn handoff meta. */
export function clearChatHandoffMeta(conversationId: string): void {
  clearMeta(CHAT_META_PREFIX + conversationId);
}

/** Read the pending CLOUD handoff for a business turn (null when none). */
export function readBusinessCloudHandoffMeta(businessId: string): CloudHandoffMeta | null {
  return readMeta(BUSINESS_META_PREFIX + businessId);
}

/** The note appended to the stale streaming placeholder when the turn was
 *  handed to Trigger.dev Cloud (must contain "task was interrupted" — the
 *  settle pass uses that substring as its idempotency marker). */
export const CLOUD_HANDOFF_NOTE =
  "This task was interrupted by the app closing — it was handed to Trigger.dev Cloud and keeps running in the background. Live progress is shown in the background tasks strip; the finished result lands in this chat automatically when it completes.";

// ---------------------------------------------------------------------------
// Business turn snapshots (registry lives here; the orchestrator registers).
// ---------------------------------------------------------------------------

export interface BusinessTurnSnapshot {
  businessId: string;
  businessName: string;
  userId: string;
  prompt: string;
  systemPrompt: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  chatUrl: string;
  apiKey: string;
  model: string;
  temperature: number | null;
  startedAt: number;
}

const businessSnapshots = new Map<string, BusinessTurnSnapshot>();

/** Register the CURRENT business turn for a possible close-handoff. Called
 *  from sendBusinessMessage once the model config is resolved. */
export function registerBusinessTurnHandoff(snapshot: BusinessTurnSnapshot): void {
  businessSnapshots.set(snapshot.businessId, snapshot);
}

/** Drop the business snapshot (turn finished/stopped/failed). */
export function unregisterBusinessTurnHandoff(businessId: string): void {
  businessSnapshots.delete(businessId);
}

/** Pagehide pass — dispatch every running business turn to the cloud. */
export function dispatchBusinessTurnHandoffs(e2bApiKey: string | null): void {
  for (const snap of businessSnapshots.values()) {
    const dispatched = dispatchCloudAgentRunBeacon({
      userId: snap.userId,
      prompt: snap.prompt,
      systemPrompt: snap.systemPrompt,
      history: snap.history,
      chatUrl: snap.chatUrl,
      apiKey: snap.apiKey,
      model: snap.model,
      temperature: snap.temperature,
      title: `${snap.businessName} — background turn`,
      e2bApiKey,
    });
    if (dispatched) {
      writeMeta(BUSINESS_META_PREFIX + snap.businessId, {
        taskId: dispatched.taskId,
        taskToken: dispatched.taskToken,
        kind: "business",
        conversationId: null,
        businessId: snap.businessId,
        startedAt: Date.now(),
        promptPreview: snap.prompt.slice(0, 400),
      });
    }
  }
  businessSnapshots.clear();
}

// ---------------------------------------------------------------------------
// Run adoption — the return path.
// ---------------------------------------------------------------------------

/** Resolve a server run by the self-minted task id (pagehide beacons cannot
 *  read the dispatch response). Null when the run cannot be found. */
async function fetchRunByTaskId(taskId: string): Promise<TaskStatusRun | null> {
  try {
    const res = await fetch(`/api/tasks/status?taskId=${encodeURIComponent(taskId)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { run?: TaskStatusRun };
    return data.run ?? null;
  } catch {
    return null;
  }
}

/** Upsert the Dexie mirror row WITH the task token so cancel/sync/sync-back
 *  are authorized in this browser. */
async function mirrorRunWithToken(
  run: TaskStatusRun,
  meta: CloudHandoffMeta,
  userId: string,
  conversationId: string | null,
): Promise<void> {
  const existing = await backgroundTaskService.get(run.runId);
  await backgroundTaskService.put({
    id: run.runId,
    task_id: meta.taskId,
    user_id: userId,
    type: run.type,
    status: run.status,
    title: run.title,
    prompt: run.prompt,
    conversation_id: conversationId,
    schedule_id: run.scheduleId ?? null,
    orchestrator: run.orchestrator,
    task_token: meta.taskToken,
    cursor: Math.max(existing?.cursor ?? 0, 0),
    artifact_ids: existing?.artifact_ids ?? [],
    sync_state: existing?.sync_state ?? "pending",
    started_at: Date.parse(run.startedAt) || meta.startedAt,
    updated_at: Date.now(),
    finished_at: run.finishedAt ? Date.parse(run.finishedAt) : null,
    error: run.error,
  });
}

export interface AdoptCloudRunResult {
  /** The resolved run (null when the beacon never landed). */
  run: TaskStatusRun | null;
  /** True when the finished work was landed into the conversation. */
  landed: boolean;
}

/**
 * Adopt the cloud handoff for a chat conversation on return:
 *   1. resolve the run by taskId (404 ⇒ the beacon never landed — clear the
 *      meta, the honest interrupted note remains),
 *   2. write/refresh the Dexie mirror row WITH the token,
 *   3. terminal ⇒ clear the meta and land the result now (the strip may also
 *      sync it — both paths are idempotent); live ⇒ keep the meta so a later
 *      reload re-adopts, and let the strip poll progress.
 */
export async function adoptCloudHandoffRun(
  userId: string,
  conversationId: string,
): Promise<AdoptCloudRunResult> {
  const meta = readCloudHandoffMeta(conversationId);
  if (!meta) return { run: null, landed: false };

  const run = await fetchRunByTaskId(meta.taskId);
  if (!run) {
    // The beacon never landed (offline close, server error) — no cloud run
    // exists. Clear the pointer; the interrupted note stays honest.
    clearMeta(CHAT_META_PREFIX + conversationId);
    return { run: null, landed: false };
  }

  await mirrorRunWithToken(run, meta, userId, conversationId);

  const terminal = run.status !== "queued" && run.status !== "running";
  if (!terminal) return { run, landed: false };

  // Terminal — land it. A run already synced by the strip settles as
  // "synced" idempotently; the meta is spent either way.
  clearMeta(CHAT_META_PREFIX + conversationId);
  let landed = false;
  try {
    landed = (await syncRunToConversation(run.runId, userId)) === "synced";
  } catch {
    landed = false; // the strip's sync button remains available
  }
  // Re-settle the mirror status after the sync attempt.
  const fresh = await pollTaskStatus(run.runId, 0);
  if (fresh) await mirrorRunWithToken(fresh, meta, userId, conversationId);
  return { run, landed };
}

// ---------------------------------------------------------------------------
// Business landing — the cloud result becomes a Main Agent message.
// ---------------------------------------------------------------------------

/** Pull the message/report artifacts' text out of a finished business run. */
async function extractBusinessResult(
  run: TaskStatusRun,
  taskToken: string,
): Promise<string | null> {
  const texts: string[] = [];
  for (const summary of (run.artifacts ?? []).slice(0, 20)) {
    if (summary.kind !== "message" && summary.kind !== "report") continue;
    try {
      const art = await fetchArtifact(summary.id, taskToken);
      let text = art.content;
      if (art.encoding === "base64") {
        try {
          text = new TextDecoder().decode(
            Uint8Array.from(atob(art.content), (c) => c.charCodeAt(0)),
          );
        } catch {
          // keep raw — some providers double-encode plain text
        }
      }
      if (text.trim()) texts.push(text.trim());
    } catch {
      // unavailable artifact — skip
    }
  }
  return texts.length > 0 ? texts.join("\n\n---\n\n") : null;
}

/**
 * Adopt + (when finished) land a business turn's cloud handoff. Live runs
 * return `{ run, landed: false }` and stay pollable — call this again later
 * (or from a poll loop) to land the result when it completes.
 */
export async function adoptBusinessCloudHandoff(
  userId: string,
  businessId: string,
): Promise<AdoptCloudRunResult> {
  const meta = readBusinessCloudHandoffMeta(businessId);
  if (!meta) return { run: null, landed: false };

  const run = await fetchRunByTaskId(meta.taskId);
  if (!run) {
    clearMeta(BUSINESS_META_PREFIX + businessId);
    return { run: null, landed: false };
  }

  await mirrorRunWithToken(run, meta, userId, null);

  const terminal = run.status !== "queued" && run.status !== "running";
  if (!terminal) return { run, landed: false };

  clearMeta(BUSINESS_META_PREFIX + businessId);
  let landed = false;
  try {
    const { businessChatService } = await import("@/lib/business/data");
    const { useBusinessStore } = await import("@/stores/business-store");
    const content =
      run.status === "completed"
        ? ((await extractBusinessResult(run, meta.taskToken)) ??
          `The background turn finished, but its result could not be read (run ${run.runId}).`)
        : `The background turn ${
            run.status === "failed" ? "failed" : "was cancelled"
          }: ${run.error ?? "no error detail"}.`;
    const row = await businessChatService.append(businessId, {
      role: "main",
      content,
      metadata: {
        turnId: `cloud-${meta.taskId.slice(0, 8)}`,
        cloudRunId: run.runId,
        background: true,
      },
    });
    useBusinessStore.getState().appendChatMessage(row);
    landed = true;
  } catch {
    landed = false;
  }
  return { run, landed };
}

// ---------------------------------------------------------------------------
// Detached-mode dispatch — the EXPLICIT background lane (not in unload).
// ---------------------------------------------------------------------------

/**
 * Start a chat turn directly as a Trigger.dev Cloud run (the "cloud runs"
 * detached mode): full payload serialization (workspace manifest included),
 * Dexie mirror row with the token, and the background-tasks strip owns the
 * live status. The turn NEVER runs in the browser — maximal durability.
 */
export async function dispatchDetachedCloudTurn(input: {
  userId: string;
  conversationId: string;
  prompt: string;
  systemPrompt: string;
  chatUrl: string;
  model: string;
  temperature: number | null;
  preferredProviderId?: string | null;
  title?: string;
}): Promise<{ runId: string; orchestrator: string }> {
  const { triggerBackgroundTask } = await import("@/lib/tasks/client");
  let sandboxApiKey: string | undefined;
  try {
    const { settingsService } = await import("@/lib/services");
    const key = await settingsService.getDecryptedSandboxKey(input.userId);
    if (key) sandboxApiKey = key;
  } catch {
    // no E2B key — the cloud worker uses the server env
  }
  return triggerBackgroundTask({
    userId: input.userId,
    conversationId: input.conversationId,
    type: "agent_run",
    prompt: input.prompt,
    title: input.title,
    config: {
      systemPrompt: input.systemPrompt,
      model: input.model || undefined,
      maxRounds: 24,
      ...(typeof input.temperature === "number" ? { temperature: input.temperature } : {}),
      ...(isAbsoluteHttp(input.chatUrl) ? { chatUrl: input.chatUrl.trim() } : {}),
    },
    includeWorkspace: true,
    preferredProviderId: input.preferredProviderId ?? undefined,
    sandboxApiKey,
  });
}

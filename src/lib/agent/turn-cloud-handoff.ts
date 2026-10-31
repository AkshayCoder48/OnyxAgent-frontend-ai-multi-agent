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
//               already owns that registry).
//   pagehide:   turn-handoff.ts → dispatchCloudAgentRunBeacon(...) for the
//               newest running chat turns. Each beacon carries: prompt,
//               system prompt, budget-clamped history seed, provider config,
//               rotational key pool, E2B key (or the USE_SERVER_ENV sentinel).
//               A localStorage meta (taskId + taskToken) is the durable
//               pointer for the return path.
//   return:     the chat path takes over the interrupted bubble IN PLACE — it
//               becomes a live background status bubble that is replaced by
//               the finished answer when the run completes (no strips, no
//               "interrupted" notes — changes land directly in the chat
//               bubbles). When the beacon never landed, use-chat re-dispatches
//               the turn itself (self-heal) instead of settling it as
//               interrupted.
//
// The cloud runner re-executes the turn from the seed (the in-flight partial
// output is dropped) — and on return the interrupted chat bubble is taken
// over IN PLACE: it shows live background status and is replaced by the
// finished answer when the run lands. E2B is only ever a TOOL (sandbox),
// never the background execution engine.
//
// The cloud lane is the ONLY durability lane (the legacy E2B beacon was
// removed — user directive: "use trigger for bg work, not e2b").
// ============================================================================

import { buildKeyPool } from "@/lib/tasks/key-pool";
import {
  backgroundTaskService,
  fetchArtifact,
} from "@/lib/tasks/client";
import type { TaskStatusRun } from "@/lib/tasks/protocol";
// PURE leaf of the shared AI client layer — the legacy-endpoint guard for
// every pinned-gateway dispatch lane below.
import { isLegacyClassicUrl } from "./provider-url";

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
      // USER DIRECTIVE: no 24-round cap — the server default (400) governs;
      // the real bound is the run's execution window.
      maxRounds: 400,
      ...(typeof input.temperature === "number" ? { temperature: input.temperature } : {}),
      // LEGACY-CLASSIC GUARD: never pin the retired text.pollinations.ai
      // endpoint into a NEW cloud run (a stale pre-migration tab can still
      // flip the provider row onto the legacy host — the foreground turn
      // may have resolved it before the flip was healed). A legacy pin
      // drops to the keyless bridge instead of a guaranteed-404 gateway.
      ...(isAbsoluteHttp(input.chatUrl) && !isLegacyClassicUrl(input.chatUrl)
        ? { chatUrl: input.chatUrl.trim() }
        : {}),
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
  kind: "chat";
  conversationId: string | null;
  businessId: null;
  startedAt: number;
  promptPreview: string;
}

const CHAT_META_PREFIX = "onyx-turn-cloud-handoff:";
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

/** Clear a spent chat-turn handoff meta. */
export function clearChatHandoffMeta(conversationId: string): void {
  clearMeta(CHAT_META_PREFIX + conversationId);
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

// ---------------------------------------------------------------------------
// Run adoption — the return path.
// ---------------------------------------------------------------------------

/** Resolve a server run by the self-minted task id (pagehide beacons cannot
 *  read the dispatch response). Null when the run cannot be found. */
export async function resolveCloudRun(taskId: string): Promise<TaskStatusRun | null> {
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
export async function mirrorCloudRunWithToken(
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

/** Mark a run's Dexie mirror row terminal + synced — used by the in-bubble
 * chat landing flow when it lands the finished result ITSELF (the general
 * background lander must not append a second copy afterwards). */
export async function markCloudRunSynced(run: TaskStatusRun): Promise<void> {
  try {
    await backgroundTaskService.update(run.runId, {
      status: run.status,
      sync_state: "synced",
      finished_at: run.finishedAt ? Date.parse(run.finishedAt) : Date.now(),
      error: run.error,
    });
  } catch {
    // best-effort — a duplicate sync would be idempotent anyway
  }
}

/** Pull the message/report artifacts' text out of a finished run. PUBLIC:
 * the in-bubble chat landing flow uses it to write the finished answer
 * straight into the chat bubble.
 *
 * When the task token is unknown (a beacon run whose localStorage meta was
 * lost), the artifact fetch 401s — the caller falls back to the run's public
 * TEXT CHUNKS (extractChunkText), which carry the native runner's answer. */
export async function extractChatResult(
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

/** Reconstruct answer text from a run's PUBLIC status chunks — the tokenless
 * fallback for adopted beacon runs whose artifacts cannot be fetched. Text
 * chunks arrive in seq order; each was capped at write time, so long answers
 * are joined back together on multiple chunks. */
export function extractChunkText(run: TaskStatusRun): string | null {
  const chunks = (run.chunks ?? [])
    .filter((c) => c.kind === "text" && typeof c.content === "string")
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const text = chunks.map((c) => String(c.content).trim()).filter(Boolean).join("");
  return text.length > 0 ? text : null;
}

// ---------------------------------------------------------------------------
// Detached-mode dispatch — the EXPLICIT background lane (not in unload).
// ---------------------------------------------------------------------------

/** The detached dispatch result — runId for the strip plus the client-minted
 * taskId/taskToken pair (the self-heal re-dispatch path persists it as a
 * handoff meta so the standard adoption loop can take over). */
export interface DetachedCloudTurn {
  runId: string;
  orchestrator: string;
  taskId: string;
  taskToken: string;
}

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
  /** Absolute provider chat URL. Empty/relative → the keyless LLM bridge
   *  (the documented fallback when no provider gateway exists). */
  chatUrl: string;
  /** The pinned provider's API key — leads the runner's key pool. */
  apiKey?: string;
  model: string;
  temperature: number | null;
  preferredProviderId?: string | null;
  title?: string;
}): Promise<DetachedCloudTurn> {
  const { triggerBackgroundTask } = await import("@/lib/tasks/client");
  let sandboxApiKey: string | undefined;
  try {
    const { settingsService } = await import("@/lib/services");
    const key = await settingsService.getDecryptedSandboxKey(input.userId);
    if (key) sandboxApiKey = key;
  } catch {
    // no E2B key — the cloud worker uses the server env
  }
  const dispatched = await triggerBackgroundTask({
    userId: input.userId,
    conversationId: input.conversationId,
    type: "agent_run",
    prompt: input.prompt,
    title: input.title,
    config: {
      systemPrompt: input.systemPrompt,
      model: input.model || undefined,
      // USER DIRECTIVE: no 24-round cap — the server default (400) governs.
      maxRounds: 400,
      ...(typeof input.temperature === "number" ? { temperature: input.temperature } : {}),
      // LEGACY-CLASSIC GUARD (same as the beacon lane): never pin the
      // retired text.pollinations.ai endpoint into a NEW cloud run — a
      // legacy pin drops to the keyless bridge instead.
      ...(isAbsoluteHttp(input.chatUrl) && !isLegacyClassicUrl(input.chatUrl)
        ? { chatUrl: input.chatUrl.trim() }
        : {}),
    },
    includeWorkspace: true,
    preferredProviderId: input.preferredProviderId ?? undefined,
    // Pinned gateway → its key leads the pool (no rotation). Empty chatUrl
    // (bridge lane) ignores the key — the bridge authorizes by task token.
    ...(isAbsoluteHttp(input.chatUrl) && !isLegacyClassicUrl(input.chatUrl) && input.apiKey?.trim()
      ? { pinnedApiKey: input.apiKey.trim() }
      : {}),
    sandboxApiKey,
  });
  return {
    runId: dispatched.runId,
    orchestrator: dispatched.orchestrator,
    taskId: dispatched.taskId,
    taskToken: dispatched.taskToken,
  };
}

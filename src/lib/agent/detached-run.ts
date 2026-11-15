"use client";

/**
 * DETACHED SANDBOX RUNS — the "close and resume" architecture (E2B lane).
 *
 * OnyxAgent is a frontend-only app: the foreground agent loop lives in the
 * browser tab, so closing the tab kills it. This module moves the
 * orchestration loop INTO the E2B sandbox:
 *
 *   send ──▶ /api/sandbox agent_start ──▶ detached python3 headless_runner.py
 *                                              │ (survives the app closing)
 *   return ──▶ agent_status + chat_history.json ──▶ synced assistant message
 *
 * The runner (see src/lib/e2b/headless-agent.ts) talks to the LLM gateway
 * directly from inside the sandbox, executes sandbox-native tools
 * (terminal / files / todos), and persists everything to
 * /home/user/chat_history.json + agent_status.json. This client library:
 *
 *   · builds the run config (seed messages from the conversation history),
 *   · starts / stops / polls the runner through the E2BClient,
 *   · ADOPTS a live run: polls to terminal and lands the finished work
 *     INTO the chat bubble in place (adoptDetachedRun) — used both by the
 *     live send path and by the reattach-on-return path in use-chat,
 *   · converts the sandbox history into a native assistant ChatMessage
 *     (tool parts + final text),
 *   · merges sandbox todos.json (agent + cron-scheduled todos) into the
 *     conversation's Dexie todo list.
 *
 * NOT-CUT-MID-RUN guarantees this lane rides on (server side, /api/sandbox):
 *   · agent_start resets the sandbox window to 24h (pause-on-timeout, not
 *     kill; the next connect auto-resumes),
 *   · pause + rotation guards skip sandboxes hosting a live runner,
 *   · the runner persists history + status after EVERY round.
 *
 * Durable state of record: the Dexie `detached_runs` table (survives reloads
 * and app restarts). The live UI mirror lives in `detached-run-store`.
 */

import { nanoid } from "nanoid";
import type { AgentStatusResponse, SandboxHistoryMessage } from "@/lib/e2b/client";
import { getE2BClient } from "@/lib/e2b/client";
import { getEffectiveE2BKey } from "@/lib/e2b/env-key";
import { getDB, type DetachedRunRow } from "@/lib/db";
import type { MessagePart, ToolCall } from "@/types/chat";
import type { SandboxStreamEvent } from "@/lib/agent/sandbox-stream-events";
import { clearDetachedActive, markDetachedActive } from "@/lib/agent/detached-active";
import { useDetachedRunStore } from "@/stores/detached-run-store";
import { notifyConversationsChanged } from "@/lib/chat-events";

// ---------------------------------------------------------------------------
// Run config (what gets written to /home/user/.onyx/agent/run.json)
// ---------------------------------------------------------------------------

export interface DetachedRunConfig {
  run_id: string;
  conversation_id: string;
  prompt: string;
  /** Final chat-completions URL (baseUrl + /chat/completions — the caller
   *  resolves the provider's noPrefix rule, mirroring runtime.ts). */
  chat_url: string;
  api_key: string;
  model: string;
  /** Extra model ids the runner rotates to when the primary is unavailable
   *  (rung 0 of its retry ladder — e.g. the Kilo anon tier's concrete :free
   *  fallbacks when the virtual tier id rotates). */
  fallback_models?: string[];
  system_prompt: string;
  /** Seed = system + prior conversation + the NEW user message. The runner
   *  appends its own assistant/tool messages after these. */
  seed_messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature?: number | null;
  max_rounds?: number;
}

/** Hard limits for the seed (bounded history so the run config stays light
 *  and every gateway accepts it). The runner re-sends exactly these
 *  messages each round. */
const SEED_MAX_MESSAGES = 30;
const SEED_MAX_MESSAGE_CHARS = 12_000;

/** Compress one history row into a plain-text seed entry. Assistant rows
 *  carrying tool calls are summarized (their tool results are too heavy and
 *  the runner cannot replay foreign tool_call ids anyway). */
export function buildSeedMessages(
  systemPrompt: string,
  history: Array<{ role: string; content: string }>,
  newPrompt: string,
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const seed: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
  if (systemPrompt.trim()) seed.push({ role: "system", content: systemPrompt });

  const recent = history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .filter((m) => (m.content ?? "").trim().length > 0)
    .slice(-SEED_MAX_MESSAGES)
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: (m.content ?? "").slice(0, SEED_MAX_MESSAGE_CHARS),
    }));
  seed.push(...recent);
  seed.push({ role: "user", content: newPrompt.slice(0, SEED_MAX_MESSAGE_CHARS) });
  return seed;
}

// ---------------------------------------------------------------------------
// History → assistant ChatMessage conversion (the sync path)
// ---------------------------------------------------------------------------

/** Parse a tool-call arguments string safely. */
function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return { raw };
  }
}

export interface ConvertedAssistantMessage {
  content: string;
  parts: MessagePart[];
  toolCalls: ToolCall[];
  failed: boolean;
}

/**
 * Convert the NEW slice of the sandbox chat history (everything after the
 * seed) into one native assistant message payload: one tool part per
 * executed tool call (with its result), then a final text part. Mirrors how
 * the foreground runtime builds parts, so the existing tool-call cards
 * render detached results identically.
 */
export function convertHistoryToAssistantMessage(
  history: SandboxHistoryMessage[],
): ConvertedAssistantMessage {
  const parts: MessagePart[] = [];
  const toolCalls: ToolCall[] = [];
  let finalText = "";
  let sawFailure = false;

  for (const msg of history) {
    if (msg.role !== "assistant") continue;
    const toolCallSpecs = msg.tool_calls ?? [];

    for (const spec of toolCallSpecs) {
      const name = spec.function?.name ?? "unknown";
      const args = parseArgs(spec.function?.arguments);
      const result = findToolResult(history, spec.id);
      const isError = typeof result === "string" && result.startsWith("error:");
      if (isError) sawFailure = true;
      const startedAt = Date.now();
      const toolCall: ToolCall = {
        id: spec.id || `call_${nanoid(8)}`,
        name,
        args,
        result,
        status: isError ? "error" : "completed",
        startedAt,
        endedAt: startedAt,
      };
      toolCalls.push(toolCall);
      parts.push({
        id: `part_${nanoid(8)}`,
        type: "tool",
        toolCall,
      });
    }

    if ((msg.content ?? "").trim()) {
      finalText = (msg.content ?? "").trim();
    }
  }

  parts.push({
    id: `part_${nanoid(8)}`,
    type: "text",
    content: finalText || "(the run finished without a final message)",
  });

  return {
    content: finalText || "(the run finished without a final message)",
    parts,
    toolCalls,
    failed: sawFailure,
  };
}

/** Find the tool-role message answering a tool_call id. */
function findToolResult(history: SandboxHistoryMessage[], toolCallId: string): string | undefined {
  const hit = history.find((m) => m.role === "tool" && m.tool_call_id === toolCallId);
  if (!hit) return undefined;
  return typeof hit.content === "string" ? hit.content : JSON.stringify(hit.content ?? "");
}

// ---------------------------------------------------------------------------
// Sandbox todos.json → conversation todo list (scheduled-task visibility)
// ---------------------------------------------------------------------------

interface SandboxTodo {
  id?: string;
  title?: string;
  description?: string;
  status?: string;
}

/** Map the sandbox runner's status vocabulary onto the app's Todo statuses. */
function mapTodoStatus(status: string | undefined): "not_planned" | "in_progress" | "done" | "not_done" {
  switch (status) {
    case "in_progress":
      return "in_progress";
    case "done":
      return "done";
    case "not_done":
      return "not_done";
    default:
      return "not_planned";
  }
}

/**
 * Merge the sandbox's todos.json into the conversation's Dexie todo list.
 * Only sandbox-managed ids (`sched-…` from cron scripts, `todo-…` from the
 * detached runner) are touched — foreground todos keep their own ids
 * (`todo_XXXX`, different format) and are never overwritten. New sandbox
 * todos are appended; known ones are refreshed in place.
 */
export async function mergeSandboxTodosIntoConversation(
  conversationId: string,
  sandboxTodos: unknown,
): Promise<number> {
  if (!Array.isArray(sandboxTodos) || sandboxTodos.length === 0) return 0;
  const { restoreTodos, persistTodos } = await import("@/lib/tools/todos");
  const existing = await restoreTodos(conversationId);
  const byId = new Map(existing.map((t) => [t.id, t]));
  let changed = 0;

  for (const raw of sandboxTodos as SandboxTodo[]) {
    const id = typeof raw?.id === "string" ? raw.id : null;
    const title = typeof raw?.title === "string" ? raw.title : null;
    if (!id || !title) continue;
    // Only sandbox-managed namespaces (cron scripts use `sched-<ts>`, the
    // detached runner's manage_todo uses `todo-<ts>`).
    if (!id.startsWith("sched-") && !id.startsWith("todo-")) continue;
    const now = Date.now();
    const mapped = {
      id,
      title,
      description: typeof raw.description === "string" ? raw.description : undefined,
      status: mapTodoStatus(raw.status),
      createdAt: now,
      updatedAt: now,
    };
    const cur = byId.get(id);
    if (!cur) {
      byId.set(id, { ...mapped, createdAt: now, updatedAt: now });
      changed++;
    } else if (
      cur.title !== mapped.title ||
      cur.status !== mapped.status ||
      cur.description !== mapped.description
    ) {
      byId.set(id, { ...cur, ...mapped, createdAt: cur.createdAt });
      changed++;
    }
  }

  if (changed > 0) {
    await persistTodos(conversationId, [...byId.values()]);
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Dexie run records
// ---------------------------------------------------------------------------

/** The most recent detached-run row for a conversation (any status). */
export async function getDetachedRunForConversation(
  userId: string,
  conversationId: string,
): Promise<DetachedRunRow | null> {
  try {
    const db = getDB();
    const rows = await db.detached_runs
      .where("conversation_id")
      .equals(conversationId)
      .and((r) => r.user_id === userId)
      .sortBy("started_at");
    let row = rows[rows.length - 1] ?? null;
    if (!row) {
      // USER-ID DRIFT FALLBACK (the refresh auto-stop bug): a run dispatched
      // under the transient pre-auth id ("local-user") while this session
      // resolved to the real id made the user-scoped miss fall through to
      // the interrupted-settle path — a LIVE run landed as "interrupted" on
      // every reload. Conversation ids are nanoid-unique, so a
      // conversation-scoped match is provably this conversation's run.
      const any = await db.detached_runs
        .where("conversation_id")
        .equals(conversationId)
        .sortBy("started_at");
      row = any[any.length - 1] ?? null;
    }
    return row;
  } catch {
    return null;
  }
}

async function saveRunRow(row: DetachedRunRow): Promise<void> {
  try {
    const db = getDB();
    await db.detached_runs.put(row);
  } catch (err) {
    console.warn("[detached-run] failed to persist run row:", err);
  }
}

// ---------------------------------------------------------------------------
// Start / poll / stop
// ---------------------------------------------------------------------------

export interface StartDetachedRunInput {
  userId: string;
  conversationId: string;
  prompt: string;
  systemPrompt: string;
  chatUrl: string;
  apiKey: string;
  model: string;
  /** Extra model ids the runner may rotate to when the primary is
   *  unavailable (the Kilo anon tier reroutes server-side; concrete :free
   *  ids rotate over time). */
  fallbackModels?: readonly string[];
  temperature?: number | null;
  /** Prior conversation history (Dexie rows) — used for the seed. */
  history: Array<{ role: string; content: string }>;
  maxRounds?: number;
}

export interface StartDetachedRunResult {
  ok: boolean;
  runId: string;
  sandboxId: string | null;
  error?: string;
}

/** Resolve the chat's E2B client for a conversation (same shared sandbox
 *  the chat's sandbox tools use — matching runtime.ts's "shared" mode). */
async function chatE2BClient(userId: string, conversationId: string) {
  const e2bKey = await getEffectiveE2BKey(userId);
  if (!e2bKey) return null;
  return getE2BClient(e2bKey, conversationId, "shared");
}

/**
 * Start a detached run: resolve the E2B key, deploy the runner (version-
 * stamped), write the run config + launch the detached process, persist the
 * Dexie row + store view + the pagehide-pause exemption flag. The server
 * resets the sandbox window to 24h at start (pause-on-timeout — the run is
 * never cut mid-flight by the E2B lifetime cap).
 */
export async function startDetachedRun(
  input: StartDetachedRunInput,
): Promise<StartDetachedRunResult> {
  const runId = `run_${nanoid(10)}`;
  const e2bKey = await getEffectiveE2BKey(input.userId);
  if (!e2bKey) {
    return {
      ok: false,
      runId,
      sandboxId: null,
      error:
        "No E2B sandbox key configured. Add one in Settings → API Keys (or set E2B_API_KEY on the server) to use background runs.",
    };
  }

  const seed = buildSeedMessages(input.systemPrompt, input.history, input.prompt);
  const config: DetachedRunConfig = {
    run_id: runId,
    conversation_id: input.conversationId,
    prompt: input.prompt,
    chat_url: input.chatUrl,
    api_key: input.apiKey,
    model: input.model,
    fallback_models: [...(input.fallbackModels ?? [])],
    system_prompt: input.systemPrompt,
    seed_messages: seed,
    temperature: input.temperature ?? null,
    max_rounds: input.maxRounds ?? 400,
  };

  // Same shared sandbox the chat's sandbox tools resolve to.
  const client = getE2BClient(e2bKey, input.conversationId, "shared");
  try {
    await client.agentDeploy();
    const started = await client.agentStart(config);
    if (!started.started) {
      return {
        ok: false,
        runId,
        sandboxId: started.sandboxId ?? null,
        error: "The sandbox runner failed to launch (see Settings → Logs).",
      };
    }
    const sandboxId = started.sandboxId;
    const now = Date.now();

    const row: DetachedRunRow = {
      id: runId,
      user_id: input.userId,
      conversation_id: input.conversationId,
      sandbox_id: sandboxId,
      status: "running",
      prompt: input.prompt.slice(0, 4000),
      seed_count: seed.length,
      provider_model: input.model,
      chat_url: input.chatUrl,
      started_at: now,
      updated_at: now,
    };
    await saveRunRow(row);

    // UI mirror + pagehide-pause exemption (the sandbox must NOT be paused
    // on app close — the whole point is that the runner keeps working).
    useDetachedRunStore.getState().setRun(input.conversationId, {
      runId,
      sandboxId,
      status: "running",
      stage: "starting",
      startedAt: now,
    });
    markDetachedActive(sandboxId);

    return { ok: true, runId, sandboxId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, runId, sandboxId: null, error: message };
  }
}

/** Light status poll (no history) for live progress. */
export async function pollDetachedRunStatus(
  userId: string,
  conversationId: string,
): Promise<AgentStatusResponse | null> {
  try {
    const client = await chatE2BClient(userId, conversationId);
    if (!client) return null;
    return await client.agentStatus({ includeHistory: false });
  } catch {
    return null;
  }
}

/** User-initiated stop (the chat Stop button while a sandbox run is live). */
export async function stopDetachedRun(
  userId: string,
  conversationId: string,
): Promise<boolean> {
  const store = useDetachedRunStore.getState();
  const view = store.runs[conversationId];
  if (!view) return false;
  try {
    const client = await chatE2BClient(userId, conversationId);
    if (client) await client.agentStop();
  } catch {
    // best-effort — the runner may already be gone
  }
  const now = Date.now();
  store.patchRun(conversationId, { status: "stopped", error: null });
  const row = await getDetachedRunForConversation(userId, conversationId);
  if (row && row.id === view.runId) {
    await saveRunRow({ ...row, status: "stopped", finished_at: now, updated_at: now });
  }
  clearDetachedActive(view.sandboxId);
  return true;
}

// ---------------------------------------------------------------------------
// Adoption — poll a live run to terminal and land the finished work
// ---------------------------------------------------------------------------

export interface AdoptDetachedRunInput {
  userId: string;
  conversationId: string;
  /** The streaming assistant row the run is rendering into (the
   *  placeholder bubble). Null → the append path (syncDetachedRun) lands
   *  the result as a NEW assistant message instead. */
  messageId: string | null;
  /** Breaks the poll loop (unmount / navigation). The next mount re-adopts
   *  from the persisted Dexie row. */
  isCancelled: () => boolean;
  /** Live progress tick — the caller rewrites the bubble's status line. */
  onProgress?: (status: NonNullable<AgentStatusResponse["status"]>) => void;
  /** LIVE EVENT BRIDGE — sandbox runner events (response.delta tokens,
   *  tool.started / tool.result, round.started, terminal markers) forwarded
   *  in real time from the SSE stream. Purely additive live view: the
   *  authoritative landing happens from chat_history.json at terminal, so a
   *  dropped or late event never corrupts the final message. */
  onEvent?: (ev: SandboxStreamEvent) => void;
  /** The run's sandbox (row.sandbox_id) — helps the SSE bridge resolve the
   *  sandbox on a serverless cold start. */
  sandboxId?: string | null;
}

/** One structured event from the runner's replay log (agent_events.jsonl),
 *  forwarded by the SSE bridge (/api/sandbox?stream=1). `i` is the 1-based
 *  event id — the SSE Last-Event-ID — so reconnects replay exactly the
 *  missing tail. (Defined in sandbox-stream-events.ts; re-exported here as
 *  the historical import site.) */
export type { SandboxStreamEvent } from "@/lib/agent/sandbox-stream-events";

export interface AdoptDetachedRunResult {
  /** Terminal runner status ("completed" | "failed" | "stopped"). */
  status: "completed" | "failed" | "stopped";
  error?: string | null;
  /** True when the poll loop broke early (cancelled) — nothing was landed. */
  cancelled: boolean;
}

const ADOPT_POLL_MS = 4000;
/** Consecutive "no sandbox resolvable" polls tolerated before failing. */
const ADOPT_NO_SANDBOX_GRACE = 15;
/** Consecutive "no status file + dead runner" polls before declaring the
 *  run dead (covers a wiped sandbox / killed runner mid-boot). */
const ADOPT_DEAD_GRACE = 5;

/** localStorage ref (PRD persistence layer 3) — the lightweight pointer a
 *  reload reads to know a live run exists for a conversation. Written from
 *  the event stream, throttled to ~1/s. */
function writeStreamRef(conversationId: string, ref: Record<string, unknown>) {
  try {
    const key = `onyx-bg-stream:${conversationId}`;
    const prev = window.localStorage.getItem(key);
    const prevTs = prev ? (JSON.parse(prev) as { updatedAt?: number }).updatedAt ?? 0 : 0;
    if (Date.now() - prevTs < 1000) return;
    window.localStorage.setItem(key, JSON.stringify({ ...ref, updatedAt: Date.now() }));
  } catch {
    // best-effort
  }
}

/** Open the LIVE EVENT BRIDGE (SSE) for an adopted run. Returns a closer.
 *
 * The endpoint tails /home/user/agent_events.jsonl and forwards each event
 * with its `i` as the SSE id — an EventSource auto-reconnect replays the
 * missing tail via Last-Event-ID, so a network blip or the server's 240s
 * connection cap loses nothing. When the bridge answers `done` with
 * {noSandbox} while the adoption loop is still polling (a pausing sandbox),
 * we back off and reconnect a few times before giving up on the live view —
 * the status-poll watchdog (adoptDetachedRun's loop) remains the source of
 * truth either way. */
function openAgentEventStream(
  input: AdoptDetachedRunInput,
  runId: string | null,
  onEvent: (ev: SandboxStreamEvent) => void,
): () => void {
  if (typeof window === "undefined" || typeof EventSource === "undefined") {
    return () => undefined;
  }
  let closed = false;
  let es: EventSource | null = null;
  let attempts = 0;
  const MAX_REOPEN = 6;

  const open = async () => {
    if (closed) return;
    try {
      const { getEffectiveE2BKey } = await import("@/lib/e2b/env-key");
      const key = await getEffectiveE2BKey(input.userId);
      if (!key || closed) return;
      const params = new URLSearchParams({
        stream: "1",
        key,
        conversationId: input.conversationId,
        mode: "shared",
      });
      if (input.sandboxId) params.set("sandboxId", input.sandboxId);
      es = new EventSource(`/api/sandbox?${params.toString()}`);
      es.addEventListener("agent", (e) => {
        attempts = 0; // events are flowing — reset the reopen budget
        try {
          const ev = JSON.parse((e as MessageEvent).data as string) as SandboxStreamEvent;
          onEvent(ev);
          writeStreamRef(input.conversationId, {
            runId,
            sandboxId: input.sandboxId ?? null,
            lastEventId: ev.i,
          });
        } catch {
          // torn line — the next poll re-forwards it
        }
      });
      es.addEventListener("done", (e) => {
        es?.close();
        es = null;
        let payload: { noSandbox?: boolean } = {};
        try {
          payload = JSON.parse((e as MessageEvent).data as string) as { noSandbox?: boolean };
        } catch {
          /* empty payload is fine */
        }
        if (!closed && payload.noSandbox && ++attempts < MAX_REOPEN) {
          // The sandbox is mid-pause/resume — retry the bridge shortly.
          setTimeout(() => void open(), 4000 + attempts * 2000);
        }
      });
    } catch {
      if (!closed && ++attempts < MAX_REOPEN) {
        setTimeout(() => void open(), 4000 + attempts * 2000);
      }
    }
  };
  void open();
  return () => {
    closed = true;
    es?.close();
    es = null;
  };
}

/**
 * ADOPT A DETACHED RUN — the one loop both live paths ride on:
 *
 *   · the live send path (use-chat runDetachedTurn) calls it right after a
 *     successful start while the user watches the bubble;
 *   · the reattach-on-return path calls it when the app reopens a
 *     conversation whose Dexie row is still starting/running (the sandbox
 *     kept working while the app was closed).
 *
 * Polls agent_status (the server reconnects to the sandbox — auto-resuming
 * it if E2B paused it at the 24h timeout — and never mints a new one) while
 * the SSE bridge streams token-level events into the live view. On a
 * terminal status the sandbox history's NEW slice (past the seed) is
 * converted to tool parts + final text and written INTO the bubble row in
 * place (or appended when no bubble was given), the sandbox todos merge,
 * and the Dexie row settles to synced.
 */
export async function adoptDetachedRun(
  input: AdoptDetachedRunInput,
): Promise<AdoptDetachedRunResult> {
  const row = await getDetachedRunForConversation(input.userId, input.conversationId);
  if (!row || row.status === "synced" || row.result_message_id) {
    return { status: "completed", cancelled: false };
  }
  const client = await chatE2BClient(input.userId, input.conversationId);
  if (!client) {
    return {
      status: "failed",
      error: "E2B key unavailable — cannot reach the sandbox to sync the run.",
      cancelled: false,
    };
  }

  // LIVE EVENT BRIDGE — every event forwards to the caller (which feeds the
  // processor for the real streaming UI + throttles a Dexie checkpoint).
  const closeStream = openAgentEventStream(
    { ...input, sandboxId: input.sandboxId ?? row.sandbox_id },
    row.id,
    (ev) => {
      try {
        input.onEvent?.(ev);
      } catch {
        // the live view must never break the adoption loop
      }
    },
  );

  let noSandboxStreak = 0;
  let deadStreak = 0;
  try {
    for (;;) {
      if (input.isCancelled()) return { status: "completed", cancelled: true };
      await new Promise((r) => setTimeout(r, ADOPT_POLL_MS));
      if (input.isCancelled()) return { status: "completed", cancelled: true };

      let res: AgentStatusResponse;
      try {
        res = await client.agentStatus({ includeHistory: false });
      } catch {
        continue; // transient — the next poll retries
      }

      if (res.noSandbox) {
        // Nothing resolvable yet (a just-dispatched beacon, a resuming pause).
        if (++noSandboxStreak >= ADOPT_NO_SANDBOX_GRACE) {
          return {
            status: "failed",
            error: "The sandbox could not be reached — it may have expired. Re-send the message to continue.",
            cancelled: false,
          };
        }
        continue;
      }
      noSandboxStreak = 0;

      const st = res.status?.status ?? null;
      if (st === "running" || st === "starting") {
        deadStreak = 0;
        input.onProgress?.(res.status!);
        continue;
      }
      if (st === "completed" || st === "failed" || st === "stopped") {
        return await landDetachedRun(input, row, st, res.status?.error ?? null);
      }

      // No status file — the runner is only alive if pgrep says so.
      if (res.runnerAlive) {
        deadStreak = 0;
        continue;
      }
      if (++deadStreak >= ADOPT_DEAD_GRACE) {
        return await landDetachedRun(input, row, "failed", "the sandbox runner vanished before producing a status");
      }
    }
  } finally {
    closeStream();
  }
}

/** Terminal landing shared by adoptDetachedRun: fetch the full history,
 *  convert the new slice, write it into the bubble (or append), settle the
 *  Dexie row + store + pause-exemption flag. */
async function landDetachedRun(
  input: AdoptDetachedRunInput,
  row: DetachedRunRow,
  finalStatus: "completed" | "failed" | "stopped",
  runnerError: string | null,
): Promise<AdoptDetachedRunResult> {
  const client = await chatE2BClient(input.userId, input.conversationId);
  let history: SandboxHistoryMessage[] = [];
  let sandboxTodos: unknown[] | null = null;
  if (client) {
    try {
      const full = await client.agentStatus({ includeHistory: true });
      history = full.history ?? [];
      sandboxTodos = full.sandboxTodos;
    } catch {
      // best-effort — land what we have
    }
  }

  const newSlice = history.slice(row.seed_count);
  const converted = convertHistoryToAssistantMessage(newSlice);
  const hasAssistantText = newSlice.some(
    (m) => m.role === "assistant" && (m.content ?? "").trim(),
  );

  // Honest closing copy for runs that never produced a final message.
  let content = converted.content;
  let parts: MessagePart[] = converted.parts;
  if (finalStatus === "failed" && !hasAssistantText) {
    content = `The background run failed: ${runnerError ?? "it failed before producing a reply."}`;
    parts = [{ id: `part_${nanoid(8)}`, type: "text", content }];
  } else if (finalStatus === "stopped" && !hasAssistantText) {
    content =
      converted.toolCalls.length > 0
        ? "The sandbox run was stopped — here is the work it completed first."
        : "The sandbox run was stopped before it produced any output.";
    parts = [
      ...parts.filter((p) => p.type === "tool"),
      { id: `part_${nanoid(8)}`, type: "text", content },
    ];
  }

  const now = Date.now();
  let resultMessageId: string | null = input.messageId;
  try {
    const { conversationService } = await import("@/lib/services");
    if (input.messageId) {
      // LAND IN PLACE — rewrite the streaming placeholder bubble into the
      // finished message (tool parts + final text + generation meta).
      await conversationService.updateMessage(input.messageId, {
        content,
        parts,
        is_streaming: false,
        generation: {
          startedAt: row.started_at,
          completedAt: now,
          durationMs: now - row.started_at,
          failed: finalStatus === "failed",
        },
      } as never);
      // Tool-call rows (Dexie tool_calls table) — same shape addMessage
      // writes, so the FILES footer / tool history keep working.
      if (converted.toolCalls.length > 0) {
        const db = getDB();
        await db.tool_calls.bulkAdd(
          converted.toolCalls.map((tc) => ({
            id: nanoid(),
            message_id: input.messageId!,
            tool_call_id: tc.id,
            tool_name: tc.name,
            args: tc.args,
            result: typeof tc.result === "string" ? tc.result : JSON.stringify(tc.result ?? null),
            status: tc.status === "error" ? "failed" : "completed",
            started_at: new Date(row.started_at).toISOString(),
            completed_at: new Date(now).toISOString(),
            duration_ms: 0,
          })),
        );
      }
    } else {
      // No bubble (placeholder settled / missing) — append a NEW assistant
      // message with the full payload.
      const saved = await conversationService.addMessage(input.conversationId, input.userId, {
        role: "assistant",
        content,
        parts,
        toolCalls: converted.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          args: tc.args,
          result: tc.result,
          status: tc.status === "error" ? ("error" as const) : ("completed" as const),
        })),
        generation: {
          startedAt: row.started_at,
          completedAt: now,
          durationMs: now - row.started_at,
          failed: finalStatus === "failed",
        },
      });
      resultMessageId = saved.id;
    }

    // Surface it in the live UI when the user is viewing this conversation.
    const { useConversationStore, useChatStore } = await import("@/stores");
    if ((useConversationStore.getState().currentConversationId ?? null) === input.conversationId) {
      const { conversationMessageToChatMessage } = await import("@/lib/conversation-to-chat");
      if (input.messageId) {
        // In-place landing — reload the rows so the rewritten bubble shows.
        const refreshed = await conversationService.getMessages(input.conversationId, input.userId);
        useChatStore.setState({
          messages: refreshed.map((r) =>
            conversationMessageToChatMessage({
              id: r.id,
              conversation_id: r.conversation_id,
              role: r.role,
              content: r.content,
              created_at: r.created_at,
              tool_calls: r.tool_calls,
              user_rating: r.user_rating,
              rating_count: r.rating_count,
              files: r.files,
              thinking: (r as { thinking?: string | null }).thinking,
              reasoning: (r as { reasoning?: string | null }).reasoning,
              parts: (r as { parts?: unknown[] | null }).parts as
                | import("@/types").MessagePart[]
                | null
                | undefined,
            }),
          ),
        });
      } else {
        const latest = await conversationService.getMessages(input.conversationId, input.userId);
        const savedRow = latest.find((r) => r.id === resultMessageId);
        if (savedRow) {
          useChatStore
            .getState()
            .addMessage(
              conversationMessageToChatMessage(
                savedRow as Parameters<typeof conversationMessageToChatMessage>[0],
              ),
            );
        }
      }
    }
    notifyConversationsChanged();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: finalStatus, error: message, cancelled: false };
  }

  // Merge the sandbox todos (agent + scheduled `sched-` entries).
  try {
    await mergeSandboxTodosIntoConversation(input.conversationId, sandboxTodos);
  } catch {
    // best-effort — todos are a nice-to-have on top of the message
  }

  // Settle: row synced, store cleared, sandbox allowed to auto-pause again.
  await saveRunRow({
    ...row,
    status: "synced",
    updated_at: Date.now(),
    finished_at: now,
    result_message_id: resultMessageId,
    error: runnerError ?? null,
  });
  clearDetachedActive(row.sandbox_id);
  useDetachedRunStore.getState().clearRun(input.conversationId);

  return { status: finalStatus, error: runnerError ?? null, cancelled: false };
}

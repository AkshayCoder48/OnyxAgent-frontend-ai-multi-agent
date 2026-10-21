"use client";

/**
 * DETACHED SANDBOX RUNS — the "close and resume" architecture.
 *
 * OnyxAgent is a frontend-only app: the foreground agent loop lives in the
 * browser tab, so closing the tab kills it. This module moves the
 * orchestration loop INTO the E2B sandbox:
 *
 *   send ──▶ /api/sandbox agent_start ──▶ nohup python3 headless_runner.py &
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
 *   · converts the sandbox history into a native assistant ChatMessage
 *     (tool parts + final text) on return,
 *   · merges sandbox todos.json (agent + cron-scheduled todos) into the
 *     conversation's Dexie todo list.
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
  system_prompt: string;
  /** Seed = system + prior conversation + the NEW user message. The runner
   *  appends its own assistant/tool messages after these. */
  seed_messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature?: number | null;
  max_rounds?: number;
}

/** Hard limits for the seed (mirrors the old bg-agent budget philosophy):
 *  bounded history so the run config stays light and every gateway accepts
 *  it. The runner re-sends exactly these messages each round. */
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
    .slice(-SEED_MAX_MESSAGES);

  for (const m of recent) {
    const content =
      m.content.length > SEED_MAX_MESSAGE_CHARS
        ? `${m.content.slice(0, SEED_MAX_MESSAGE_CHARS)}\n…[truncated]`
        : m.content;
    seed.push({ role: m.role as "user" | "assistant", content });
  }

  seed.push({ role: "user", content: newPrompt });
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
 * todos are appended; known ones are refreshed in place. This is what makes
 * "a nightly cron script appends a todo" show up in the UI.
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
    return rows[rows.length - 1] ?? null;
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
// Start / poll / stop / sync
// ---------------------------------------------------------------------------

export interface StartDetachedRunInput {
  userId: string;
  conversationId: string;
  prompt: string;
  systemPrompt: string;
  chatUrl: string;
  apiKey: string;
  model: string;
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

/**
 * Start a detached run: resolve the E2B key, deploy the runner (version-
 * stamped), write the run config + launch the nohup process, persist the
 * Dexie row + store view + the pagehide-pause exemption flag.
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
        "No E2B sandbox key configured. Add one in Settings → E2B (or set E2B_API_KEY on the server) to use detached runs.",
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
    system_prompt: input.systemPrompt,
    seed_messages: seed,
    temperature: input.temperature ?? null,
    max_rounds: input.maxRounds ?? 24,
  };

  // Same shared sandbox the chat's sandbox tools resolve to.
  const client = getE2BClient(e2bKey, null, "shared");
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

/** Light status poll (no history) for the live strip. */
export async function pollDetachedRunStatus(
  userId: string,
  sandboxId: string,
): Promise<AgentStatusResponse | null> {
  try {
    const e2bKey = await getEffectiveE2BKey(userId);
    if (!e2bKey) return null;
    const client = getE2BClient(e2bKey, null, "shared");
    return await client.agentStatus({ includeHistory: false });
  } catch {
    return null;
  }
}

/** User-initiated stop (the strip's Stop button). */
export async function stopDetachedRun(
  userId: string,
  conversationId: string,
): Promise<boolean> {
  const store = useDetachedRunStore.getState();
  const view = store.runs[conversationId];
  if (!view) return false;
  try {
    const e2bKey = await getEffectiveE2BKey(userId);
    if (e2bKey) {
      const client = getE2BClient(e2bKey, null, "shared");
      await client.agentStop();
    }
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

export interface SyncDetachedRunResult {
  /** No run to sync (nothing running / already synced). */
  skipped: boolean;
  /** The run is still executing — the strip keeps polling. */
  running: boolean;
  /** An assistant message was written back into the conversation. */
  synced: boolean;
  status?: AgentStatusResponse["status"];
  error?: string;
}

/**
 * SYNC-ON-RETURN (the "come back to finished work" path). Call on
 * conversation load, window focus, or when the strip's poll observes a
 * terminal status. Idempotent: a row already `synced` (or with a
 * result_message_id) is never re-synced.
 *
 * Flow: Dexie row → agent_status (with history) → convert the new slice →
 * conversationService.addMessage → merge todos.json → mark synced.
 */
export async function syncDetachedRun(
  userId: string,
  conversationId: string,
): Promise<SyncDetachedRunResult> {
  const row = await getDetachedRunForConversation(userId, conversationId);
  if (!row) return { skipped: true, running: false, synced: false };
  if (row.status === "synced" || row.result_message_id) {
    return { skipped: true, running: false, synced: false };
  }

  const e2bKey = await getEffectiveE2BKey(userId);
  if (!e2bKey) {
    return {
      skipped: false,
      running: false,
      synced: false,
      error: "E2B key unavailable — cannot reach the sandbox to sync the run.",
    };
  }

  let status: AgentStatusResponse;
  try {
    const client = getE2BClient(e2bKey, null, "shared");
    status = await client.agentStatus({ includeHistory: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { skipped: false, running: false, synced: false, error: message };
  }

  const runnerStatus = status.status?.status ?? null;

  // Still executing (or status file missing but process alive) → keep going.
  if (
    runnerStatus === "running" ||
    runnerStatus === "starting" ||
    (!runnerStatus && status.runnerAlive)
  ) {
    useDetachedRunStore.getState().patchRun(conversationId, {
      status: "running",
      stage: status.status?.stage,
      round: status.status?.round,
      totalRounds: status.status?.total_rounds,
      currentTool: status.status?.current_tool ?? null,
    });
    return { skipped: false, running: true, synced: false, status: status.status };
  }

  // Terminal (completed / failed / stopped, or dead with history present).
  // Persist the runner state onto the row first (crash-resume friendly).
  const finalStatus =
    runnerStatus ?? (status.runnerAlive ? "running" : row.status === "running" ? "failed" : row.status);
  if (finalStatus === "running") {
    return { skipped: false, running: true, synced: false, status: status.status };
  }

  const now = Date.now();
  await saveRunRow({
    ...row,
    status: finalStatus === "completed" ? "completed" : finalStatus,
    finished_at: status.status?.finished_at ?? now,
    updated_at: now,
    error: status.status?.error ?? null,
  });

  const history = status.history ?? [];
  const newSlice = history.slice(row.seed_count);
  const converted = convertHistoryToAssistantMessage(newSlice);
  const hasAssistantText = newSlice.some(
    (m) => m.role === "assistant" && (m.content ?? "").trim(),
  );

  // Honest closing copy for runs that never produced a final message.
  let content = converted.content;
  let parts = converted.parts;
  if (finalStatus === "failed" && !hasAssistantText) {
    const errText = status.status?.error ?? "The detached run failed before producing a reply.";
    content = `The background run failed: ${errText}`;
    parts = [{ id: `part_${nanoid(8)}`, type: "text", content }];
  } else if (finalStatus === "stopped") {
    // A stopped run keeps its completed tool work; the closing text explains
    // why there is no final answer.
    content = hasAssistantText
      ? converted.content
      : converted.toolCalls.length > 0
        ? "The sandbox run was stopped — here is the work it completed first."
        : "The sandbox run was stopped before it produced any output.";
    if (!hasAssistantText) {
      parts = [
        ...parts.filter((p) => p.type === "tool"),
        { id: `part_${nanoid(8)}`, type: "text", content },
      ];
    }
  }

  let resultMessageId: string | null = null;
  try {
    const { conversationService } = await import("@/lib/services");
    const saved = await conversationService.addMessage(conversationId, userId, {
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

    // Surface it in the live UI when the user is viewing this conversation.
    const { useConversationStore, useChatStore } = await import("@/stores");
    if ((useConversationStore.getState().currentConversationId ?? null) === conversationId) {
      const { conversationMessageToChatMessage } = await import("@/lib/conversation-to-chat");
      useChatStore
        .getState()
        .addMessage(conversationMessageToChatMessage(saved as Parameters<typeof conversationMessageToChatMessage>[0]));
    }
    notifyConversationsChanged();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { skipped: false, running: false, synced: false, error: message };
  }

  // Merge the sandbox todos (agent + scheduled `sched-` entries).
  try {
    await mergeSandboxTodosIntoConversation(conversationId, status.sandboxTodos);
  } catch {
    // best-effort — todos are a nice-to-have on top of the message
  }

  // Settle: row synced, store cleared, sandbox allowed to auto-pause again.
  await saveRunRow({
    ...row,
    status: "synced",
    updated_at: Date.now(),
    result_message_id: resultMessageId,
    error: status.status?.error ?? null,
  });
  clearDetachedActive(row.sandbox_id);
  useDetachedRunStore.getState().clearRun(conversationId);

  return { skipped: false, running: false, synced: true, status: status.status };
}

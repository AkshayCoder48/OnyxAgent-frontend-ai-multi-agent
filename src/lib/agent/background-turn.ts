"use client";

import { nanoid } from "nanoid";
import type { AgentTurnOptions } from "./runtime";
import type { WSEvent } from "@/types";
import { useChatStore } from "@/stores/chat-store";
import { useResearchStore } from "@/stores";
import { conversationService } from "@/lib/services";
import {
  launchBackgroundTurn,
  streamBackgroundTurn,
  stopBackgroundTurn,
  clearJob,
  getActiveJob,
  type BgEvent,
  type BgJob,
} from "@/lib/e2b/background-agent";

/**
 * Background agent turn — runs the agent loop INSIDE the E2B sandbox as a
 * background command, so the turn keeps working after the browser closes,
 * stops, or minimizes (E2B sandboxes are server-side VMs; background
 * commands "keep running inside the sandbox even after the SDK disconnects"
 * — per the E2B docs).
 *
 * v2.1 STREAMING DELIVERY: the sandbox runner streams token-level events
 * (reasoning_delta / text_delta / tool_call_delta / tool_call / tool_result
 * / status / done — 1:1 with each upstream SSE delta) into an append-only
 * per-run log (.onyx/runs/<runId>/events.jsonl, every event carrying ts +
 * seq). This orchestrator consumes that log through `bg_wait` — a
 * SERVER-PUSH SSE stream (the server reads the log every 60ms while events
 * flow and PUSHES each batch as a data frame over ONE connection per ~11s
 * segment) driven by a seq cursor — and replays every event through the
 * SAME `emit` pipeline the in-browser runtime uses. Latency from runner→UI
 * is the server's read cadence (~60-150ms) — no per-batch HTTP round trip —
 * so thinking/text/tools update word-by-word exactly like a foreground
 * turn.
 *
 * Every event carries the RUNNER's wall-clock (`ts`), which flows into the
 * WSEvent timestamp + `data.ts` — duration badges ("Reasoned for Ns") stamp
 * with when things actually happened inside the sandbox, not when this
 * browser happened to receive them.
 *
 * On reload, `resumeBackgroundTurn` picks the persisted job back up and
 * continues consuming from its seq cursor: whatever ran while the browser
 * was closed replays into the chat exactly once.
 */

/** One bg_wait segment — the HTTP request stays open up to ~11s, then the
 *  client immediately re-issues. Well under the route's maxDuration=300. */
const WAIT_SEGMENT_MS = 11_000;
/** Network-level failures (fetch throws / unreachable) before giving up. */
const MAX_UNREACHABLE = 5;
/** Pause between unreachable retries. */
const UNREACHABLE_PAUSE_MS = 1_000;

export interface BackgroundTurnHandle {
  /** Stop the background job + the consumer. */
  stop: () => Promise<void>;
}

interface RunContext {
  turn: AgentTurnOptions;
  e2bApiKey: string;
  userId: string;
  conversationId: string | null;
  /** The emit callback from use-chat (the WSEvent pipeline). */
  emit: (event: WSEvent) => void;
  /** Called when the turn finishes (done or error). */
  onFinished: () => void;
}

/** Text-only conversation history for the sandbox runner (no tool parts). */
function buildHistory(turn: AgentTurnOptions): Array<{ role: "user" | "assistant" | "system"; content: string }> {
  void turn; // history reads the live chat store (below); the options param
  // is kept for future turn-scoped history shaping.
  const history: Array<{ role: "user" | "assistant" | "system"; content: string }> = [];
  // Prior turns from the chat store (text content only — the background
  // runner has no access to browser-side tool context).
  for (const msg of useChatStore.getState().messages) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const text =
      msg.content ||
      (msg.parts ?? [])
        .filter((p) => p.type === "text" && p.content)
        .map((p) => p.content)
        .join("\n\n");
    if (text && text.trim()) {
      history.push({ role: msg.role, content: text });
    }
  }
  return history.slice(-20); // cap the context window
}

async function persistCheckpoint(
  conversationId: string,
  userId: string,
  assistantMessageId: string,
  isStreaming: boolean,
): Promise<void> {
  const msg = useChatStore.getState().messages.find((m) => m.id === assistantMessageId);
  if (!msg) return;
  await conversationService.saveAgentCheckpoint(conversationId, userId, assistantMessageId, {
    role: "assistant",
    content: msg.content ?? "",
    thinking: (msg.parts ?? []).some((p) => p.type === "thinking")
      ? (msg.parts ?? []).filter((p) => p.type === "thinking").map((p) => p.content ?? "").join("\n")
      : undefined,
    reasoning: (msg.parts ?? []).some((p) => p.type === "reasoning")
      ? (msg.parts ?? []).filter((p) => p.type === "reasoning").map((p) => p.content ?? "").join("\n")
      : undefined,
    parts: msg.parts,
    toolCalls: msg.toolCalls,
    isStreaming,
  });
}

/**
 * Consume one background run: seq-cursor SSE segment loop. The server PUSHES
 * each batch of new events the moment its sandbox read lands (60ms cadence
 * while the stream is hot); this consumer replays every event through the
 * SAME `emit` pipeline the in-browser runtime uses and re-opens the segment
 * when it caps out (~11s, one amortized RTT). Returns when the run reaches a
 * terminal status (done/error) or the consumer is stopped. Shared by start +
 * resume so both paths replay identically.
 */
async function consumeRun(ctx: {
  e2bApiKey: string;
  job: BgJob;
  conversationId: string;
  userId: string;
  emit: (type: WSEvent["type"], data: Record<string, unknown>) => void;
  onFinished: () => void;
  isStopped: () => boolean;
}): Promise<void> {
  const { e2bApiKey, job } = ctx;
  let cursor = 0;
  let unreachable = 0;

  for (;;) {
    if (ctx.isStopped()) return;
    let sawFrame = false;
    let unreachableFrame = false;
    let unreachableMsg: string | null = null;
    try {
      for await (const resp of streamBackgroundTurn(e2bApiKey, job.sandboxId, job.runId, cursor, WAIT_SEGMENT_MS)) {
        sawFrame = true;
        if (ctx.isStopped()) return; // for-await return → generator's finally cancels the fetch
        if (resp.status === "unreachable") {
          unreachableFrame = true;
          unreachableMsg =
            resp.error ??
            "Background sandbox unreachable on E2B. If it expired, start a new message — otherwise reopening this page resumes a paused sandbox automatically.";
          break;
        }
        unreachable = 0;
        // Replay new events through the pipeline (seq order == file order).
        const events = resp.events ?? [];
        let finished = false;
        for (const ev of events) {
          if (typeof ev.seq === "number" && ev.seq > cursor) cursor = ev.seq;
          replayEvent(ctx.emit, ev);
          if (ev.t === "done" || ev.t === "error") finished = true;
        }
        if (typeof resp.afterSeq === "number" && resp.afterSeq > cursor) cursor = resp.afterSeq;
        if (resp.done) finished = true;

        // Checkpoint after every batch with content (so a reload mid-run
        // shows progress).
        if (events.length > 0) {
          try {
            await persistCheckpoint(ctx.conversationId, ctx.userId, job.assistantMessageId, !finished);
          } catch {
            // best-effort
          }
        }
        if (finished) {
          ctx.emit("complete", {});
          clearJob(job.assistantMessageId);
          ctx.onFinished();
          return;
        }
        // Immediately keep reading — the server pushes the next batch the
        // moment it lands (no fixed-tick sleep, no per-batch round trip).
      }
    } catch {
      // fetch/stream failed mid-segment — treat like an unreachable frame
      unreachableFrame = true;
    }
    if (ctx.isStopped()) return;
    if (unreachableFrame) {
      unreachable++;
      if (unreachable >= MAX_UNREACHABLE) {
        ctx.emit("error", {
          message:
            unreachableMsg ??
            "Lost the connection to the background sandbox on E2B (network error). The job itself is unaffected — reopening or reloading this page reconnects and resumes it.",
        });
        clearJob(job.assistantMessageId);
        ctx.onFinished();
        return;
      }
      await new Promise((r) => setTimeout(r, UNREACHABLE_PAUSE_MS));
      continue;
    }
    if (sawFrame) {
      // Clean segment end (timeout frame) — checkpoint and re-open at once.
      try {
        await persistCheckpoint(ctx.conversationId, ctx.userId, job.assistantMessageId, true);
      } catch {
        // best-effort
      }
    } else {
      // Generator ended without a single frame — defensive unreachable path.
      unreachable++;
      if (unreachable >= MAX_UNREACHABLE) {
        ctx.emit("error", {
          message:
            "Lost the connection to the background sandbox on E2B (no stream frames). The job itself is unaffected — reopening or reloading this page reconnects and resumes it.",
        });
        clearJob(job.assistantMessageId);
        ctx.onFinished();
        return;
      }
      await new Promise((r) => setTimeout(r, UNREACHABLE_PAUSE_MS));
    }
  }
}

/**
 * Run one turn in the background sandbox. Returns the handle, or null when
 * the launch failed (caller falls back to the in-browser runtime).
 */
export async function startBackgroundTurn(ctx: RunContext): Promise<BackgroundTurnHandle | null> {
  const generationId = `bg-${nanoid(10)}`;
  let conversationId = ctx.conversationId;

  const emit = (type: WSEvent["type"], data: Record<string, unknown>) => {
    ctx.emit({ type, data: { ...data, generation_id: generationId }, timestamp: new Date().toISOString() });
  };

  try {
    // 1. Ensure a conversation exists (new chat → create + notify).
    if (!conversationId) {
      const conv = await conversationService.create(ctx.userId);
      conversationId = conv.id;
      // The pipeline's conversation_created handler attaches the id, fixes
      // the URL, and notifies the host — no separate callback needed.
      emit("conversation_created", { conversation_id: conv.id });
    }

    // 2. Persist the user message (mirrors the runtime's user_prompt path —
    //    the store's optimistic temp id swaps for the DB row id).
    const userRow = await conversationService.addMessage(conversationId, ctx.userId, {
      role: "user",
      content: ctx.turn.userMessage,
      fileIds: ctx.turn.fileIds,
    });
    emit("user_prompt", { message_id: userRow.id });

    // 3. Create the assistant message in the store via the pipeline.
    emit("model_request_start", { round: 1 });
    // The pipeline creates the message with a temp id; use a stable id via
    // message_saved immediately so later checkpoints upsert one row.
    const assistantMessageId = `bgmsg-${nanoid(10)}`;
    emit("message_saved", { message_id: assistantMessageId });

    // 4. Launch the sandbox background job. The current todo plan (live
    //    store snapshot) rides along as seedTodos — the runner restores it
    //    into the sandbox's shared todos.json when the sandbox was recreated
    //    (PRD FR-1: todos persist across tool calls, turns, sessions).
    const seedTodos = (() => {
      try {
        const bucket = useResearchStore.getState().byTurn[conversationId ?? ""];
        const todos = bucket?.agentTodos;
        return Array.isArray(todos) && todos.length > 0
          ? todos.map((t) => ({
              id: t.id,
              title: t.title,
              status: t.status,
              createdAt: t.createdAt,
              updatedAt: t.updatedAt,
            }))
          : undefined;
      } catch {
        return undefined;
      }
    })();
    const job = await launchBackgroundTurn({
      e2bApiKey: ctx.e2bApiKey,
      provider: {
        baseUrl: ctx.turn.provider.baseUrl,
        apiKey: ctx.turn.provider.apiKey,
        model: ctx.turn.provider.model,
        temperature: ctx.turn.temperature ?? undefined,
        toolsEnabled: ctx.turn.provider.toolsEnabled,
        noPrefix: ctx.turn.provider.noPrefix,
      },
      systemPrompt: ctx.turn.systemPrompt,
      history: buildHistory(ctx.turn),
      assistantMessageId,
      conversationId,
      seedTodos,
    });

    // 5. Consume the run's event stream until it finishes. The consumer
    //    lives only as long as this browser tab is open; the JOB itself
    //    keeps running regardless.
    let stopped = false;
    void (async () => {
      await consumeRun({
        e2bApiKey: ctx.e2bApiKey,
        job,
        conversationId: conversationId!,
        userId: ctx.userId,
        emit,
        onFinished: ctx.onFinished,
        isStopped: () => stopped,
      });
    })().catch(() => {
      // The consumer died unexpectedly — surface as a normal turn error.
      emit("error", { message: "The background stream consumer stopped unexpectedly." });
      clearJob(assistantMessageId);
      ctx.onFinished();
    });

    return {
      stop: async () => {
        stopped = true;
        try {
          await stopBackgroundTurn(ctx.e2bApiKey, job.sandboxId);
        } catch {
          // best-effort
        }
        clearJob(assistantMessageId);
        emit("final_result", { output: "" });
        emit("complete", {});
        ctx.onFinished();
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[background-turn] launch failed, falling back to in-browser runtime:", message);
    return null;
  }
}

/** Translate one sandbox event into the WSEvent pipeline. */
function replayEvent(
  emit: (type: WSEvent["type"], data: Record<string, unknown>) => void,
  ev: BgEvent,
): void {
  const round = ev.round ?? 1;
  // Runner wall-clock flows into the event data (`ts`) so the chat store
  // stamps durations with when things ACTUALLY happened in the sandbox.
  const ts = typeof ev.ts === "number" ? ev.ts : Date.now();
  switch (ev.t) {
    case "round_start":
      emit("model_request_start", { round, ts });
      break;
    case "reasoning":
      // v1 legacy monolithic reasoning — one big delta.
      emit("reasoning_delta", { content: ev.content ?? "", round, ts });
      break;
    case "reasoning_delta":
      emit("reasoning_delta", { content: ev.content ?? "", round, ts });
      break;
    case "text":
      // v1 legacy monolithic text — one big delta.
      emit("text_delta", { content: ev.content ?? "", round, ts });
      break;
    case "text_delta":
      emit("text_delta", { content: ev.content ?? "", round, ts });
      break;
    case "tool_call_delta":
      if (ev.tool_calls?.length) {
        emit("tool_call_delta", { tool_calls: ev.tool_calls, ts });
      }
      break;
    case "tool_call": {
      const preemit = (ev as { _preemit?: boolean })._preemit === true;
      emit("tool_call", {
        tool_call_id: ev.id ?? `bg-${round}-${ev.name}`,
        tool_name: ev.name ?? "unknown",
        args: ev.args ?? {},
        ts,
        ...(preemit ? { _preemit: true } : {}),
      });
      break;
    }
    case "tool_result": {
      // The runner stringifies the result; parse it back so the cards get
      // real objects (matching the in-browser tool_result shape).
      let result: unknown = ev.result ?? "";
      if (typeof result === "string" && result.trim().startsWith("{")) {
        try {
          result = JSON.parse(result);
        } catch {
          // keep the string
        }
      }
      emit("tool_result", {
        tool_call_id: ev.id ?? "unknown",
        content: result,
        ts,
      });
      break;
    }
    case "status": {
      const kind = ev.kind ?? "";
      if (kind === "first_token") {
        emit("llm_started", { ts });
      } else if (kind === "llm_end") {
        emit("llm_completed", { round, ts });
      } else if (kind === "retry") {
        emit("rate_limited", {
          retryAfterMs: ev.delayMs ?? 2_000,
          attempt: ev.attempt ?? 1,
          maxAttempts: 4,
          status: 429,
          ts,
        });
      }
      // "boot" and unknown kinds carry no UI state — ignored.
      break;
    }
    case "todo_event": {
      // Live todo snapshot from the sandbox's shared todos.json — feeds the
      // same todo_event pipeline the in-browser tools use, so the
      // TodoPreview statuses update IN REAL TIME in background mode too.
      if (Array.isArray(ev.todos)) {
        emit("todo_event", {
          event_type: "snapshot",
          todo: null,
          all_todos: ev.todos,
          ts,
        });
      }
      break;
    }
    case "done":
      emit("llm_completed", { round, ts });
      emit("final_result", { output: ev.content ?? "" });
      break;
    case "error":
      emit("error", { message: ev.message ?? "Background run failed." });
      break;
  }
}

/**
 * Resume the persisted background job for a conversation after a reload:
 * replays any events that ran while the browser was closed, then keeps
 * consuming until the turn finishes. Returns the handle, or null when there
 * is nothing to resume.
 */
export async function resumeBackgroundTurn(ctx: {
  e2bApiKey: string;
  userId: string;
  conversationId: string;
  emit: (event: WSEvent) => void;
  onFinished: () => void;
}): Promise<BackgroundTurnHandle | null> {
  const job = getActiveJob(ctx.conversationId);
  if (!job) return null;

  const generationId = `bg-${nanoid(10)}`;
  const emit = (type: WSEvent["type"], data: Record<string, unknown>) => {
    ctx.emit({ type, data: { ...data, generation_id: generationId }, timestamp: new Date().toISOString() });
  };

  // Reload restored the assistant message from the checkpoint; re-adopt it
  // as the current streaming message.
  emit("model_request_start", { round: 1 });
  emit("message_saved", { message_id: job.assistantMessageId });

  let stopped = false;
  void (async () => {
    await consumeRun({
      e2bApiKey: ctx.e2bApiKey,
      job,
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      emit,
      onFinished: ctx.onFinished,
      isStopped: () => stopped,
    });
  })().catch(() => {
    // best-effort — the next reload resumes again.
  });

  return {
    stop: async () => {
      stopped = true;
      try {
        await stopBackgroundTurn(ctx.e2bApiKey, job.sandboxId);
      } catch {
        // best-effort
      }
      clearJob(job.assistantMessageId);
      emit("final_result", { output: "" });
      emit("complete", {});
      ctx.onFinished();
    },
  };
}

/** The persisted job for a conversation, if any (used by the resume path). */
export function backgroundJobFor(conversationId: string | null): BgJob | null {
  const job = getActiveJob(conversationId);
  return job;
}

"use client";

import { nanoid } from "nanoid";
import type { AgentTurnOptions } from "./runtime";
import type { WSEvent } from "@/types";
import { useChatStore } from "@/stores/chat-store";
import { conversationService } from "@/lib/services";
import {
  launchBackgroundTurn,
  pollBackgroundTurn,
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
 * commands "keep running inside the sandbox even after the SDK
 * disconnects" — per the E2B docs).
 *
 * The runner script inside the sandbox writes an event log to a state file.
 * This orchestrator polls it (every 2.5s while the browser is open) and
 * replays every event through the SAME `emit` pipeline the in-browser
 * runtime uses — so the chat UI, store updates, tool cards, and persistence
 * behave exactly like a normal turn. On reload, `resumeBackgroundTurn`
 * picks the persisted job back up and continues replaying from where it
 * left off: whatever ran while the browser was closed appears in the chat.
 */

const POLL_INTERVAL_MS = 2500;
const MAX_UNREACHABLE_POLLS = 5;

export interface BackgroundTurnHandle {
  /** Stop the background job + the poller. */
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

    // 4. Launch the sandbox background job.
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
    });

    // 5. Poll + replay until done. The poller lives only as long as this
    //    browser tab is open; the JOB itself keeps running regardless.
    let stopped = false;
    void (async () => {
      let processed = 0;
      let unreachableCount = 0;
      for (;;) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        if (stopped) return;
        let status;
        try {
          status = await pollBackgroundTurn(ctx.e2bApiKey, job.sandboxId);
          unreachableCount = 0;
        } catch {
          unreachableCount++;
          if (unreachableCount >= MAX_UNREACHABLE_POLLS) {
            emit("error", { message: "Lost the connection to the background sandbox on E2B (network error). The job itself is unaffected — reopening or reloading this page reconnects and resumes it." });
            clearJob(assistantMessageId);
            ctx.onFinished();
            return;
          }
          continue;
        }
        if (status.status === "unreachable") {
          unreachableCount++;
          if (unreachableCount >= MAX_UNREACHABLE_POLLS) {
            emit("error", { message: status.error ?? "Background sandbox unreachable on E2B. If it expired, start a new message — otherwise reopening this page resumes a paused sandbox automatically." });
            clearJob(assistantMessageId);
            ctx.onFinished();
            return;
          }
          continue;
        }
        // Replay new events through the pipeline.
        const events = status.events ?? [];
        let finished = false;
        while (processed < events.length) {
          const ev = events[processed]!;
          processed++;
          replayEvent(emit, ev);
          if (ev.t === "done" || ev.t === "error") finished = true;
        }
        // Checkpoint after every batch (so a reload mid-run shows progress).
        try {
          await persistCheckpoint(conversationId!, ctx.userId, assistantMessageId, !finished);
        } catch {
          // best-effort
        }
        if (finished) {
          emit("complete", {});
          clearJob(assistantMessageId);
          ctx.onFinished();
          return;
        }
      }
    })().catch(() => {
      // The poller died unexpectedly — surface as a normal turn error.
      emit("error", { message: "The background poller stopped unexpectedly." });
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
  switch (ev.t) {
    case "round_start":
      emit("model_request_start", { round });
      break;
    case "reasoning":
      emit("reasoning_delta", { content: ev.content ?? "", round });
      break;
    case "text":
      emit("text_delta", { content: ev.content ?? "", round });
      break;
    case "tool_call":
      emit("tool_call", {
        tool_call_id: ev.id ?? `bg-${round}-${ev.name}`,
        tool_name: ev.name ?? "unknown",
        args: ev.args ?? {},
      });
      break;
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
      });
      break;
    }
    case "done":
      emit("llm_completed", { round });
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
 * polling until the turn finishes. Returns the handle, or null when there
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
    let processed = 0;
    let unreachableCount = 0;
    while (!stopped) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      if (stopped) return;
      let status;
      try {
        status = await pollBackgroundTurn(ctx.e2bApiKey, job.sandboxId);
        unreachableCount = 0;
      } catch {
        unreachableCount++;
        if (unreachableCount >= MAX_UNREACHABLE_POLLS) return;
        continue;
      }
      if (status.status === "unreachable") {
        unreachableCount++;
        if (unreachableCount >= MAX_UNREACHABLE_POLLS) return;
        continue;
      }
      const events = status.events ?? [];
      let finished = false;
      while (processed < events.length) {
        const ev = events[processed]!;
        processed++;
        replayEvent(emit, ev);
        if (ev.t === "done" || ev.t === "error") finished = true;
      }
      try {
        await persistCheckpoint(ctx.conversationId, ctx.userId, job.assistantMessageId, !finished);
      } catch {
        // best-effort
      }
      if (finished) {
        emit("complete", {});
        clearJob(job.assistantMessageId);
        ctx.onFinished();
        return;
      }
    }
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

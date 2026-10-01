"use client";

import { nanoid } from "nanoid";
import type {
  ChatMessage,
  ResearchTodo,
  Todo,
  ToolCall,
  WSEvent,
} from "@/types";
import { getGenerationId } from "@/types";
import { setUrlParam } from "@/lib/utils";
import { persistTodos } from "@/lib/tools/todos";
import {
  markerHoldbackIndex,
  resolveToolCall,
  stripInternalMarkers,
  timelineDebug,
} from "@/lib/agent/timeline";
import { useConversationStore, useResearchStore } from "@/stores";
import { useSubagentStore } from "@/stores/subagent-store";
import { logError } from "@/lib/client-logger";
import type { ExecutionChatStore } from "@/stores/chat-store";

/**
 * AgentEventProcessor — the WSEvent → message-state pipeline, extracted from
 * the old `handleAgentEvent` useCallback inside useChat.
 *
 * WHY IT EXISTS AS A CLASS (not a hook): agent executions must outlive the
 * React component that started them. The ExecutionHub (module singleton)
 * owns one processor per execution; events keep flowing into it (and into
 * Dexie checkpoints) while the user is on ANY page of the app. A useChat
 * instance merely SUBSCRIBES to the execution's store when the user views
 * that conversation — navigating away unsubscribes the UI but never stops
 * the execution.
 *
 * The processor writes to:
 *   - its per-execution zustand store (message parts, tool calls, rounds,
 *     isProcessing / pendingQuestions / rateLimitStatus — the same shapes
 *     the UI rendered before),
 *   - the module-level research/subagent stores (todo events, sidebar),
 *   - Dexie via the runtime/consumer's checkpoint paths (unchanged).
 *
 * Everything else (generation-id guards, round tracking, render batching
 * buffers, the stream-start gate) carries over VERBATIM from the original
 * handler — see the preserved comments.
 */

/** STREAM-START GATE: one-time visual pause before a response begins
 *  visibly streaming — the request itself is never delayed. (Timeline PRD
 *  speed pass: 300ms → 120ms — “a bit faster, lower delay”.) */
const STREAM_START_DELAY_MS = 120;

export interface AgentEventProcessorOptions {
  /** The execution's headless chat store — the message-state target. */
  store: ExecutionChatStore;
  /** The execution's conversation id — read AT EVENT TIME (the hub re-keys
   *  it when the runtime creates the conversation for a new chat). */
  getConversationId: () => string | null;
  /** The runtime attached this execution to a NEW conversation (new chat). */
  onConversationCreated?: (conversationId: string) => void;
  /** Terminal notification — "completed" (clean done) / "failed" (error). */
  onTurnEnd?: (status: "completed" | "failed") => void;
}

export class AgentEventProcessor {
  private readonly opts: AgentEventProcessorOptions;
  private readonly store: ExecutionChatStore;

  // ── MESSAGE IDENTITY (was currentMessageIdRef & friends) ──────────────
  /** The streaming assistant message id — read synchronously by events
   *  arriving in the same tick as the message's creation. */
  private currentMessageId: string | null = null;
  /** Temp id of the user message the CURRENT turn is processing (user_prompt
   *  swaps it for the real Dexie row id). */
  private currentUserMessageId: string | null = null;
  private currentGroupId: string | null = null;

  // ── GENERATION IDENTITY (PRD §19) ─────────────────────────────────────
  private activeGenerationId: string | null = null;
  private currentMessageGeneration: string | null = null;

  // ── ROUND TRACKING (PRD §9–16) ────────────────────────────────────────
  private activeRound = 1;

  // ── GENERATION TIMING ("Worked {time}" panel) ──────────────────────
  /** Wall-clock when the CURRENT generation's first event arrived — the
   *  "Worked 18s" start point. Stamped per generation (a new generation
   * resets it). */
  private turnStartedAt: number | null = null;

  // ── STREAMING BUFFERS (render batching — see original comments) ───────
  private textDeltaBuffer = "";
  private textDeltaTimer: ReturnType<typeof setTimeout> | null = null;
  private textAt: number | null = null;
  private thinkingBuffer = "";
  private thinkingTimer: ReturnType<typeof setTimeout> | null = null;
  private thinkingAt: number | null = null;
  private reasoningBuffer = "";
  private reasoningTimer: ReturnType<typeof setTimeout> | null = null;
  private reasoningAt: number | null = null;
  private toolArgBuffer = new Map<number, { id: string; name: string; args: string }>();
  private toolArgTimer: ReturnType<typeof setTimeout> | null = null;
  private toolOutputBuffer = new Map<string, { stdout: string; stderr: string }>();
  private toolOutputTimer: ReturnType<typeof setTimeout> | null = null;

  // ── TIMELINE NORMALIZATION STATE (timeline PRD §2–§7/§17) ────────────
  /** Part ids of pre-emit placeholder tool parts still awaiting adoption
   *  by their finalized `tool_call` event, in emission order. Each
   *  placeholder is consumed at most once — one underlying execution →
   *  exactly one UI component. */
  private preemitPartIds: string[] = [];
  /** Arrival-order sequence for normalized events (providers rarely send
   *  one — stamped at ingestion, §4; the parts array position IS the
   *  timeline). */
  private eventSeq = 0;

  // ── STREAM-START GATE ──────────────────────────────────────────────────
  private streamGate: { messageId: string | null; opened: boolean } = {
    messageId: null,
    opened: false,
  };

  constructor(opts: AgentEventProcessorOptions) {
    this.opts = opts;
    this.store = opts.store;
  }

  /** The streaming assistant message id (stop/regenerate paths). */
  get streamingMessageId(): string | null {
    return this.currentMessageId;
  }

  /** Set from doSend — the optimistic user message id for this turn. */
  setUserMessageId(id: string | null): void {
    this.currentUserMessageId = id;
  }

  /** Clear all pending timers (hub calls this when unregistering). */
  dispose(): void {
    for (const t of [this.textDeltaTimer, this.thinkingTimer, this.reasoningTimer, this.toolArgTimer, this.toolOutputTimer]) {
      if (t) clearTimeout(t);
    }
    this.textDeltaTimer = this.thinkingTimer = this.reasoningTimer = this.toolArgTimer = this.toolOutputTimer = null;
  }

  // ── GATE HELPERS ────────────────────────────────────────────────────────
  /** Delay for the NEXT scheduled flush: the start-gate hold for the
   *  message's very first flush, the caller's steady cadence afterwards. */
  private gateDelayFor(steadyMs: number): number {
    const mid = this.currentMessageId;
    if (!mid) return steadyMs;
    const gate = this.streamGate;
    if (gate.messageId !== mid) {
      gate.messageId = mid;
      gate.opened = false;
    }
    return gate.opened ? steadyMs : STREAM_START_DELAY_MS;
  }

  /** Mark the stream as visibly started — later flushes use steady cadence. */
  private openStreamGate(): void {
    const gate = this.streamGate;
    if (gate.messageId && gate.messageId === this.currentMessageId) gate.opened = true;
  }

  // ── FLUSH (force — final_result / error / complete) ─────────────────────
  /** Flush ONLY the text/thinking/reasoning delta buffers (§20 boundary
   *  flush): called synchronously before a tool part is added so text
   *  that ARRIVED before the tool call lands in an earlier timeline
   *  position — the parts array keeps true arrival order. Tool-arg and
   *  tool-output buffers are untouched. */
  private flushTextBuffers(): void {
    if (this.textDeltaTimer) { clearTimeout(this.textDeltaTimer); this.textDeltaTimer = null; }
    if (this.textDeltaBuffer && this.currentMessageId) {
      // §8 second pass: a marker split across SSE chunks is only whole in
      // the accumulated buffer.
      const clean = stripInternalMarkers(this.textDeltaBuffer);
      if (clean) {
        this.store.getState().appendTextDelta(this.currentMessageId, clean, this.activeRound, this.textAt ?? undefined);
      }
      this.textDeltaBuffer = "";
      this.textAt = null;
    }
    if (this.thinkingTimer) { clearTimeout(this.thinkingTimer); this.thinkingTimer = null; }
    if (this.thinkingBuffer && this.currentMessageId) {
      this.store.getState().appendThinkingDelta(this.currentMessageId, this.thinkingBuffer, this.activeRound, this.thinkingAt ?? undefined);
      this.thinkingBuffer = "";
      this.thinkingAt = null;
    }
    if (this.reasoningTimer) { clearTimeout(this.reasoningTimer); this.reasoningTimer = null; }
    if (this.reasoningBuffer && this.currentMessageId) {
      this.store.getState().appendReasoningDelta(this.currentMessageId, this.reasoningBuffer, this.activeRound, this.reasoningAt ?? undefined);
      this.reasoningBuffer = "";
      this.reasoningAt = null;
    }
    // Content became visible — later flushes use steady cadence.
    this.openStreamGate();
  }

  flush(): void {
    this.flushTextBuffers();
    if (this.toolArgTimer) { clearTimeout(this.toolArgTimer); this.toolArgTimer = null; }
    this.toolArgBuffer.clear();
    if (this.toolOutputTimer) { clearTimeout(this.toolOutputTimer); this.toolOutputTimer = null; }
    if (this.currentMessageId && this.toolOutputBuffer.size > 0) {
      for (const [tcId, chunks] of this.toolOutputBuffer) {
        if (chunks.stdout) this.store.getState().appendToolStreamingOutput(this.currentMessageId, tcId, chunks.stdout, "stdout");
        if (chunks.stderr) this.store.getState().appendToolStreamingOutput(this.currentMessageId, tcId, chunks.stderr, "stderr");
      }
      this.toolOutputBuffer.clear();
    }
    // A force flush means the turn/round ended — never gate later content.
    this.openStreamGate();
  }

  /** Freeze the given round's timing on the streaming message. */
  private endActiveRound(round: number, at?: number): void {
    if (this.currentMessageId) this.store.getState().endRound(this.currentMessageId, round, at);
  }

  /** Settle the round's reasoning the moment its stream stops. */
  private endActiveReasoning(round: number, at?: number): void {
    if (this.currentMessageId) this.store.getState().endReasoning(this.currentMessageId, round, at);
  }

  // ── MESSAGE CREATION ────────────────────────────────────────────────────
  private createNewMessage(content: string): string {
    // Flush any pending delta buffers into the PREVIOUS message before
    // switching (cross-generation contamination guard).
    this.flush();
    // New message → new adoption queue (placeholders belong to their own
    // message's timeline).
    this.preemitPartIds = [];
    if (this.currentMessageId) {
      this.store.getState().updateMessage(this.currentMessageId, (msg) => ({
        ...msg,
        isStreaming: false,
      }));
    }
    const newMsgId = nanoid();
    // The EXECUTION's conversation id — read at event time; the hub re-keys
    // it synchronously on conversation_created, so a lazily-created
    // assistant message always carries the real id (never a stale one from
    // wherever the user happens to be browsing).
    const effectiveConversationId = this.opts.getConversationId() ?? undefined;
    this.store.getState().addMessage({
      id: newMsgId,
      role: "assistant",
      content,
      timestamp: new Date(),
      isStreaming: true,
      toolCalls: [],
      parts: content === "" ? [] : undefined,
      groupId: this.currentGroupId || undefined,
      conversationId: effectiveConversationId,
      isTemporaryId: true,
    });
    this.currentMessageId = newMsgId;
    return newMsgId;
  }

  /** Ensure an assistant message exists and belongs to the ACTIVE
   *  generation (rounds 2+ reuse the message). */
  private ensureMessageForActiveGeneration(): void {
    if (
      this.currentMessageId !== null &&
      this.currentMessageGeneration === this.activeGenerationId
    ) {
      return; // same generation still streaming — reuse the message
    }
    // New generation → new "Worked {time}" window.
    this.turnStartedAt = Date.now();
    this.createNewMessage("");
    this.currentMessageGeneration = this.activeGenerationId;
  }

  // ── GENERATION SUMMARY ("Worked {time}" panel) ─────────────────────
  /** Stamp `generation` metadata on the current message so the settled
   *  turn collapses into a "Worked {duration}" panel (PRD §§12–22).
   *  Prefers the processor's wall-clock window; falls back to the part
   *  stamps (roundStartedAt/tool startedAt) when the turn predates the
   *  timer (resumed background runs). */
  private stampGeneration(outcome: { failed?: boolean; stopped?: boolean }): void {
    const id = this.currentMessageId;
    if (!id) return;
    const store = this.store.getState();
    const msg = store.messages.find((m) => m.id === id);
    if (!msg || msg.generation) return; // never overwrite a settled summary
    const completedAt = Date.now();
    let startedAt = this.turnStartedAt ?? undefined;
    if (startedAt === undefined) {
      // Fallback: earliest part stamp on the message.
      for (const p of msg.parts ?? []) {
        if (p.roundStartedAt !== undefined && (startedAt === undefined || p.roundStartedAt < startedAt)) {
          startedAt = p.roundStartedAt;
        }
        const tcStarted = (p as { toolCall?: { startedAt?: number } }).toolCall?.startedAt;
        if (tcStarted !== undefined && (startedAt === undefined || tcStarted < startedAt)) {
          startedAt = tcStarted;
        }
      }
    }
    if (startedAt === undefined) startedAt = msg.timestamp instanceof Date ? msg.timestamp.getTime() : completedAt;
    const durationMs = Math.max(0, completedAt - startedAt);
    store.updateMessage(id, (m) => ({
      ...m,
      generation: {
        startedAt,
        completedAt,
        durationMs,
        ...(outcome.failed ? { failed: true } : {}),
        ...(outcome.stopped ? { stopped: true } : {}),
      },
    }));
  }

  // ── STOP PATH (explicit user stop only) ────────────────────────────────
  /** Mark the streaming message's tool calls as stopped + finalize. Called
   *  by the hub's stop() — mirrors the old stopGeneration store mutations. */
  markStoppedByUser(): void {
    if (this.currentMessageId) {
      const msgId = this.currentMessageId;
      const msg = this.store.getState().messages.find((m) => m.id === msgId);
      const seen = new Set<string>();
      const stopped = { status: "completed" as const, result: { stopped: true, message: "Stopped by user" } };
      const markStopped = (tc: ToolCall) => {
        if (seen.has(tc.id)) return;
        seen.add(tc.id);
        if (tc.status === "running" || tc.status === "pending") {
          this.store.getState().updateToolCallPart(msgId, tc.id, stopped);
        }
      };
      msg?.toolCalls?.forEach(markStopped);
      msg?.parts?.forEach((p) => {
        if (p.type === "tool" && p.toolCall) markStopped(p.toolCall);
      });
      this.store.getState().updateMessage(msgId, (m) => ({ ...m, isStreaming: false }));
      // User-stopped turns keep their work summary too ("Worked {time}").
      this.stampGeneration({ stopped: true });
    }
    this.flush();
    this.currentMessageId = null;
    this.currentGroupId = null;
    this.activeGenerationId = null;
    this.currentMessageGeneration = null;
    this.turnStartedAt = null;
    this.store.getState().setPendingQuestions(null);
    this.store.getState().setProcessing(false);
  }

  // ── THE EVENT HANDLER ───────────────────────────────────────────────────
  handle = (wsEvent: WSEvent): void => {
    const eventGenId = getGenerationId(wsEvent);
    const activeGenId = this.activeGenerationId;

    const isFromActiveGeneration = (): boolean => {
      if (!eventGenId) return true; // legacy / external event
      if (!activeGenId) return true; // no active generation — accept
      return eventGenId === activeGenId;
    };

    switch (wsEvent.type) {
      case "conversation_created": {
        const { conversation_id } = wsEvent.data as { conversation_id: string };
        // Attach the UI ONLY when the user is still on the new-chat (null)
        // state — if they already switched to another conversation, a late
        // attach would hijack the view. The hub re-keys the execution
        // regardless (below).
        if (useConversationStore.getState().currentConversationId === null) {
          // `attachConversation` switches the id WITHOUT clearing anything
          // and marks the conversation hydrated — the live streaming
          // messages are authoritative, no DB reload may fire for this id.
          useConversationStore.getState().attachConversation(conversation_id);
          // Reflect the new ID in the URL so the page is refreshable.
          setUrlParam("id", conversation_id);
        }
        // CRITICAL: associate the persisted (sessionStorage) messages with
        // the new conversation ID (refresh would otherwise wipe them).
        if (typeof window !== "undefined") {
          window.sessionStorage.setItem("chat-store:conversationId", conversation_id);
        }
        // Update all messages that don't have a conversationId yet — in the
        // EXECUTION's store (where the live stream actually lives).
        this.store.getState().updateMessagesWhere(
          (msg) => !msg.conversationId,
          (msg) => ({ ...msg, conversationId: conversation_id }),
        );
        this.opts.onConversationCreated?.(conversation_id);
        break;
      }

      case "user_prompt": {
        if (!isFromActiveGeneration()) break;
        const { message_id } = wsEvent.data as { message_id: string };
        const tempUserId = this.currentUserMessageId;
        if (tempUserId && tempUserId !== message_id) {
          this.store.getState().replaceMessageId(tempUserId, message_id);
          this.currentUserMessageId = message_id;
        }
        break;
      }

      case "message_saved": {
        if (!isFromActiveGeneration()) break;
        const { message_id } = wsEvent.data as { message_id: string };
        const oldId = this.currentMessageId;
        if (oldId && oldId !== message_id) {
          // RELOAD-RESUME DEDUP (PRD §38): on background-turn resume the
          // store was seeded from the Dexie checkpoint, which ALREADY holds
          // a row with `message_id`. Renaming the fresh temp shell on top
          // of it would leave TWO rows sharing the id (an empty duplicate
          // bubble + deltas landing on the first match). Adopt the
          // checkpointed row instead and drop the shell.
          const exists = this.store.getState().messages.some((m) => m.id === message_id);
          if (exists) {
            this.store.getState().removeMessage(oldId);
          } else {
            this.store.getState().replaceMessageId(oldId, message_id);
          }
          this.currentMessageId = message_id;
        } else if (!oldId) {
          const messages = this.store.getState().messages;
          const lastTemp = [...messages]
            .reverse()
            .find((msg) => msg.role === "assistant" && !!msg.isTemporaryId);
          if (lastTemp && lastTemp.id !== message_id) {
            this.store.getState().replaceMessageId(lastTemp.id, message_id);
            this.currentMessageId = message_id;
          }
        }
        break;
      }

      case "model_request_start": {
        if (eventGenId && activeGenId && eventGenId !== activeGenId) {
          break; // stale event from a previous generation
        }
        const isFirstRequestOfGeneration = !activeGenId || activeGenId !== eventGenId;
        if (eventGenId && !activeGenId) {
          this.activeGenerationId = eventGenId;
        }
        const eventRoundRaw = (wsEvent.data as { round?: unknown }).round;
        const eventRound =
          typeof eventRoundRaw === "number" && eventRoundRaw >= 1 ? Math.floor(eventRoundRaw) : null;
        if (isFirstRequestOfGeneration && this.currentMessageGeneration !== this.activeGenerationId) {
          this.activeRound = eventRound ?? 1;
        } else if (!isFirstRequestOfGeneration) {
          const roundChanged = eventRound !== null ? eventRound !== this.activeRound : true;
          if (roundChanged) {
            this.flush();
            const at = (wsEvent.data as { ts?: number }).ts;
            this.endActiveRound(this.activeRound, typeof at === "number" ? at : undefined);
            this.activeRound = eventRound ?? this.activeRound + 1;
          }
        }
        this.ensureMessageForActiveGeneration();
        // SERVED-MODEL BADGE (Auto Router): the runtime stamps the model that
        // serves THIS round onto the event (absent on legacy/background
        // emitters). Record it on the active assistant message so any badge
        // reading message.model_name shows the model that ACTUALLY served —
        // with the Auto Router this can differ round to round.
        const servedModel = (wsEvent.data as { model?: unknown }).model;
        if (typeof servedModel === "string" && servedModel && this.currentMessageId) {
          const messageId = this.currentMessageId;
          this.store.getState().updateMessage(messageId, (m) =>
            m.model_name === servedModel ? m : { ...m, model_name: servedModel },
          );
        }
        break;
      }

      case "text_delta": {
        if (!isFromActiveGeneration()) break;
        if (this.currentMessageId) {
          const d = wsEvent.data as { index: number; content: string; ts?: number };
          // §8 PARSER-LAYER GUARD: whole-chunk internal lifecycle markers
          // (PROCESS & friends) never enter the text timeline. The
          // flush-time pass in flushTextBuffers catches markers split
          // across SSE chunks.
          const content = stripInternalMarkers(d.content ?? "");
          if (content) {
            this.eventSeq += 1;
            if (!this.textDeltaBuffer) this.textAt = typeof d.ts === "number" ? d.ts : Date.now();
            this.textDeltaBuffer += content;
            if (!this.textDeltaTimer) {
              this.textDeltaTimer = setTimeout(() => {
                if (this.textDeltaBuffer && this.currentMessageId) {
                  // §8 cadence pass: drop whole markers + hold back a
                  // trailing marker PREFIX (a marker split across chunks
                  // stays recognizable by the next pass).
                  const safeEnd = markerHoldbackIndex(this.textDeltaBuffer);
                  const safe = stripInternalMarkers(this.textDeltaBuffer.slice(0, safeEnd));
                  if (safe) {
                    this.store.getState().appendTextDelta(this.currentMessageId, safe, this.activeRound, this.textAt ?? undefined);
                  }
                  this.textDeltaBuffer = this.textDeltaBuffer.slice(safeEnd);
                  if (!this.textDeltaBuffer) this.textAt = null;
                  this.openStreamGate();
                }
                this.textDeltaTimer = null;
              }, this.gateDelayFor(32)); // ~120ms start-gate, then 32ms (~30fps) — Runtime PRD §25: 20–60ms UI batch; 1ms caused ~1000 store writes/sec (the lag root cause)
            }
          }
        }
        break;
      }

      case "thinking_delta": {
        if (!isFromActiveGeneration()) break;
        if (this.currentMessageId) {
          const d = wsEvent.data as { index: number; content: string; ts?: number };
          if (d.content) {
            if (!this.thinkingBuffer) this.thinkingAt = typeof d.ts === "number" ? d.ts : Date.now();
            this.thinkingBuffer += d.content;
            if (!this.thinkingTimer) {
              this.thinkingTimer = setTimeout(() => {
                if (this.thinkingBuffer && this.currentMessageId) {
                  this.store.getState().appendThinkingDelta(this.currentMessageId, this.thinkingBuffer, this.activeRound, this.thinkingAt ?? undefined);
                  this.thinkingBuffer = "";
                  this.thinkingAt = null;
                  this.openStreamGate();
                }
                this.thinkingTimer = null;
              }, this.gateDelayFor(16)); // ~300ms start-gate, then 16ms (~60fps)
            }
          }
        }
        break;
      }

      case "reasoning_delta": {
        if (!isFromActiveGeneration()) break;
        if (this.currentMessageId) {
          const d = wsEvent.data as { index: number; content: string; ts?: number };
          if (d.content) {
            if (!this.reasoningBuffer) this.reasoningAt = typeof d.ts === "number" ? d.ts : Date.now();
            this.reasoningBuffer += d.content;
            if (!this.reasoningTimer) {
              this.reasoningTimer = setTimeout(() => {
                if (this.reasoningBuffer && this.currentMessageId) {
                  this.store.getState().appendReasoningDelta(this.currentMessageId, this.reasoningBuffer, this.activeRound, this.reasoningAt ?? undefined);
                  this.reasoningBuffer = "";
                  this.reasoningAt = null;
                  this.openStreamGate();
                }
                this.reasoningTimer = null;
              }, this.gateDelayFor(16));
            }
          }
        }
        break;
      }

      case "llm_started":
      case "llm_completed": {
        if (wsEvent.type === "llm_completed" && this.currentMessageId) {
          this.flush();
          const at = (wsEvent.data as { ts?: number }).ts;
          this.endActiveReasoning(this.activeRound, typeof at === "number" ? at : undefined);
        }
        this.store.getState().setRateLimitStatus(null);
        break;
      }

      case "rate_limited": {
        // Rate-limit auto-retry was REMOVED (user request) — the foreground
        // runtime no longer emits this event. The background runner still
        // emits it for its SELF-HEAL / transient-5xx / network retries (and
        // for the sandbox reconnect banner). Show the honest reason.
        const d = wsEvent.data as {
          retryAfterMs?: number;
          attempt?: number;
          maxAttempts?: number;
          reason?: string;
        };
        const attempt = d.attempt ?? 1;
        const max = d.maxAttempts ?? 3;
        const secs = Math.max(1, Math.round((d.retryAfterMs ?? 1000) / 1000));
        const text = d.reason
          ? `Provider hiccup — retrying in ${secs}s (attempt ${attempt}/${max}): ${d.reason}`
          : `Provider hiccup — retrying automatically in ${secs}s… (attempt ${attempt}/${max})`;
        this.store.getState().setRateLimitStatus(text);
        break;
      }

      case "tool_call_delta": {
        if (!isFromActiveGeneration()) break;
        if (this.currentMessageId) {
          const data = wsEvent.data as {
            tool_calls?: Array<{
              index: number;
              id?: string;
              name?: string;
              arguments?: string;
            }>;
          };
          const toolCalls = data.tool_calls ?? [];
          for (const tc of toolCalls) {
            const existing = this.toolArgBuffer.get(tc.index);
            if (tc.name) {
              this.toolArgBuffer.set(tc.index, {
                id: tc.id || existing?.id || `pending-${tc.index}`,
                name: tc.name,
                args: tc.arguments || "",
              });
            } else if (tc.id && tc.id !== existing?.id && !existing) {
              this.toolArgBuffer.set(tc.index, {
                id: tc.id,
                name: "",
                args: tc.arguments || "",
              });
            } else if (tc.id && tc.id !== existing?.id && existing) {
              existing.id = tc.id;
              if (tc.arguments) existing.args += tc.arguments;
            } else if (tc.arguments && existing) {
              existing.args += tc.arguments;
            }
          }
          if (!this.toolArgTimer) {
            this.toolArgTimer = setTimeout(() => {
              this.toolArgTimer = null;
              if (!this.currentMessageId) return;
              const msgs = this.store.getState().messages;
              const msg = msgs.find((m) => m.id === this.currentMessageId);
              if (!msg?.parts) return;

              for (const [index, buffered] of this.toolArgBuffer) {
                // Live arg fragments update the EXISTING placeholder part
                // (by part id — safe id swaps) — they never create cards
                // (only the tool_call event does, §18).
                const parts = msg.parts.filter(
                  (p) => p.type === "tool" && p.toolCall,
                ) as Array<import("@/types/chat").MessagePart & {
                  toolCall: import("@/types").ToolCall;
                }>;
                let target = parts.find((p) => p.toolCall.id === buffered.id);
                if (!target) {
                  target = parts.find((p) => p.toolCall.id === `pending-${index}`);
                }
                const realName = buffered.name && !buffered.name.startsWith("pending-")
                  ? buffered.name
                  : "";
                if (!target && realName) {
                  target = parts.find(
                    (p) =>
                      p.toolCall.name === realName &&
                      (p.toolCall.status === "pending" ||
                        (p.toolCall.args as { _streaming?: string })?._streaming !== undefined),
                  );
                }
                if (target && this.currentMessageId) {
                  const idSwap =
                    buffered.id &&
                    !buffered.id.startsWith("pending-") &&
                    target.toolCall.id.startsWith("pending-")
                      ? { id: buffered.id }
                      : {};
                  this.store.getState().updateToolCallPartByPart(
                    this.currentMessageId,
                    target.id,
                    {
                      args: { _streaming: buffered.args },
                      name: realName || target.toolCall.name,
                      ...idSwap,
                    },
                  );
                }
                // DO NOT create a new card here — only the tool_call event
                // (pre-emit or final) creates cards.
              }
            }, 16);
          }
        }
        break;
      }

      case "tool_call": {
        if (!isFromActiveGeneration()) break;

        // SUB-AGENT SIDEBAR AUTO-OPEN (PRD §15).
        {
          const tn = (wsEvent.data as { tool_name?: string }).tool_name;
          if (
            tn === "spawn_subagent" ||
            tn === "query_subagent" ||
            tn === "create_subagent_chat" ||
            tn === "manage_subagent_chat" ||
            tn === "steer_subagent" ||
            tn === "complete_subagent" ||
            tn === "cancel_subagent"
          ) {
            useSubagentStore.getState().setSidebarOpen(true);
          }
        }

        if (!this.currentMessageId) break;
        const data = wsEvent.data as {
          tool_name: string;
          args: Record<string, unknown>;
          tool_call_id: string;
          _preemit?: boolean;
          ts?: number;
        };
        const { tool_name, args, tool_call_id } = data;
        const isPreemit = !!data._preemit;
        const ts = typeof data.ts === "number" ? data.ts : undefined;
        this.eventSeq += 1;

        // ── TIMELINE NORMALIZER + DEDUPLICATOR (§2/§6/§17) ─────────────
        // Raw provider events never reach the renderer directly. The
        // resolution decides EXACTLY ONE disposition for this call:
        // update the existing part (replay / pre-emit→final with same
        // id), adopt the pre-emit placeholder (provider id arrived after
        // pre-emit), or create the one new part. A second card can never
        // appear for the same underlying execution.

        // §20 BOUNDARY FLUSH: text/thinking that arrived BEFORE this tool
        // call occupies its timeline position first — the parts array
        // keeps true arrival order (text above this tool part).
        this.flushTextBuffers();

        const store = this.store.getState();
        const msg = store.messages.find((m) => m.id === this.currentMessageId);
        const toolParts = (msg?.parts ?? []).flatMap((p) =>
          p.type === "tool" && p.toolCall
            ? [{ partId: p.id, toolCall: p.toolCall }]
            : [],
        );

        const resolution = resolveToolCall({
          toolCallId: tool_call_id,
          toolName: tool_name,
          preemit: isPreemit,
          toolParts,
          preemitQueue: this.preemitPartIds,
        });

        // The pre-emit arg stream's buffered entry is spent once the final
        // call lands — a stale entry must not clobber the parsed args.
        if (!isPreemit) {
          for (const [idx, buffered] of this.toolArgBuffer) {
            if (
              buffered.name === tool_name ||
              buffered.id === tool_call_id ||
              buffered.id === `pending-${idx}`
            ) {
              this.toolArgBuffer.delete(idx);
              break;
            }
          }
        }

        if (resolution.action === "update") {
          const existing = toolParts.find((p) => p.toolCall.id === tool_call_id)!;
          const hasStreamingArgs =
            (existing.toolCall.args as { _streaming?: string } | undefined)?._streaming !== undefined;
          store.updateToolCallPart(this.currentMessageId, tool_call_id, {
            name: tool_name || existing.toolCall.name,
            args: !isPreemit ? args : (hasStreamingArgs ? existing.toolCall.args : args),
            status: isPreemit ? "pending" : "running",
          });
          timelineDebug(
            `tool_call ${tool_call_id} (${tool_name || "?"}) → updated existing part${isPreemit ? " (pre-emit)" : ""}`,
          );
          break;
        }

        if (resolution.action === "adopt") {
          this.preemitPartIds = this.preemitPartIds.filter((id) => id !== resolution.partId);
          store.updateToolCallPartByPart(this.currentMessageId, resolution.partId, {
            id: tool_call_id,
            name: tool_name,
            args,
            status: "running",
          });
          timelineDebug(
            `tool_call ${tool_call_id} (${tool_name || "?"}) → adopted placeholder part ${resolution.partId}`,
          );
          break;
        }

        const partId = store.addToolCallPart(
          this.currentMessageId,
          {
            id: tool_call_id,
            name: tool_name,
            args,
            status: isPreemit ? "pending" : "running",
          },
          this.activeRound,
          ts,
        );
        if (isPreemit && partId) this.preemitPartIds.push(partId);
        timelineDebug(
          `tool_call ${tool_call_id} (${tool_name || "?"}) → created part ${partId}${isPreemit ? " (pre-emit placeholder)" : ""}`,
        );
        break;
      }

      case "tool_result": {
        if (!isFromActiveGeneration()) break;
        if (this.currentMessageId) {
          const { tool_call_id, content } = wsEvent.data as {
            tool_call_id: string;
            content: string;
          };
          this.eventSeq += 1;
          if (this.toolOutputBuffer.has(tool_call_id)) {
            const chunks = this.toolOutputBuffer.get(tool_call_id)!;
            if (chunks.stdout) this.store.getState().appendToolStreamingOutput(this.currentMessageId, tool_call_id, chunks.stdout, "stdout");
            if (chunks.stderr) this.store.getState().appendToolStreamingOutput(this.currentMessageId, tool_call_id, chunks.stderr, "stderr");
            this.toolOutputBuffer.delete(tool_call_id);
            if (this.toolOutputBuffer.size === 0 && this.toolOutputTimer) {
              clearTimeout(this.toolOutputTimer);
              this.toolOutputTimer = null;
            }
          }
          // §7: the result attaches to ITS tool call's existing part —
          // it never renders as an independent assistant message, and a
          // replayed result only re-writes the same part (idempotent).
          this.store.getState().updateToolCallPart(this.currentMessageId, tool_call_id, {
            result: content,
            status: "completed",
          });
          timelineDebug(`tool_result ${tool_call_id} attached (${String(content).length} chars)`);
        }
        // Broadcast a window event so other components (e.g. FileSidebar)
        // can auto-refresh when the agent mutates the workspace.
        try {
          const data = wsEvent.data as { tool_call_id?: string };
          const msgs = this.store.getState().messages;
          outer: for (let i = msgs.length - 1; i >= 0; i--) {
            const msg = msgs[i];
            if (!msg?.parts) continue;
            for (const p of msg.parts) {
              if (
                p.type === "tool" &&
                p.toolCall?.id === data.tool_call_id &&
                p.toolCall
              ) {
                window.dispatchEvent(
                  new CustomEvent("tool_result", {
                    detail: { tool_name: p.toolCall.name },
                  }),
                );
                break outer;
              }
            }
          }
        } catch {
          // ignore — best-effort event
        }
        break;
      }

      case "tool_output": {
        if (!isFromActiveGeneration()) break;
        if (this.currentMessageId) {
          const { tool_call_id, content, type } = wsEvent.data as {
            tool_call_id: string;
            content: string;
            type: "stdout" | "stderr";
          };
          const existing = this.toolOutputBuffer.get(tool_call_id) ?? { stdout: "", stderr: "" };
          if (type === "stdout") existing.stdout += content;
          else existing.stderr += content;
          this.toolOutputBuffer.set(tool_call_id, existing);
          if (!this.toolOutputTimer) {
            this.toolOutputTimer = setTimeout(() => {
              this.toolOutputTimer = null;
              if (!this.currentMessageId) return;
              for (const [tcId, chunks] of this.toolOutputBuffer) {
                if (chunks.stdout) this.store.getState().appendToolStreamingOutput(this.currentMessageId, tcId, chunks.stdout, "stdout");
                if (chunks.stderr) this.store.getState().appendToolStreamingOutput(this.currentMessageId, tcId, chunks.stderr, "stderr");
              }
              this.toolOutputBuffer.clear();
            }, 50);
          }
        }
        break;
      }

      case "round_retry": {
        if (!isFromActiveGeneration()) break;
        // IDEMPOTENT INGESTION (§17): the provider is about to RE-STREAM
        // this round. Drop the unflushed delta buffers (their content is
        // re-sent) and rewind everything the failed attempt already
        // flushed — partial text, thinking/reasoning, pre-emit tool
        // placeholders — so the retry can never duplicate content.
        for (const t of [this.textDeltaTimer, this.thinkingTimer, this.reasoningTimer]) {
          if (t) clearTimeout(t);
        }
        this.textDeltaTimer = this.thinkingTimer = this.reasoningTimer = null;
        this.textDeltaBuffer = "";
        this.textAt = null;
        this.thinkingBuffer = "";
        this.thinkingAt = null;
        this.reasoningBuffer = "";
        this.reasoningAt = null;
        const retryRoundRaw = (wsEvent.data as { round?: unknown }).round;
        const retryRound =
          typeof retryRoundRaw === "number" && retryRoundRaw >= 1
            ? Math.floor(retryRoundRaw)
            : this.activeRound;
        if (this.currentMessageId) {
          this.store.getState().rewindRoundParts(this.currentMessageId, retryRound);
          // Pre-emit placeholders of the rewound round are gone — drop
          // their part ids from the adoption queue.
          const msg = this.store
            .getState()
            .messages.find((m) => m.id === this.currentMessageId);
          const liveIds = new Set((msg?.parts ?? []).map((p) => p.id));
          this.preemitPartIds = this.preemitPartIds.filter((id) => liveIds.has(id));
        }
        timelineDebug(`round_retry round=${retryRound} → rewound streamed parts`);
        break;
      }

      case "final_result": {
        if (!isFromActiveGeneration()) break;
        this.flush();
        this.endActiveRound(this.activeRound);
        if (this.currentMessageId) {
          const { output } = wsEvent.data as { output: string };
          const fr = this.store.getState().messages.find((m) => m.id === this.currentMessageId);
          if (output && fr && !fr.content && this.currentMessageId) {
            this.store.getState().appendTextDelta(this.currentMessageId, output, this.activeRound);
          }
          this.store.getState().updateMessage(this.currentMessageId, (msg) => ({
            ...msg,
            isStreaming: false,
          }));
        }
        this.store.getState().setProcessing(false);
        this.currentGroupId = null;
        break;
      }

      case "error": {
        if (!isFromActiveGeneration()) break;
        this.store.getState().setRateLimitStatus(null);
        this.flush();
        this.endActiveRound(this.activeRound);
        // "Worked {time} · Failed" — the work done before the failure stays
        // inspectable in the collapsed panel (PRD §22).
        this.stampGeneration({ failed: true });
        // IN-APP ERROR LOG: mirror the surfaced chat error into the Logs
        // store so the full trail (LLM body, self-heal steps, retries) is
        // one click away.
        logError("chat", (wsEvent.data as { message?: string })?.message || "Unknown chat error");
        if (this.currentMessageId) {
          const id = this.currentMessageId;
          const { message } = wsEvent.data as { message: string };
          const errText = `\n\n❌ Error: ${message || "Unknown error"}\n\n_Full details in the Logs panel — click the 🐛 button (bottom-left) or the Logs icon in the top bar._`;
          const cur = this.store.getState().messages.find((m) => m.id === id);
          if (cur?.parts) {
            this.store.getState().appendTextDelta(id, errText, this.activeRound);
          } else {
            this.store.getState().updateMessage(id, (msg) => ({ ...msg, content: msg.content + errText }));
          }
          this.store.getState().updateMessage(id, (msg) => ({ ...msg, isStreaming: false }));
        } else {
          const { message } = wsEvent.data as { message: string };
          const errText = `❌ Error: ${message || "Unknown error"}`;
          const id = this.createNewMessage(errText);
          this.store.getState().updateMessage(id, (msg) => ({ ...msg, isStreaming: false }));
        }
        this.store.getState().setProcessing(false);
        this.activeGenerationId = null;
        this.currentMessageId = null;
        this.opts.onTurnEnd?.("failed");
        break;
      }

      case "ask_user": {
        const { questions } = wsEvent.data as {
          questions: { question: string; options: string[]; allow_custom: boolean }[];
        };
        this.store.getState().setPendingQuestions(
          (questions ?? []).map((q) => ({
            question: q.question,
            options: q.options ?? [],
            allowCustom: q.allow_custom,
          })),
        );
        break;
      }

      case "todo_event": {
        const { event_type, todo, all_todos } = wsEvent.data as {
          event_type: string;
          todo: ResearchTodo | null;
          all_todos?: ResearchTodo[] | null;
        };
        if (Array.isArray(all_todos)) {
          const isNewShape = (all_todos as unknown[]).some(
            (t) => t && typeof t === "object" && "title" in (t as Record<string, unknown>),
          );
          if (isNewShape) {
            // The EXECUTION's conversation is the todo bucket — read at
            // event time (the hub re-keys on conversation_created).
            const turnId = this.opts.getConversationId() || "default";
            useResearchStore.getState().setAgentTodos(turnId, all_todos as unknown as Todo[]);
            if (turnId !== "default") {
              void persistTodos(turnId, all_todos as unknown as Todo[]).catch(() => {});
            }
            break;
          }
        }
        useResearchStore.getState().applyTodoEvent(event_type, todo, all_todos);
        break;
      }

      case "complete": {
        this.store.getState().setRateLimitStatus(null);
        if (!isFromActiveGeneration()) break;
        this.flush();
        this.endActiveRound(this.activeRound);
        // Settled — the whole generation collapses into "Worked {time}".
        this.stampGeneration({});
        this.store.getState().setProcessing(false);
        this.currentMessageId = null;
        this.activeGenerationId = null;
        this.currentMessageGeneration = null;
        this.turnStartedAt = null;
        this.opts.onTurnEnd?.("completed");
        break;
      }
    }
  };
}

export type { ChatMessage };

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
import { useConversationStore, useResearchStore } from "@/stores";
import { useSubagentStore } from "@/stores/subagent-store";
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

/** STREAM-START GATE: one-time visual pause (~0.30s) before a response
 *  begins visibly streaming — the request itself is never delayed. */
const STREAM_START_DELAY_MS = 300;

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
  flush(): void {
    if (this.textDeltaTimer) { clearTimeout(this.textDeltaTimer); this.textDeltaTimer = null; }
    if (this.textDeltaBuffer && this.currentMessageId) {
      this.store.getState().appendTextDelta(this.currentMessageId, this.textDeltaBuffer, this.activeRound, this.textAt ?? undefined);
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
    this.createNewMessage("");
    this.currentMessageGeneration = this.activeGenerationId;
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
    }
    this.flush();
    this.currentMessageId = null;
    this.currentGroupId = null;
    this.activeGenerationId = null;
    this.currentMessageGeneration = null;
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
          this.store.getState().replaceMessageId(oldId, message_id);
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
        break;
      }

      case "text_delta": {
        if (!isFromActiveGeneration()) break;
        if (this.currentMessageId) {
          const d = wsEvent.data as { index: number; content: string; ts?: number };
          if (d.content) {
            if (!this.textDeltaBuffer) this.textAt = typeof d.ts === "number" ? d.ts : Date.now();
            this.textDeltaBuffer += d.content;
            if (!this.textDeltaTimer) {
              this.textDeltaTimer = setTimeout(() => {
                if (this.textDeltaBuffer && this.currentMessageId) {
                  this.store.getState().appendTextDelta(this.currentMessageId, this.textDeltaBuffer, this.activeRound, this.textAt ?? undefined);
                  this.textDeltaBuffer = "";
                  this.textAt = null;
                  this.openStreamGate();
                }
                this.textDeltaTimer = null;
              }, this.gateDelayFor(1)); // ~300ms start-gate, then 1ms
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
        const d = wsEvent.data as { retryAfterMs?: number; attempt?: number; maxAttempts?: number };
        const secs = Math.max(1, Math.round((d.retryAfterMs ?? 1000) / 1000));
        const attempt = d.attempt ?? 1;
        const max = d.maxAttempts ?? 3;
        this.store.getState().setRateLimitStatus(
          `Rate limit reached — retrying automatically in ${secs}s… (attempt ${attempt}/${max})`,
        );
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
              if (!msg?.toolCalls) return;

              for (const [index, buffered] of this.toolArgBuffer) {
                let existing = msg.toolCalls.find((t) => t.id === buffered.id);
                if (!existing) {
                  existing = msg.toolCalls.find((t) => t.id === `pending-${index}`);
                }
                const realName = buffered.name && !buffered.name.startsWith("pending-")
                  ? buffered.name
                  : "";
                if (!existing && realName) {
                  existing = msg.toolCalls.find(
                    (t) => t.name === realName && (t.status === "pending" || (t.args as { _streaming?: string })?._streaming !== undefined),
                  );
                }
                if (!existing) {
                  existing = msg.toolCalls.find(
                    (t) => (t.status === "pending" || (t.args as { _streaming?: string })?._streaming !== undefined) && (!t.name || t.name.startsWith("pending-") || t.name === ""),
                  );
                }
                if (existing && this.currentMessageId) {
                  this.store.getState().updateToolCallPart(this.currentMessageId, existing.id, {
                    args: { _streaming: buffered.args },
                    name: realName || existing.name,
                    ...(buffered.id && !buffered.id.startsWith("pending-") && existing.id.startsWith("pending-")
                      ? { id: buffered.id }
                      : {}),
                  });
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

        if (this.currentMessageId) {
          const data = wsEvent.data as {
            tool_name: string;
            args: Record<string, unknown>;
            tool_call_id: string;
            _preemit?: boolean;
            ts?: number;
          };
          const { tool_name, args, tool_call_id } = data;
          const toolCall: ToolCall = {
            id: tool_call_id,
            name: tool_name,
            args,
            status: data._preemit ? "pending" : "running",
          };

          if (!data._preemit) {
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

          // Card matching rules — see the original comments in use-chat.ts
          // (exact id → placeholder-pending → composing → placeholder adopt).
          const msgs = this.store.getState().messages;
          const msg = msgs.find((m) => m.id === this.currentMessageId);
          let existingTc = msg?.toolCalls?.find((t) => t.id === tool_call_id);
          if (!existingTc) {
            existingTc = msg?.toolCalls?.find(
              (t) =>
                t.status === "pending" &&
                t.name === tool_name &&
                (t.id.startsWith("dsml_") || t.id.startsWith("pending-")),
            );
          }
          if (!existingTc) {
            existingTc = msg?.toolCalls?.find(
              (t) =>
                t.status === "pending" &&
                (t.id.startsWith("fence_composing_") || t.id.startsWith("dsml_composing_")),
            );
          }
          if (!existingTc && (!tool_name || tool_name === "tool" || tool_name.startsWith("pending-"))) {
            existingTc = msg?.toolCalls?.find(
              (t) =>
                t.status === "pending" &&
                (!t.name || t.name === "tool" || t.name.startsWith("pending-")),
            );
          }

          if (existingTc && this.currentMessageId) {
            const existingArgs = existingTc.args as { _streaming?: string };
            const hasStreamingArgs = existingArgs?._streaming !== undefined;
            const isPreemit = !!data._preemit;
            this.store.getState().updateToolCallPart(this.currentMessageId, existingTc.id, {
              id: tool_call_id,
              args: !isPreemit
                ? args
                : (hasStreamingArgs ? existingTc.args : args),
              status: isPreemit ? "pending" : "running",
            });
          } else if (data._preemit) {
            if (this.currentMessageId) {
              this.store.getState().addToolCallPart(this.currentMessageId, toolCall, this.activeRound, typeof data.ts === "number" ? data.ts : undefined);
            }
          } else {
            if (this.currentMessageId) {
              this.store.getState().addToolCallPart(this.currentMessageId, toolCall, this.activeRound, typeof data.ts === "number" ? data.ts : undefined);
            }
          }
        }
        break;
      }

      case "tool_result": {
        if (!isFromActiveGeneration()) break;
        if (this.currentMessageId) {
          const { tool_call_id, content } = wsEvent.data as {
            tool_call_id: string;
            content: string;
          };
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
          this.store.getState().updateToolCallPart(this.currentMessageId, tool_call_id, {
            result: content,
            status: "completed",
          });
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
        if (this.currentMessageId) {
          const id = this.currentMessageId;
          const { message } = wsEvent.data as { message: string };
          const errText = `\n\n❌ Error: ${message || "Unknown error"}`;
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
        this.store.getState().setProcessing(false);
        this.currentMessageId = null;
        this.activeGenerationId = null;
        this.currentMessageGeneration = null;
        this.opts.onTurnEnd?.("completed");
        break;
      }
    }
  };
}

export type { ChatMessage };

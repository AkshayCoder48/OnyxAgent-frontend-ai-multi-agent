"use client";

import { create } from "zustand";
import type { ChatMessage, MessagePart, ToolCall } from "@/types";

function newPartId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `part-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const PERSIST_KEY = "chat-store:messages";
const PERSIST_CONV_KEY = "chat-store:conversationId";

function loadPersisted(): ChatMessage[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(PERSIST_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw) as ChatMessage[];
    return data.map((m) => ({ ...m, timestamp: new Date(m.timestamp) }));
  } catch {
    return [];
  }
}

// Debounced persistence — only save to sessionStorage at most once per 2 seconds
// during streaming. This prevents JSON.stringify + sessionStorage.setItem on
// every single text delta (which causes massive lag).
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingMessages: ChatMessage[] | null = null;

function savePersisted(messages: ChatMessage[]): void {
  if (typeof window === "undefined") return;
  pendingMessages = messages;
  if (saveTimer) return; // Already scheduled
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (pendingMessages && typeof window !== "undefined") {
      try {
        const safe = pendingMessages.slice(-50);
        window.sessionStorage.setItem(PERSIST_KEY, JSON.stringify(safe));
      } catch {
        // Quota exceeded — ignore
      }
    }
  }, 2000);
}

/** Flush pending save immediately (called on complete/unmount). */
function flushPersisted(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (pendingMessages && typeof window !== "undefined") {
    try {
      const safe = pendingMessages.slice(-50);
      window.sessionStorage.setItem(PERSIST_KEY, JSON.stringify(safe));
    } catch {}
  }
}

interface ChatState {
  messages: ChatMessage[];
  isStreaming: boolean;
  /** Currently selected provider ID (set by ChatControls, read by subagents). */
  selectedProviderId: string | null;
  /** Currently selected model (set by ChatControls, read by subagents). */
  selectedModel: string | null;

  setSelectedProviderId: (id: string | null) => void;
  setSelectedModel: (model: string | null) => void;
  /** One-shot post-hydration restore of the sessionStorage-persisted
   *  messages (see the restorePersisted body for why it is NOT done in
   *  create()). Called from ChatContainer's mount effect. */
  restorePersisted: () => void;

  addMessage: (message: ChatMessage) => void;
  updateMessage: (id: string, updater: (msg: ChatMessage) => ChatMessage) => void;
  updateMessagesWhere: (
    predicate: (msg: ChatMessage) => boolean,
    updater: (msg: ChatMessage) => ChatMessage,
  ) => void;
  replaceMessageId: (oldId: string, newId: string) => void;
  addToolCall: (messageId: string, toolCall: ToolCall) => void;
  updateToolCall: (messageId: string, toolCallId: string, update: Partial<ToolCall>) => void;
  appendTextDelta: (messageId: string, text: string, round?: number) => void;
  appendThinkingDelta: (messageId: string, text: string, round?: number) => void;
  appendReasoningDelta: (messageId: string, text: string, round?: number) => void;
  addToolCallPart: (messageId: string, toolCall: ToolCall, round?: number) => void;
  /** Stamp `roundEndedAt` on every part of `round` that lacks it — called
   *  when the next round starts or the turn completes. Completed round
   *  timing stays frozen forever (PRD §12). */
  endRound: (messageId: string, round: number, endedAt?: number) => void;
  /** Stamp `reasoningEndedAt` on the round's thinking/reasoning parts that
   *  lack it — called the moment the first text delta / tool call / LLM
   *  completion arrives after reasoning. The reasoning panel settles
   *  ("Thought for Ns" + auto-collapse) INSTANTLY instead of waiting for
   *  the round to end. Idempotent — already-stamped parts are untouched. */
  endReasoning: (messageId: string, round: number, endedAt?: number) => void;
  updateToolCallPart: (messageId: string, toolCallId: string, update: Partial<ToolCall>) => void;
  appendToolStreamingOutput: (
    messageId: string,
    toolCallId: string,
    text: string,
    type: "stdout" | "stderr",
  ) => void;
  setStreaming: (streaming: boolean) => void;
  clearMessages: () => void;
}

// BACKGROUND RESILIENCE (PRD §6/§24): flush the debounced sessionStorage
// snapshot the moment the page is hidden or unloaded, so a mid-stream
// refresh restores the freshest possible partial state (the runtime's
// per-round Dexie checkpoints carry the durable copy).
if (typeof window !== "undefined") {
  const flushNow = () => {
    try {
      flushPersisted();
    } catch {
      // ignore — best-effort
    }
  };
  window.addEventListener("pagehide", flushNow);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushNow();
  });
}

// One-shot guard for restorePersisted — survives Fast Refresh double-mounts
// and StrictMode's double effect invocation.
let persistedRestored = false;

export const useChatStore = create<ChatState>((set) => ({
  // Empty on the FIRST render — server AND client. sessionStorage is
  // client-only, so the server always renders the empty chat; restoring
  // persisted messages synchronously here made the client's hydration
  // render diverge from the server HTML (hydration mismatch + full tree
  // re-render on every revisit-with-persisted-messages). The restore now
  // happens post-hydration via restorePersisted() from ChatContainer's
  // mount effect — same visual result, no mismatch.
  messages: [],
  isStreaming: false,
  selectedProviderId: null,
  selectedModel: null,

  setSelectedProviderId: (id) => set({ selectedProviderId: id }),
  setSelectedModel: (model) => set({ selectedModel: model }),

  restorePersisted: () =>
    set((state) => {
      if (persistedRestored || state.messages.length > 0) return state;
      persistedRestored = true;
      const persisted = loadPersisted();
      return persisted.length > 0 ? { messages: persisted } : state;
    }),

  addMessage: (message) =>
    set((state) => {
      const messages = [...state.messages, message];
      savePersisted(messages);
      return { messages };
    }),

  updateMessage: (id, updater) =>
    set((state) => {
      const messages = state.messages.map((msg) => (msg.id === id ? updater(msg) : msg));
      savePersisted(messages);
      return { messages };
    }),

  updateMessagesWhere: (predicate, updater) =>
    set((state) => {
      const messages = state.messages.map((msg) => (predicate(msg) ? updater(msg) : msg));
      savePersisted(messages);
      return { messages };
    }),

  replaceMessageId: (oldId, newId) =>
    set((state) => {
      const messages = state.messages.map((msg) =>
        msg.id === oldId
          ? {
              ...msg,
              id: newId,
              isTemporaryId: false,
              // Preserve the ORIGINAL temp id as the render key so the id
              // swap doesn't remount the message subtree (GenUI iframes and
              // streamed cards keep their DOM identity across the swap).
              renderKey: msg.renderKey ?? oldId,
            }
          : msg,
      );
      savePersisted(messages);
      return { messages };
    }),

  addToolCall: (messageId, toolCall) =>
    set((state) => {
      const messages = state.messages.map((msg) =>
        msg.id === messageId ? { ...msg, toolCalls: [...(msg.toolCalls || []), toolCall] } : msg,
      );
      savePersisted(messages);
      return { messages };
    }),

  updateToolCall: (messageId, toolCallId, update) =>
    set((state) => {
      const messages = state.messages.map((msg) =>
        msg.id === messageId
          ? {
              ...msg,
              toolCalls: msg.toolCalls?.map((tc) =>
                tc.id === toolCallId ? { ...tc, ...update } : tc,
              ),
            }
          : msg,
      );
      savePersisted(messages);
      return { messages };
    }),

  // OPTIMIZED: Only update the LAST message's text — avoid mapping the entire
  // messages array. This is the hot path during streaming (called for every
  // text delta). Using a direct mutation pattern with a shallow copy of just
  // the changed message + its parent array.
  appendTextDelta: (messageId, text, round) =>
    set((state) => {
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return state;

      const msg = state.messages[idx]!;
      const parts: MessagePart[] = msg.parts ? [...msg.parts] : [];
      // REASONING SETTLEMENT: text arriving after reasoning means the
      // model finished thinking — stamp reasoningEndedAt so the panel
      // flips to "Thought for Ns" + auto-collapses right now (not when
      // the round ends). Only parts of the SAME round + not yet stamped.
      if (parts.length > 0) {
        const roundKey = round ?? 0;
        let reasoningSettled = false;
        const stamped = parts.map((p) => {
          if (
            !reasoningSettled &&
            (p.type === "thinking" || p.type === "reasoning") &&
            p.reasoningEndedAt === undefined
          ) {
            // Only settle reasoning of the SAME round (or legacy parts with
            // no round stamp — treat as this round).
            if ((p.round ?? 0) === roundKey) {
              reasoningSettled = true;
              return { ...p, reasoningEndedAt: Date.now() };
            }
          }
          return p;
        });
        if (reasoningSettled) parts.splice(0, parts.length, ...stamped);
      }
      const last = parts[parts.length - 1];
      // CHRONOLOGICAL TEXT PLACEMENT (timeline PRD §3–§9: EVENT SEQUENCE =
      // VISUAL SEQUENCE). Text merges into an earlier text part ONLY when
      // that part belongs to the SAME agent round — a continuation within
      // one round. Text arriving in a NEW round (e.g. the final answer after
      // the last round's thinking) must create a NEW part at the END of the
      // parts array, i.e. at its chronological position.
      //
      // The old rule ("text after thinking appends to the last text part
      // ANYWHERE") moved later-round text INTO an earlier round's text part
      // — so the final answer rendered ABOVE thinking that streamed before
      // it, while that thinking (and its round's tools) stayed at the bottom
      // looking "stuck". With round-aware placement, each round's text stays
      // inside that round's segment.
      const roundKey = round ?? 0;
      const isThinkingPart = (p: MessagePart) => p.type === "thinking" || p.type === "reasoning";
      if (last && last.type === "text" && (last.round ?? 0) === roundKey) {
        // Same round, text after text → continue the same text part.
        parts[parts.length - 1] = { ...last, content: (last.content ?? "") + text };
      } else if (last && isThinkingPart(last)) {
        // Text after thinking/reasoning. If a text part of the SAME round
        // exists (within-round text → thinking → text interleave), append to
        // it — it renders in the same round segment, under the round's
        // thinking header. Otherwise create a NEW part AFTER the thinking
        // (chronological position; never merge across rounds).
        let lastTextIdx = -1;
        for (let i = parts.length - 1; i >= 0; i--) {
          if (parts[i]!.type === "text") {
            lastTextIdx = i;
            break;
          }
        }
        if (lastTextIdx >= 0 && (parts[lastTextIdx]!.round ?? 0) === roundKey) {
          parts[lastTextIdx] = {
            ...parts[lastTextIdx]!,
            content: (parts[lastTextIdx]!.content ?? "") + text,
          };
        } else {
          parts.push({ id: newPartId(), type: "text" as const, content: text, round });
        }
      } else {
        // Last part is a DIFFERENT-round text, a tool call, or no parts —
        // create a NEW text part at the end (post-tool / new-round text).
        parts.push({ id: newPartId(), type: "text" as const, content: text, round });
      }

      const messages = [...state.messages];
      messages[idx] = { ...msg, parts, content: msg.content + text };
      savePersisted(messages);
      return { messages };
    }),

  appendThinkingDelta: (messageId, text, round) =>
    set((state) => {
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return state;

      const msg = state.messages[idx]!;
      const parts: MessagePart[] = msg.parts ? [...msg.parts] : [];
      // ROUND-AWARE MERGE: append to the last thinking part ONLY when it
      // belongs to the SAME agent round. A new round (model_request_start
      // after tool calls) creates a NEW thinking part — reasoning from
      // different rounds is never merged into one panel (PRD §9–10).
      // Within one round, interleaved text/tool deltas still merge into the
      // same part (no split bars mid-round).
      const lastThinkIdx = parts.reduce(
        (acc, p, i) => (p.type === "thinking" ? i : acc),
        -1,
      );
      const lastThink = lastThinkIdx >= 0 ? parts[lastThinkIdx] : undefined;
      const sameRound = lastThink !== undefined && lastThink.round === round;
      if (lastThinkIdx >= 0 && sameRound) {
        parts[lastThinkIdx] = {
          ...lastThink!,
          content: (lastThink!.content ?? "") + text,
        };
      } else {
        parts.push({
          id: newPartId(),
          type: "thinking" as const,
          content: text,
          round,
          roundStartedAt: Date.now(),
        });
      }

      const messages = [...state.messages];
      messages[idx] = { ...msg, parts, thinking: (msg.thinking ?? "") + text };
      savePersisted(messages);
      return { messages };
    }),

  appendReasoningDelta: (messageId, text, round) =>
    set((state) => {
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return state;

      const msg = state.messages[idx]!;
      const parts: MessagePart[] = msg.parts ? [...msg.parts] : [];
      // ROUND-AWARE MERGE — same rule as thinking: only merge within the
      // SAME round; a new round creates a new reasoning part (PRD §9–10).
      const lastReasonIdx = parts.reduce(
        (acc, p, i) => (p.type === "reasoning" ? i : acc),
        -1,
      );
      const lastReason = lastReasonIdx >= 0 ? parts[lastReasonIdx] : undefined;
      const sameRound = lastReason !== undefined && lastReason.round === round;
      if (lastReasonIdx >= 0 && sameRound) {
        parts[lastReasonIdx] = {
          ...lastReason!,
          content: (lastReason!.content ?? "") + text,
        };
      } else {
        parts.push({
          id: newPartId(),
          type: "reasoning" as const,
          content: text,
          round,
          roundStartedAt: Date.now(),
        });
      }

      const messages = [...state.messages];
      messages[idx] = { ...msg, parts, reasoning: (msg.reasoning ?? "") + text };
      savePersisted(messages);
      return { messages };
    }),

  addToolCallPart: (messageId, toolCall, round) =>
    set((state) => {
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return state;

      const msg = state.messages[idx]!;
      const messages = [...state.messages];
      // REASONING SETTLEMENT: a tool call arriving after reasoning means the
      // model finished thinking — stamp reasoningEndedAt on the same round's
      // unstamped thinking/reasoning parts so the panel settles instantly.
      const roundKey = round ?? 0;
      const baseParts = (msg.parts ?? []).map((p) =>
        (p.type === "thinking" || p.type === "reasoning") &&
        p.reasoningEndedAt === undefined &&
        (p.round ?? 0) === roundKey
          ? { ...p, reasoningEndedAt: Date.now() }
          : p,
      );
      messages[idx] = {
        ...msg,
        parts: [
          ...baseParts,
          {
            id: newPartId(),
            type: "tool" as const,
            toolCall,
            // Stamp the round so tool calls stack under their round's panel.
            round,
            roundStartedAt: Date.now(),
          },
        ],
        toolCalls: [...(msg.toolCalls || []), toolCall],
      };
      savePersisted(messages);
      return { messages };
    }),

  endRound: (messageId, round, endedAt) =>
    set((state) => {
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return state;

      const msg = state.messages[idx]!;
      if (!msg.parts) return state;
      const at = endedAt ?? Date.now();
      let changed = false;
      const parts = msg.parts.map((p) => {
        if (p.round === round && p.roundEndedAt === undefined) {
          changed = true;
          return { ...p, roundEndedAt: at };
        }
        return p;
      });
      if (!changed) return state;

      const messages = [...state.messages];
      messages[idx] = { ...msg, parts };
      savePersisted(messages);
      return { messages };
    }),

  endReasoning: (messageId, round, endedAt) =>
    set((state) => {
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return state;

      const msg = state.messages[idx]!;
      if (!msg.parts) return state;
      const at = endedAt ?? Date.now();
      let changed = false;
      const parts = msg.parts.map((p) => {
        if (
          (p.type === "thinking" || p.type === "reasoning") &&
          p.reasoningEndedAt === undefined &&
          p.round === round
        ) {
          changed = true;
          return { ...p, reasoningEndedAt: at };
        }
        return p;
      });
      if (!changed) return state;

      const messages = [...state.messages];
      messages[idx] = { ...msg, parts };
      savePersisted(messages);
      return { messages };
    }),

  updateToolCallPart: (messageId, toolCallId, update) =>
    set((state) => {
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return state;

      const msg = state.messages[idx]!;
      const messages = [...state.messages];
      messages[idx] = {
        ...msg,
        parts: msg.parts?.map((p) =>
          p.type === "tool" && p.toolCall && p.toolCall.id === toolCallId
            ? { ...p, toolCall: { ...p.toolCall, ...update } }
            : p,
        ),
        toolCalls: msg.toolCalls?.map((tc) =>
          tc.id === toolCallId ? { ...tc, ...update } : tc,
        ),
      };
      savePersisted(messages);
      return { messages };
    }),

  appendToolStreamingOutput: (messageId, toolCallId, text, type) =>
    set((state) => {
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return state;

      const msg = state.messages[idx]!;
      const field = type === "stderr" ? "streamingError" : "streamingOutput";

      // Update the toolCall inside BOTH msg.toolCalls AND msg.parts (the tool
      // part's nested toolCall). The RunningToolPanel reads
      // `toolCall.streamingOutput` / `toolCall.streamingError`, so we must
      // write to those nested objects, not to the message itself.
      const toolCalls = (msg.toolCalls ?? []).map((tc) =>
        tc.id === toolCallId
          ? { ...tc, [field]: (tc[field as "streamingOutput" | "streamingError"] ?? "") + text }
          : tc,
      );
      const parts = (msg.parts ?? []).map((p) => {
        if (p.type === "tool" && p.toolCall && p.toolCall.id === toolCallId) {
          return {
            ...p,
            toolCall: {
              ...p.toolCall,
              [field]: (p.toolCall[field as "streamingOutput" | "streamingError"] ?? "") + text,
            },
          };
        }
        return p;
      });

      const messages = [...state.messages];
      messages[idx] = { ...msg, toolCalls, parts };
      // Don't persist streaming output — it's transient
      return { messages };
    }),

  setStreaming: (streaming) => {
    if (!streaming) flushPersisted();
    set({ isStreaming: streaming });
  },

  clearMessages: () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    pendingMessages = null;
    set((state) => {
      if (state.messages.length === 0) return state;
      if (typeof window !== "undefined") {
        window.sessionStorage.removeItem(PERSIST_KEY);
        window.sessionStorage.removeItem(PERSIST_CONV_KEY);
      }
      return { messages: [] };
    });
  },
}));

/** Track which conversation the persisted messages belong to. */
export function setPersistedConversationId(id: string | null): void {
  if (typeof window === "undefined") return;
  if (id === null) {
    window.sessionStorage.removeItem(PERSIST_CONV_KEY);
  } else {
    window.sessionStorage.setItem(PERSIST_CONV_KEY, id);
  }
}

export function getPersistedConversationId(): string | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem(PERSIST_CONV_KEY);
}

/** Drop persisted messages when they belong to a different conversation. */
export function reconcilePersisted(activeConversationId: string | null): void {
  const stored = getPersistedConversationId();
  if (stored !== (activeConversationId ?? null)) {
    if (typeof window !== "undefined") {
      window.sessionStorage.removeItem(PERSIST_KEY);
    }
    useChatStore.setState({ messages: [] });
    setPersistedConversationId(activeConversationId);
  }
}

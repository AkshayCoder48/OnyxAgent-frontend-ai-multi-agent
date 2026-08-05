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

  addMessage: (message: ChatMessage) => void;
  updateMessage: (id: string, updater: (msg: ChatMessage) => ChatMessage) => void;
  updateMessagesWhere: (
    predicate: (msg: ChatMessage) => boolean,
    updater: (msg: ChatMessage) => ChatMessage,
  ) => void;
  replaceMessageId: (oldId: string, newId: string) => void;
  addToolCall: (messageId: string, toolCall: ToolCall) => void;
  updateToolCall: (messageId: string, toolCallId: string, update: Partial<ToolCall>) => void;
  appendTextDelta: (messageId: string, text: string) => void;
  appendThinkingDelta: (messageId: string, text: string) => void;
  appendReasoningDelta: (messageId: string, text: string) => void;
  addToolCallPart: (messageId: string, toolCall: ToolCall) => void;
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

export const useChatStore = create<ChatState>((set) => ({
  messages: loadPersisted(),
  isStreaming: false,
  selectedProviderId: null,
  selectedModel: null,

  setSelectedProviderId: (id) => set({ selectedProviderId: id }),
  setSelectedModel: (model) => set({ selectedModel: model }),

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
        msg.id === oldId ? { ...msg, id: newId, isTemporaryId: false } : msg,
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
  appendTextDelta: (messageId, text) =>
    set((state) => {
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return state;

      const msg = state.messages[idx]!;
      const parts: MessagePart[] = msg.parts ? [...msg.parts] : [];
      const last = parts[parts.length - 1];
      // If the last part is "text", append to it (normal streaming case).
      if (last && last.type === "text") {
        parts[parts.length - 1] = { ...last, content: (last.content ?? "") + text };
      } else {
        // The last part is NOT text (could be thinking, reasoning, or tool).
        // We need to decide: append to an existing text part, or create new?
        //
        // If the last part is a TOOL call, we should create a NEW text part
        // — this is text AFTER a tool call (post-tool text), which is a
        // separate text block from the pre-tool text.
        //
        // If the last part is thinking/reasoning, we should append to the
        // LAST text part (text was streaming, thinking interleaved, now
        // more text arrives — it should go into the same text bubble).
        if (last && (last.type === "thinking" || last.type === "reasoning")) {
          // Find the last text part — append to it.
          const lastTextIdx = parts.reduce(
            (acc, p, i) => (p.type === "text" ? i : acc),
            -1,
          );
          if (lastTextIdx >= 0) {
            parts[lastTextIdx] = {
              ...parts[lastTextIdx]!,
              content: (parts[lastTextIdx]!.content ?? "") + text,
            };
          } else {
            parts.push({ id: newPartId(), type: "text" as const, content: text });
          }
        } else {
          // Last part is tool (or empty) — create new text part.
          parts.push({ id: newPartId(), type: "text" as const, content: text });
        }
      }

      const messages = [...state.messages];
      messages[idx] = { ...msg, parts, content: msg.content + text };
      savePersisted(messages);
      return { messages };
    }),

  appendThinkingDelta: (messageId, text) =>
    set((state) => {
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return state;

      const msg = state.messages[idx]!;
      const parts: MessagePart[] = msg.parts ? [...msg.parts] : [];
      // ALWAYS append to the LAST thinking part if one exists.
      // The previous logic tried to find the last thinking part after the
      // last tool part, but this caused the content to split into TWO
      // thinking parts when other deltas (text, tool) interleaved —
      // resulting in two "Thinking" bars with half the content each.
      // Now: find the LAST thinking part regardless of what's between.
      const lastThinkIdx = parts.reduce(
        (acc, p, i) => (p.type === "thinking" ? i : acc),
        -1,
      );
      if (lastThinkIdx >= 0) {
        parts[lastThinkIdx] = {
          ...parts[lastThinkIdx]!,
          content: (parts[lastThinkIdx]!.content ?? "") + text,
        };
      } else {
        parts.push({ id: newPartId(), type: "thinking" as const, content: text });
      }

      const messages = [...state.messages];
      messages[idx] = { ...msg, parts, thinking: (msg.thinking ?? "") + text };
      savePersisted(messages);
      return { messages };
    }),

  appendReasoningDelta: (messageId, text) =>
    set((state) => {
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return state;

      const msg = state.messages[idx]!;
      const parts: MessagePart[] = msg.parts ? [...msg.parts] : [];
      // Same fix as thinking — ALWAYS append to the LAST reasoning part
      // regardless of what's between. Prevents content from splitting
      // into two reasoning bars when other deltas interleave.
      const lastReasonIdx = parts.reduce(
        (acc, p, i) => (p.type === "reasoning" ? i : acc),
        -1,
      );
      if (lastReasonIdx >= 0) {
        parts[lastReasonIdx] = {
          ...parts[lastReasonIdx]!,
          content: (parts[lastReasonIdx]!.content ?? "") + text,
        };
      } else {
        parts.push({ id: newPartId(), type: "reasoning" as const, content: text });
      }

      const messages = [...state.messages];
      messages[idx] = { ...msg, parts, reasoning: (msg.reasoning ?? "") + text };
      savePersisted(messages);
      return { messages };
    }),

  addToolCallPart: (messageId, toolCall) =>
    set((state) => {
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return state;

      const msg = state.messages[idx]!;
      const messages = [...state.messages];
      messages[idx] = {
        ...msg,
        parts: [...(msg.parts ?? []), { id: newPartId(), type: "tool" as const, toolCall }],
        toolCalls: [...(msg.toolCalls || []), toolCall],
      };
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

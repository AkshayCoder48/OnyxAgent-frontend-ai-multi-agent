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
      // Find the message index without mapping the entire array
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return state;

      const msg = state.messages[idx]!;
      const parts: MessagePart[] = msg.parts ? [...msg.parts] : [];
      const last = parts[parts.length - 1];
      // If the last part is "text", append to it (normal streaming case).
      // If the last part is "thinking" or "reasoning" (interleaved thinking
      // and text within the same round), we still want to append to the
      // LAST text part to avoid splitting text into multiple bubbles.
      // Only create a NEW text part if there's no existing text part, or
      // if a tool call happened after the last text part.
      if (last && last.type === "text") {
        parts[parts.length - 1] = { ...last, content: (last.content ?? "") + text };
      } else {
        // Check if there's a text part after the last tool part.
        // Find the last text part that comes after the last tool part.
        let lastToolIdx = -1;
        let lastTextIdx = -1;
        for (let i = 0; i < parts.length; i++) {
          if (parts[i]!.type === "tool") lastToolIdx = i;
          if (parts[i]!.type === "text") lastTextIdx = i;
        }
        // If there's a text part AND it comes after the last tool part
        // (or there are no tool parts), append to it. This prevents text
        // from splitting when thinking/reasoning deltas interleave with
        // text deltas within a single round.
        if (lastTextIdx >= 0 && lastToolIdx < lastTextIdx) {
          parts[lastTextIdx] = {
            ...parts[lastTextIdx]!,
            content: (parts[lastTextIdx]!.content ?? "") + text,
          };
        } else {
          parts.push({ id: newPartId(), type: "text" as const, content: text });
        }
      }

      // Only create new objects for the changed message + the array wrapper
      const messages = [...state.messages];
      messages[idx] = { ...msg, parts, content: msg.content + text };

      // Debounced save (not on every delta)
      savePersisted(messages);
      return { messages };
    }),

  appendThinkingDelta: (messageId, text) =>
    set((state) => {
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return state;

      const msg = state.messages[idx]!;
      const parts: MessagePart[] = msg.parts ? [...msg.parts] : [];
      const last = parts[parts.length - 1];
      // If the last part is "thinking", append to it.
      // Otherwise, find the last thinking part that comes after the last
      // tool part (same logic as text — prevents splitting when other
      // deltas interleave with thinking within a single round).
      if (last && last.type === "thinking") {
        parts[parts.length - 1] = { ...last, content: (last.content ?? "") + text };
      } else {
        let lastToolIdx = -1;
        let lastThinkIdx = -1;
        for (let i = 0; i < parts.length; i++) {
          if (parts[i]!.type === "tool") lastToolIdx = i;
          if (parts[i]!.type === "thinking") lastThinkIdx = i;
        }
        if (lastThinkIdx >= 0 && lastToolIdx < lastThinkIdx) {
          parts[lastThinkIdx] = {
            ...parts[lastThinkIdx]!,
            content: (parts[lastThinkIdx]!.content ?? "") + text,
          };
        } else {
          parts.push({ id: newPartId(), type: "thinking" as const, content: text });
        }
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
      const last = parts[parts.length - 1];
      // Same logic as thinking — prevent splitting when other deltas interleave.
      if (last && last.type === "reasoning") {
        parts[parts.length - 1] = { ...last, content: (last.content ?? "") + text };
      } else {
        let lastToolIdx = -1;
        let lastReasonIdx = -1;
        for (let i = 0; i < parts.length; i++) {
          if (parts[i]!.type === "tool") lastToolIdx = i;
          if (parts[i]!.type === "reasoning") lastReasonIdx = i;
        }
        if (lastReasonIdx >= 0 && lastToolIdx < lastReasonIdx) {
          parts[lastReasonIdx] = {
            ...parts[lastReasonIdx]!,
            content: (parts[lastReasonIdx]!.content ?? "") + text,
          };
        } else {
          parts.push({ id: newPartId(), type: "reasoning" as const, content: text });
        }
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

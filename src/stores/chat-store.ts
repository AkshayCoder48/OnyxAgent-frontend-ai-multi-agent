"use client";

import { create, createStore, type StoreApi } from "zustand";
import type { AskUserQuestion, ChatMessage, MessagePart, ToolCall } from "@/types";
import { canMergeIntoLastTextPart } from "@/lib/agent/timeline";

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

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE-SLICE FACTORY
//
// The full set of message-mutating actions, extracted from the old global
// store so it can be instantiated TWICE:
//
//   1. The global `useChatStore` (the UI store for the conversation the user
//      is viewing — exactly as before; every existing consumer is unchanged).
//   2. A HEADLESS per-execution store (`createExecutionChatStore`) owned by
//      the ExecutionHub — the module-level agent runtime that survives React
//      unmounts. While the user views the execution's conversation the UI
//      reads the execution store; while they're elsewhere the hub keeps
//      applying events to it and checkpointing to Dexie.
//
// All actions locate messages by id, so ids stay unique across stores and the
// exact same logic serves both targets.
// ─────────────────────────────────────────────────────────────────────────────

/** Everything the message actions need from their host store. */
interface MessageSliceHost {
  /** Persist sink (sessionStorage snapshot). The EXECUTION stores pass a
   *  gating wrapper so only the VIEWED conversation ever lands in the
   *  snapshot (two running executions must never interleave writes). */
  persist: (messages: ChatMessage[]) => void;
}

function buildMessageActions<S extends { messages: ChatMessage[] }>(
  set: (partial: Partial<S> | ((state: S) => Partial<S>)) => void,
  host: MessageSliceHost,
) {
  const persist = host.persist;

  const addMessage = (message: ChatMessage) =>
    set((state: S) => {
      const messages = [...state.messages, message];
      persist(messages);
      return { messages } as Partial<S>;
    });

  const removeMessage = (id: string) =>
    set((state: S) => {
      const messages = state.messages.filter((msg) => msg.id !== id);
      persist(messages);
      return { messages } as Partial<S>;
    });

  const updateMessage = (id: string, updater: (msg: ChatMessage) => ChatMessage) =>
    set((state: S) => {
      const messages = state.messages.map((msg) => (msg.id === id ? updater(msg) : msg));
      persist(messages);
      return { messages } as Partial<S>;
    });

  const updateMessagesWhere = (
    predicate: (msg: ChatMessage) => boolean,
    updater: (msg: ChatMessage) => ChatMessage,
  ) =>
    set((state: S) => {
      const messages = state.messages.map((msg) => (predicate(msg) ? updater(msg) : msg));
      persist(messages);
      return { messages } as Partial<S>;
    });

  const replaceMessageId = (oldId: string, newId: string) =>
    set((state: S) => {
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
      persist(messages);
      return { messages } as Partial<S>;
    });

  const addToolCall = (messageId: string, toolCall: ToolCall) =>
    set((state: S) => {
      const messages = state.messages.map((msg) =>
        msg.id === messageId ? { ...msg, toolCalls: [...(msg.toolCalls || []), toolCall] } : msg,
      );
      persist(messages);
      return { messages } as Partial<S>;
    });

  const updateToolCall = (messageId: string, toolCallId: string, update: Partial<ToolCall>) =>
    set((state: S) => {
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
      persist(messages);
      return { messages } as Partial<S>;
    });

  const appendTextDelta = (messageId: string, text: string, round?: number, at?: number) =>
    set((state: S) => {
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return {} as Partial<S>;

      const msg = state.messages[idx]!;
      const parts: MessagePart[] = msg.parts ? [...msg.parts] : [];
      // REASONING SETTLEMENT: text arriving after reasoning means the
      // model finished thinking — stamp reasoningEndedAt so the panel
      // flips to "Thought for Ns" + auto-collapses right now (not when the
      // round ends). Only parts of the SAME round + not yet stamped.
      // `at` is the event's origin timestamp (runner wall-clock for
      // background turns) so the duration reflects WHEN the model
      // switched from thinking to answering.
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
              return { ...p, reasoningEndedAt: at ?? Date.now() };
            }
          }
          return p;
        });
        if (reasoningSettled) parts.splice(0, parts.length, ...stamped);
      }
      // ── CHRONOLOGICAL TEXT (timeline PRD §20/§23/§25) ─────────────────
      // Text chunks merge ONLY into a TRAILING same-round text part (the
      // adjacent chunk of the same assistant round). Text is NEVER
      // re-ordered above an earlier tool part and NEVER merges across a
      // tool boundary — `text → tool → text` stays `text → tool → text`.
      // Arrival order at tool boundaries is guaranteed by the event
      // processor, which flushes pending text buffers BEFORE a tool part
      // is added, so the parts array is the true execution timeline.
      if (canMergeIntoLastTextPart(parts, round ?? 0)) {
        const last = parts[parts.length - 1]!;
        parts[parts.length - 1] = {
          ...last,
          content: (last.content ?? "") + text,
        };
      } else {
        parts.push({ id: newPartId(), type: "text" as const, content: text, round });
      }

      const messages = [...state.messages];
      messages[idx] = { ...msg, parts, content: msg.content + text };
      persist(messages);
      return { messages } as Partial<S>;
    });

  const appendThinkingDelta = (messageId: string, text: string, round?: number, at?: number) =>
    set((state: S) => {
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return {} as Partial<S>;

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
          // `at` = origin timestamp (runner wall-clock on background turns)
          // — the "Thought for Ns" badge measures THINKING time in the
          // sandbox, not browser-poll reception time.
          roundStartedAt: at ?? Date.now(),
        });
      }

      const messages = [...state.messages];
      messages[idx] = { ...msg, parts, thinking: (msg.thinking ?? "") + text };
      persist(messages);
      return { messages } as Partial<S>;
    });

  const appendReasoningDelta = (messageId: string, text: string, round?: number, at?: number) =>
    set((state: S) => {
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return {} as Partial<S>;

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
          roundStartedAt: at ?? Date.now(),
        });
      }

      const messages = [...state.messages];
      messages[idx] = { ...msg, parts, reasoning: (msg.reasoning ?? "") + text };
      persist(messages);
      return { messages } as Partial<S>;
    });

  const addToolCallPart = (
    messageId: string,
    toolCall: ToolCall,
    round?: number,
    at?: number,
  ): string => {
    const partId = newPartId();
    set((state: S) => {
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return {} as Partial<S>;

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
          ? { ...p, reasoningEndedAt: at ?? Date.now() }
          : p,
      );
      messages[idx] = {
        ...msg,
        parts: [
          ...baseParts,
          {
            id: partId,
            type: "tool" as const,
            // Stamp the start time (event `ts` in bg mode, runner clock) for
            // the live elapsed timer + settled duration badge.
            toolCall: { ...toolCall, startedAt: toolCall.startedAt ?? at ?? Date.now() },
            // Stamp the round so tool calls stack under their round's panel.
            round,
            roundStartedAt: at ?? Date.now(),
          },
        ],
        toolCalls: [...(msg.toolCalls || []), { ...toolCall, startedAt: toolCall.startedAt ?? at ?? Date.now() }],
      };
      persist(messages);
      return { messages } as Partial<S>;
    });
    return partId;
  }

  const endRound = (messageId: string, round: number, endedAt?: number) =>
    set((state: S) => {
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return {} as Partial<S>;

      const msg = state.messages[idx]!;
      if (!msg.parts) return {} as Partial<S>;
      const at = endedAt ?? Date.now();
      let changed = false;
      const parts = msg.parts.map((p) => {
        if (p.round === round && p.roundEndedAt === undefined) {
          changed = true;
          return { ...p, roundEndedAt: at };
        }
        return p;
      });
      if (!changed) return {} as Partial<S>;

      const messages = [...state.messages];
      messages[idx] = { ...msg, parts };
      persist(messages);
      return { messages } as Partial<S>;
    });

  const endReasoning = (messageId: string, round: number, endedAt?: number) =>
    set((state: S) => {
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return {} as Partial<S>;

      const msg = state.messages[idx]!;
      if (!msg.parts) return {} as Partial<S>;
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
      if (!changed) return {} as Partial<S>;

      const messages = [...state.messages];
      messages[idx] = { ...msg, parts };
      persist(messages);
      return { messages } as Partial<S>;
    });

  const updateToolCallPart = (
    messageId: string,
    toolCallId: string,
    update: Partial<ToolCall>,
  ) =>
    set((state: S) => {
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return {} as Partial<S>;

      const msg = state.messages[idx]!;
      const messages = [...state.messages];
      // Terminal transitions stamp endedAt (once) — the settled duration
      // badge reads it next to the status mark.
      const isTerminal =
        (update.status === "completed" || update.status === "error") &&
        update.endedAt === undefined;
      const withEnd = isTerminal ? { ...update, endedAt: Date.now() } : update;
      messages[idx] = {
        ...msg,
        parts: msg.parts?.map((p) =>
          p.type === "tool" && p.toolCall && p.toolCall.id === toolCallId
            ? { ...p, toolCall: { ...p.toolCall, ...withEnd } }
            : p,
        ),
        toolCalls: msg.toolCalls?.map((tc) =>
          tc.id === toolCallId ? { ...tc, ...withEnd } : tc,
        ),
      };
      persist(messages);
      return { messages } as Partial<S>;
    });

  /** Update a tool part by its PART id — the deterministic adoption path
   *  (timeline PRD §6/§17): a finalized `tool_call` whose provider id
   *  differs from the pre-emit placeholder's id re-identifies the
   *  placeholder IN PLACE (same part, new toolCallId) instead of adding a
   *  second card. The flat `toolCalls` mirror is matched on BOTH the old
   *  and the new id so it stays in sync. */
  const updateToolCallPartByPart = (
    messageId: string,
    partId: string,
    update: Partial<ToolCall>,
  ) =>
    set((state: S) => {
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return {} as Partial<S>;

      const msg = state.messages[idx]!;
      const target = (msg.parts ?? []).find((p) => p.id === partId);
      if (!target || target.type !== "tool" || !target.toolCall) {
        return {} as Partial<S>;
      }
      const oldToolCallId = target.toolCall.id;
      const isTerminal =
        (update.status === "completed" || update.status === "error") &&
        update.endedAt === undefined;
      const withEnd = isTerminal ? { ...update, endedAt: Date.now() } : update;
      const newToolCallId =
        typeof withEnd.id === "string" && withEnd.id ? withEnd.id : oldToolCallId;
      const messages = [...state.messages];
      messages[idx] = {
        ...msg,
        parts: (msg.parts ?? []).map((p) =>
          p.type === "tool" && p.id === partId && p.toolCall
            ? { ...p, toolCall: { ...p.toolCall, ...withEnd } }
            : p,
        ),
        toolCalls: (msg.toolCalls ?? []).map((tc) =>
          tc.id === oldToolCallId || tc.id === newToolCallId
            ? { ...tc, ...withEnd, ...(withEnd.id ? { id: newToolCallId } : {}) }
            : tc,
        ),
      };
      persist(messages);
      return { messages } as Partial<S>;
    });

  /** Rewind one round's streamed parts (timeline PRD §17 — idempotent
   *  ingestion): before a failed round attempt is re-streamed, everything
   *  it already flushed (partial text, thinking/reasoning, pre-emit tool
   *  placeholders) is removed so the retry cannot duplicate it. The flat
   *  content/thinking/reasoning fields are rebuilt from the remaining
   *  parts (they are exact concatenations of part content). */
  const rewindRoundParts = (messageId: string, round: number) =>
    set((state: S) => {
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return {} as Partial<S>;

      const msg = state.messages[idx]!;
      if (!msg.parts) return {} as Partial<S>;
      const roundKey = round ?? 0;
      const keep = msg.parts.filter((p) => (p.round ?? 0) !== roundKey);
      if (keep.length === msg.parts.length) return {} as Partial<S>; // nothing streamed for that round

      const removedToolIds = new Set(
        msg.parts
          .filter(
            (p) =>
              p.type === "tool" &&
              p.toolCall != null &&
              (p.round ?? 0) === roundKey,
          )
          .map((p) => (p as { toolCall: { id: string } }).toolCall.id),
      );
      const rebuild = (type: MessagePart["type"]) =>
        keep.filter((p) => p.type === type).map((p) => p.content ?? "").join("");

      const messages = [...state.messages];
      messages[idx] = {
        ...msg,
        parts: keep,
        content: rebuild("text"),
        thinking: rebuild("thinking"),
        reasoning: rebuild("reasoning"),
        toolCalls: (msg.toolCalls ?? []).filter((tc) => !removedToolIds.has(tc.id)),
      };
      persist(messages);
      return { messages } as Partial<S>;
    });

  const appendToolStreamingOutput = (
    messageId: string,
    toolCallId: string,
    text: string,
    type: "stdout" | "stderr",
  ) =>
    set((state: S) => {
      const idx = state.messages.findIndex((m) => m.id === messageId);
      if (idx === -1) return {} as Partial<S>;

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
      return { messages } as Partial<S>;
    });

  return {
    addMessage,
    removeMessage,
    updateMessage,
    updateMessagesWhere,
    replaceMessageId,
    addToolCall,
    updateToolCall,
    appendTextDelta,
    appendThinkingDelta,
    appendReasoningDelta,
    addToolCallPart,
    endRound,
    endReasoning,
    updateToolCallPart,
    updateToolCallPartByPart,
    rewindRoundParts,
    appendToolStreamingOutput,
  };
}

type MessageActions = ReturnType<typeof buildMessageActions>;

interface ChatState extends MessageActions {
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
   *  create()). Called from ChatContainer's mount effect with the active
   *  conversation id so only a matching snapshot can be restored. */
  restorePersisted: (activeConversationId?: string | null) => void;
  setStreaming: (streaming: boolean) => void;
  clearMessages: () => void;
}

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

  ...buildMessageActions<ChatState>(set, { persist: savePersisted }),

  setSelectedProviderId: (id) => set({ selectedProviderId: id }),
  setSelectedModel: (model) => set({ selectedModel: model }),

  restorePersisted: (activeConversationId?: string | null) =>
    set((state) => {
      if (persistedRestored || state.messages.length > 0) return state;
      persistedRestored = true;
      // ORPHAN GUARD: only restore messages that PROVABLY belong to the
      // active conversation (the persisted conversation key matches). A
      // key-less snapshot is leftover junk from a wiped selection —
      // restoring it painted a previous conversation's messages under the
      // "New conversation" state after navigating away and back.
      const persisted = loadPersisted();
      if (persisted.length === 0) return state;
      const persistedFor = getPersistedConversationId();
      const activeId = activeConversationId ?? null;
      if (persistedFor === null || (activeId !== null && persistedFor !== activeId)) {
        // Key-less or foreign snapshot — drop it instead of painting orphans.
        if (typeof window !== "undefined") {
          window.sessionStorage.removeItem(PERSIST_KEY);
        }
        return state;
      }
      return { messages: persisted };
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

/** Persist a snapshot directly (ExecutionHub's finish-time sync-back writes
 *  the store via setState, which bypasses the actions' persist hooks). */
export function persistChatSnapshot(messages: ChatMessage[]): void {
  savePersisted(messages);
}

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

// ─────────────────────────────────────────────────────────────────────────────
// HEADLESS EXECUTION STORES
//
// One per ACTIVE agent execution (ExecutionHub). Same message actions as the
// global UI store, plus the turn's UI-derivable state (isProcessing /
// pendingQuestions / rateLimitStatus) so ANY mounted UI can subscribe to a
// running execution and render it — and so the event processor keeps working
// (and checkpointing to Dexie) after the user navigates away.
// ─────────────────────────────────────────────────────────────────────────────

export interface ExecutionChatState extends MessageActions {
  messages: ChatMessage[];
  isStreaming: boolean;
  isProcessing: boolean;
  pendingQuestions: AskUserQuestion[] | null;
  rateLimitStatus: string | null;
  setStreaming: (streaming: boolean) => void;
  setProcessing: (processing: boolean) => void;
  setPendingQuestions: (questions: AskUserQuestion[] | null) => void;
  setRateLimitStatus: (status: string | null) => void;
  /** Seed / replace the whole messages array (hub: initial seed from the
   *  global store, final sync-back is done by the hub). */
  replaceAllMessages: (messages: ChatMessage[]) => void;
  /** End-of-execution flush: stamp remaining streaming bits + drop transient
   *  flags (called by the hub after the terminal event). */
  finishExecution: () => void;
}

export type ExecutionChatStore = StoreApi<ExecutionChatState>;

/** A no-op persist sink (used when the execution's conversation isn't the
 *  one being viewed). */
const persistNoop = () => {};

/** Create a headless execution store. `persistGate` — when provided, the
 *  sessionStorage snapshot is only written while it returns true (the hub
 *  keeps it pointed at "is this conversation currently viewed"). */
export function createExecutionChatStore(persistGate?: () => boolean): ExecutionChatStore {
  const persist = persistGate
    ? (messages: ChatMessage[]) => {
        if (persistGate()) savePersisted(messages);
      }
    : persistNoop;
  return createStore<ExecutionChatState>((set) => ({
    messages: [],
    isStreaming: false,
    isProcessing: false,
    pendingQuestions: null,
    rateLimitStatus: null,

    ...buildMessageActions<ExecutionChatState>(set, { persist }),

    setStreaming: (streaming) => {
      if (!streaming) flushPersisted();
      set({ isStreaming: streaming });
    },
    setProcessing: (processing) => set({ isProcessing: processing }),
    setPendingQuestions: (questions) => set({ pendingQuestions: questions }),
    setRateLimitStatus: (status) => set({ rateLimitStatus: status }),
    replaceAllMessages: (messages) =>
      set(() => ({ messages: messages.map((m) => ({ ...m })) })),
    finishExecution: () =>
      set((state) => ({
        messages: state.messages.map((m) =>
          m.isStreaming || m.role === "assistant" ? { ...m, isStreaming: false } : m,
        ),
        isStreaming: false,
        isProcessing: false,
        pendingQuestions: null,
      })),
  }));
}

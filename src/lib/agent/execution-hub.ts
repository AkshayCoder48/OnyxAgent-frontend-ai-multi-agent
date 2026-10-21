"use client";

import { useMemo } from "react";
import { nanoid } from "nanoid";
import { create, useStore } from "zustand";
import type { ChatMessage } from "@/types";
import {
  createExecutionChatStore,
  useChatStore,
  setPersistedConversationId,
  persistChatSnapshot,
  type ExecutionChatStore,
} from "@/stores/chat-store";
import type { AgentTurnOptions } from "@/lib/agent/runtime";
import { runAgentTurn } from "@/lib/agent/runtime";
import { AgentEventProcessor } from "@/lib/agent/event-processor";
import { isAbortLikeError } from "@/lib/agent/stream-guards";

/**
 * ExecutionHub — the module-level agent-execution registry.
 *
 * ARCHITECTURE (the "navigation never aborts" contract):
 *
 *   useChat (a React hook)  ──subscribes──▶  Execution  ──runs──▶  E2B / fetch
 *        │                                    │
 *        │ route change / chat switch /        │ keeps running:
 *        │ component unmount = DETACH ONLY     │  · bg consumer keeps streaming
 *        ▼                                    │  · fg fetch keeps streaming
 *   any later useChat re-subscribes            │  · Dexie checkpoints keep saving
 *                                             ▼
 *                                     terminal → sync back → unregister
 *
 * The hub owns one Execution per active agent turn. Each execution has:
 *   - a HEADLESS chat store (message parts / tool calls / rounds — the exact
 *     shapes the UI renders) that ANY mounted UI can subscribe to,
 *   - an AgentEventProcessor (the old 868-line handleAgentEvent, extracted),
 *   - the turn's abort controller.
 *
 * Cancellation is EXPLICIT ONLY: hub.stopExecution() (the Stop button).
 * Nothing that happens to the React tree ever stops an execution.
 */

export type ExecutionStatus = "running" | "completed" | "failed" | "stopped";
export type ExecutionMode = "foreground" | "background";
export type ExecutionTrigger = "user" | "resume";

export interface ExecutionSummary {
  id: string;
  conversationId: string | null;
  mode: ExecutionMode;
  status: ExecutionStatus;
  trigger: ExecutionTrigger;
  startedAt: number;
}

export interface ExecutionRecord extends ExecutionSummary {
  finishedAt?: number;
  store: ExecutionChatStore;
  processor: AgentEventProcessor;
  abortController: AbortController | null;
}

// ── React-subscribable registry (summaries only; records stay private) ──────
interface HubState {
  byConversation: Record<string, ExecutionSummary>;
  byExecution: Record<string, ExecutionSummary>;
  /** The conversation the mounted UI is currently viewing (persist-snapshot
   *  gate + "which execution should this UI render" resolution). */
  viewedConversationId: string | null;
  upsert: (s: ExecutionSummary) => void;
  patch: (id: string, p: Partial<ExecutionSummary>) => void;
  remove: (id: string) => void;
  setViewed: (conversationId: string | null) => void;
}

const useHubStore = create<HubState>((set) => ({
  byConversation: {},
  byExecution: {},
  viewedConversationId: null,
  upsert: (s) =>
    set((state) => {
      const byExecution = { ...state.byExecution, [s.id]: s };
      const byConversation = { ...state.byConversation };
      if (s.conversationId) byConversation[s.conversationId] = s;
      return { byConversation, byExecution };
    }),
  patch: (id, p) =>
    set((state) => {
      const cur = state.byExecution[id];
      if (!cur) return state;
      const next = { ...cur, ...p };
      const byConversation = { ...state.byConversation };
      if (cur.conversationId && byConversation[cur.conversationId]?.id === id) {
        byConversation[cur.conversationId] = next;
      }
      if (p.conversationId && p.conversationId !== cur.conversationId) {
        delete byConversation[cur.conversationId ?? ""];
        byConversation[p.conversationId] = next;
      }
      return { byConversation, byExecution: { ...state.byExecution, [id]: next } };
    }),
  remove: (id) =>
    set((state) => {
      const cur = state.byExecution[id];
      if (!cur) return state;
      const byExecution = { ...state.byExecution };
      const byConversation = { ...state.byConversation };
      delete byExecution[id];
      if (cur.conversationId && byConversation[cur.conversationId]?.id === id) {
        delete byConversation[cur.conversationId];
      }
      return { byConversation, byExecution };
    }),
  setViewed: (conversationId) => set({ viewedConversationId: conversationId }),
}));

// ── Module-level record map (survives every React lifecycle) ────────────────
const records = new Map<string, ExecutionRecord>();

function recordToSummary(r: ExecutionRecord): ExecutionSummary {
  return {
    id: r.id,
    conversationId: r.conversationId,
    mode: r.mode,
    status: r.status,
    trigger: r.trigger,
    startedAt: r.startedAt,
  };
}

/** Fallback store for the optional-subscription hook below. */
const FALLBACK_STORE = createExecutionChatStore();

export const executionHub = {
  // ── LOOKUPS ────────────────────────────────────────────────────────────
  getFor(conversationId: string | null): ExecutionSummary | null {
    if (!conversationId) return null;
    return useHubStore.getState().byConversation[conversationId] ?? null;
  },
  getSummary(executionId: string): ExecutionSummary | null {
    return useHubStore.getState().byExecution[executionId] ?? null;
  },
  getStore(executionId: string): ExecutionChatStore | null {
    return records.get(executionId)?.store ?? null;
  },
  /** All live executions (sidebar "Running" section). */
  listRunning(): ExecutionSummary[] {
    const { byExecution } = useHubStore.getState();
    return Object.values(byExecution).filter((e) => e.status === "running");
  },
  isViewed(conversationId: string | null): boolean {
    // NOTE: null === null is a MATCH — the "new chat" (null) view is the
    // rightful destination for a pending new-chat execution's final content
    // (its conversation id doesn't exist until conversation_created). Without
    // this, a new-chat turn's error/result message vanished on finish (the
    // exec store unregistered without ever syncing the global UI store).
    const viewed = useHubStore.getState().viewedConversationId;
    return viewed === conversationId;
  },
  setViewed(conversationId: string | null): void {
    useHubStore.getState().setViewed(conversationId);
  },

  // ── CREATION ───────────────────────────────────────────────────────────
  /**
   * Create a new execution (called by useChat.doSend BEFORE the turn runs).
   * The execution's store is seeded with the conversation's current messages
   * from the global UI store (the user is viewing this conversation when
   * they press send), so the optimistic user message + all subsequent agent
   * events land in one place that survives navigation.
   */
  createExecution(opts: {
    conversationId: string | null;
    mode: ExecutionMode;
    trigger?: ExecutionTrigger;
    /** UI notification when the runtime creates the conversation (new chat):
     *  refreshes the conversation list etc. The hub's own re-key always runs. */
    onConversationCreated?: (conversationId: string) => void;
  }): ExecutionRecord {
    const id = `exec_${nanoid(8)}`;
    // NOTE: the closures below capture `record` before it is initialized —
    // they only ever RUN after the initializer completes, so the TDZ is never
    // hit at runtime.
    const record = {} as ExecutionRecord;
    const store = createExecutionChatStore(() =>
      this.isViewed(record.conversationId ?? opts.conversationId),
    );
    const processor = new AgentEventProcessor({
      store,
      getConversationId: () => record.conversationId,
      onConversationCreated: (conversationId) => {
        // Re-key: the new-chat execution now belongs to a real conversation.
        record.conversationId = conversationId;
        useHubStore.getState().patch(id, { conversationId });
        opts.onConversationCreated?.(conversationId);
      },
      onTurnEnd: (status) => {
        this.finishExecution(id, status);
      },
    });
    Object.assign(record, {
      id,
      conversationId: opts.conversationId,
      mode: opts.mode,
      status: "running",
      trigger: opts.trigger ?? "user",
      startedAt: Date.now(),
      store,
      processor,
      abortController: new AbortController(),
    });
    // Seed: the conversation's current messages (user is viewing it).
    store.getState().replaceAllMessages(useChatStore.getState().messages);
    records.set(id, record);
    useHubStore.getState().upsert(recordToSummary(record));
    store.getState().setProcessing(true);
    return record;
  },

  /** The processor's event sink (fg runtime + bg consumer both use this). */
  emitFor(executionId: string) {
    const r = records.get(executionId);
    return r ? r.processor.handle : undefined;
  },

  processorFor(executionId: string) {
    return records.get(executionId)?.processor ?? null;
  },

  // ── RUN (foreground) ───────────────────────────────────────────────────
  /** Run the in-browser runtime for the execution. The returned turn options
   * carry the execution's emit + abort signal. */
  buildOptions(executionId: string, opts: AgentTurnOptions): AgentTurnOptions {
    const r = records.get(executionId);
    if (!r || !r.abortController) return opts;
    return {
      ...opts,
      emit: r.processor.handle,
      signal: r.abortController.signal,
    };
  },

  runForeground(executionId: string, opts: AgentTurnOptions): void {
    const r = records.get(executionId);
    if (!r) return;
    const final = this.buildOptions(executionId, opts);
    void runAgentTurn(final).catch((err) => {
      // ABORT ≠ ERROR: the Stop button (or a race between the stop path
      // and the turn's final await) rejects with an AbortError-shaped
      // DOMException ("BodyStreamBuffer was aborted") — stopExecution
      // already finalized the message, so surfacing it as a chat error
      // was pure noise (the "❌ AbortError" bug). Only real failures
      // become error events.
      if (r.abortController?.signal.aborted || isAbortLikeError(err)) return;
      const message = err instanceof Error ? err.message : "Agent turn failed";
      r.processor.handle({ type: "error", data: { message } });
    });
  },

  // ── STOP (explicit only — the Stop button) ─────────────────────────────
  stopExecution(executionId: string): void {
    const r = records.get(executionId);
    if (!r || r.status !== "running") return;
    r.processor.markStoppedByUser();
    r.abortController?.abort();
    r.abortController = null;
    this.finishExecution(executionId, "stopped");
  },

  /** Stop whatever is running for a conversation (Stop button path). */
  stopFor(conversationId: string | null): string | null {
    if (!conversationId) return null;
    const s = this.getFor(conversationId);
    if (!s || s.status !== "running") return null;
    this.stopExecution(s.id);
    return s.id;
  },

  // ── FINISH ─────────────────────────────────────────────────────────────
  finishExecution(executionId: string, status: ExecutionStatus): void {
    const r = records.get(executionId);
    if (!r || r.status !== "running") return; // idempotent
    r.status = status;
    r.finishedAt = Date.now();
    r.processor.flush();
    r.store.getState().finishExecution();
    // Sync back to the global UI store when the user is still viewing this
    // conversation — the UI flips from the execution store to the global
    // store with identical content (no flash).
    const viewed = this.isViewed(r.conversationId);
    if (viewed) {
      const finalMessages = [...r.store.getState().messages];
      useChatStore.setState({ messages: finalMessages, isStreaming: false });
      setPersistedConversationId(r.conversationId);
      persistChatSnapshot(finalMessages);
    }
    useHubStore.getState().patch(executionId, { status });
    // Unregister on the next macrotask — subscribers flip to the global
    // store (or Dexie) with the final content already in place.
    setTimeout(() => {
      const rec = records.get(executionId);
      if (!rec || rec.status === status) {
        rec?.processor.dispose();
        records.delete(executionId);
        useHubStore.getState().remove(executionId);
      }
    }, 0);
  },

};

// ── REACT BINDINGS ─────────────────────────────────────────────────────────

/** Subscribe to the execution summary for a conversation (null when none). */
export function useExecutionFor(conversationId: string | null): ExecutionSummary | null {
  return useHubStore((s) => (conversationId ? s.byConversation[conversationId] ?? null : null));
}

/**
 * The merged message source: the live execution's store when the viewed
 * conversation has one (message events keep flowing regardless of where the
 * user navigates), otherwise the global chat store.
 */
export function useExecutionMessages(executionId: string | null): ChatMessage[] {
  const execStore = executionId ? executionHub.getStore(executionId) : null;
  const execMessages = useStore(execStore ?? FALLBACK_STORE, (s) => s.messages);
  const globalMessages = useChatStore((s) => s.messages);
  return execStore ? execMessages : globalMessages;
}

/** Live per-execution UI state with a global fallback. */
export function useExecutionChatValue<T>(
  executionId: string | null,
  selector: (s: import("@/stores/chat-store").ExecutionChatState) => T,
  fallback: T,
): T {
  const execStore = executionId ? executionHub.getStore(executionId) : null;
  const value = useStore(execStore ?? FALLBACK_STORE, selector);
  return execStore ? value : fallback;
}

/** Live per-execution isProcessing with a global fallback. */
export function useExecutionUiState(executionId: string | null): {
  isProcessing: boolean;
} {
  const isProcessing = useExecutionChatValue<boolean>(executionId, (s) => s.isProcessing, false);
  return { isProcessing };
}

/** Subscribe to a specific execution's summary (by execution id). */
export function useExecutionById(executionId: string | null): ExecutionSummary | null {
  return useHubStore((s) => (executionId ? s.byExecution[executionId] ?? null : null));
}

/** Subscribe to every running execution (sidebar status list). */
export function useRunningExecutions(): ExecutionSummary[] {
  // Subscribe to the stable byExecution MAP reference (only replaced on
  // registry mutations) and derive the array in useMemo — returning a fresh
  // array from the selector itself re-rendered on every store snapshot
  // ("Maximum update depth exceeded").
  const byExecution = useHubStore((s) => s.byExecution);
  return useMemo(
    () => Object.values(byExecution).filter((e) => e.status === "running"),
    [byExecution],
  );
}

export { useHubStore };

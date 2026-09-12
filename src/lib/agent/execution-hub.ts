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
import { conversationService } from "@/lib/services";
import { conversationMessageToChatMessage } from "@/lib/conversation-to-chat";
import type { AgentTurnOptions } from "@/lib/agent/runtime";
import { runAgentTurn } from "@/lib/agent/runtime";
import type { BackgroundTurnHandle } from "@/lib/agent/background-turn";
import { AgentEventProcessor } from "@/lib/agent/event-processor";
import {
  listJobs,
  getActiveJob,
} from "@/lib/e2b/background-agent";

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
 *   - the turn's abort controller (foreground) / E2B background handle.
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
  /** E2B sandbox (background executions) — surfaced in the running list. */
  sandboxId?: string;
}

export interface ExecutionRecord extends ExecutionSummary {
  finishedAt?: number;
  store: ExecutionChatStore;
  processor: AgentEventProcessor;
  handle: BackgroundTurnHandle | null;
  abortController: AbortController | null;
  /** bg stop bookkeeping (set after launch so stop works pre-resume). */
  onStopped?: () => void;
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
/** In-flight resume guards (conversationId → promise) so a mount effect and
 *  the app-level rehydrator can never double-resume the same job. */
const resuming = new Map<string, Promise<ExecutionRecord | null>>();

function recordToSummary(r: ExecutionRecord): ExecutionSummary {
  return {
    id: r.id,
    conversationId: r.conversationId,
    mode: r.mode,
    status: r.status,
    trigger: r.trigger,
    startedAt: r.startedAt,
    sandboxId: r.sandboxId,
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
      handle: null,
      abortController: opts.mode === "foreground" ? new AbortController() : null,
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
      const message = err instanceof Error ? err.message : "Agent turn failed";
      r.processor.handle({ type: "error", data: { message } });
    });
  },

  // ── RUN (background) ───────────────────────────────────────────────────
  /** Register the launched background handle (doSend calls this after
   *  startBackgroundTurn resolves). */
  registerBackgroundHandle(
    executionId: string,
    handle: BackgroundTurnHandle | null,
    sandboxId?: string,
  ): void {
    const r = records.get(executionId);
    if (!r) return;
    r.handle = handle;
    if (sandboxId) {
      r.sandboxId = sandboxId;
      useHubStore.getState().patch(executionId, { sandboxId });
    }
  },

  /** Mode correction (bg launch failed → foreground fallback). */
  patchMode(executionId: string, mode: ExecutionMode): void {
    const r = records.get(executionId);
    if (!r || r.status !== "running") return;
    r.mode = mode;
    if (mode === "foreground" && !r.abortController) r.abortController = new AbortController();
    useHubStore.getState().patch(executionId, { mode });
  },

  // ── STOP (explicit only — the Stop button) ─────────────────────────────
  stopExecution(executionId: string): void {
    const r = records.get(executionId);
    if (!r || r.status !== "running") return;
    r.processor.markStoppedByUser();
    r.abortController?.abort();
    r.abortController = null;
    if (r.handle) {
      const handle = r.handle;
      r.handle = null;
      void handle.stop();
    }
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

  // ── RESUME (page reload / app rehydrate) ───────────────────────────────
  /**
   * Ensure an execution exists for a conversation with a persisted E2B
   * background job. Idempotent + race-safe (a guard map prevents the chat
   * page's mount effect and the app-level rehydrator from double-resuming).
   * Returns the summary (existing OR resumed), or null when there is no job.
   */
  async ensureResumed(
    conversationId: string,
    userId: string,
    e2bApiKey: string,
  ): Promise<ExecutionSummary | null> {
    const existing = this.getFor(conversationId);
    if (existing) return existing;
    const inflight = resuming.get(conversationId);
    if (inflight) return inflight.then((r) => (r ? recordToSummary(r) : null));
    const job = getActiveJob(conversationId);
    if (!job) return null;

    const promise = (async (): Promise<ExecutionRecord | null> => {
      // Re-check after the async boundary — a doSend may have created an
      // execution for this conversation while we were loading.
      const existing2 = this.getFor(conversationId);
      if (existing2) {
        resuming.delete(conversationId);
        return records.get(existing2.id) ?? null;
      }
      const record = this.createExecution({
        conversationId,
        mode: "background",
        trigger: "resume",
      });
      // Seed the execution store from Dexie (the checkpointed history).
      try {
        const rows = await conversationService.getMessages(conversationId, userId);
        const seed: ChatMessage[] = [];
        for (const row of rows) {
          const chatMsg = conversationMessageToChatMessage({
            id: row.id,
            conversation_id: row.conversation_id,
            role: row.role,
            content: row.content,
            created_at: row.created_at,
            tool_calls: row.tool_calls,
            user_rating: row.user_rating,
            rating_count: row.rating_count,
            files: row.files,
            thinking: (row as { thinking?: string | null }).thinking,
            reasoning: (row as { reasoning?: string | null }).reasoning,
            parts: (row as { parts?: unknown[] | null }).parts as
              | import("@/types").MessagePart[]
              | null
              | undefined,
          });
          seed.push(chatMsg);
        }
        record.store.getState().replaceAllMessages(seed);
      } catch {
        // best-effort — events replay will still populate the message
      }
      record.store.getState().setProcessing(true);

      const { resumeBackgroundTurn } = await import("@/lib/agent/background-turn");
      const handle = await resumeBackgroundTurn({
        e2bApiKey,
        userId,
        conversationId,
        emit: (ev) => record.processor.handle(ev),
        onFinished: () => {
          // The consumer's terminal events already routed through the
          // processor (onTurnEnd). This is the safety net for paths that
          // end without a terminal event (e.g. unreachable give-up emits
          // an error event — handled — or a consumer crash).
          executionHub.finishExecution(record.id, "failed");
        },
        store: record.store,
      }).catch(() => null);
      if (handle) {
        record.handle = handle;
        record.sandboxId = job.sandboxId;
        useHubStore.getState().patch(record.id, { sandboxId: job.sandboxId });
      } else {
        // Nothing resumable (job gone / sandbox expired) — drop the
        // placeholder execution cleanly.
        record.store.getState().setProcessing(false);
        this.finishExecution(record.id, "stopped");
      }
      resuming.delete(conversationId);
      return record;
    })();
    resuming.set(conversationId, promise);
    return promise.then((r) => (r ? recordToSummary(r) : null));
  },

  /**
   * App-mount rehydration: resume EVERY persisted background job (not just
   * the current conversation) — the browser is the persistence layer for
   * interactive runs, so all running jobs keep checkpointing to Dexie the
   * moment the app reopens. Spec §14: refresh must not terminate execution.
   */
  async rehydrateAll(userId: string, e2bApiKey: string): Promise<void> {
    const jobs = listJobs();
    for (const job of jobs) {
      if (!job.conversationId) continue;
      try {
        await this.ensureResumed(job.conversationId, userId, e2bApiKey);
      } catch {
        // best-effort — the per-conversation resume effect retries on view
      }
    }
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

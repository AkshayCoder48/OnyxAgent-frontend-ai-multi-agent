"use client";

/**
 * Business Mode zustand store (Task 2-a).
 *
 * Main data (businesses, agents, tasks, drafts, memory, events, chat
 * messages) is NEVER persisted through zustand middleware — Dexie/IndexedDB
 * is the source of truth and this store is just the live view of the
 * ACTIVE business. The only persisted bit is `activeBusinessId`
 * (localStorage, key `onyx-business-active-id`) so the workspace can be
 * restored after a reload.
 *
 * Module-level usage is fine: `useBusinessStore.getState().…`.
 */

import { create } from "zustand";
import { useAuthStore } from "@/stores/auth-store";
import {
  businessAgentService,
  businessChatService,
  businessDraftService,
  businessEventService,
  businessMemoryService,
  businessService,
  businessTaskService,
  setBusinessEventListener,
} from "@/lib/business/data";
import type {
  BusinessAgentRow,
  BusinessChatMessageRow,
  BusinessDraftRow,
  BusinessEventRow,
  BusinessMemoryRow,
  BusinessRow,
  BusinessTaskRow,
} from "@/lib/business/types";

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

const ACTIVE_BUSINESS_ID_KEY = "onyx-business-active-id";

/** Event feed cap (newest-first list). */
const EVENTS_CAP = 500;
/** Chat transcript cap (ascending — oldest messages are dropped). */
const CHAT_CAP = 300;

// ---------------------------------------------------------------------------
// State + actions (pinned contract — see worklog.md / types.ts).
// ---------------------------------------------------------------------------

export interface BusinessState {
  businesses: BusinessRow[];
  businessesLoaded: boolean;
  activeBusinessId: string | null;
  activeBusiness: BusinessRow | null;
  agents: BusinessAgentRow[];
  tasks: BusinessTaskRow[];
  drafts: BusinessDraftRow[];
  memory: BusinessMemoryRow[];
  /** Newest-first, capped at EVENTS_CAP. */
  events: BusinessEventRow[];
  /** Ascending (chronological), capped at the last CHAT_CAP messages. */
  chatMessages: BusinessChatMessageRow[];
  turnRunning: boolean;

  loadBusinesses: () => Promise<void>;
  openBusiness: (id: string | null) => Promise<void>;
  setBusiness: (row: BusinessRow | null) => void;
  upsertAgent: (agent: BusinessAgentRow) => void;
  removeAgent: (id: string) => void;
  upsertTask: (task: BusinessTaskRow) => void;
  upsertDraft: (draft: BusinessDraftRow) => void;
  upsertMemory: (row: BusinessMemoryRow) => void;
  removeMemory: (id: string) => void;
  appendEvent: (evt: BusinessEventRow) => void;
  appendChatMessage: (msg: BusinessChatMessageRow) => void;
  updateChatMessage: (id: string, patch: Partial<BusinessChatMessageRow>) => void;
  setTurnRunning: (b: boolean) => void;
  reset: () => void;
}

const EMPTY_ACTIVE = {
  activeBusiness: null,
  agents: [] as BusinessAgentRow[],
  tasks: [] as BusinessTaskRow[],
  drafts: [] as BusinessDraftRow[],
  memory: [] as BusinessMemoryRow[],
  events: [] as BusinessEventRow[],
  chatMessages: [] as BusinessChatMessageRow[],
  turnRunning: false,
};

// ---------------------------------------------------------------------------
// Sort helpers (sane, stable orders for the live arrays).
// ---------------------------------------------------------------------------

function sortAgents(rows: BusinessAgentRow[]): BusinessAgentRow[] {
  return [...rows].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
}

function sortTasks(rows: BusinessTaskRow[]): BusinessTaskRow[] {
  return [...rows].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
}

function sortDrafts(rows: BusinessDraftRow[]): BusinessDraftRow[] {
  return [...rows].sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
}

function sortMemory(rows: BusinessMemoryRow[]): BusinessMemoryRow[] {
  return [...rows].sort((a, b) => {
    if (!!b.pinned !== !!a.pinned) return a.pinned ? -1 : 1;
    return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
  });
}

// ---------------------------------------------------------------------------
// Store.
// ---------------------------------------------------------------------------

export const useBusinessStore = create<BusinessState>()((set, get) => ({
  businesses: [],
  businessesLoaded: false,
  activeBusinessId: null,
  ...EMPTY_ACTIVE,
  turnRunning: false,

  loadBusinesses: async () => {
    const userId = useAuthStore.getState().user?.id ?? "local-user";
    const rows = await businessService.list(userId);
    set({ businesses: rows, businessesLoaded: true });
  },

  openBusiness: async (id) => {
    // Persist the active id (survives reloads). Storage failures are
    // non-fatal — the in-memory state still updates.
    try {
      if (typeof window !== "undefined") {
        if (id) window.localStorage.setItem(ACTIVE_BUSINESS_ID_KEY, id);
        else window.localStorage.removeItem(ACTIVE_BUSINESS_ID_KEY);
      }
    } catch {
      // localStorage unavailable (private mode / SSR) — ignore.
    }
    set({ activeBusinessId: id });

    if (!id) {
      set({ ...EMPTY_ACTIVE });
      return;
    }

    const business = await businessService.get(id);
    if (!business) {
      // Stale id (business deleted) — clear the active fields.
      set({ activeBusinessId: null, ...EMPTY_ACTIVE });
      try {
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(ACTIVE_BUSINESS_ID_KEY);
        }
      } catch {
        // ignore
      }
      return;
    }

    // Stale-task recovery BEFORE loading tasks: any task still in a
    // work-in-flight status is marked "interrupted" so the loaded roster
    // reflects reality (no fake running state after a reload).
    const interrupted = await businessTaskService.markStaleInterrupted(id);

    const [agents, tasks, drafts, memory, evtRows, chatRows] = await Promise.all([
      businessAgentService.list(id),
      businessTaskService.list(id),
      businessDraftService.list(id),
      businessMemoryService.list(id),
      businessEventService.list(id, 200),
      businessChatService.list(id, 200),
    ]);

    // A concurrent openBusiness(id2) may have started while we awaited —
    // its set() wins; discard this (now stale) payload.
    if (get().activeBusinessId !== id) return;

    set({
      activeBusiness: business,
      agents,
      tasks,
      drafts,
      memory,
      // list() returns chronological order — reverse to newest-first.
      events: evtRows.slice().reverse(),
      chatMessages: chatRows,
      turnRunning: false,
    });

    if (interrupted.length > 0) {
      await businessEventService.append({
        business_id: id,
        event_type: "notification",
        payload: { kind: "interrupted_recovery", count: interrupted.length },
      });
    }
  },

  setBusiness: (row) =>
    set((s) => {
      if (!row) return { activeBusiness: null };
      const exists = s.businesses.some((b) => b.id === row.id);
      const businesses = exists
        ? s.businesses.map((b) => (b.id === row.id ? row : b))
        : [...s.businesses, row];
      // Dashboard order: most recently updated first.
      businesses.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
      return {
        businesses,
        activeBusiness: s.activeBusinessId === row.id ? row : s.activeBusiness,
      };
    }),

  upsertAgent: (agent) =>
    set((s) => ({ agents: sortAgents([...s.agents.filter((a) => a.id !== agent.id), agent]) })),

  removeAgent: (id) => set((s) => ({ agents: s.agents.filter((a) => a.id !== id) })),

  upsertTask: (task) =>
    set((s) => ({ tasks: sortTasks([...s.tasks.filter((t) => t.id !== task.id), task]) })),

  upsertDraft: (draft) =>
    set((s) => ({ drafts: sortDrafts([...s.drafts.filter((d) => d.id !== draft.id), draft]) })),

  upsertMemory: (row) =>
    set((s) => ({ memory: sortMemory([...s.memory.filter((m) => m.id !== row.id), row]) })),

  removeMemory: (id) => set((s) => ({ memory: s.memory.filter((m) => m.id !== id) })),

  appendEvent: (evt) =>
    set((s) => ({ events: [evt, ...s.events].slice(0, EVENTS_CAP) })),

  appendChatMessage: (msg) =>
    set((s) => {
      const next = [...s.chatMessages, msg];
      return { chatMessages: next.length > CHAT_CAP ? next.slice(next.length - CHAT_CAP) : next };
    }),

  updateChatMessage: (id, patch) =>
    set((s) => ({
      chatMessages: s.chatMessages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    })),

  setTurnRunning: (b) => set({ turnRunning: b }),

  /** Clear every in-memory field (called on workspace unmount). The
   *  persisted `activeBusinessId` in localStorage is intentionally kept —
   *  it is the restore pointer for the next session, owned by
   *  openBusiness(null). */
  reset: () =>
    set({
      businesses: [],
      businessesLoaded: false,
      activeBusinessId: null,
      ...EMPTY_ACTIVE,
    }),
}));

// ---------------------------------------------------------------------------
// Event listener wiring — registered ONCE at store creation so every
// businessEventService.append (from any orchestrator turn) automatically
// flows into the active workspace's feed. data.ts stays store-free (no
// circular import); the listener only reacts to the ACTIVE business.
// ---------------------------------------------------------------------------

setBusinessEventListener((evt) => {
  const state = useBusinessStore.getState();
  if (evt.business_id === state.activeBusinessId) {
    state.appendEvent(evt);
  }
});

// ---------------------------------------------------------------------------
// Convenience selectors.
// ---------------------------------------------------------------------------

/** Agents of the active business (created_at asc). */
export function useActiveBusinessAgents(): BusinessAgentRow[] {
  return useBusinessStore((s) => s.agents);
}

/** Tasks of the active business (created_at desc — newest first). */
export function useBusinessTasks(): BusinessTaskRow[] {
  return useBusinessStore((s) => s.tasks);
}

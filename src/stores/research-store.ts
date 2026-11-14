"use client";

import { create } from "zustand";
import type { Todo } from "@/types";

interface ResearchTurn {
  /** The ONE todo bucket (2026-11-14: "it's all todos, not a separate plan
   *  thing"). manage_todo / show_todo snapshots AND legacy-backend
   *  todo_events both land here (the event processor maps the legacy
   *  shape). Read by the Todos dock above the composer and the TodoPreview
   *  tables attached to tool rows — live updates arrive as todo_event
   *  snapshots, and the list rehydrates from Dexie across refreshes. */
  agentTodos?: Todo[];
  /** User clicked the "Cut" button — panel stays hidden until the next event. */
  dismissed?: boolean;
}

interface ResearchState {
  /** Keyed by conversation id; "current" key tracks the active conversation. */
  byTurn: Record<string, ResearchTurn>;
  /** The active conversation id (used as the turn key). */
  currentTurnId: string | null;
  setCurrentTurnId: (turnId: string | null) => void;
  /** Replace the agent todos for a turn. */
  setAgentTodos: (turnId: string, todos: Todo[]) => void;
  dismiss: () => void;
  reset: (turnId?: string) => void;
}

/**
 * The live TODO store. The agent emits `todo_event` frames carrying a full
 * `all_todos` snapshot for every mutation; the event processor forwards them
 * here into `agentTodos` (the single todo pipeline — legacy shapes are
 * mapped onto the Todo contract upstream). The Todos dock and the
 * TodoPreview tables render from this one bucket.
 */
export const useResearchStore = create<ResearchState>((set, get) => ({
  byTurn: {},
  currentTurnId: null,

  setCurrentTurnId: (turnId) => set({ currentTurnId: turnId }),

  setAgentTodos: (turnId, todos) => {
    set((state) => {
      const prevTurn = state.byTurn[turnId] ?? {};
      return {
        byTurn: {
          ...state.byTurn,
          [turnId]: { ...prevTurn, agentTodos: todos, dismissed: false },
        },
      };
    });
  },

  dismiss: () => {
    const turnId = get().currentTurnId ?? "default";
    set((state) => {
      const prevTurn = state.byTurn[turnId] ?? {};
      return {
        byTurn: {
          ...state.byTurn,
          [turnId]: { ...prevTurn, dismissed: true },
        },
      };
    });
  },

  reset: (turnId) => {
    const target = turnId ?? get().currentTurnId ?? "default";
    set((state) => {
      const next = { ...state.byTurn };
      delete next[target];
      return { byTurn: next };
    });
  },
}));

/** Read the agent todos for a turn without subscribing to the whole store
 *  (used by imperative callers). */
export function getAgentTodos(turnId: string | null): Todo[] {
  const key = turnId ?? "default";
  return useResearchStore.getState().byTurn[key]?.agentTodos ?? [];
}

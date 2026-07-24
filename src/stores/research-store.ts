"use client";

import { create } from "zustand";
import type { ResearchTodo } from "@/types";

interface ResearchTurn {
  todos: ResearchTodo[];
  /** User clicked the "Cut" button — panel stays hidden until the next event. */
  dismissed?: boolean;
}

interface ResearchState {
  /** Keyed by conversation id; "current" key tracks the active conversation. */
  byTurn: Record<string, ResearchTurn>;
  /** The active conversation id (used as the turn key). */
  currentTurnId: string | null;
  setCurrentTurnId: (turnId: string | null) => void;
  applyTodoEvent: (
    eventType: string,
    todo: ResearchTodo | null,
    allTodos?: ResearchTodo[] | null,
  ) => void;
  dismiss: () => void;
  reset: (turnId?: string) => void;
}

/**
 * Live TODO plan store. The agent emits `todo_event` WS frames for every
 * mutation (created / updated / status_changed / completed / deleted /
 * reset / snapshot); the hook in `use-chat.ts` forwards them here. The
 * `ResearchPanel` reads the active turn's todos and renders them with a
 * real-time progress bar, status icons, and a "Cut" button.
 *
 * The backend ships the full `all_todos` snapshot on every event (see
 * `app/agents/todo_integration.py:_make_handler`), so we don't need to
 * implement per-event merging logic — just replace the list.
 */
export const useResearchStore = create<ResearchState>((set, get) => ({
  byTurn: {},
  currentTurnId: null,

  setCurrentTurnId: (turnId) => set({ currentTurnId: turnId }),

  applyTodoEvent: (eventType, todo, allTodos) => {
    const turnId = get().currentTurnId ?? "default";
    // Snapshot / reset events carry `allTodos` directly; individual events
    // also include it so we can always replace the list cheaply.
    const nextTodos: ResearchTodo[] = allTodos
      ? (allTodos as ResearchTodo[])
      : todo
        ? [todo as ResearchTodo]
        : [];

    set((state) => {
      const prevTurn = state.byTurn[turnId] ?? { todos: [] };
      // "reset" clears; "snapshot" replaces; anything else also uses the
      // shipped `allTodos` (with a fallback to the previous list so a stray
      // event without snapshot doesn't blow away the panel).
      let todos: ResearchTodo[];
      if (eventType === "reset") {
        todos = [];
      } else if (allTodos && Array.isArray(allTodos)) {
        todos = allTodos as ResearchTodo[];
      } else if (todo) {
        // Merge single-todo event into existing list.
        const idx = prevTurn.todos.findIndex((t) => t.id === (todo as ResearchTodo).id);
        if (idx >= 0) {
          todos = [...prevTurn.todos];
          if (eventType === "deleted") todos.splice(idx, 1);
          else todos[idx] = todo as ResearchTodo;
        } else if (eventType !== "deleted") {
          todos = [...prevTurn.todos, todo as ResearchTodo];
        } else {
          todos = prevTurn.todos;
        }
      } else {
        todos = prevTurn.todos;
      }
      return {
        byTurn: {
          ...state.byTurn,
          [turnId]: { todos, dismissed: false },
        },
      };
    });
  },

  dismiss: () => {
    const turnId = get().currentTurnId ?? "default";
    set((state) => {
      const prevTurn = state.byTurn[turnId] ?? { todos: [] };
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

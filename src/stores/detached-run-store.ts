"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Live view of one detached sandbox-agent run (per conversation). Mirrors
 *  the durable Dexie `detached_runs` row; the strip UI subscribes to this. */
export interface DetachedRunView {
  runId: string;
  sandboxId: string;
  status: "starting" | "running" | "completed" | "failed" | "stopped" | "synced";
  stage?: string;
  round?: number;
  totalRounds?: number;
  currentTool?: string | null;
  startedAt: number;
  error?: string | null;
}

interface DetachedRunState {
  /** When ON, sending a message hands the turn to the sandbox-resident
   *  headless agent instead of the in-browser loop — press send, close the
   *  app, come back to the finished work. Persisted per browser. */
  detachedMode: boolean;
  setDetachedMode: (enabled: boolean) => void;
  toggleDetachedMode: () => void;
  /** Active/unsynced runs by conversation id. Persisted so a reload or an
   *  app restart still knows a run may be in flight (the strip re-attaches
   *  and the sync-on-return path settles it). */
  runs: Record<string, DetachedRunView>;
  setRun: (conversationId: string, run: DetachedRunView) => void;
  patchRun: (conversationId: string, patch: Partial<DetachedRunView>) => void;
  clearRun: (conversationId: string) => void;
}

/**
 * Detached-run store — the UI-facing half of the "close and resume"
 * architecture. The orchestration loop itself lives INSIDE the E2B sandbox
 * (a detached nohup Python process), so it survives the browser closing;
 * this store only tracks the toggle + the per-conversation run pointer so
 * the strip can poll status and sync results when the user returns.
 *
 * Durable state of record is the Dexie `detached_runs` table; this store is
 * the fast, subscribeable mirror (persisted to localStorage for re-entry).
 */
export const useDetachedRunStore = create<DetachedRunState>()(
  persist(
    (set) => ({
      detachedMode: false,
      setDetachedMode: (enabled) => set({ detachedMode: enabled }),
      toggleDetachedMode: () => set((s) => ({ detachedMode: !s.detachedMode })),
      runs: {},
      setRun: (conversationId, run) =>
        set((s) => ({ runs: { ...s.runs, [conversationId]: run } })),
      patchRun: (conversationId, patch) =>
        set((s) => {
          const cur = s.runs[conversationId];
          if (!cur) return s;
          return { runs: { ...s.runs, [conversationId]: { ...cur, ...patch } } };
        }),
      clearRun: (conversationId) =>
        set((s) => {
          if (!s.runs[conversationId]) return s;
          const runs = { ...s.runs };
          delete runs[conversationId];
          return { runs };
        }),
    }),
    {
      name: "onyx:detached-run-store",
      partialize: (s) => ({ detachedMode: s.detachedMode, runs: s.runs }),
    },
  ),
);

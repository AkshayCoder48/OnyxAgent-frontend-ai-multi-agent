"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { nanoid } from "nanoid";

/**
 * Log store — the in-app replacement for browser devtools.
 *
 * The app runs its whole agent runtime in the browser (backendless), so
 * every LLM/network/runtime failure happens where the user often CANNOT
 * open devtools (installed PWA, mobile WebView, locked-down browser).
 * This store is a capped ring buffer of every error/warning the app
 * produces, persisted to localStorage so the last 300 entries survive a
 * reload — open the Logs panel (chat top bar or the floating bug button)
 * to read them.
 */

export type LogLevel = "error" | "warn" | "info";

export interface LogEntry {
  id: string;
  /** ISO timestamp. */
  timestamp: string;
  level: LogLevel;
  /** Where it came from: "llm" | "agent" | "subagent" | "title" | "chat" |
   *  "provider-test" | "network" | "global" | … */
  source: string;
  /** One-line human summary (already secret-redacted by the logger). */
  message: string;
  /** Full error body / stack / response text (already redacted + truncated). */
  detail?: string;
  /** Structured context chips (provider host, model, HTTP status, …). */
  context?: Record<string, string | number | boolean>;
}

/** Ring-buffer cap — oldest entries are dropped beyond this. */
export const MAX_LOG_ENTRIES = 300;

interface LogState {
  logs: LogEntry[];
  /** Error-level entries added since the user last opened the logs (badge). */
  unseenErrors: number;
  addLog: (entry: Omit<LogEntry, "id" | "timestamp"> & { timestamp?: string }) => void;
  /** Reset the unseen badge (called when a logs surface is opened). */
  markSeen: () => void;
  clear: () => void;
}

export const useLogStore = create<LogState>()(
  persist(
    (set) => ({
      logs: [],
      unseenErrors: 0,
      addLog: (entry) =>
        set((s) => ({
          // Newest-first so the panel can render top-down without sorting.
          logs: [
            { id: nanoid(), timestamp: new Date().toISOString(), ...entry },
            ...s.logs,
          ].slice(0, MAX_LOG_ENTRIES),
          unseenErrors:
            entry.level === "error" ? s.unseenErrors + 1 : s.unseenErrors,
        })),
      markSeen: () => set({ unseenErrors: 0 }),
      clear: () => set({ logs: [], unseenErrors: 0 }),
    }),
    {
      name: "onyx-error-logs",
      storage: createJSONStorage(() => localStorage),
      // Only the entries persist — the unseen badge is per-session.
      partialize: (s) => ({ logs: s.logs.slice(0, MAX_LOG_ENTRIES) }),
    },
  ),
);

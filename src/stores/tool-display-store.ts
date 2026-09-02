"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ToolDisplayMode = "simple" | "technical";

interface ToolDisplayState {
  mode: ToolDisplayMode;
  setMode: (mode: ToolDisplayMode) => void;
}

/**
 * Tool activity display preference — how tool calls render across the chat,
 * the tool timeline, and the timeline dialog:
 *
 *  - "simple"    : plain-language sentences. No tool names, no code, no raw
 *                  arguments or output — for people who don't read code.
 *  - "technical" : full tool cards — tool names, arguments, diffs, raw
 *                  output, and the per-card "view details" toggle.
 *
 * Persisted per browser (localStorage), defaulting to the friendly view so
 * non-coders never meet raw tool calls unless they ask for them.
 */
export const useToolDisplayStore = create<ToolDisplayState>()(
  persist(
    (set) => ({
      mode: "simple",
      setMode: (mode) => set({ mode }),
    }),
    { name: "tool-display-storage" },
  ),
);

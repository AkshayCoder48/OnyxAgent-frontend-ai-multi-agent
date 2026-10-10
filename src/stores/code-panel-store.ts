"use client";

/**
 * OnyxCode panel state — which right-hand Code Mode panel (Database /
 * Preview) is open.
 *
 * Lives in a store (not ChatWorkspace's local state) so surfaces OUTSIDE the
 * workspace can open a panel directly: the tool-result cards ("Open preview
 * panel"), the legacy /code/database and /code/preview routes (now redirects
 * that open the panel), and the chat itself. ChatWorkspace is the only
 * RENDERER — it subscribes here and docks the matching DockedPanel beside
 * the chat, exactly like the Files / Timeline / Subagent panels.
 */

import { create } from "zustand";

export type CodePanelId = "database" | "preview";

interface CodePanelState {
  /** The Code Mode panel that should be docked (null = none). */
  open: CodePanelId | null;
  /** Set the open panel directly (null closes). */
  setOpen: (panel: CodePanelId | null) => void;
  /** Toggle a panel (closing whatever else the dock shows). */
  toggle: (panel: CodePanelId) => void;
}

export const useCodePanelStore = create<CodePanelState>((set, get) => ({
  open: null,
  setOpen: (panel) => set({ open: panel }),
  toggle: (panel) => set({ open: get().open === panel ? null : panel }),
}));

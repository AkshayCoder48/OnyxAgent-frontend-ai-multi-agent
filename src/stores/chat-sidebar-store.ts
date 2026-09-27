"use client";

import { create } from "zustand";

interface ChatSidebarState {
  /** Mobile sheet (below md) open state for the conversation sidebar. */
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  /**
   * Desktop icon-rail collapse state for the conversation sidebar (md+).
   * Lifted out of the component so the workspace layout (ChatPage) can
   * auto-collapse the rail when a right-hand panel needs the space —
   * one source of truth for both the collapse chevron and the layout logic.
   */
  collapsed: boolean;
  collapse: () => void;
  expand: () => void;
  toggleCollapsed: () => void;
}

export const useChatSidebarStore = create<ChatSidebarState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((state) => ({ isOpen: !state.isOpen })),
  collapsed: false,
  collapse: () => set({ collapsed: true }),
  expand: () => set({ collapsed: false }),
  toggleCollapsed: () => set((state) => ({ collapsed: !state.collapsed })),
}));

"use client";

import { create } from "zustand";

interface ChatModeState {
  deepResearch: boolean;
  setDeepResearch: (value: boolean) => void;
  toggleDeepResearch: () => void;
}

// Stub store — deep research / subagents are disabled in this build.
export const useChatModeStore = create<ChatModeState>((set) => ({
  deepResearch: false,
  setDeepResearch: (value) => set({ deepResearch: value }),
  toggleDeepResearch: () => set((s) => ({ deepResearch: !s.deepResearch })),
}));

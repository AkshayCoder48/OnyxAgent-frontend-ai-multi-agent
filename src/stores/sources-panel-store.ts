"use client";

import { create } from "zustand";
import type { SourceItem } from "@/lib/chat-sources";

/**
 * Sources organizer store (Task 24): the fixed sources SIDEBAR is gone —
 * the CitationsFooter under each answer is now the organizer. `open`
 * carries the message's sources array (BY IDENTITY — the footer whose
 * `sources` prop === `store.sources` is the one that expands) plus the
 * cited index to highlight + scroll to.
 */
interface SourcesPanelState {
  isOpen: boolean;
  sources: readonly SourceItem[];
  highlightedIndex: number | null;
  open: (sources: readonly SourceItem[], highlightedIndex?: number | null) => void;
  close: () => void;
}

export const useSourcesPanelStore = create<SourcesPanelState>((set) => ({
  isOpen: false,
  sources: [],
  highlightedIndex: null,
  open: (sources, highlightedIndex = null) => set({ isOpen: true, sources, highlightedIndex }),
  close: () => set({ isOpen: false, highlightedIndex: null }),
}));

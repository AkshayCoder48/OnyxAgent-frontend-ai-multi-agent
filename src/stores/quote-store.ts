"use client";

import { create } from "zustand";

interface QuoteState {
  quote: { text: string } | null;
  setQuote: (text: string) => void;
  clearQuote: () => void;
}

/**
 * Quote reply — the passage currently held for the composer to quote.
 *
 * The runtime selection flow (SelectionToolbar from
 * components/assistant-ui/elements/quote-reply.tsx) drops the user's
 * selected message text here via setQuote; the composer renders it as a
 * ComposerQuotePreview above the input and clears it when the message is
 * sent or the preview is dismissed.
 *
 * Deliberately session-only (not persisted) — a quote is ephemeral by
 * nature and should never survive a reload.
 */
export const useQuoteStore = create<QuoteState>()((set) => ({
  quote: null,
  setQuote: (text) => set({ quote: { text } }),
  clearQuote: () => set({ quote: null }),
}));

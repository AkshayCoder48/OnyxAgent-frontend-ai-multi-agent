"use client";

import { create } from "zustand";
import type { ConversationMessage } from "@/types";

interface ConversationState {
  // UI state only. The conversations LIST is owned by React Query
  // (qk.conversations.list). This store holds the current selection, the
  // loaded messages for that selection, and the fetch/select status.
  currentConversationId: string | null;
  currentMessages: ConversationMessage[];
  isLoading: boolean;
  error: string | null;

  setCurrentConversationId: (id: string | null) => void;
  /** Atomically switch conversation: set the id, clear any stale messages
   *  from the previous conversation, and (optionally) flag loading. Use this
   *  from `selectConversation` so the message array can never leak across
   *  conversations between the id change and the fetch resolving. */
  selectConversation: (id: string | null, opts?: { loading?: boolean }) => void;
  setCurrentMessages: (messages: ConversationMessage[]) => void;
  addMessage: (message: ConversationMessage) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

/**
 * On initial load, hydrate `currentConversationId` from the URL `?id=` param
 * so the sidebar immediately highlights the active chat — even before
 * `fetchConversations()` resolves. Without this, the store starts with
 * `null` and the sidebar shows "no chat selected" during the brief loading
 * window after a page refresh (PRD §24).
 */
function getInitialConversationId(): string | null {
  if (typeof window === "undefined") return null; // SSR safety
  try {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");
    return id || null;
  } catch {
    return null;
  }
}

const initialState = {
  currentConversationId: getInitialConversationId(),
  currentMessages: [] as ConversationMessage[],
  isLoading: false,
  error: null,
};

export const useConversationStore = create<ConversationState>((set) => ({
  ...initialState,

  // Atomically clear `currentMessages` whenever the conversation id changes.
  // Without this, the chat-container useEffect that loads DB messages into
  // the chat store could fire between the id change and the next
  // `setCurrentMessages` call — and find the PREVIOUS conversation's messages
  // still in `currentMessages`, painting them into the new conversation.
  // No-op when the id is unchanged so subscribers don't get a spurious re-render.
  setCurrentConversationId: (id) =>
    set((state) => {
      if (state.currentConversationId === id) return state;
      return { currentConversationId: id, currentMessages: [] };
    }),

  // Atomic select: id + clear messages + (optional) loading flag in one
  // state update. The hook layer (`use-conversations.ts`) calls this and
  // then does the async fetch; the messages array stays `[]` until the
  // fetch resolves, so no stale data can bleed through.
  selectConversation: (id, opts) =>
    set((state) => {
      if (state.currentConversationId === id && opts?.loading === undefined) {
        return state;
      }
      return {
        currentConversationId: id,
        currentMessages: [],
        // Only flip loading when explicitly requested; the caller controls
        // the loading lifecycle (sets true before fetch, false after).
        isLoading: opts?.loading ?? state.isLoading,
        error: null,
      };
    }),

  setCurrentMessages: (messages) => set({ currentMessages: messages }),

  addMessage: (message) =>
    set((state) => ({
      currentMessages: [...(state.currentMessages || []), message],
    })),

  setLoading: (loading) => set({ isLoading: loading }),

  setError: (error) => set({ error }),

  reset: () => set(initialState),
}));

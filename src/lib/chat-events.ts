"use client";

// ============================================================================
// Chat-surface events — tiny generic window-event helpers shared across the
// app (sidebar, projects, approvals, chat hook). Formerly lived in the
// scheduler's chat-sync module; promoted here when the scheduler was removed.
// ============================================================================

/** Window event fired when the conversation list changed OUTSIDE React Query
 *  (a tool created a dedicated chat, or a merge created/updated a
 *  conversation in Dexie). The sidebar listens and refetches the list. */
export const CONVERSATIONS_CHANGED_EVENT = "onyx:conversations-changed";

/** Window event asking the chat surface to OPEN a conversation (tool result
 *  cards' "Open chat" action — the sidebar owns selection). CustomEvent
 *  detail carries the chatId. */
export const OPEN_CONVERSATION_EVENT = "onyx:open-conversation";

/** Best-effort notification that conversations changed outside React Query —
 *  the sidebar refetches the list. */
export function notifyConversationsChanged(): void {
  try {
    window.dispatchEvent(new Event(CONVERSATIONS_CHANGED_EVENT));
  } catch {
    /* best-effort */
  }
}

/** Ask the mounted chat surface to open a conversation (in-page switch — no
 *  route change). Returns false when no listener can act (caller falls back
 *  to router navigation). */
export function openConversation(chatId: string): boolean {
  try {
    window.dispatchEvent(new CustomEvent(OPEN_CONVERSATION_EVENT, { detail: chatId }));
    return true;
  } catch {
    return false;
  }
}

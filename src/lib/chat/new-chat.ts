"use client";

/**
 * THE ONE canonical "New Chat" reset (Global Chat State Isolation PRD §3/§5).
 *
 * Every "New Chat" surface (sidebar button, command palette, project
 * workspaces, the ⌘N shortcut) funnels through THIS function so the reset
 * can never drift between callers again. It performs the FULL reset — the
 * previous chat's identity is detached everywhere, atomically, in one call:
 *
 *   1. the visible thread (global chat store) is cleared;
 *   2. the selection SSOT (conversation store) is reset: id → null,
 *      loaded messages → [], hydrated/branch state → null;
 *   3. the `?id=` URL param is stripped, so a refresh mid-flight lands on
 *      a FRESH /chat instead of the old conversation;
 *   4. the prompt-box todo dock starts EMPTY (PRD §10): the bucket the
 *      fresh state will read ("default") is wiped, so the previous chat's
 *      temporary todos can never bleed into the new chat.
 *
 * What it deliberately does NOT do:
 *   - it never CREATES a conversation — creation stays lazy (first
 *     message), so repeated "New Chat" clicks can never mint ghost or
 *     duplicate conversations;
 *   - it never reuses the previous conversation's identity — the old
 *     "reuse the current conversation when it looks empty" shortcut was
 *     the root cause of the "new chat shows the old title, sends with the
 *     old context, and the message lands in the old chat after refresh"
 *     corruption (the emptiness test could not distinguish "genuinely
 *     empty" from "streamed-into-the-live-store, DB-non-empty");
 *   - it never aborts a running generation — the ExecutionHub keeps
 *     streaming the old conversation's turn in the background and
 *     persists it to ITS conversation (PRD §7).
 */

import { useChatStore } from "@/stores/chat-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useResearchStore } from "@/stores/research-store";
import { setUrlParam } from "@/lib/utils";
import { logChatIntegrity } from "@/lib/chat/integrity";

export function startNewChatSession(): void {
  const previousChatId = useConversationStore.getState().currentConversationId;
  useChatStore.getState().clearMessages();
  useConversationStore.getState().selectConversation(null, { loading: false });
  setUrlParam("id", null);
  // Fresh chat = EMPTY todo dock (PRD §10 — temporary todos never leak).
  useResearchStore.getState().reset();
  logChatIntegrity("new_chat_session", { previousChatId, activeChatId: null });
}

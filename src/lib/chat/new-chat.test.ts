// @vitest-environment jsdom
/**
 * THE canonical New Chat reset — regression suite for the reported bug
 * (Global Chat State Isolation PRD §3/§5/§10/§15):
 *
 *   "one time I tapped it it created a new chat, but again one time I tapped
 *    I was in the same chat, as of the chat name, but the chat was empty.
 *    And when sent message it was using the same context, and after I
 *    refreshed the page that errored chat's message was on the same chat"
 *
 * Root cause under test: the old startNewChat reused the current
 * conversation whenever `currentMessages` looked empty — but that array is
 * empty for EVERY chat the runtime attached mid-first-message, so the
 * "new chat" kept the old conversation's identity (selection, ?id=, DB
 * writes) while showing an empty thread.
 */
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { startNewChatSession } from "./new-chat";
import { useConversationStore } from "@/stores/conversation-store";
import { useChatStore } from "@/stores/chat-store";
import { useResearchStore } from "@/stores/research-store";
import { conversationService } from "@/lib/services";
import type { Todo } from "@/types";

const TODO = (title: string): Todo => ({
  id: `todo_${title}`,
  title,
  status: "not_planned",
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

/** Paint the exact post-first-message state of a runtime-attached chat:
 *  selection = the chat, `currentMessages` EMPTY (the live stream lives in
 *  the execution store), hydrated = the chat. This is the state the old
 *  "reuse the empty conversation" shortcut misread as a fresh chat. */
function seedAttachedChatState(chatId: string) {
  const store = useConversationStore.getState();
  store.setCurrentConversationId(chatId);
  useConversationStore.setState({
    currentMessages: [], // ← the trap: empty array, NON-empty conversation
    hydratedConversationId: chatId,
    activeLeafId: null,
  });
  useChatStore.getState().replaceAllMessages([
    {
      id: "m1",
      role: "user",
      content: "hello from chat A",
      timestamp: new Date(),
      conversationId: chatId,
    },
  ]);
}

describe("startNewChatSession (the canonical New Chat reset)", () => {
  beforeEach(() => {
    useConversationStore.setState({
      currentConversationId: null,
      currentMessages: [],
      hydratedConversationId: null,
      activeLeafId: null,
      isLoading: false,
      error: null,
    });
    useChatStore.getState().clearMessages();
    useResearchStore.setState({ byTurn: {}, currentTurnId: null });
  });

  it("detaches the previous conversation completely (id, messages, hydration)", () => {
    seedAttachedChatState("chat_A");
    startNewChatSession();
    const s = useConversationStore.getState();
    expect(s.currentConversationId).toBeNull();
    expect(s.hydratedConversationId).toBeNull();
    expect(s.currentMessages).toEqual([]);
  });

  it("REGRESSION: never reuses the previous conversation when its message array looks empty", () => {
    // The exact reported scenario: the runtime attached chat A
    // mid-first-message (currentMessages === []), then the user hits New
    // Chat. The OLD code early-returned and kept chat A selected.
    seedAttachedChatState("chat_A");
    startNewChatSession();
    expect(useConversationStore.getState().currentConversationId).toBeNull();
  });

  it("clears the visible thread (global chat store)", () => {
    seedAttachedChatState("chat_A");
    startNewChatSession();
    expect(useChatStore.getState().messages).toEqual([]);
  });

  it("strips the ?id= URL param so a refresh lands on a fresh /chat", () => {
    const url = new URL(window.location.href);
    url.searchParams.set("id", "chat_A");
    window.history.replaceState({}, "", url.toString());
    startNewChatSession();
    expect(new URL(window.location.href).searchParams.get("id")).toBeNull();
  });

  it("wipes the prompt-box todo dock — temporary todos never leak into the new chat", () => {
    seedAttachedChatState("chat_A");
    useResearchStore.getState().setCurrentTurnId("chat_A");
    useResearchStore.getState().setAgentTodos("chat_A", [TODO("stale-from-chat-A")]);
    startNewChatSession();
    // The currently-visible bucket is wiped by the reset itself…
    expect(useResearchStore.getState().byTurn["chat_A"]).toBeUndefined();
    // …and the fresh state's dock reads the "default" bucket, which the
    // useChat effect wipes on entry (simulated here as the same reset).
    useResearchStore.getState().reset();
    expect(useResearchStore.getState().byTurn["default"]).toBeUndefined();
  });

  it("never creates a conversation — 10 consecutive resets mint ZERO ghost chats", async () => {
    seedAttachedChatState("chat_A");
    for (let i = 0; i < 10; i += 1) {
      startNewChatSession();
    }
    const all = await conversationService.list("user_1");
    expect(all.length).toBe(0);
  });

  it("is idempotent from the fresh state (double-tap New Chat is safe)", () => {
    startNewChatSession();
    startNewChatSession();
    const s = useConversationStore.getState();
    expect(s.currentConversationId).toBeNull();
    expect(s.currentMessages).toEqual([]);
  });
});

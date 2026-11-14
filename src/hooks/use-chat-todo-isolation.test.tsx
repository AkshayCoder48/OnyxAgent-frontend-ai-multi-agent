// @vitest-environment jsdom
/**
 * PRD §10/§13 — prompt-box todo dock isolation through the real useChat
 * hook: entering ANY conversation state (switch A → B, open a chat, start a
 * new chat) starts with an EMPTY dock, and stale todos from a previous
 * session are NEVER rehydrated into the panel.
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";
import { useChat } from "./use-chat";
import { useConversationStore } from "@/stores/conversation-store";
import { useResearchStore } from "@/stores/research-store";
import { persistTodos } from "@/lib/tools/todos";
import type { Todo } from "@/types";

const TODO = (title: string): Todo => ({
  id: `todo_${title}`,
  title,
  status: "not_planned",
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

function selectConversation(id: string | null) {
  act(() => {
    useConversationStore.getState().selectConversation(id);
  });
}

describe("useChat — prompt-box todo dock isolation (PRD §10)", () => {
  beforeEach(() => {
    useConversationStore.setState({
      currentConversationId: null,
      currentMessages: [],
      hydratedConversationId: null,
      activeLeafId: null,
      isLoading: false,
      error: null,
    });
    useResearchStore.setState({ byTurn: {}, currentTurnId: null });
  });

  it("entering a chat wipes ITS live bucket — no cross-chat todos in the dock", () => {
    useResearchStore.getState().setAgentTodos("chat_A", [TODO("stale-A")]);
    useResearchStore.getState().setAgentTodos("chat_B", [TODO("stale-B")]);
    const { rerender } = renderHook(() => useChat());

    // Mount while viewing chat A → the dock reads byTurn[chat_A] … EMPTY.
    selectConversation("chat_A");
    rerender();
    expect(useResearchStore.getState().byTurn["chat_A"]?.agentTodos ?? []).toEqual([]);

    // Switch to B → B's bucket is wiped on entry; A's leftovers stay out
    // of the dock (the dock keys on the ACTIVE turn only).
    selectConversation("chat_B");
    rerender();
    expect(useResearchStore.getState().byTurn["chat_B"]?.agentTodos ?? []).toEqual([]);
    expect(useResearchStore.getState().currentTurnId).toBe("chat_B");
  });

  it("starting a new chat leaves the dock EMPTY (byTurn.default is wiped)", () => {
    useResearchStore.getState().setAgentTodos("default", [TODO("leftover-new-chat")]);
    const { rerender } = renderHook(() => useChat());
    selectConversation(null);
    rerender();
    expect(useResearchStore.getState().currentTurnId).toBeNull();
    expect(useResearchStore.getState().byTurn["default"]?.agentTodos ?? []).toEqual([]);
  });

  it("returning to a chat does NOT rehydrate stale todos from its previous session", async () => {
    // A previous session persisted todos for chat A (Dexie)…
    await persistTodos("chat_A", [TODO("from-previous-session")]);
    const { rerender } = renderHook(() => useChat());

    selectConversation("chat_A");
    rerender();
    // …but the prompt-box dock is live-only: entering A must NOT repaint
    // them (they stay available to the model's own manage_todo rounds).
    expect(useResearchStore.getState().byTurn["chat_A"]?.agentTodos ?? []).toEqual([]);
  });

  it("live events still populate the dock for the ACTIVE conversation", () => {
    const { rerender } = renderHook(() => useChat());
    selectConversation("chat_A");
    rerender();
    act(() => {
      useResearchStore.getState().setAgentTodos("chat_A", [TODO("live-A")]);
    });
    const bucket = useResearchStore.getState().byTurn["chat_A"]?.agentTodos ?? [];
    expect(bucket).toEqual([expect.objectContaining({ title: "live-A" })]);
  });
});

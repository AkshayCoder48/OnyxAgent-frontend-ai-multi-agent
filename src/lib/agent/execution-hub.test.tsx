// @vitest-environment jsdom
/**
 * The merged message view's EMPTY-STORE FALLBACK: a reattached execution
 * starts with an empty store (it only fills through the SSE replay). While
 * it is still empty — the bridge cold-starting or unreachable on a
 * serverless deployment — the view must render the DB-painted GLOBAL
 * messages (the checkpointed partial), never a blank conversation. Once the
 * replay fills the execution store, the view switches to it.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executionHub, useExecutionMessages } from "./execution-hub";
import { useChatStore } from "@/stores/chat-store";
import type { ChatMessage } from "@/types";

const globalMsg = (id: string, content: string): ChatMessage =>
  ({
    id,
    role: "user",
    content,
    createdAt: Date.now().toString(),
  }) as unknown as ChatMessage;

const execMsg = (id: string, content: string): ChatMessage =>
  ({
    id,
    role: "assistant",
    content,
    parts: [{ id: `${id}_p1`, type: "text", content }],
    createdAt: Date.now().toString(),
  }) as unknown as ChatMessage;

function setGlobalMessages(msgs: ChatMessage[]) {
  act(() => {
    useChatStore.setState({ messages: msgs });
  });
}

let createdIds: string[] = [];

beforeEach(() => {
  createdIds.forEach((id) => executionHub.finishExecution(id, "completed"));
  createdIds = [];
  setGlobalMessages([]);
});

afterEach(() => {
  createdIds.forEach((id) => executionHub.finishExecution(id, "completed"));
  setGlobalMessages([]);
});

describe("useExecutionMessages — empty-store fallback", () => {
  it("renders the GLOBAL view while a registered execution's store is still empty", () => {
    setGlobalMessages([globalMsg("g1", "checkpointed partial from Dexie")]);
    let execId: string | null = null;
    act(() => {
      const execution = executionHub.createExecution({
        conversationId: "conv_1",
        mode: "background",
        trigger: "resume",
      });
      execId = execution.id;
      createdIds.push(execution.id);
    });

    const { result } = renderHook(() => useExecutionMessages(execId));
    // The reattach execution store is empty → the DB-painted partial shows.
    expect(result.current.map((m) => m.id)).toEqual(["g1"]);
  });

  it("switches to the EXECUTION view once the replay fills its store", () => {
    setGlobalMessages([globalMsg("g1", "checkpointed partial from Dexie")]);
    let execId: string | null = null;
    act(() => {
      const execution = executionHub.createExecution({
        conversationId: "conv_1",
        mode: "background",
        trigger: "resume",
      });
      execId = execution.id;
      createdIds.push(execution.id);
      execution.store.getState().addMessage?.(execMsg("e1", "replayed live content"));
    });

    const { result } = renderHook(() => useExecutionMessages(execId));
    expect(result.current.map((m) => m.id)).toEqual(["e1"]);
  });

  it("renders the GLOBAL view when no execution is registered", () => {
    setGlobalMessages([globalMsg("g1", "plain history view")]);
    const { result } = renderHook(() => useExecutionMessages(null));
    expect(result.current.map((m) => m.id)).toEqual(["g1"]);
  });
});

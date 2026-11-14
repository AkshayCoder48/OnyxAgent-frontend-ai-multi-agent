/**
 * PRD §6/§14 — the message-ownership gate: every subsystem involved
 * in a send must agree on ONE conversation id, and a disagreement blocks
 * the submission instead of "recovering" by picking one of them.
 * Also pins the dev-time integrity-trace behavior (no conversation
 * content is ever logged — ids and counts only).
 */
import { describe, expect, it, vi } from "vitest";
import { logChatIntegrity, messageOwnershipVerified } from "./integrity";

describe("messageOwnershipVerified (PRD §6 conceptual check)", () => {
  it("accepts when every subsystem agrees on the same non-null id", () => {
    expect(
      messageOwnershipVerified({
        activeChatId: "chat_B",
        composerChatId: "chat_B",
        contextChatId: "chat_B",
      }),
    ).toBe(true);
  });

  it("rejects a stale composer (render-scope) identity", () => {
    // The user switched chats between the render that captured this
    // send and the fresh one — the message must NOT silently ship into
    // the newly selected chat.
    expect(
      messageOwnershipVerified({
        activeChatId: "chat_B",
        composerChatId: "chat_A",
        contextChatId: "chat_B",
      }),
    ).toBe(false);
  });

  it("rejects a null active id (the new-chat case is not valid ownership)", () => {
    expect(
      messageOwnershipVerified({
        activeChatId: null,
        composerChatId: null,
        contextChatId: null,
      }),
    ).toBe(false);
  });

  it("rejects a disagreement between ANY pair of ids", () => {
    expect(
      messageOwnershipVerified({
        activeChatId: "chat_B",
        composerChatId: "chat_B",
        contextChatId: "chat_A",
      }),
    ).toBe(false);
    expect(
      messageOwnershipVerified({
        activeChatId: "chat_A",
        composerChatId: "chat_B",
        contextChatId: "chat_A",
      }),
    ).toBe(false);
  });

  it("blocks a stale new-chat view (composer null, selection set)", () => {
    expect(
      messageOwnershipVerified({
        activeChatId: "chat_B",
        composerChatId: null,
        contextChatId: "chat_B",
      }),
    ).toBe(false);
  });
});

describe("logChatIntegrity (PRD §14 dev-time trace)", () => {
  it("logs ids and counts — never conversation content", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    logChatIntegrity("message_submitted", { activeChatId: "chat_B", count: 1 });
    expect(spy).toHaveBeenCalledWith("[chat-integrity] message_submitted", {
      activeChatId: "chat_B",
      count: 1,
    });
    spy.mockRestore();
  });
});

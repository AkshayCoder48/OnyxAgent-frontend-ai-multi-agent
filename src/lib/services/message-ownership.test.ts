/**
 * PRD §8/§15 — persistence integrity: every message write must land under
 * an EXISTING conversation, and the create path must mint unique
 * conversations (the "10 consecutive chats → 10 unique conversations"
 * stress row).
 *
 * Runs against fake-indexeddb with the REAL service modules — only the
 * IndexedDB engine is faked (same pattern as projects/service.test.ts).
 */
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { conversationService } from "@/lib/services";

const USER = "user_1";

async function messageCountFor(conversationId: string): Promise<number> {
  return db.messages.where("conversation_id").equals(conversationId).count();
}

describe("message persistence ownership (PRD §8)", () => {
  beforeEach(async () => {
    await db.conversations.clear();
    await db.messages.clear();
    await db.tool_calls.clear();
  });

  it("persists a message under an existing conversation", async () => {
    const conv = await conversationService.create(USER, "Chat A");
    await conversationService.addMessage(conv.id, USER, {
      role: "user",
      content: "hello",
    });
    expect(await messageCountFor(conv.id)).toBe(1);
  });

  it("REFUSES a write to a nonexistent conversation — no orphan rows (PRD §8)", async () => {
    await expect(
      conversationService.addMessage("ghost_chat", USER, {
        role: "user",
        content: "where does this land?",
      }),
    ).rejects.toThrow(/integrity guard/);
    // Nothing was half-persisted.
    expect(await db.messages.count()).toBe(0);
  });

  it("REFUSES an agent checkpoint for a nonexistent conversation", async () => {
    await expect(
      conversationService.saveAgentCheckpoint("ghost_chat", USER, "msg_1", {
        content: "partial stream",
      }),
    ).rejects.toThrow(/integrity guard/);
    expect(await db.messages.count()).toBe(0);
  });

  it("never assigns one conversation's messages to another (ownership is per-write)", async () => {
    const a = await conversationService.create(USER, "Chat A");
    const b = await conversationService.create(USER, "Chat B");
    await conversationService.addMessage(a.id, USER, { role: "user", content: "for A" });
    await conversationService.addMessage(b.id, USER, { role: "user", content: "for B" });
    expect(await messageCountFor(a.id)).toBe(1);
    expect(await messageCountFor(b.id)).toBe(1);
  });

  it("STRESS: 10 consecutive chats → 10 unique conversations (PRD §15)", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10; i += 1) {
      const conv = await conversationService.create(USER, `Chat ${i}`);
      ids.add(conv.id);
      await conversationService.addMessage(conv.id, USER, {
        role: "user",
        content: `message ${i}`,
      });
    }
    expect(ids.size).toBe(10);
    for (const id of ids) {
      expect(await messageCountFor(id)).toBe(1);
    }
  });
});

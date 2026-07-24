"use client";

import { registerTool } from "./registry";
import { db } from "@/lib/db";

/**
 * list_chats + read_chat — let the agent recall past conversations.
 *
 * Mirrors the original Python `list_chats(limit=20)` and
 * `read_chat(conversation_id)` workspace tools. Queries Dexie directly — no
 * server round-trip.
 */

registerTool(
  "list_chats",
  "List the user's recent conversations (id + title + last message time). Useful when the user asks 'what did we talk about earlier' or refers to a previous chat.",
  {
    type: "object",
    properties: {
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        default: 20,
      },
    },
    additionalProperties: false,
  },
  async (args, ctx) => {
    const limit = Math.min((args.limit as number) ?? 20, 100);
    const conversations = await db.conversations
      .where("user_id")
      .equals(ctx.userId)
      .reverse()
      .sortBy("updated_at");
    const items = conversations.slice(0, limit).map((c) => ({
      id: c.id,
      title: c.title ?? "(untitled)",
      updated_at: c.updated_at,
      is_archived: c.is_archived,
    }));
    return { items, total: conversations.length };
  },
  false,
  "memory",
);

registerTool(
  "read_chat",
  "Read the full message transcript of a past conversation by id. Returns an array of `{ role, content, created_at, tool_calls? }`. Use `list_chats` first to find the id.",
  {
    type: "object",
    properties: {
      conversation_id: { type: "string" },
    },
    required: ["conversation_id"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const conversationId = args.conversation_id as string;
    if (!conversationId) {
      return { error: "conversation_id is required" };
    }
    // Ownership check — agent should only read the user's own chats.
    const conv = await db.conversations.get(conversationId);
    if (!conv) {
      return { error: `Conversation not found: ${conversationId}` };
    }
    if (conv.user_id !== ctx.userId) {
      return { error: "Conversation not found" }; // don't leak existence
    }
    const messages = await db.messages
      .where("conversation_id")
      .equals(conversationId)
      .sortBy("created_at");
    return {
      id: conversationId,
      title: conv.title ?? "(untitled)",
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        created_at: m.created_at,
        tool_calls: m.tool_calls,
      })),
    };
  },
  false,
  "memory",
);

"use client";

// Past-conversation recall — ONE multi-function tool.
//
// MERGE NOTE (tool-count cap): the two former chat tools
// (list_chats / read_chat) were merged into this single `manage_chats` tool
// with an `action` parameter. Each action preserves the EXACT result shape of
// the tool it replaced.
//
// Mirrors the original Python `list_chats(limit=20)` and
// `read_chat(conversation_id)` workspace tools. Queries Dexie directly — no
// server round-trip.

import { registerTool } from "./registry";
import { db } from "@/lib/db";

const MANAGE_CHATS_DESCRIPTION = `Recall the user's past conversations — one tool for both operations. Pass \`action\` plus the fields that action needs:

- action "list": list the user's recent conversations (id + title + last message time). Useful when the user asks 'what did we talk about earlier' or refers to a previous chat. Optional \`limit\` (1-100, default 20).
- action "read": read the full message transcript of a past conversation. Requires \`conversation_id\` — use action "list" first to find it.`;

registerTool(
  "manage_chats",
  MANAGE_CHATS_DESCRIPTION,
  {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "read"],
        description: "Which operation to perform.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        default: 20,
        description: "Max conversations to return (action 'list').",
      },
      conversation_id: {
        type: "string",
        description: "The conversation id to read (action 'read').",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const action = String(args.action ?? "");

    // ---- action: list (was list_chats) ----
    if (action === "list") {
      const limit = Math.min((args.limit as number) ?? 20, 100);
      // CHAT MODE ISOLATION (Runtime PRD §60/§62): the agent in Agent mode
      // lists ONLY agent chats; a Code-mode agent lists ONLY code chats.
      // The tool's own conversation decides the mode (persisted with the
      // chat, §63 — never the route).
      const ownConv = ctx.conversationId
        ? await db.conversations.get(ctx.conversationId)
        : undefined;
      const listMode = ownConv?.mode === "code" ? "code" : "agent";
      const conversations = await db.conversations
        .where("user_id")
        .equals(ctx.userId)
        .reverse()
        .sortBy("updated_at");
      const sameMode = conversations.filter((c) =>
        listMode === "code" ? c.mode === "code" : c.mode !== "code",
      );
      const items = sameMode.slice(0, limit).map((c) => ({
        id: c.id,
        title: c.title ?? "(untitled)",
        updated_at: c.updated_at,
        is_archived: c.is_archived,
      }));
      return { items, total: sameMode.length };
    }

    // ---- action: read (was read_chat) ----
    if (action === "read") {
      const conversationId = args.conversation_id as string | undefined;
      if (!conversationId) {
        return { error: "conversation_id is required for action 'read'" };
      }
      // Ownership check — agent should only read the user's own chats.
      const conv = await db.conversations.get(conversationId);
      if (!conv) {
        return { error: `Conversation not found: ${conversationId}` };
      }
      if (conv.user_id !== ctx.userId) {
        return { error: "Conversation not found" }; // don't leak existence
      }
      // CROSS-MODE READ GUARD (Runtime PRD §60/§62): an Agent-mode agent can
      // never read a Code chat (and vice versa) — same "not found" answer as
      // a foreign chat so mode boundaries don't leak either.
      const ownConv = ctx.conversationId
        ? await db.conversations.get(ctx.conversationId)
        : undefined;
      const readerMode = ownConv?.mode === "code" ? "code" : "agent";
      const targetMode = conv.mode === "code" ? "code" : "agent";
      if (readerMode !== targetMode) {
        return { error: "Conversation not found" };
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
    }

    return { error: `Unknown action: ${action}` };
  },
  false,
  "memory",
);

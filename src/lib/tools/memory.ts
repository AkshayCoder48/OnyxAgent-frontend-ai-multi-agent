"use client";

import { registerTool } from "./registry";
import * as opfs from "@/lib/storage/opfs";
import { nanoid } from "nanoid";

/**
 * Memory tool — long-term memory for the AI agent.
 * The AI can save and retrieve information across conversations.
 * Memory is stored in OPFS at users/<userId>/memory/.
 *
 * Two tools:
 * - memory_save: Save a memory entry (text + metadata)
 * - memory_search: Search memories by keyword (simple text search)
 * - memory_list: List all memories
 */

registerTool(
  "memory_save",
  "Save information to long-term memory. Use this to remember user preferences, important facts, decisions, or context that should persist across conversations. Memories are stored locally and can be searched later.",
  {
    type: "object",
    properties: {
      content: { type: "string", description: "The information to remember" },
      category: { type: "string", description: "Category tag (e.g. 'preference', 'fact', 'decision', 'context')" },
      tags: { type: "array", items: { type: "string" }, description: "Optional tags for easier retrieval" },
    },
    required: ["content"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    try {
      const memoryDir = `users/${ctx.userId}/memory`;
      await opfs.ensurePath(ctx.userId, "memory");
      const id = nanoid();
      const entry = {
        id,
        content: args.content,
        category: args.category || "general",
        tags: args.tags || [],
        created_at: new Date().toISOString(),
      };
      await opfs.writeFileAtPath(memoryDir, `${id}.json`, JSON.stringify(entry, null, 2));
      return { id, message: "Memory saved", entry };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  },
  false,
  "memory",
);

registerTool(
  "memory_search",
  "Search the agent's long-term memory for previously saved information. Use this to recall user preferences, past decisions, or context from previous conversations. Searches by keyword in content, category, and tags.",
  {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query (keywords to search for)" },
      category: { type: "string", description: "Filter by category (optional)" },
      limit: { type: "number", description: "Max results (default 10)" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    try {
      const query = (args.query as string).toLowerCase();
      const limit = (args.limit as number) ?? 10;
      const category = args.category as string | undefined;

      const dir = await opfs.ensurePath(ctx.userId, "memory");
      const walked = await opfs.walkFiles(dir);
      const results: Array<Record<string, unknown>> = [];

      for (const f of walked) {
        try {
          const file = await f.handle.getFile();
          const content = await file.text();
          const entry = JSON.parse(content);

          // Filter by category if specified
          if (category && entry.category !== category) continue;

          // Simple text search in content + tags
          const searchText = (
            entry.content + " " +
            (entry.tags || []).join(" ") + " " +
            (entry.category || "")
          ).toLowerCase();

          if (searchText.includes(query)) {
            results.push(entry);
            if (results.length >= limit) break;
          }
        } catch {}
      }

      return { results, count: results.length, query };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  },
  false,
  "memory",
);

registerTool(
  "memory_list",
  "List all saved memories. Returns a summary of each memory entry (id, category, content preview, date). Useful for reviewing what the agent remembers.",
  {
    type: "object",
    properties: {
      category: { type: "string", description: "Filter by category (optional)" },
      limit: { type: "number", description: "Max results (default 50)" },
    },
    additionalProperties: false,
  },
  async (args, ctx) => {
    try {
      const limit = (args.limit as number) ?? 50;
      const category = args.category as string | undefined;

      const dir = await opfs.ensurePath(ctx.userId, "memory");
      const walked = await opfs.walkFiles(dir);
      const results: Array<Record<string, unknown>> = [];

      for (const f of walked) {
        try {
          const file = await f.handle.getFile();
          const content = await file.text();
          const entry = JSON.parse(content);

          if (category && entry.category !== category) continue;

          results.push({
            id: entry.id,
            category: entry.category,
            content_preview: (entry.content || "").slice(0, 100),
            tags: entry.tags || [],
            created_at: entry.created_at,
          });
          if (results.length >= limit) break;
        } catch {}
      }

      return { memories: results, count: results.length };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  },
  false,
  "memory",
);

registerTool(
  "memory_delete",
  "Delete a memory entry by ID. Use when the user asks to forget something or when a memory is no longer relevant.",
  {
    type: "object",
    properties: {
      id: { type: "string", description: "Memory entry ID to delete" },
    },
    required: ["id"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    try {
      const { deleteFile } = await import("@/lib/storage/opfs");
      await deleteFile(`users/${ctx.userId}/memory/${args.id}.json`);
      return { id: args.id, message: "Memory deleted" };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  },
  false,
  "memory",
);

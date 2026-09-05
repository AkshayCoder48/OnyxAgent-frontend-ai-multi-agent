"use client";

// Memory tool — ONE multi-function tool for long-term memory.
//
// MERGE NOTE (tool-count cap): the four former memory tools
// (memory_save / memory_search / memory_list / memory_delete) were merged
// into this single `manage_memory` tool with an `action` parameter. Each
// action preserves the EXACT result shape of the tool it replaced — the
// chat UI's memory-chip renderer is shape-driven, so chips keep working.
//
// Memory is stored in OPFS at users/<userId>/memory/.

import { registerTool } from "./registry";
import * as opfs from "@/lib/storage/opfs";
import { nanoid } from "nanoid";

const MANAGE_MEMORY_DESCRIPTION = `Manage the agent's long-term memory — one tool for every memory operation. Memories persist across conversations and are stored locally. Pass \`action\` plus the fields that action needs:

- action "save": save information to long-term memory (user preferences, important facts, decisions, context). Requires \`content\`; optional \`category\` (e.g. 'preference', 'fact', 'decision', 'context') and \`tags\` (array of strings).
- action "search": search previously saved memories by keyword (matches content, category, and tags). Requires \`query\`; optional \`category\` filter and \`limit\` (default 10).
- action "list": list all saved memories as summaries (id, category, content preview, date). Optional \`category\` filter and \`limit\` (default 50).
- action "delete": delete a memory entry by id. Requires \`id\`.`;

registerTool(
  "manage_memory",
  MANAGE_MEMORY_DESCRIPTION,
  {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["save", "search", "list", "delete"],
        description: "Which memory operation to perform.",
      },
      content: { type: "string", description: "The information to remember (action 'save')." },
      category: { type: "string", description: "Category tag — e.g. 'preference', 'fact', 'decision', 'context' (save, or filter for search/list)." },
      tags: { type: "array", items: { type: "string" }, description: "Optional tags for easier retrieval (save)." },
      query: { type: "string", description: "Search keywords (action 'search')." },
      limit: { type: "number", description: "Max results (search: default 10, list: default 50)." },
      id: { type: "string", description: "Memory entry id to delete (action 'delete')." },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const action = String(args.action ?? "");
    const category = args.category as string | undefined;

    // ---- action: save (was memory_save) ----
    if (action === "save") {
      if (!args.content) return { error: "content is required for action 'save'" };
      try {
        const memoryDir = `users/${ctx.userId}/memory`;
        await opfs.ensurePath(ctx.userId, "memory");
        const id = nanoid();
        const entry = {
          id,
          content: args.content,
          category: category || "general",
          tags: args.tags || [],
          created_at: new Date().toISOString(),
        };
        await opfs.writeFileAtPath(memoryDir, `${id}.json`, JSON.stringify(entry, null, 2));
        return { id, message: "Memory saved", entry };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    }

    // ---- action: search (was memory_search) ----
    if (action === "search") {
      if (!args.query) return { error: "query is required for action 'search'" };
      try {
        const query = (args.query as string).toLowerCase();
        const limit = (args.limit as number) ?? 10;

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

        return { results, count: results.length, query: args.query };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    }

    // ---- action: list (was memory_list) ----
    if (action === "list") {
      try {
        const limit = (args.limit as number) ?? 50;

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
    }

    // ---- action: delete (was memory_delete) ----
    if (action === "delete") {
      if (!args.id) return { error: "id is required for action 'delete'" };
      try {
        const { deleteFile } = await import("@/lib/storage/opfs");
        await deleteFile(`users/${ctx.userId}/memory/${args.id}.json`);
        return { id: args.id, message: "Memory deleted" };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    }

    return { error: `Unknown action: ${action}` };
  },
  false,
  "memory",
);

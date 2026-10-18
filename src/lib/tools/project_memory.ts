"use client";

// Project memory tool (Task 2-d / PRD §7.2) — the agent's read/write surface
// for a PROJECT's structured memory (Dexie `project_memories`, Task 1-a's
// service). Scoped STRICTLY to the CURRENT conversation's project:
//
//   - the conversation → project lookup mirrors how context-aware tools
//     resolve their scope (local_chats.ts reads ctx.conversationId from
//     Dexie the same way);
//   - a general chat (no project) gets an honest error — the tool is not a
//     global memory (manage_memory covers that) but a PROJECT's memory;
//   - every memory_id operation verifies the item belongs to the CURRENT
//     project, so one project can never read or mutate another's memory.
//
// `save` additionally respects the project's memory_settings:
//   - automatic_updates must be enabled (the user's opt-out is honored);
//   - content is capped at 2000 chars;
//   - dedupe/supersede is 1-a's saveMemory (>0.9 similarity supersedes,
//     provenance unioned) — near-duplicates never pile up.

import { registerTool } from "./registry";
import { db } from "@/lib/db";
import { getProject } from "@/lib/projects/service";
import {
  deleteMemory,
  listMemories,
  pinMemory,
  saveMemory,
  updateMemory,
  type SaveMemoryResult,
} from "@/lib/projects/memory";
import type { Project, ProjectMemoryCategory, ProjectMemoryItem } from "@/types";

const MAX_CONTENT_CHARS = 2000;

const MEMORY_CATEGORIES: ProjectMemoryCategory[] = [
  "overview",
  "decision",
  "preference",
  "constraint",
  "task",
  "reference",
  "bug",
  "file_ref",
];

const PROJECT_MEMORY_DESCRIPTION = `Manage THIS project's memory — durable facts shared across all of the project's chats (conversations). Memory plus cross-chat retrieval inform every future chat in this project, so save things worth remembering and cite sources when you use remembered context. Pass \`action\` plus the fields it needs:

- action "save": persist a durable project fact. Requires \`category\` (${MEMORY_CATEGORIES.join(", ")}) and \`content\` (max 2000 chars); optional \`source_note\` provenance. Save: architectural decisions, user-approved preferences, important constraints, known bugs, file/directory references, implementation status. Do NOT save transient chatter or unverified guesses.
- action "list": list the project's memories (id, category, content, pinned). Optional \`category\` filter.
- action "update": replace a memory's content. Requires \`memory_id\` + \`content\`.
- action "delete": remove a memory. Requires \`memory_id\`.
- action "pin": pin/unpin a memory — pinned items are ALWAYS included in the project context. Requires \`memory_id\` + \`pinned\` (boolean).`;

/** Summary shape shared by every successful action result. */
function summarize(item: ProjectMemoryItem) {
  return {
    id: item.id,
    category: item.category,
    content: item.content,
    pinned: item.pinned ?? false,
    updated_at: item.updated_at,
  };
}

function describeSave(result: SaveMemoryResult) {
  return {
    ...summarize(result.item),
    superseded_id: result.superseded?.id ?? null,
  };
}

/** Resolve the CURRENT conversation's project (or null for general chats,
 * unknown conversations, and subagent session ids — those resolve to no
 * conversation row, which is the honest "no project" answer). */
async function currentProject(
  conversationId: string | undefined,
): Promise<Project | null> {
  if (!conversationId) return null;
  const conv = await db.conversations.get(conversationId).catch(() => null);
  if (!conv?.project_id) return null;
  return getProject(conv.project_id).catch(() => null);
}

registerTool(
  "project_memory",
  PROJECT_MEMORY_DESCRIPTION,
  {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["save", "list", "update", "delete", "pin"],
        description: "Which memory operation to perform.",
      },
      category: {
        type: "string",
        enum: MEMORY_CATEGORIES,
        description: "Memory category (action 'save'; optional filter for 'list').",
      },
      content: {
        type: "string",
        description: "The fact to remember (actions 'save'/'update'; max 2000 chars).",
      },
      source_note: {
        type: "string",
        description: "Optional provenance note, e.g. who decided this and where (action 'save').",
      },
      memory_id: {
        type: "string",
        description: "The memory item id (actions 'update'/'delete'/'pin').",
      },
      pinned: {
        type: "boolean",
        description: "Pin state (action 'pin').",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const action = String(args.action ?? "");

    // Scope resolution — EVERY action needs the conversation's project.
    let project: Project | null = null;
    try {
      project = await currentProject(ctx.conversationId);
    } catch {
      project = null;
    }
    if (!project) {
      return {
        error:
          "project_memory only works inside a project — this conversation is not part of one. " +
          "For personal cross-chat memory use manage_memory instead.",
      };
    }

    // ---- action: save ----
    if (action === "save") {
      const category = args.category as ProjectMemoryCategory | undefined;
      if (!category || !MEMORY_CATEGORIES.includes(category)) {
        return { error: `category is required for action 'save' (one of: ${MEMORY_CATEGORIES.join(", ")})` };
      }
      const content = typeof args.content === "string" ? args.content.trim() : "";
      if (!content) return { error: "content is required for action 'save'" };
      if (content.length > MAX_CONTENT_CHARS) {
        return {
          error: `content too long (${content.length} chars) — the maximum is ${MAX_CONTENT_CHARS}. Save a compact statement of the fact instead of a transcript.`,
        };
      }
      if (project.memory_settings?.automatic_updates === false) {
        return {
          error:
            "This project has automatic memory updates disabled — the user opted out of agent-written memories. Mention the fact in your reply instead and suggest enabling automatic updates in the project settings if they want it remembered.",
        };
      }
      try {
        // Provenance: the source conversation rides on the row (1-a's
        // model); a caller-provided source_note is appended to the content
        // in brackets so it survives the item verbatim.
        const sourceNote =
          typeof args.source_note === "string" && args.source_note.trim()
            ? args.source_note.trim().slice(0, 200)
            : null;
        const result = await saveMemory(project.id, {
          category,
          content: sourceNote ? `${content} [source: ${sourceNote}]` : content,
          source_conversation_ids: ctx.conversationId ? [ctx.conversationId] : [],
        });
        return {
          ok: true,
          message: result.superseded
            ? "Memory saved (it superseded a near-duplicate older item)"
            : "Memory saved",
          memory: describeSave(result),
        };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    }

    // ---- action: list ----
    if (action === "list") {
      try {
        const filterCategory = args.category as ProjectMemoryCategory | undefined;
        const items = await listMemories(project.id);
        const filtered = filterCategory ? items.filter((m) => m.category === filterCategory) : items;
        return {
          project_id: project.id,
          total: filtered.length,
          items: filtered.map(summarize),
        };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    }

    // The remaining actions all target one memory_id — resolve it ONCE with
    // the strict same-project check.
    const memoryId = typeof args.memory_id === "string" ? args.memory_id : "";
    if (!memoryId) {
      return { error: `memory_id is required for action '${action}'` };
    }
    let target: ProjectMemoryItem | null = null;
    try {
      const row = await db.project_memories.get(memoryId);
      // Strict scoping: a memory of ANOTHER project (or a foreign id) is
      // "not found" from this conversation's point of view.
      target = row && row.project_id === project.id ? row : null;
    } catch {
      target = null;
    }
    if (!target) {
      return { error: `No such memory in this project: ${memoryId}` };
    }

    // ---- action: update ----
    if (action === "update") {
      const content = typeof args.content === "string" ? args.content.trim() : "";
      if (!content) return { error: "content is required for action 'update'" };
      if (content.length > MAX_CONTENT_CHARS) {
        return { error: `content too long (${content.length} chars) — the maximum is ${MAX_CONTENT_CHARS}.` };
      }
      try {
        const updated = await updateMemory(memoryId, { content });
        return updated
          ? { ok: true, message: "Memory updated", memory: summarize(updated) }
          : { error: `No such memory in this project: ${memoryId}` };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    }

    // ---- action: delete ----
    if (action === "delete") {
      try {
        await deleteMemory(memoryId);
        return { ok: true, message: "Memory deleted", memory_id: memoryId };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    }

    // ---- action: pin ----
    if (action === "pin") {
      const pinned = args.pinned === true;
      try {
        const updated = await pinMemory(memoryId, pinned);
        return updated
          ? {
              ok: true,
              message: pinned ? "Memory pinned (always included in the project context)" : "Memory unpinned",
              memory: summarize(updated),
            }
          : { error: `No such memory in this project: ${memoryId}` };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    }

    return { error: `Unknown action: ${action}` };
  },
  false,
  "memory",
);

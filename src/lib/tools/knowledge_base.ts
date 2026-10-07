"use client";

// Knowledge Base tool — ONE unified tool for the workspace's persistent
// AI memory, backed by OnyxBase (the existing KV + Files platform).
//
// The model never sees separate low-level storage tools: every operation
// (search / get / save / update / delete / list / file hosting / links)
// rides this single `knowledge_base` tool with an `action` parameter —
// the same one-tool-per-domain convention as manage_memory etc.
//
// SECURITY MODEL (mirrors scheduled_tasks): the OnyxBase API key is
// resolved from the encrypted vault HERE, at execution time. It is never
// part of any tool schema, argument, prompt, or result.

import { registerTool } from "./registry";
import {
  resolveKBClients,
  kbSave,
  kbGet,
  kbUpdate,
  kbDelete,
  kbList,
  kbSearch,
  kbHostFile,
  MAX_KB_CONTENT_CHARS,
  MAX_KB_TITLE_CHARS,
  type KBItemType,
  type KBItemSummary,
  type KBSearchResult,
} from "@/lib/onyxbase/kb-store";

const NOT_CONFIGURED =
  "The Knowledge Base isn't configured yet. Ask the user to add their OnyxBase API key in Settings → Cloud Workspace (the same key that powers the cloud workspace) — then workspace knowledge can persist across chats.";

const USAGE_RULES = `Save DELIBERATELY — only information that is important, persistent and likely to be useful later: project decisions, user preferences, architecture knowledge, coding conventions, safe API/config knowledge, research findings, task conclusions, important generated artifacts, or anything the user explicitly asks you to remember. Do NOT save temporary reasoning, ordinary conversation, ephemeral tool output, duplicates, or sensitive secrets. Search the Knowledge Base when prior workspace knowledge could materially improve your response.`;

const KNOWLEDGE_BASE_DESCRIPTION = `The workspace Knowledge Base — persistent AI memory that survives across chats, sessions and restarts (OnyxBase-backed). ${USAGE_RULES}

Pass \`action\` plus only the fields that action needs:
- "search": find saved knowledge by keyword (matches titles, tags AND content). Requires \`query\`; optional \`type\`, \`limit\` (default 10). Use this BEFORE answering questions that prior workspace knowledge could inform.
- "get": read one full knowledge item by \`id\`.
- "save": persist NEW knowledge. Requires \`title\` + \`content\`; optional \`type\` ("memory" | "knowledge" | "decision" | "document" | "research" | "note"), \`tags\` (string array), \`category\`. Content limit ~${Math.round(MAX_KB_CONTENT_CHARS / 1000)}k chars.
- "update": modify an existing item. Requires \`id\`; optional \`title\`, \`content\`, \`type\`, \`tags\`, \`category\`.
- "delete": remove an item permanently. Requires \`id\`.
- "list": list saved knowledge (newest first). Optional \`type\` filter, \`limit\` (default 50).
- "save_file": HOST a file in the persistent OnyxBase file store and get a public download link. Requires \`name\` + \`content\` (file text) or \`content_base64\` (binary); optional \`mime_type\`, \`label\`. Returns the fileId + a fresh link. Use for important generated artifacts that must outlive the sandbox.
- "get_file": fetch a hosted file's metadata + a fresh download link. Requires \`file_id\`.
- "list_files": list hosted files.
- "delete_file": permanently delete a hosted file. Requires \`file_id\`.`;

interface KBOpResult {
  ok?: boolean;
  error?: string;
  message?: string;
  [k: string]: unknown;
}

/** Human one-line summary for a KB item (used by list/search results). */
function summaryLine(s: KBItemSummary | KBSearchResult): string {
  const tags = s.tags.length ? ` [${s.tags.join(", ")}]` : "";
  const rawExcerpt = "excerpt" in s ? (s as KBSearchResult).excerpt : undefined;
  const excerpt = typeof rawExcerpt === "string" ? ` — ${rawExcerpt.slice(0, 100)}` : "";
  return `${s.id} · (${s.type}${s.source === "ai" ? ", ai-saved" : ""}) "${s.title}"${tags}${excerpt} · updated ${s.updatedAt}`;
}

registerTool(
  "knowledge_base",
  KNOWLEDGE_BASE_DESCRIPTION,
  {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "search",
          "get",
          "save",
          "update",
          "delete",
          "list",
          "save_file",
          "get_file",
          "list_files",
          "delete_file",
        ],
        description: "Which Knowledge Base operation to perform.",
      },
      query: { type: "string", description: "Search keywords (action 'search')." },
      id: { type: "string", description: "Knowledge item id (actions 'get', 'update', 'delete')." },
      title: {
        type: "string",
        description: `Item title, max ${MAX_KB_TITLE_CHARS} chars (actions 'save', 'update').`,
      },
      content: {
        type: "string",
        description: "Knowledge content to persist ('save', 'update'), or the file TEXT for 'save_file'.",
      },
      content_base64: {
        type: "string",
        description: "Base64 file bytes for 'save_file' (binary files).",
      },
      type: {
        type: "string",
        enum: ["memory", "knowledge", "decision", "document", "research", "note"],
        description: "Item type ('save', 'update', or filter for 'search' / 'list').",
      },
      tags: { type: "array", items: { type: "string" }, description: "Retrieval tags ('save', 'update')." },
      category: { type: "string", description: "Optional category ('save', 'update')." },
      limit: { type: "number", description: "Max results ('search' default 10, 'list' default 50)." },
      name: { type: "string", description: "File name for 'save_file'." },
      mime_type: { type: "string", description: "Optional MIME type for 'save_file'." },
      label: { type: "string", description: "Optional human label for 'save_file'." },
      file_id: { type: "string", description: "Hosted file id (actions 'get_file', 'delete_file')." },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async (args, ctx): Promise<KBOpResult> => {
    const action = String(args.action ?? "");

    // ---- resolve the OnyxBase clients (execution-time key decryption) ----
    const clients = await resolveKBClients(ctx.userId);
    if (!clients) {
      return { error: "NOT_CONFIGURED", message: NOT_CONFIGURED };
    }

    try {
      // ---- action: search ----
      if (action === "search") {
        if (!args.query) return { error: "query is required for action 'search'" };
        const results = await kbSearch(clients.kv, ctx.userId, {
          query: String(args.query),
          type: (args.type as KBItemType | undefined) ?? undefined,
          limit: (args.limit as number | undefined) ?? undefined,
        });
        return {
          action: "search",
          query: args.query,
          count: results.length,
          results: results.map(summaryLine),
          note:
            results.length === 0
              ? "No matching knowledge saved yet for this workspace."
              : undefined,
        };
      }

      // ---- action: get ----
      if (action === "get") {
        if (!args.id) return { error: "id is required for action 'get'" };
        const item = await kbGet(clients.kv, ctx.userId, String(args.id));
        if (!item) return { error: `Knowledge item ${args.id} was not found` };
        return {
          action: "get",
          item: {
            id: item.id,
            type: item.type,
            title: item.title,
            content: item.content,
            source: item.source,
            category: item.category,
            tags: item.tags,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            ...(item.fileId ? { fileId: item.fileId } : {}),
          },
        };
      }

      // ---- action: save ----
      if (action === "save") {
        if (!args.title || !args.content) {
          return { error: "title and content are required for action 'save'" };
        }
        const item = await kbSave(clients.kv, ctx.userId, {
          title: String(args.title),
          content: String(args.content),
          type: args.type as KBItemType | undefined,
          tags: Array.isArray(args.tags) ? (args.tags as unknown[]).map(String) : undefined,
          category: args.category ? String(args.category) : undefined,
          source: "ai",
        });
        return {
          action: "save",
          id: item.id,
          message: `Saved "${item.title}" to the workspace Knowledge Base — it persists across chats.`,
        };
      }

      // ---- action: update ----
      if (action === "update") {
        if (!args.id) return { error: "id is required for action 'update'" };
        const item = await kbUpdate(clients.kv, ctx.userId, String(args.id), {
          title: args.title !== undefined ? String(args.title) : undefined,
          content: args.content !== undefined ? String(args.content) : undefined,
          type: args.type as KBItemType | undefined,
          tags: Array.isArray(args.tags) ? (args.tags as unknown[]).map(String) : undefined,
          category: args.category !== undefined ? String(args.category ?? "") || null : undefined,
        });
        return {
          action: "update",
          id: item.id,
          message: `Updated "${item.title}" in the Knowledge Base.`,
        };
      }

      // ---- action: delete ----
      if (action === "delete") {
        if (!args.id) return { error: "id is required for action 'delete'" };
        await kbDelete(clients.kv, ctx.userId, String(args.id));
        return { action: "delete", id: String(args.id), message: "Deleted from the Knowledge Base." };
      }

      // ---- action: list ----
      if (action === "list") {
        const items = await kbList(clients.kv, ctx.userId, {
          type: (args.type as KBItemType | undefined) ?? undefined,
          limit: (args.limit as number | undefined) ?? undefined,
        });
        return {
          action: "list",
          count: items.length,
          items: items.map(summaryLine),
          note: items.length === 0 ? "The Knowledge Base is empty for this workspace." : undefined,
        };
      }

      // ---- action: save_file (host + link) ----
      if (action === "save_file") {
        if (!args.name) return { error: "name is required for action 'save_file'" };
        let bytes: Uint8Array;
        if (args.content_base64) {
          try {
            const bin = atob(String(args.content_base64));
            bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          } catch {
            return { error: "content_base64 is not valid base64" };
          }
        } else if (args.content) {
          bytes = new TextEncoder().encode(String(args.content));
        } else {
          return { error: "content (text) or content_base64 (binary) is required for action 'save_file'" };
        }
        const { file, link } = await kbHostFile(clients.files, {
          bytes,
          name: String(args.name),
          mimeType: args.mime_type ? String(args.mime_type) : undefined,
          label: args.label ? String(args.label) : undefined,
        });
        return {
          action: "save_file",
          file_id: file.id,
          file_id_public: file.fileId,
          name: file.name ?? String(args.name),
          size: file.size,
          url: link.proxyUrl || link.url,
          url_expires_in_sec: link.expiresInSec,
          message: `Hosted "${file.name ?? args.name}" in the Knowledge Base file store. The link is fresh for ~55 minutes — call get_file with file_id to mint a new one anytime.`,
        };
      }

      // ---- action: get_file ----
      if (action === "get_file") {
        if (!args.file_id) return { error: "file_id is required for action 'get_file'" };
        const fileId = String(args.file_id);
        const meta = await clients.files.getMeta(fileId);
        if (!meta) return { error: `File ${fileId} was not found` };
        const link = await clients.files.mintLink(meta.id);
        return {
          action: "get_file",
          file: {
            id: meta.id,
            fileId: meta.fileId,
            name: meta.name,
            label: meta.label,
            size: meta.size,
            type: meta.type,
            uploadedAt: meta.uploadedAt ?? meta.createdAt,
          },
          url: link.proxyUrl || link.url,
          url_expires_in_sec: link.expiresInSec,
        };
      }

      // ---- action: list_files ----
      if (action === "list_files") {
        const listing = await clients.files.list();
        return {
          action: "list_files",
          count: listing.files.length,
          files: listing.files.map(
            (f) =>
              `${f.id} · "${f.name ?? f.label ?? f.fileId ?? f.id}"${f.size ? ` (${f.size} bytes)` : ""}${f.fileId ? ` /f/${f.fileId}` : ""}`,
          ),
          note: listing.files.length === 0 ? "No files are hosted in the Knowledge Base yet." : undefined,
        };
      }

      // ---- action: delete_file ----
      if (action === "delete_file") {
        if (!args.file_id) return { error: "file_id is required for action 'delete_file'" };
        await clients.files.deleteFile(String(args.file_id));
        return { action: "delete_file", file_id: String(args.file_id), message: "Hosted file deleted." };
      }

      return { error: `Unknown action: ${action}` };
    } catch (e) {
      // OnyxBaseError → structured error; anything else → honest message.
      const message = e instanceof Error ? e.message : String(e);
      return { error: "KB_OPERATION_FAILED", message };
    }
  },
  false,
  "knowledge",
);

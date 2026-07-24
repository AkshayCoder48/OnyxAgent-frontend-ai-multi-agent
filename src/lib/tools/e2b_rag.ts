"use client";

import { registerTool } from "./registry";
import { getE2BClient } from "@/lib/e2b/client";
import * as opfs from "@/lib/storage/opfs";

/**
 * search_documents — grep-based document search across the user's workspace.
 *
 * The original backend used pgvector + embeddings for RAG. In the backendless
 * model we don't have a server-side vector store; instead we grep the user's
 * text files (in the E2B sandbox if a key is configured, OPFS otherwise) and
 * return matching snippets with surrounding context. This is intentionally
 * simple — no embeddings, no reranking, no chunking — but it works for the
 * common case (the user uploaded some .md/.txt/.json/.csv files and wants the
 * agent to find a passage).
 *
 * The result shape matches what the chat UI's `parseRAGResults` helper
 * expects (see `components/chat/tool-results/rag.tsx`):
 *   `{ results: [{ index, source, content, page?, chunk?, score? }] }`.
 */

interface SearchHit {
  index: number;
  source: string;
  content: string;
  page?: number;
  chunk?: number;
  score?: string;
}

const MAX_RESULTS = 10;
const CONTEXT_CHARS = 250; // characters of context on each side of the match.

/** Greppable text extensions. Binary / huge formats are skipped. */
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "yaml", "yml", "csv", "tsv", "html",
  "htm", "xml", "log", "py", "js", "ts", "tsx", "jsx", "rs", "go", "java",
  "c", "cc", "cpp", "h", "hpp", "rb", "php", "sh", "bash", "zsh", "sql",
  "ini", "toml", "cfg", "conf", "env", "rtf",
]);

function isTextFile(name: string): boolean {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return TEXT_EXTENSIONS.has(ext);
}

async function grepFile(
  content: string,
  query: string,
  source: string,
): Promise<SearchHit[]> {
  const hits: SearchHit[] = [];
  const lower = content.toLowerCase();
  const qLower = query.toLowerCase();
  let idx = 0;
  let found = 0;
  while (found < MAX_RESULTS) {
    const pos = lower.indexOf(qLower, idx);
    if (pos === -1) break;
    const start = Math.max(0, pos - CONTEXT_CHARS);
    const end = Math.min(content.length, pos + query.length + CONTEXT_CHARS);
    const snippet =
      (start > 0 ? "… " : "") +
      content.slice(start, end).replace(/\s+/g, " ").trim() +
      (end < content.length ? " …" : "");
    hits.push({
      index: found + 1,
      source,
      content: snippet,
      score: "1.0",
    });
    idx = pos + query.length;
    found += 1;
  }
  return hits;
}

registerTool(
  "search_documents",
  "Search the user's workspace for documents containing the given query string. Returns matching snippets with surrounding context. Use this whenever the user asks about content of files they've uploaded or created in the workspace. Cite sources inline as [1], [2], etc.",
  {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query (substring match, case-insensitive).",
      },
      top_k: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        default: 5,
        description: "Maximum number of snippets to return.",
      },
      path: {
        type: "string",
        description: "Optional subdirectory to search (relative to workspace root).",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const query = (args.query as string).trim();
    const topK = (args.top_k as number) ?? 5;
    const path = (args.path as string) ?? ".";
    if (!query) {
      return { results: [], note: "Empty query" };
    }
    const maxHits = Math.min(topK, MAX_RESULTS);
    const allHits: SearchHit[] = [];

    const apiKey = ctx.e2bApiKey ?? ctx.sandboxApiKey;
    if (apiKey) {
      const client = getE2BClient(apiKey, ctx.userId);
      const entries = await client.listFiles(path);
      for (const entry of entries) {
        if (allHits.length >= maxHits) break;
        const entryName = entry.name ?? entry.path.split("/").pop() ?? entry.path;
        if (entry.type !== "file" || !isTextFile(entryName)) continue;
        try {
          const content = await client.readFile(entry.path);
          const hits = await grepFile(content, query, entryName);
          for (const h of hits) {
            if (allHits.length >= maxHits) break;
            allHits.push(h);
          }
        } catch {
          // skip unreadable files.
        }
      }
    } else {
      // OPFS fallback.
      const entries = await opfs.listDir(ctx.userId, `workspace/${path === "." ? "" : path}`);
      // Recursively walk directories.
      const queue = [...entries];
      while (queue.length > 0 && allHits.length < maxHits) {
        const entry = queue.shift()!;
        if (entry.kind === "directory") {
          const nested = await opfs.listDir(ctx.userId, entry.path.replace(`users/${ctx.userId}/`, ""));
          queue.push(...nested);
          continue;
        }
        if (!isTextFile(entry.name)) continue;
        try {
          const content = await opfs.readTextFile(entry.path);
          const hits = await grepFile(content, query, entry.name);
          for (const h of hits) {
            if (allHits.length >= maxHits) break;
            allHits.push(h);
          }
        } catch {
          // skip.
        }
      }
    }

    return { results: allHits };
  },
  false,
  "rag",
);

"use client";

import { registerTool } from "./registry";
import { getE2BClient } from "@/lib/e2b/client";

/**
 * search_documents — grep-based document search across the user's workspace.
 *
 * The original backend used pgvector + embeddings for RAG. In the backendless
 * model we don't have a server-side vector store; instead we grep the user's
 * text files in the E2B sandbox (the authoritative workspace) and return
 * matching snippets with surrounding context. This is intentionally simple —
 * no embeddings, no reranking, no chunking — but it works for the common case
 * (the user uploaded some .md/.txt/.json/.csv files and wants the agent to
 * find a passage).
 *
 * PRD §25/§26: the OPFS fallback was removed. E2B is the single source of
 * truth for workspace files. If no sandbox key is configured, the tool
 * returns an error message instead of silently scanning a divergent OPFS
 * tree (which the AI's `read_file` tool cannot see anyway).
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

/** Recursively list all files under `rootPath` in the E2B sandbox. */
async function listSandboxFiles(
  client: ReturnType<typeof getE2BClient>,
  rootPath: string,
): Promise<Array<{ path: string; name: string }>> {
  const out: Array<{ path: string; name: string }> = [];
  const stack: string[] = [rootPath];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Awaited<ReturnType<typeof client.listFiles>>;
    try {
      entries = await client.listFiles(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = entry.path.startsWith("/") ? entry.path : `${dir.replace(/\/$/, "")}/${entry.path}`;
      const name = entry.name ?? full.split("/").pop() ?? full;
      if (entry.type === "directory") {
        stack.push(full);
      } else if (entry.type === "file") {
        out.push({ path: full, name });
      }
    }
  }
  return out;
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
    if (!apiKey) {
      return {
        results: [],
        error:
          "Document search requires an E2B sandbox. Configure one in Settings → Config → E2B Sandbox.",
      };
    }

    const client = getE2BClient(apiKey, ctx.userId, ctx.sandboxMode ?? "shared");
    const rootPath = path === "."
      ? "/home/user"
      : (path.startsWith("/") ? path : `/home/user/${path}`);
    const files = await listSandboxFiles(client, rootPath);

    for (const file of files) {
      if (allHits.length >= maxHits) break;
      if (!isTextFile(file.name)) continue;
      try {
        const content = await client.readFile(file.path);
        const hits = await grepFile(content, query, file.name);
        for (const h of hits) {
          if (allHits.length >= maxHits) break;
          allHits.push(h);
        }
      } catch {
        // skip unreadable files.
      }
    }

    return { results: allHits };
  },
  false,
  "rag",
);

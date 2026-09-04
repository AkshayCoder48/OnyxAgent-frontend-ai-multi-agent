import { parseRAGResults } from "@/components/chat/tool-results/rag";
import type { ChatMessage, ToolCall } from "@/types";

export interface SourceItem {
  index: number;
  type: "rag" | "web";
  title: string;
  subtitle?: string;
  url?: string;
  content?: string;
  score?: number;
}

function getToolCalls(message: ChatMessage): ToolCall[] {
  const fromParts = (message.parts ?? [])
    .filter((p) => p.type === "tool" && !!p.toolCall)
    .map((p) => p.toolCall!);
  if (fromParts.length > 0) return fromParts;
  return message.toolCalls ?? [];
}

/** The tool result as the store keeps it: a JSON string (from the
 *  `tool_result` event) OR the already-parsed ToolResult object (older
 *  persistence paths). Normalize to a record, or null. */
function asRecord(result: unknown): Record<string, unknown> | null {
  if (result == null) return null;
  let obj: unknown = result;
  if (typeof result === "string") {
    const trimmed = result.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  if (Array.isArray(obj)) return null;
  if (!obj || typeof obj !== "object") return null;
  return obj as Record<string, unknown>;
}

interface WebHit {
  title?: string;
  url?: string;
  content?: string;
  snippet?: string;
  description?: string;
}

/** Parse the results array out of a web_search tool result, tolerating ALL
 *  the shapes that have existed:
 *   - string or object
 *   - ToolResult wrapper { success, output: { kind, query, results } }
 *   - direct { kind: "web_search", query, results }
 *   - bare { results: [...] }
 *  Beta V1.2: the tool now stamps `kind: "web_search"` in its output, but
 *  old messages (and the E2B background runner) may carry any variant. */
function parseWebResults(result: unknown): WebHit[] | null {
  const rec = asRecord(result);
  if (!rec) return null;
  const isWebSearchTool =
    rec.kind === "web_search" ||
    (typeof rec.output === "object" && rec.output !== null &&
      (rec.output as Record<string, unknown>).kind === "web_search") ||
    false;
  // Wrapper { success, output: {...} } → unwrap; otherwise use as-is.
  const output =
    rec.output && typeof rec.output === "object" && !Array.isArray(rec.output)
      ? (rec.output as Record<string, unknown>)
      : rec;
  const rawResults = output.results;
  if (!Array.isArray(rawResults)) {
    // A web_search-shaped record without results is still "a web search
    // happened, nothing matched" — return empty (not null) so the caller
    // can distinguish from "not a web search result at all".
    return isWebSearchTool || rec.kind === "web_search" ? [] : null;
  }
  const hits: WebHit[] = [];
  for (const r of rawResults) {
    if (!r || typeof r !== "object") continue;
    const h = r as Record<string, unknown>;
    if (typeof h.url !== "string" && typeof h.title !== "string") continue;
    hits.push({
      title: typeof h.title === "string" ? h.title : undefined,
      url: typeof h.url === "string" ? h.url : undefined,
      content:
        typeof h.content === "string" ? h.content :
        typeof h.snippet === "string" ? h.snippet :
        typeof h.description === "string" ? h.description :
        undefined,
    });
  }
  return hits;
}

export function extractSources(message: ChatMessage): SourceItem[] {
  const sources: SourceItem[] = [];
  const seenUrls = new Set<string>();
  // Web sources are numbered CUMULATIVELY across the turn (1..N, deduped)
  // so the citation footer lists unique numbers and [n] chips map 1:1 to
  // the array position. The model sees per-call numbering in each tool
  // result — for the dominant single-search turn they are identical.
  let webIndex = 0;

  for (const tc of getToolCalls(message)) {
    const result = tc.result;
    if (!result) continue;

    if (tc.name === "search_knowledge_base" || tc.name === "search_documents") {
      const resultStr = typeof result === "string" ? result : JSON.stringify(result);
      for (const item of parseRAGResults(resultStr)) {
        sources.push({
          index: item.index,
          type: "rag",
          title: item.source,
          subtitle:
            [item.page && `p.${item.page}`, item.chunk && `chunk ${item.chunk}`]
              .filter(Boolean)
              .join(" · ") || undefined,
          content: item.content,
          score: item.score ? parseFloat(item.score) : undefined,
        });
      }
    } else if (tc.name === "web_search" || tc.name === "search_web") {
      const hits = parseWebResults(result);
      if (!hits) continue;
      for (const hit of hits) {
        const url = hit.url ?? "";
        // Dedupe across multiple searches in one turn — the same page cited
        // twice should map to one chip.
        if (url && seenUrls.has(url)) continue;
        if (url) seenUrls.add(url);
        webIndex += 1;
        sources.push({
          index: webIndex,
          type: "web",
          title: hit.title || domainOf(url),
          subtitle: domainOf(url),
          url: url || undefined,
          content: hit.content,
        });
      }
    }
  }

  return sources;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

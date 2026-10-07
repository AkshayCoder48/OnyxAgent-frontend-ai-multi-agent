"use client";

import { useMemo, useState } from "react";
import { Check, Copy, Library, Link2 } from "lucide-react";
import type { ToolCall } from "@/types";
import { MemoryChips, type MemoryChip } from "@/components/assistant-ui/elements/memory-chips";

/**
 * knowledge_base tool results — ONE compact presentation for the unified
 * Knowledge Base tool (never one card per internal operation):
 *
 *  - save        → one "added" chip (what was persisted)
 *  - update      → one "updated" chip
 *  - search/list → the matched items as neutral chips
 *  - save_file   → a hosted-file row with a copy-link button (the link
 *                  came back in the tool result)
 *
 * The narration line itself ("Saved “X” to the Knowledge Base") is handled
 * by friendlyStep — this component is the payload beneath it.
 */

/** Parse a knowledge_base tool result into chips + hosted-file payload. */
export function parseKBResult(toolCall: ToolCall): {
  chips: MemoryChip[];
  hostedFile: { name: string; url: string } | null;
} {
  const result = toolCall.result;
  let obj: Record<string, unknown> | null = null;
  if (typeof result === "object" && result !== null) {
    obj = result as Record<string, unknown>;
  } else if (typeof result === "string") {
    try {
      const parsed: unknown = JSON.parse(result);
      if (typeof parsed === "object" && parsed !== null) obj = parsed as Record<string, unknown>;
    } catch {
      obj = null;
    }
  }
  if (!obj || obj.error !== undefined) return { chips: [], hostedFile: null };

  const args = (toolCall.args ?? {}) as Record<string, unknown>;
  const action = typeof args.action === "string" ? args.action : "";
  const title = typeof args.title === "string" ? args.title : null;

  // save / update → one fresh chip with the title the model gave.
  if ((action === "save" || action === "update") && (obj.id || obj.message)) {
    if (title) {
      return {
        chips: [{ id: String(obj.id ?? title), text: title, change: action === "save" ? "added" : "updated" }],
        hostedFile: null,
      };
    }
  }

  // save_file → the hosted file + its link.
  if (action === "save_file" && typeof obj.url === "string" && obj.url) {
    return {
      chips: [],
      hostedFile: {
        name: typeof obj.name === "string" && obj.name ? obj.name : "file",
        url: obj.url,
      },
    };
  }

  // search → the matched lines as neutral chips. Lines come from the tool's
  // summary format: `kb_x · (decision, ai-saved) "Title" [tags] — excerpt …`
  const toChip = (line: unknown): MemoryChip | null => {
    if (typeof line !== "string" || !line.trim()) return null;
    const m = /"([^"]+)"|“([^”]+)”/.exec(line);
    const text = m ? (m[1] ?? m[2] ?? line) : line;
    return { id: line.slice(0, 80), text: text.length > 90 ? `${text.slice(0, 89)}…` : text, change: "existing" };
  };
  if (action === "search" && Array.isArray(obj.results)) {
    const chips = (obj.results as unknown[])
      .map(toChip)
      .filter((c): c is MemoryChip => c !== null)
      .slice(0, 6);
    return { chips, hostedFile: null };
  }
  // list → same shape.
  if (action === "list" && Array.isArray(obj.items)) {
    const chips = (obj.items as unknown[])
      .map(toChip)
      .filter((c): c is MemoryChip => c !== null)
      .slice(0, 8);
    return { chips, hostedFile: null };
  }
  return { chips: [], hostedFile: null };
}

export function KnowledgeBaseResult({ toolCall }: { toolCall: ToolCall }) {
  const parsed = useMemo(() => parseKBResult(toolCall), [toolCall]);
  const [copied, setCopied] = useState(false);

  if (parsed.chips.length === 0 && !parsed.hostedFile) return null;

  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard blocked — the link is still visible for manual copy
    }
  };

  return (
    <div className="space-y-1.5 px-1.5 sm:px-2">
      {parsed.chips.length > 0 && <MemoryChips chips={parsed.chips} />}
      {parsed.hostedFile && (
        <div className="border-border bg-foreground/[0.03] inline-flex max-w-full items-center gap-2 rounded-full border py-1 pl-3 pr-1.5">
          <Library className="text-primary h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate text-xs font-medium">{parsed.hostedFile.name}</span>
          <button
            type="button"
            onClick={() => copyLink(parsed.hostedFile!.url)}
            aria-label="Copy hosted file link"
            className="text-muted-foreground hover:text-foreground hover:bg-foreground/5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors"
          >
            {copied ? (
              <Check className="text-primary h-3.5 w-3.5" aria-hidden />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden />
            )}
          </button>
          <a
            href={parsed.hostedFile.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open hosted file"
            className="text-muted-foreground hover:text-foreground hover:bg-foreground/5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors"
          >
            <Link2 className="h-3.5 w-3.5" aria-hidden />
          </a>
        </div>
      )}
    </div>
  );
}

/**
 * Export feature — Markdown document builder (isomorphic, pure).
 *
 * `buildMarkdownExport` follows the PRD §12.5 example structure:
 *
 * ```md
 * # Database Architecture
 *
 * Project: OnyxAgent Development
 * Exported: 2026-10-18
 *
 * ## User
 *
 * How should we structure database migrations?
 *
 * ## Assistant
 *
 * The migration strategy should preserve compatibility...
 *
 * ### Tool Activity
 *
 * - Tool: web_search
 * - Status: Completed
 * - Duration: 123 ms
 * ```
 *
 * The SAME function runs on the server (the `/api/export` route imports it
 * for the `md` format) so client-side and API-generated Markdown are
 * byte-identical. Pure function: no I/O, no Date.now() — everything
 * time-dependent arrives via `options.exportDate` / message timestamps.
 */

import { stripCodeBlocks, CODE_OMITTED_PLACEHOLDER } from "./segments";
import { formatExportDuration, formatExportTimestamp } from "./format";
import type { ExportConversation, ExportLayout, ExportMessage, ExportOptions } from "./types";

/** Display label for a message role. */
export function speakerLabel(role: ExportMessage["role"]): "USER" | "ASSISTANT" {
  return role === "assistant" ? "ASSISTANT" : "USER";
}

/** Heading text for a message, honoring layout + speaker toggle. */
function messageHeading(message: ExportMessage, index: number, layout: ExportLayout): string {
  const label = speakerLabel(message.role);
  // Technical layout numbers every message like `[003] USER` (1-based).
  if (layout === "technical") {
    const num = String(index + 1).padStart(3, "0");
    return `[${num}] ${label}`;
  }
  return label;
}

/** The `*2026-02-03 14:05 UTC · gpt-4o*` metadata line (or null). */
function metadataLine(message: ExportMessage, options: ExportOptions): string | null {
  const parts: string[] = [];
  if (options.includeTimestamps) parts.push(formatExportTimestamp(message.created_at));
  if (message.role === "assistant" && message.model_name) parts.push(message.model_name);
  return parts.length > 0 ? `*${parts.join(" · ")}*` : null;
}

/** The `**Files:** `a.png`, `b.pdf`` attachment line (or null). */
function filesLine(message: ExportMessage, options: ExportOptions): string | null {
  if (!options.includeFileNames) return null;
  const names = (message.file_names ?? []).filter((n) => n && n.trim().length > 0);
  if (names.length === 0) return null;
  return `**Files:** ${names.map((n) => `\`${n}\``).join(", ")}`;
}

/** Body content for a message — fenced code preserved or placeholdered. */
function bodyText(message: ExportMessage, options: ExportOptions): string {
  if (options.includeCode) return message.content;
  return stripCodeBlocks(message.content, CODE_OMITTED_PLACEHOLDER);
}

/** The `### Tool Activity` block for a message (or null). */
function toolActivityBlock(message: ExportMessage, options: ExportOptions): string | null {
  if (!options.includeToolCalls) return null;
  const calls = message.tool_calls ?? [];
  if (calls.length === 0) return null;
  const clusters = calls.map((call) => {
    const lines = [
      `- Tool: ${call.tool_name}`,
      `- Status: ${call.status === "completed" ? "Completed" : "Failed"}`,
    ];
    const duration = formatExportDuration(call.duration_ms);
    if (duration) lines.push(`- Duration: ${duration}`);
    if (call.result_summary) lines.push(`- Result: ${call.result_summary}`);
    return lines.join("\n");
  });
  return ["### Tool Activity", "", clusters.join("\n\n")].join("\n");
}

/** Human-readable document title (options override wins). */
export function exportTitle(conversation: ExportConversation, options: ExportOptions): string {
  const t = (options.title ?? conversation.title ?? "").toString().trim();
  return t.length > 0 ? t : "Conversation";
}

/**
 * Build the full Markdown export document.
 *
 * Layout differences (Markdown is layout-light; the heavy visual treatments
 * live in the PDF/DOCX builders):
 *  - `professional` / `technical` — `---` horizontal rules between messages;
 *  - `technical` — numbered headings (`## [003] USER`);
 *  - `clean` / `compact` — plain headings, no rules.
 */
export function buildMarkdownExport(
  conversation: ExportConversation,
  layout: ExportLayout,
  options: ExportOptions,
): string {
  const lines: string[] = [];

  // ── Title + metadata header (PRD §12.5 example) ─────────────────────────
  lines.push(`# ${exportTitle(conversation, options)}`, "");
  if (options.projectName) lines.push(`Project: ${options.projectName}`);
  lines.push(`Exported: ${options.exportDate}`, "");
  const useRules = layout === "professional" || layout === "technical";

  // ── Messages, in original order ──────────────────────────────────────────
  conversation.messages.forEach((message, index) => {
    if (useRules && index > 0) lines.push("", "---", "");
    if (options.includeSpeakers) {
      lines.push(`## ${messageHeading(message, index, layout)}`, "");
    }
    const meta = metadataLine(message, options);
    if (meta) lines.push(meta, "");
    const files = filesLine(message, options);
    if (files) lines.push(files, "");
    lines.push(bodyText(message, options), "");
    const toolBlock = toolActivityBlock(message, options);
    if (toolBlock) lines.push(toolBlock, "");
  });

  // Normalize: collapse 3+ consecutive blank lines, trim the tail.
  const doc = lines.join("\n");
  const collapsed = doc.replace(/\n{3,}/g, "\n\n");
  return collapsed.replace(/\s+$/, "") + "\n";
}

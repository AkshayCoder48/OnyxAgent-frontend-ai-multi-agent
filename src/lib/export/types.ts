/**
 * Export feature — shared, isomorphic type contract.
 *
 * Used by BOTH sides of the export flow:
 *  - Client (`src/lib/export/collect.ts`) reads the conversation out of Dexie
 *    and shapes it into an `ExportPayload`.
 *  - Server (`src/app/api/export/route.ts`) receives that payload as the POST
 *    body and renders PDF / DOCX / Markdown from it.
 *  - `src/lib/export/markdown.ts` shares the same conversation/options types
 *    so client and server produce byte-identical Markdown.
 *
 * SECURITY: the payload carries conversation messages ONLY — never provider
 * API keys, vault contents, or system-prompt text. `collect.ts` additionally
 * drops `role: "system"` messages so hidden instructions can never reach an
 * exported file.
 */

/** Output file format. */
export type ExportFormat = "pdf" | "docx" | "md";

/**
 * Visual document layout (PRD §12.2 "Document layout").
 *
 *  - `clean`        — airy spacing, light rules between messages.
 *  - `professional` — header band with title/date/project, report styling,
 *                     footer page numbers ("X / Y").
 *  - `compact`      — tight leading, smaller font, more content per page.
 *  - `technical`    — monospace-forward, code on shaded background blocks,
 *                     numbered messages like `[003] USER`.
 */
export type ExportLayout = "clean" | "professional" | "compact" | "technical";

/** A tool call summary attached to a message (PRD §12.2 "Include tool-call
 *  summaries" — only completed/failed records, never in-flight ones). */
export interface ExportToolCallSummary {
  tool_name: string;
  /** Only `"completed"` | `"failed"` rows are exported. */
  status: "completed" | "failed";
  duration_ms?: number;
  /** Short result excerpt (≤200 chars, single line) — optional. */
  result_summary?: string;
}

/** One exported message. System-role messages are filtered out by the
 *  collector and never reach this shape. */
export interface ExportMessage {
  id: string;
  role: "user" | "assistant";
  /** Original message content (markdown preserved — exports keep code blocks). */
  content: string;
  created_at: string;
  model_name?: string;
  tool_calls?: ExportToolCallSummary[];
  /** Names of files attached to the message (for the "Referenced file names"
   *  toggle). Empty/omitted when the message has no attachments. */
  file_names?: string[];
}

/** Content toggles + document options chosen in the export dialog. */
export interface ExportOptions {
  /** Optional title override; falls back to the conversation title. */
  title?: string;
  includeTimestamps: boolean;
  includeSpeakers: boolean;
  includeToolCalls: boolean;
  includeCode: boolean;
  includeFileNames: boolean;
  /** Table of contents (PDF/DOCX only). */
  includeToc: boolean;
  /** Page numbers (PDF only). */
  pageNumbers: boolean;
  /** Optional project label (Task 1-b's project drawer may pass the project
   *  name when exporting from a project context). */
  projectName?: string | null;
  /** Export date (ISO date `YYYY-MM-DD`) chosen by the client. */
  exportDate: string;
}

/** The conversation as exported — messages in ORIGINAL ORDER. */
export interface ExportConversation {
  title: string;
  created_at: string;
  messages: ExportMessage[];
}

/** POST body of `/api/export`. */
export interface ExportPayload {
  format: ExportFormat;
  layout: ExportLayout;
  options: ExportOptions;
  conversation: ExportConversation;
}

/** Defaults used by the export dialog when it opens. */
export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  includeTimestamps: true,
  includeSpeakers: true,
  includeToolCalls: true,
  includeCode: true,
  includeFileNames: true,
  includeToc: false,
  pageNumbers: true,
  projectName: null,
  exportDate: "",
};

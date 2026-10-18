/**
 * Export feature — client-side conversation collector.
 *
 * Reads a conversation + ALL of its messages + tool calls + attachment names
 * from Dexie and shapes them into the `ExportPayload` POST body for
 * `/api/export`.
 *
 * Reuses the EXISTING loaders (no duplicated query logic):
 *  - messages/tool-calls/files come from `conversationService.getMessages`
 *    (the same call `use-conversations` uses to load a thread — one Dexie
 *    `where("conversation_id")` pass plus two registry joins);
 *  - the conversation row is read user-agnostically like
 *    `conversationService.exists` does (the local-first app can have
 *    transient auth identities mid-hydration).
 *
 * The collector has NO UI dependency, so exporting works for any
 * conversation (including archived ones) without mounting it in the chat
 * UI, and long conversations are read in a single pass — nothing streams
 * through React state.
 *
 * SECURITY: system-role messages are dropped here (never exported), tool
 * calls are filtered to completed/failed with a ≤200-char result excerpt,
 * and nothing besides message content reaches the payload.
 */

import { db } from "@/lib/db";
import { conversationService } from "@/lib/services";
import { excerptText } from "./format";
import type {
  ExportConversation,
  ExportMessage,
  ExportPayload,
  ExportToolCallSummary,
} from "./types";

/** Max characters of a tool result kept in the export. */
const RESULT_EXCERPT_MAX = 200;

/**
 * Collect the full export payload for a conversation.
 *
 * @param conversationId the Dexie conversation id.
 * @param config the dialog's current `{ format, layout, options }` — the
 *        conversation data is attached to it.
 * @returns the complete POST body, or `null` when the conversation no
 *          longer exists (deleted mid-flight).
 */
export async function collectConversationForExport(
  conversationId: string,
  config: Pick<ExportPayload, "format" | "layout" | "options">,
): Promise<ExportPayload | null> {
  // User-agnostic row read (same semantics as conversationService.exists —
  // see the note there about transient local auth identities).
  const row = await db.conversations.get(conversationId);
  if (!row) return null;

  // Same loader the chat UI uses — messages sorted by created_at with
  // tool_calls and file attachments hydrated in one pass.
  const messages = await conversationService.getMessages(conversationId);

  const conversation: ExportConversation = {
    title: row.title?.trim() || "Conversation",
    created_at: row.created_at,
    messages: messages
      // System-prompt content is never exported (PRD §12.2).
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map(toExportMessage),
  };

  return { ...config, conversation };
}

function toExportMessage(m: {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
  model_name?: string;
  tool_calls?: Array<{
    tool_name: string;
    status: string;
    duration_ms?: number;
    result?: string;
  }>;
  files?: Array<{ filename: string }>;
}): ExportMessage {
  const toolCalls: ExportToolCallSummary[] = (m.tool_calls ?? [])
    // Only finished records are exportable — pending/running rows would
    // present unfinished work as complete (PRD §12.6).
    .filter((t) => t.status === "completed" || t.status === "failed")
    .map((t) => ({
      tool_name: t.tool_name,
      status: t.status as "completed" | "failed",
      ...(t.duration_ms != null ? { duration_ms: t.duration_ms } : {}),
      ...(excerptText(t.result, RESULT_EXCERPT_MAX)
        ? { result_summary: excerptText(t.result, RESULT_EXCERPT_MAX)! }
        : {}),
    }));

  const fileNames = (m.files ?? [])
    .map((f) => f.filename)
    .filter((n): n is string => !!n && n.trim().length > 0);

  return {
    id: m.id,
    role: m.role,
    content: m.content,
    created_at: m.created_at,
    ...(m.model_name ? { model_name: m.model_name } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    ...(fileNames.length > 0 ? { file_names: fileNames } : {}),
  };
}

/* ---------------------------------------------------------------------------
 * Dialog preview support — a light snapshot of the conversation's SHAPE
 * (not its full content) so the export dialog can render an honest
 * "structure preview" from the first two real messages.
 * ------------------------------------------------------------------------ */

export interface ExportPreviewMessage {
  role: "user" | "assistant";
  created_at: string;
  /** First ~110 chars of the content, single line. */
  contentPreview: string;
  hasCode: boolean;
  toolCount: number;
  fileCount: number;
}

export interface ExportPreviewInfo {
  title: string;
  messageCount: number;
  /** The first two messages (the dialog's structure preview). */
  firstMessages: ExportPreviewMessage[];
  /** True when ANY message has exportable tool-call records. */
  hasToolRecords: boolean;
}

/**
 * Read a light preview of the conversation for the export dialog.
 * Uses the same `getMessages` loader as the full collector.
 */
export async function collectExportPreview(
  conversationId: string,
): Promise<ExportPreviewInfo | null> {
  const row = await db.conversations.get(conversationId);
  if (!row) return null;
  const messages = (await conversationService.getMessages(conversationId)).filter(
    (m) => m.role === "user" || m.role === "assistant",
  );

  const toPreview = (m: (typeof messages)[number]): ExportPreviewMessage => ({
    role: m.role,
    created_at: m.created_at,
    contentPreview: (m.content ?? "").replace(/\s+/g, " ").trim().slice(0, 110),
    hasCode: /(^|\n)(`{3,}|~{3,})/.test(m.content ?? ""),
    toolCount: (m.tool_calls ?? []).filter(
      (t) => t.status === "completed" || t.status === "failed",
    ).length,
    fileCount: (m.files ?? []).filter((f) => f.filename).length,
  });

  return {
    title: row.title?.trim() || "Conversation",
    messageCount: messages.length,
    firstMessages: messages.slice(0, 2).map(toPreview),
    hasToolRecords: messages.some(
      (m) =>
        (m.tool_calls ?? []).filter((t) => t.status === "completed" || t.status === "failed")
          .length > 0,
    ),
  };
}

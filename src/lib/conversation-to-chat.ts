import type { ChatMessage, ChatMessageFile, MessagePart, ToolCall } from "@/types";

/**
 * Shape of a persisted message as returned by the backend (MessageRead).
 * Both the conversation history endpoint and the public demo endpoint return this.
 */
export interface RawToolCall {
  tool_call_id: string;
  tool_name: string;
  args: Record<string, unknown>;
  result?: unknown;
  status: string;
}

export interface RawMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
  tool_calls?: RawToolCall[] | null;
  user_rating?: number | null;
  rating_count?: { likes: number; dislikes: number } | null;
  files?: ChatMessageFile[] | null;
  /** OpenAI-native reasoning trace (extended-thinking models). */
  thinking?: string | null;
  /** DeepSeek/Moonshot-style ``reasoning_content`` field. */
  reasoning?: string | null;
  /** Persisted ordered timeline (assistant turns). */
  parts?: MessagePart[] | null;
}

/**
 * Transform a persisted message into the live `ChatMessage` shape used by the chat UI.
 *
 * If the message has persisted `parts` (the new code path), use them directly —
 * this preserves the exact reasoning/thinking/tool/text ordering the user saw
 * live. Otherwise, reconstruct a timeline from `tool_calls` + `content` (the
 * old behavior) so messages saved before the parts-persistence change still
 * render correctly.
 *
 * Used by both the authenticated chat (when loading a saved conversation) and
 * the public demo replay.
 */
export function conversationMessageToChatMessage(msg: RawMessage): ChatMessage {
  // Always derive flat toolCalls from msg.tool_calls — the chat UI uses
  // toolCalls for copy/rating/exports, independent of the parts timeline.
  const toolCalls: ToolCall[] | undefined = msg.tool_calls?.map((tc) => ({
    id: tc.tool_call_id,
    name: tc.tool_name,
    args: tc.args,
    result: tc.result,
    status: (tc.status === "failed" ? "error" : tc.status) as ToolCall["status"],
  }));

  // Use persisted parts if available; otherwise reconstruct from toolCalls +
  // content (legacy messages).
  let parts: MessagePart[] | undefined;
  if (Array.isArray(msg.parts) && msg.parts.length > 0) {
    parts = msg.parts as MessagePart[];
  } else if (msg.role === "assistant") {
    parts = [
      ...(toolCalls ?? []).map((tc) => ({
        id: tc.id,
        type: "tool" as const,
        toolCall: tc,
      })),
      ...(msg.content
        ? [{ id: `${msg.id}-text`, type: "text" as const, content: msg.content }]
        : []),
    ];
  }

  const thinking = msg.thinking ?? undefined;
  const reasoning = msg.reasoning ?? undefined;

  const files = Array.isArray(msg.files) ? msg.files : undefined;

  return {
    id: msg.id,
    role: msg.role,
    content: msg.content,
    timestamp: new Date(msg.created_at),
    conversationId: msg.conversation_id,
    toolCalls,
    parts,
    thinking,
    reasoning,
    user_rating: msg.user_rating ?? undefined,
    rating_count: msg.rating_count ?? undefined,
    files,
    fileIds: files?.map((f) => f.id),
  };
}

export function conversationMessagesToChatMessages(msgs: RawMessage[]): ChatMessage[] {
  return msgs.map(conversationMessageToChatMessage);
}

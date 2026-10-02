"use client";

// read_chat — snapshot-read another chat's CURRENT contents and generation
// state, including partially streamed AI output (async subagent messaging
// spec §19–§29). Available to BOTH the Main Agent and the Code Agent (the
// "orchestration" category is shared across modes — request-scoping.ts only
// strips the Code-only surface from Agent turns).
//
// DESIGN RULES (spec §38–§40):
//   • SNAPSHOT READ — one pass over the existing stores/tables; no polling
//     loops, no workspace scans, no waiting for completion.
//   • REUSES THE EXISTING ARCHITECTURE — subagent sessions come from the
//     subagent store (the same one the sidebar renders), conversations from
//     the SAME Dexie tables + the SAME ExecutionHub live stores that drive
//     the UI. No second chat database, no duplicate runtime.
//   • LIVE STATE FIRST — when a target is actively generating, the live
//     in-memory state (execution store / subagent session) is newer than
//     any persistence checkpoint; read_chat merges: live execution store →
//     global viewed-conversation store → persisted Dexie rows.
//   • HONEST STATUS — the target's real state is exposed ("streaming"
//     while output is still growing); returning content never fabricates
//     completion.

import { registerTool } from "./registry";
import { db } from "@/lib/db";
import type { ChatMessage } from "@/types";

/** Per-message content budget (chars). Long messages keep their HEAD — the
 *  beginning carries the answer in practice; the tail is usually detail. */
const DEFAULT_MAX_CHARS = 4000;
const HARD_MAX_CHARS = 20000;
const DEFAULT_LIMIT = 12;
const HARD_MAX_LIMIT = 50;

/** Compact preview budget for a tool call's result payload. */
const TOOL_RESULT_PREVIEW_CHARS = 300;
const TOOL_RESULT_FULL_CHARS = 2000;

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

/** Stringify a tool result payload into a bounded preview. */
function previewResult(result: unknown, budget: number): string {
  let s: string;
  if (typeof result === "string") {
    s = result;
  } else {
    try {
      s = JSON.stringify(result) ?? "";
    } catch {
      s = String(result);
    }
  }
  return s.length <= budget ? s : s.slice(0, budget) + ` … [+${s.length - budget} chars]`;
}

interface ReadChatMessageOut {
  messageId: string;
  role: string;
  status: "streaming" | "completed" | "failed" | "stopped";
  content: string;
  truncated?: boolean;
  timestamp: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    status: string;
    result?: string;
  }>;
}

/** Map a live ChatMessage (execution store / global chat store) to the
 *  read_chat output shape. */
function chatMessageOut(
  m: ChatMessage,
  maxChars: number,
  includeToolResults: boolean,
): ReadChatMessageOut {
  const { text, truncated } = truncate(m.content ?? "", maxChars);
  let status: ReadChatMessageOut["status"] = "completed";
  if (m.isStreaming) status = "streaming";
  else if (m.role === "assistant" && m.generation?.failed) status = "failed";
  else if (m.role === "assistant" && m.generation?.stopped) status = "stopped";

  const out: ReadChatMessageOut = {
    messageId: m.renderKey ?? m.id,
    role: m.role,
    status,
    content: text,
    timestamp: m.timestamp instanceof Date ? m.timestamp.toISOString() : String(m.timestamp ?? ""),
  };
  if (truncated) out.truncated = true;
  if (m.toolCalls && m.toolCalls.length > 0) {
    out.toolCalls = m.toolCalls.map((tc) => ({
      id: tc.id,
      name: tc.name,
      status: tc.status,
      ...(tc.result !== undefined
        ? {
            result: previewResult(
              tc.result,
              includeToolResults ? TOOL_RESULT_FULL_CHARS : TOOL_RESULT_PREVIEW_CHARS,
            ),
          }
        : {}),
    }));
  }
  return out;
}

registerTool(
  "read_chat",
  `Read the current contents and generation state of another chat, including partially streamed AI output. Does not wait for generation to finish.

Use this to inspect what another AI or subagent has generated so far — the natural companion to query_subagent (which delivers a message fire-and-forget): send a subagent its task, keep working, then read_chat its chat to see its latest output — even while it is still streaming, thinking or running tools. Repeated calls return progressively more content.

Reads:
- A SUBAGENT chat: pass the \`target_chat_id\` returned by query_subagent, or a \`subagent_id\` (reads its most recent session). Shows the live streamed reply, tool calls and the agent's real status (streaming / running / completed / failed).
- A CONVERSATION: pass a conversation id from manage_chats (action "list"). Shows persisted messages, or the LIVE streaming state when that conversation is currently generating (foreground or background).

The result is a point-in-time snapshot: the latest known state at the moment of the call, with each message's own status (a "streaming" assistant message contains its partial content so far). It never waits, polls or freezes the target.`,
  {
    type: "object",
    properties: {
      chat_id: {
        type: "string",
        description:
          "The chat to read: a subagent session id (the target_chat_id from query_subagent / manage_subagent_chat) or a conversation id (from manage_chats list).",
      },
      subagent_id: {
        type: "string",
        description:
          "Alternative to chat_id: a subagent id — reads that subagent's most recently updated chat session.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        default: 12,
        description: "Max recent messages to return (default 12).",
      },
      max_chars: {
        type: "integer",
        minimum: 200,
        maximum: 20000,
        default: 4000,
        description: "Max characters per message content (default 4000).",
      },
      include_tool_results: {
        type: "boolean",
        default: false,
        description:
          "Include larger tool-result payloads (default: compact 300-char previews).",
      },
    },
    additionalProperties: false,
  },
  async (args, ctx) => {
    const chatId = args.chat_id as string | undefined;
    const subagentIdArg = args.subagent_id as string | undefined;
    const limit = Math.min(
      Math.max(1, Number(args.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT),
      HARD_MAX_LIMIT,
    );
    const maxChars = Math.min(
      Math.max(200, Number(args.max_chars ?? DEFAULT_MAX_CHARS) || DEFAULT_MAX_CHARS),
      HARD_MAX_CHARS,
    );
    const includeToolResults = Boolean(args.include_tool_results);

    if (!chatId && !subagentIdArg) {
      return { error: "INVALID_CHAT_ID: provide chat_id (subagent session or conversation id) or subagent_id." };
    }

    // ── 1. SUBAGENT CHAT (live session store) ─────────────────────────────
    // The subagent store IS the live runtime state — the streaming assistant
    // message carries its partial content + isStreaming flag as it grows.
    const { useSubagentStore } = await import("@/stores/subagent-store");
    const subStore = useSubagentStore.getState();

    let session = chatId
      ? subStore.sessions.find((s) => s.id === chatId)
      : undefined;

    // chat_id not a session? It may be a subagent id (callers pass either).
    if (!session && chatId) {
      const byAgent = subStore.subagents.find(
        (a) => a.id === chatId || a.name.toLowerCase() === chatId.toLowerCase(),
      );
      if (byAgent) {
        session = [...subStore.sessions]
          .filter((s) => s.subagentId === byAgent.id)
          .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0];
      }
    }
    // Direct subagent_id param → most recent session of that agent.
    if (!session && subagentIdArg) {
      const agent = subStore.subagents.find(
        (a) => a.id === subagentIdArg || a.name.toLowerCase() === subagentIdArg.toLowerCase(),
      );
      if (agent) {
        session = [...subStore.sessions]
          .filter((s) => s.subagentId === agent.id)
          .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))[0];
      }
    }

    if (session) {
      const agent = subStore.subagents.find((a) => a.id === session!.subagentId);
      const msgs = session.messages;
      const streamingMsg = [...msgs].reverse().find((m) => m.isStreaming);
      const lifecycle = agent?.lifecycle_status ?? "idle";

      // Chat-level status: the live streaming message wins; otherwise the
      // agent's lifecycle vocabulary (idle/planning/working/waiting/
      // reviewing/completed/disposed) mapped onto the shared states.
      let status: string;
      let isComplete: boolean;
      if (streamingMsg) {
        status = "streaming";
        isComplete = false;
      } else if (lifecycle === "planning" || lifecycle === "working" || lifecycle === "reviewing") {
        status = "running";
        isComplete = false;
      } else if (lifecycle === "waiting") {
        status = "waiting_for_tool";
        isComplete = false;
      } else if (lifecycle === "completed") {
        status = "completed";
        isComplete = true;
      } else if (lifecycle === "disposed") {
        status = "completed";
        isComplete = true;
      } else {
        status = "idle";
        isComplete = true;
      }

      const recent = msgs.slice(-limit);
      const messages: ReadChatMessageOut[] = recent.map((m) => {
        const { text, truncated } = truncate(m.content ?? "", maxChars);
        // The runtime writes generation errors as "Error: …" content — surface
        // them as failed status, never as fabricated completion.
        const failed = m.role === "assistant" && !m.isStreaming && /^Error:/.test(m.content ?? "");
        const out: ReadChatMessageOut = {
          messageId: m.id,
          role: m.role,
          status: m.isStreaming ? "streaming" : failed ? "failed" : "completed",
          content: text,
          timestamp: m.timestamp,
        };
        if (truncated) out.truncated = true;
        if (m.toolCalls && m.toolCalls.length > 0) {
          out.toolCalls = m.toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            status: tc.status,
            ...(tc.result !== undefined
              ? {
                  result: previewResult(
                    tc.result,
                    includeToolResults ? TOOL_RESULT_FULL_CHARS : TOOL_RESULT_PREVIEW_CHARS,
                  ),
                }
              : {}),
          }));
        }
        return out;
      });

      return {
        chatId: session.id,
        chatType: "subagent_session",
        title: session.title,
        status,
        isComplete,
        lastUpdatedAt: session.updated_at,
        agent: agent
          ? {
              id: agent.id,
              name: agent.name,
              lifecycle,
              specialty: agent.specialty,
            }
          : undefined,
        messageCount: msgs.length,
        messages,
      };
    }

    // A subagent_id that resolved to nothing is a hard error (the caller
    // explicitly targeted an agent, not a conversation).
    if (subagentIdArg && !chatId) {
      return { error: `CHAT_NOT_FOUND: no subagent or session matches "${subagentIdArg}".` };
    }

    // ── 2. CONVERSATION (live execution state → viewed store → Dexie) ─────
    const convId = chatId as string;
    const conv = await db.conversations.get(convId).catch(() => undefined);
    if (!conv) {
      return { error: `CHAT_NOT_FOUND: no chat or subagent session matches "${convId}".` };
    }
    if (conv.user_id !== ctx.userId) {
      // Same policy as manage_chats — never leak the existence of another
      // user's chat (ACCESS_DENIED reads as not-found here on purpose).
      return { error: `CHAT_NOT_FOUND: no chat or subagent session matches "${convId}".` };
    }
    // CROSS-MODE READ GUARD (mirrors manage_chats): an Agent-mode agent never
    // reads a Code chat and vice versa — mode boundaries must not leak.
    const ownConv = ctx.conversationId ? await db.conversations.get(ctx.conversationId) : undefined;
    const readerMode = ownConv?.mode === "code" ? "code" : "agent";
    const targetMode = conv.mode === "code" ? "code" : "agent";
    if (readerMode !== targetMode) {
      return { error: `CHAT_NOT_FOUND: no chat or subagent session matches "${convId}".` };
    }

    // Live execution (foreground OR background run, incl. reconnect-resumed)
    // — its store is the freshest message state while the turn is open.
    const { executionHub } = await import("@/lib/agent/execution-hub");
    const exec = executionHub.getFor(convId);
    let liveMessages: ChatMessage[] | null = null;
    let execStatus: string | null = null;
    if (exec) {
      const execStore = executionHub.getStore(exec.id);
      if (execStore) {
        liveMessages = [...execStore.getState().messages];
        execStatus = exec.status;
      }
    }

    // Viewed-conversation fallback: after a run finishes (or while the UI
    // shows this chat), the global chat store holds the latest snapshot.
    if (!liveMessages && executionHub.isViewed(convId)) {
      const globalMsgs = (await import("@/stores/chat-store")).useChatStore.getState().messages;
      if (globalMsgs.length > 0) liveMessages = [...globalMsgs];
    }

    if (liveMessages) {
      const anyStreaming = liveMessages.some((m) => m.isStreaming);
      const status =
        execStatus === "running"
          ? anyStreaming
            ? "streaming"
            : "running"
          : (execStatus as string) ?? (anyStreaming ? "streaming" : "idle");
      const isComplete = status === "completed" || status === "idle" || status === "failed" || status === "stopped";
      const recent = liveMessages.slice(-limit);
      return {
        chatId: convId,
        chatType: "conversation",
        title: conv.title ?? "(untitled)",
        status,
        isComplete,
        lastUpdatedAt: conv.updated_at,
        messageCount: liveMessages.length,
        messages: recent.map((m) => chatMessageOut(m, maxChars, includeToolResults)),
      };
    }

    // Persisted history (target not currently generating).
    const rows = await db.messages
      .where("conversation_id")
      .equals(convId)
      .sortBy("created_at");
    const recent = rows.slice(-limit);
    const messages: ReadChatMessageOut[] = recent.map((r) => {
      const { text, truncated } = truncate(r.content ?? "", maxChars);
      const out: ReadChatMessageOut = {
        messageId: r.id,
        role: r.role,
        status: "completed",
        content: text,
        timestamp: r.created_at,
      };
      if (truncated) out.truncated = true;
      if (r.tool_calls && r.tool_calls.length > 0) {
        out.toolCalls = r.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.tool_name,
          status: tc.status ?? "completed",
          ...(tc.result !== undefined && tc.result !== null
            ? {
                result: previewResult(
                  tc.result,
                  includeToolResults ? TOOL_RESULT_FULL_CHARS : TOOL_RESULT_PREVIEW_CHARS,
                ),
              }
            : {}),
        }));
      }
      return out;
    });

    return {
      chatId: convId,
      chatType: "conversation",
      title: conv.title ?? "(untitled)",
      status: "idle",
      isComplete: true,
      lastUpdatedAt: conv.last_message_at ?? conv.updated_at,
      messageCount: rows.length,
      messages,
    };
  },
  false,
  "orchestration",
);

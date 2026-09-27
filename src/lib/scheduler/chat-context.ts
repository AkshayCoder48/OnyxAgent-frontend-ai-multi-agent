"use client";

// ============================================================================
// Chat-context assembly — the SHARED browser-side builder for chat-attached
// scheduled tasks (chat-only model). Used by the AI tools
// (src/lib/tools/scheduled_tasks.ts) and the chat-sync mirror, so the server
// always receives the same shape:
//   { systemPrompt, title?, messages: ChatTurnMessage[] }
//
// The system-prompt resolution is a LIGHT copy of use-chat.ts buildTurnOptions
// (hooks can't be imported here; the constants are duplicated verbatim so a
// scheduled chat runs with the SAME prompt the live chat uses).
// ============================================================================

import type { ChatTurnMessage } from "./types";

// ── System-prompt resolution (verbatim constants from use-chat.ts) ──────────

// The system-prompt base: the Onyx AI framework prompt. Onyx AI is
// OnyxAgent's native agent framework — and the ONLY framework (there is no
// framework selection anymore; it's always used unless the user enables a
// custom system-prompt override).
const ONYX_AI_SYSTEM_PROMPT = `You are an AI agent built with Onyx AI — OnyxAgent's native agent framework. You have access to tools that you can call to help the user.
Follow Onyx AI conventions:
- Call tools using the FUNCTION-CALLING API when they would help answer the user's request. NEVER write tool calls as text (e.g. "Action: run_terminal Input: {...}"). ALWAYS use the tool-calling mechanism.
- Structure your responses clearly with markdown
- When using tools, explain what you're doing briefly
- Handle errors gracefully and suggest alternatives
- Be precise and type-safe in your reasoning`;

const WEB_RESEARCH_DIRECTIVE = `## Web Research & Citations (MANDATORY)
- For EVERY user message that involves facts, current events, technology, documentation, versions, prices, names, or anything verifiable, you MUST call the web_search tool BEFORE answering. NEVER answer such questions purely from memory — search first, then answer from the results.
- The web_search results are NUMBERED (1, 2, 3 …). Cite them inline in your answer with bracket markers like [1] or [2], placed immediately after the claim they support. Example: "Transformers scale well with data and compute[1], though attention is quadratic[2]."
- Every non-trivial factual claim in your answer should carry at least one [n] citation marker. Never invent citation numbers — only cite numbers that exist in the search results you received.
- Use web_fetch to deep-read a promising result when a short snippet is not enough.
- Purely creative tasks (write a story, refactor this file) do not need citations — but anything you state as fact does.`;

/** Resolve the system prompt exactly like use-chat.ts buildTurnOptions (user
 *  override → Onyx AI framework prompt — the only framework, + the
 *  web-research directive). */
export async function resolveChatSystemPrompt(userId: string): Promise<string> {
  try {
    const { settingsService } = await import("@/lib/services");
    const settings = await settingsService.get(userId);
    // Framework selection removed — the app always uses Onyx AI; the stored
    // ai_framework value (if any) is ignored.
    const basePrompt =
      settings.system_prompt_enabled && settings.system_prompt ? settings.system_prompt : ONYX_AI_SYSTEM_PROMPT;
    const base = (basePrompt ?? "").trim();
    return base ? `${base}\n\n${WEB_RESEARCH_DIRECTIVE}` : WEB_RESEARCH_DIRECTIVE;
  } catch {
    return WEB_RESEARCH_DIRECTIVE;
  }
}

// ── Message mapping (store messages / Dexie rows → ChatTurnMessage) ─────────

/** Structural superset covering BOTH the live chat store's ChatMessage (uses
 *  `timestamp`) and the Dexie ConversationMessage rows (use `created_at`). */
export interface ChatTurnSource {
  id?: string;
  role?: string;
  content?: string;
  timestamp?: Date | string;
  created_at?: string;
  parts?: Array<{ type?: string; content?: string }> | null;
}

/** Map chat messages (live store or Dexie rows) to the server ChatTurnMessage
 *  shape (content falls back to the parts' text segments). */
export function toChatTurnMessages(messages: ChatTurnSource[]): ChatTurnMessage[] {
  const out: ChatTurnMessage[] = [];
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant") || !m.id) continue;
    let content = typeof m.content === "string" ? m.content : "";
    if (!content && Array.isArray(m.parts)) {
      content = m.parts
        .filter((p) => p && p.type === "text" && typeof p.content === "string")
        .map((p) => p.content)
        .join("");
    }
    if (!content) continue;
    const ts =
      m.timestamp instanceof Date
        ? m.timestamp.toISOString()
        : typeof m.timestamp === "string" && m.timestamp
          ? m.timestamp
          : typeof m.created_at === "string" && m.created_at
            ? m.created_at
            : new Date().toISOString();
    out.push({ id: m.id, role: m.role, content: content.slice(0, 8_000), createdAt: ts });
  }
  return out.slice(-60);
}

// ── Full context assembly ────────────────────────────────────────────────────

export interface ChatContextPayload {
  systemPrompt: string;
  title?: string;
  messages: ChatTurnMessage[];
}

/**
 * Assemble the chat context (systemPrompt + title + recent messages) for a
 * chat-attached task — read IN THE BROWSER from the live stores. For the
 * CURRENTLY VIEWED conversation the global chat store is the source (exact
 * live content); for other conversations the history is read from Dexie (the
 * global store holds a different chat's messages). Returns null when the
 * browser has no usable context for the chat.
 */
export async function buildChatContext(
  userId: string,
  chatId: string,
): Promise<ChatContextPayload | null> {
  try {
    const { useChatStore, useConversationStore } = await import("@/stores");
    const store = useConversationStore.getState();
    const isCurrent = store.currentConversationId === chatId;
    let messages: ChatTurnMessage[];
    if (isCurrent) {
      messages = toChatTurnMessages(useChatStore.getState().messages as unknown as ChatTurnSource[]);
    } else {
      try {
        const { conversationService } = await import("@/lib/services");
        const rows = await conversationService.getMessages(chatId, userId);
        messages = toChatTurnMessages(rows as unknown as ChatTurnSource[]);
      } catch {
        messages = [];
      }
    }
    let title: string | undefined;
    try {
      const { conversationService } = await import("@/lib/services");
      const conv = await conversationService.get(chatId, userId);
      if (conv?.title) title = conv.title;
    } catch {
      /* title optional */
    }
    const systemPrompt = await resolveChatSystemPrompt(userId);
    return { systemPrompt, ...(title ? { title } : {}), messages };
  } catch {
    return null;
  }
}

/** Standing-task instruction substituted when a chat-attached task is created
 *  with empty instructions (the server requires a non-empty instruction; the
 *  engine's fireChatRun uses the same semantics as its own fallback). */
export const DEFAULT_CHAT_TASK_INSTRUCTIONS =
  "Continue this conversation's standing task and produce the deliverable.";

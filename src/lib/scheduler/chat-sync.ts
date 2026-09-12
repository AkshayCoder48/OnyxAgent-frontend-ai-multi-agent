"use client";

// ============================================================================
// Chat-sync — the BROWSER half of the unified chat records (unified chat
// mode). A scheduled task attached to a conversation runs server-side with
// the chat's history; this module keeps the two sides converged:
//
//   BROWSER → SERVER  mirrorChatToServer()  sync_chat: the browser's current
//                     state (live store for the viewed chat, Dexie otherwise)
//                     as an immutable chat mirror version record, so the next
//                     scheduled run sees the latest history.
//   SERVER → BROWSER  pullServerMessages()  pull_chat: server-appended
//                     messages (scheduled-run results, telegram replies) are
//                     deduped by id, persisted into Dexie (idempotent bulkPut
//                     via conversationService.appendServerMessages) and — when
//                     the user is viewing that chat and nothing is executing —
//                     appended live into the global chat store.
//
// The LINK REGISTRY (localStorage `onyx-chat-links`) lists the conversations
// that have a scheduled task attached; only linked chats are mirrored/pulled.
// Per-chat pull markers (localStorage `onyx-chat-smsg:<chatId>`) hold the
// newest smsg ts36 cursor.
//
// SECURITY: the OnyxBase key is resolved at call time inside
// schedulerApi/syncChat/pullChat (client.ts) — never stored here.
// ============================================================================

import { buildChatContext } from "./chat-context";
import {
  pullChat,
  syncChat,
  type PullChatUpdateView,
  type ServerChatMessageView,
} from "./client";
import type { ServerMessageRowInput } from "@/lib/services";
import type { ChatMessage, MessagePart, ToolCall } from "@/types";
import { conversationMessageToChatMessage, type RawMessage } from "@/lib/conversation-to-chat";

// ---------------------------------------------------------------------------
// Link registry (localStorage `onyx-chat-links` — JSON array of chat ids)
// ---------------------------------------------------------------------------

const LINKS_KEY = "onyx-chat-links";
/** Per-chat pull cursor: `onyx-chat-smsg:<chatId>` = last `nextAfter`. */
const MARKER_PREFIX = "onyx-chat-smsg:";
/** Mirror throttle — at most one sync_chat per chat per 30s (module map). */
const MIRROR_THROTTLE_MS = 30_000;

function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Conversations that have a scheduled task attached (chat mode). */
export function getLinkedChatIds(): string[] {
  const ls = safeLocalStorage();
  if (!ls) return [];
  try {
    const raw = ls.getItem(LINKS_KEY);
    if (!raw) return [];
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter((v): v is string => typeof v === "string" && !!v);
  } catch {
    return [];
  }
}

function isLinkedChat(chatId: string): boolean {
  return getLinkedChatIds().includes(chatId);
}

/** Register a conversation as schedule-attached (idempotent). */
export function addLinkedChat(chatId: string): void {
  const ls = safeLocalStorage();
  if (!ls || !chatId) return;
  const ids = new Set(getLinkedChatIds());
  if (ids.has(chatId)) return;
  ids.add(chatId);
  try {
    ls.setItem(LINKS_KEY, JSON.stringify([...ids]));
  } catch {
    /* quota — best-effort */
  }
}

/** Unregister a schedule-attached conversation (idempotent). */
export function removeLinkedChat(chatId: string): void {
  const ls = safeLocalStorage();
  if (!ls || !chatId) return;
  const ids = getLinkedChatIds();
  if (!ids.includes(chatId)) return;
  const next = ids.filter((id) => id !== chatId);
  try {
    ls.setItem(LINKS_KEY, JSON.stringify(next));
  } catch {
    /* best-effort */
  }
  try {
    ls.removeItem(MARKER_PREFIX + chatId);
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Pull markers
// ---------------------------------------------------------------------------

function readMarker(chatId: string): string | undefined {
  const ls = safeLocalStorage();
  if (!ls) return undefined;
  try {
    return ls.getItem(MARKER_PREFIX + chatId) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeMarker(chatId: string, marker: string): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    ls.setItem(MARKER_PREFIX + chatId, marker);
  } catch {
    /* best-effort */
  }
}

// ---------------------------------------------------------------------------
// Mirror (browser → server)
// ---------------------------------------------------------------------------

const lastMirrorAt = new Map<string, number>();

/**
 * Mirror the BROWSER's current state of a chat to the server (sync_chat).
 * Payload: messages from the live chat store (viewed conversation) or Dexie
 * (other conversations), title via conversationService, systemPrompt exactly
 * like the task-create assembly — see chat-context.buildChatContext. Silent,
 * never throws. Throttled to once per 30s per chat unless `force` (the
 * execution-finished trigger must always land).
 */
export async function mirrorChatToServer(
  userId: string,
  chatId: string,
  opts?: { force?: boolean },
): Promise<void> {
  try {
    if (!userId || !chatId) return;
    // (c) never for unlinked chats — the registry is the source of truth.
    if (!isLinkedChat(chatId)) return;
    const now = Date.now();
    if (!opts?.force && now - (lastMirrorAt.get(chatId) ?? 0) < MIRROR_THROTTLE_MS) return;
    lastMirrorAt.set(chatId, now);
    const ctx = await buildChatContext(userId, chatId);
    if (!ctx) return;
    await syncChat(userId, {
      chatId,
      ...(ctx.title ? { title: ctx.title } : {}),
      ...(ctx.systemPrompt ? { systemPrompt: ctx.systemPrompt } : {}),
      messages: ctx.messages,
    });
  } catch {
    /* silent — the next trigger converges the mirror */
  }
}

// ---------------------------------------------------------------------------
// Pull + merge (server → browser)
// ---------------------------------------------------------------------------

/** Convert a server message to the Dexie row input (toolCalls + timing). */
function serverMessageToRowInput(m: ServerChatMessageView): ServerMessageRowInput {
  const toolCalls: NonNullable<ServerMessageRowInput["toolCalls"]> = [];
  for (const raw of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
    const tc = raw as Partial<ToolCall>;
    if (!tc || typeof tc.id !== "string" || typeof tc.name !== "string") continue;
    toolCalls.push({
      id: tc.id,
      name: tc.name,
      args: (tc.args ?? {}) as Record<string, unknown>,
      result: tc.result,
      status: tc.status === "error" ? "error" : (tc.status ?? "completed"),
      startedAt: typeof tc.startedAt === "number" ? tc.startedAt : undefined,
      endedAt: typeof tc.endedAt === "number" ? tc.endedAt : undefined,
    });
  }
  return {
    id: m.id,
    role: m.role,
    content: typeof m.content === "string" ? m.content : "",
    createdAt: typeof m.createdAt === "string" && m.createdAt ? m.createdAt : new Date().toISOString(),
    thinking: m.thinking ?? null,
    reasoning: m.reasoning ?? null,
    parts: (Array.isArray(m.parts) ? (m.parts as MessagePart[]) : null) as
      | MessagePart[]
      | null,
    toolCalls,
  };
}

/** Convert a server message to the live ChatMessage shape — reusing
 *  conversationMessageToChatMessage so parts/toolCalls convert exactly like
 *  the Dexie→UI hydration path. */
function serverMessageToChatMessage(m: ServerChatMessageView, chatId: string): ChatMessage {
  const raw: RawMessage = {
    id: m.id,
    conversation_id: chatId,
    role: m.role,
    content: typeof m.content === "string" ? m.content : "",
    created_at: typeof m.createdAt === "string" && m.createdAt ? m.createdAt : new Date().toISOString(),
    tool_calls: (Array.isArray(m.toolCalls) ? m.toolCalls : []).map((rawTc) => {
      const tc = rawTc as Partial<ToolCall>;
      return {
        tool_call_id: typeof tc.id === "string" ? tc.id : "",
        tool_name: typeof tc.name === "string" ? tc.name : "",
        args: (tc.args ?? {}) as Record<string, unknown>,
        result: tc.result,
        status: tc.status === "error" ? "failed" : (tc.status ?? "completed"),
      };
    }),
    thinking: m.thinking ?? undefined,
    reasoning: m.reasoning ?? undefined,
    parts: (Array.isArray(m.parts) ? (m.parts as MessagePart[]) : null) as
      | MessagePart[]
      | null
      | undefined,
  };
  return conversationMessageToChatMessage(raw);
}

/**
 * Merge one chat's server messages into the browser: dedupe by id, persist
 * into Dexie (idempotent by primary key), then append live to the global chat
 * store when the user is viewing this conversation and no execution is
 * running for it (the execution's store owns the live view otherwise).
 */
async function mergeServerMessages(
  userId: string,
  update: PullChatUpdateView,
): Promise<void> {
  const chatId = update.chatId;
  if (!chatId || !Array.isArray(update.messages)) return;
  // Dedupe by id — server retries can re-deliver the same batch.
  const seen = new Set<string>();
  const fresh: ServerChatMessageView[] = [];
  for (const m of update.messages) {
    if (!m || typeof m.id !== "string" || seen.has(m.id)) continue;
    seen.add(m.id);
    fresh.push(m);
  }
  if (!fresh.length) return;

  // 1) Persist into Dexie (rows keep the server ids — re-merges overwrite,
  //    never duplicate).
  const { conversationService } = await import("@/lib/services");
  await conversationService.appendServerMessages(
    chatId,
    userId,
    fresh.map(serverMessageToRowInput),
    { title: update.meta?.title },
  );

  // 2) Live append — only for the CURRENTLY VIEWED conversation and only
  //    when no agent execution is running for it (read-only hub lookup; the
  //    execution store is the live source during a run).
  const { useConversationStore, useChatStore } = await import("@/stores");
  const { executionHub } = await import("@/lib/agent/execution-hub");
  if (
    useConversationStore.getState().currentConversationId === chatId &&
    executionHub.getFor(chatId)?.status !== "running"
  ) {
    const existing = new Set(useChatStore.getState().messages.map((m) => m.id));
    for (const m of fresh) {
      if (existing.has(m.id)) continue;
      useChatStore.getState().addMessage(serverMessageToChatMessage(m, chatId));
    }
  }
}

/**
 * Pull server-appended messages for every linked chat (plus the
 * currently-viewed one when it is linked) and merge them into the browser.
 * Advances the per-chat markers. Silent — never throws.
 */
export async function pullServerMessages(userId: string): Promise<void> {
  try {
    if (!userId) return;
    const chatIds = getLinkedChatIds();
    if (!chatIds.length) return;
    const updates = chatIds.slice(0, 50).map((chatId) => {
      const after = readMarker(chatId);
      return after ? { chatId, after } : { chatId };
    });
    const res = await pullChat(userId, updates);
    if (!res.ok || !Array.isArray(res.updates)) return;
    for (const u of res.updates) {
      if (!u || typeof u.chatId !== "string") continue;
      try {
        await mergeServerMessages(userId, u);
      } catch {
        /* per-chat best-effort — other chats still merge */
      }
      if (u.nextAfter) writeMarker(u.chatId, u.nextAfter);
    }
  } catch {
    /* silent — the next poll converges */
  }
}

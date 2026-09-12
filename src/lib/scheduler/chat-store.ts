/**
 * SERVER-side chat KV records — the unified chat-execution storage layer.
 *
 * A scheduled/telegram execution is a schedule attached to an EXISTING chat:
 * the agent runs with the chat's history and its result lands back in that
 * chat. The chat's state lives in OnyxBase KV under the user's account
 * (collection "onyxagent", same durability conventions as the scheduler
 * engine — SEQUENTIAL writes only, immutable version records for mutations,
 * verified critical writes, GC small; see engine.ts + worklog
 * cloud-sync-9hr-fix).
 *
 * KV layout:
 *   chat:<chatId>:mv:<ts36>     — immutable chat MIRROR version records
 *                                 (browser → KV snapshots of the chat)
 *   chat:<chatId>:smsg:<ts36>   — immutable SERVER-APPENDED message batches
 *                                 ({ts, messages: ServerChatMessage[]})
 *   chat:<chatId>:meta          — chat metadata (title, kind) for pull APIs
 *   chat:<chatId>:exv:<ts36>    — immutable chat-EXECUTION version records
 *                                 (written by engine.ts)
 *   chat:<chatId>:execs         — mutable exec envelope {w, execs[]} (engine.ts)
 *
 * Every mutation is a NEW immutable version record (a new Telegram message in
 * OnyxBase's mirror — sends are reliable, edits strand/revert); reads resolve
 * the latest surviving version via the key list. Writes are verified by
 * read-back with one fresh-key rewrite sweep (the engine's writeTaskVerified
 * pattern). Values are capped (~100KB) so no record can bloat the KV.
 */

import type { SchedulerKV } from "./server-kv";
import type { ChatTurnMessage } from "./types";

// Re-exported so consumers can import the chat-record types from either the
// shared types module or this store.
export type { ChatTurnMessage };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Browser-side mirror of a conversation (written via sync_chat / create). */
export interface ChatMirror {
  /** Format version. */
  v: number;
  chatId: string;
  title?: string;
  systemPrompt?: string;
  messages: ChatTurnMessage[];
}

/**
 * A message appended by the SERVER (scheduled runs, telegram webhook replies)
 * that the browser pulls into Dexie + the live store. `parts`/`toolCalls`
 * mirror the browser MessagePart[]/ToolCall[] shapes (type-loose here so the
 * server module needs no client imports).
 */
export interface ServerChatMessage {
  /** e.g. "smsg_<e2bRunId>" (assistant results) or a webhook-chosen id. */
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string | null;
  reasoning?: string | null;
  /** MessagePart[] from eventsToMessage. */
  parts?: unknown[] | null;
  /** ToolCall[] from eventsToMessage. */
  toolCalls?: unknown[] | null;
  createdAt: string;
  origin: "scheduled" | "telegram";
}

export interface ChatMeta {
  id: string;
  title: string;
  kind: "chat" | "telegram";
  createdAt: string;
  updatedAt: string;
}

export interface ChatServerRecord {
  /** The ts36 version marker of the record (the pull cursor). */
  ts36: string;
  key: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHAT_PREFIX = "chat:";
const MIRROR_V_PREFIX = ":mv:";
const SMSG_PREFIX = ":smsg:";
const META_SUFFIX = ":meta";

/** Mirror keeps the last 30 messages (matches buildChatHistory's cap). */
const MAX_MIRROR_MESSAGES = 30;
/** Per-message content cap in the KV records. */
const MAX_MESSAGE_CONTENT = 8_000;
/** Whole-value ceiling (~100KB) — overflow is dropped silently. */
const MAX_VALUE_CHARS = 100_000;
/** Server-message records kept per chat before GC. */
const MAX_SMSG_RECORDS = 20;
/** Immutable mirror version records kept per chat before GC. */
const MIRROR_GC_KEEP = 2;

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

function ts36Now(): string {
  return Date.now().toString(36);
}

function mirrorKey(chatId: string, version: string): string {
  return `${CHAT_PREFIX}${chatId}${MIRROR_V_PREFIX}${version}`;
}

function smsgKey(chatId: string, version: string): string {
  return `${CHAT_PREFIX}${chatId}${SMSG_PREFIX}${version}`;
}

function metaKey(chatId: string): string {
  return `${CHAT_PREFIX}${chatId}${META_SUFFIX}`;
}

/** Robust prefix list — OnyxBase's list endpoint IGNORES the prefix query
 *  param (returns the whole collection) and can hit a stale instance showing
 *  only part of the namespace. Two passes with a settle delay, unioned, then
 *  filtered client-side (same pattern as engine.ts's listKeysRobust, kept
 *  local to avoid a circular import). */
async function listChatKeys(kv: SchedulerKV): Promise<string[]> {
  const union = new Set<string>();
  let sawAny = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const keys = await kv.listKeys(CHAT_PREFIX);
      if (keys.length > 0) sawAny = true;
      for (const k of keys) {
        if (k.startsWith(CHAT_PREFIX)) union.add(k);
      }
    } catch {
      /* retry */
    }
    if (attempt === 1 && sawAny) break;
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1000));
  }
  return [...union];
}

/** Sorted version markers (base36 timestamps sort lexicographically). */
function versionsOf(keys: string[], prefix: string): string[] {
  return keys
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length))
    .filter(Boolean)
    .sort();
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

function capContent(s: string | undefined | null): string {
  if (!s) return "";
  return s.length > MAX_MESSAGE_CONTENT ? s.slice(0, MAX_MESSAGE_CONTENT) : s;
}

/** Cap a message batch to fit the value ceiling — drop overflow silently. */
function capMessageList<T extends { content: string }>(messages: T[]): T[] {
  const capped = messages.map((m) => ({ ...m, content: capContent(m.content) }));
  let kept = capped;
  while (kept.length > 0 && JSON.stringify(kept).length > MAX_VALUE_CHARS) {
    kept = kept.slice(0, Math.max(0, kept.length - 1)); // drop oldest overflow
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Verified immutable-record write (engine writeTaskVerified pattern)
// ---------------------------------------------------------------------------

interface VersionedWriteOpts {
  /** Build the key for a version marker. */
  keyFor: (version: string) => string;
  /** Serialize the value (already size-capped by the caller). */
  value: string;
  /** Key prefix used for GC (e.g. "chat:<id>:mv:"). */
  gcPrefix: string;
  /** How many records GC keeps (including the new one). */
  gcKeep: number;
}

async function writeVersionedVerified(
  kv: SchedulerKV,
  opts: VersionedWriteOpts,
): Promise<{ ok: boolean; key: string; version: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const version = ts36Now() + (attempt > 0 ? "r" : "");
    const key = opts.keyFor(version);
    try {
      await kv.set(key, opts.value);
    } catch {
      continue;
    }
    try {
      const back = await kv.get(key);
      if (back === opts.value) {
        void gcVersionRecords(kv, opts.gcPrefix, opts.gcKeep).catch(() => {});
        return { ok: true, key, version };
      }
    } catch {
      /* probe failed — try a fresh version key */
    }
  }
  return { ok: false, key: "", version: "" };
}

/** Best-effort GC — keep the newest `keep` version records, delete the rest. */
async function gcVersionRecords(kv: SchedulerKV, prefix: string, keep: number): Promise<void> {
  try {
    const keys = await kv.listKeys(CHAT_PREFIX);
    const versions = keys.filter((k) => k.startsWith(prefix)).sort();
    const toDelete = versions.slice(0, Math.max(0, versions.length - keep));
    for (const k of toDelete) {
      try {
        await kv.delete(k);
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* best-effort */
  }
}

/** Read the newest parseable record among sorted version keys (newest first). */
async function readLatestRecord<T>(kv: SchedulerKV, keys: string[]): Promise<T | null> {
  for (const key of keys) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await kv.get(key);
        if (raw) return JSON.parse(raw) as T;
      } catch {
        /* retry / next key */
      }
      if (attempt < 1) await new Promise((r) => setTimeout(r, 600));
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Chat mirror (browser → KV)
// ---------------------------------------------------------------------------

export interface WriteChatMirrorInput {
  chatId: string;
  title?: string;
  systemPrompt?: string;
  messages: ChatTurnMessage[];
}

/**
 * Write a chat mirror snapshot as a NEW immutable version record
 * (chat:<chatId>:mv:<ts36>), verified by read-back, GC'd to 2 versions.
 * Messages are capped to the last 30 with 8KB contents; overflow past the
 * ~100KB value ceiling is dropped silently.
 */
export async function writeChatMirror(kv: SchedulerKV, input: WriteChatMirrorInput): Promise<{ ok: boolean }> {
  const chatId = (input.chatId ?? "").trim();
  if (!chatId) throw new Error("writeChatMirror: chatId is required");
  const messages = capMessageList(
    (input.messages ?? [])
      .filter((m) => m && typeof m.id === "string" && (m.role === "user" || m.role === "assistant"))
      .slice(-MAX_MIRROR_MESSAGES),
  );
  const mirror: ChatMirror = {
    v: 1,
    chatId,
    ...(input.title ? { title: input.title } : {}),
    ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
    messages,
  };
  const r = await writeVersionedVerified(kv, {
    keyFor: (v) => mirrorKey(chatId, v),
    value: JSON.stringify(mirror),
    gcPrefix: mirrorKey(chatId, ""),
    gcKeep: MIRROR_GC_KEEP,
  });
  return { ok: r.ok };
}

/** Read the chat mirror — the newest surviving version record wins. */
export async function readChatMirror(kv: SchedulerKV, chatId: string): Promise<ChatMirror | null> {
  chatId = (chatId ?? "").trim();
  if (!chatId) return null;
  try {
    const keys = await listChatKeys(kv);
    const versions = versionsOf(keys, mirrorKey(chatId, ""));
    if (!versions.length) return null;
    const sortedKeys = versions
      .slice()
      .reverse()
      .map((v) => mirrorKey(chatId, v));
    const mirror = await readLatestRecord<ChatMirror>(kv, sortedKeys);
    if (!mirror || mirror.chatId !== chatId) return null;
    return mirror;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Server-appended messages (server → browser)
// ---------------------------------------------------------------------------

/** Cap one server message for KV storage (content fields 8KB; drop heavy
 *  parts/toolCalls when the serialized record exceeds the value ceiling). */
function capServerMessage(m: ServerChatMessage): ServerChatMessage {
  const capped: ServerChatMessage = {
    id: m.id,
    role: m.role,
    content: capContent(m.content),
    createdAt: m.createdAt,
    origin: m.origin,
  };
  if (m.thinking) capped.thinking = capContent(m.thinking);
  if (m.reasoning) capped.reasoning = capContent(m.reasoning);
  if (m.parts) capped.parts = m.parts;
  if (m.toolCalls) capped.toolCalls = m.toolCalls;
  // Whole-record ceiling — progressively shed the heavy optional fields.
  if (JSON.stringify(capped).length > MAX_VALUE_CHARS) {
    capped.parts = null;
    capped.toolCalls = null;
  }
  return capped;
}

/**
 * Append server messages as ONE immutable record per batch:
 * chat:<chatId>:smsg:<ts36> = {ts, messages}. Verified write; GC keeps the
 * last 20 records.
 */
export async function appendServerMessages(
  kv: SchedulerKV,
  chatId: string,
  messages: ServerChatMessage[],
): Promise<{ ok: boolean; ts36: string }> {
  chatId = (chatId ?? "").trim();
  if (!chatId) throw new Error("appendServerMessages: chatId is required");
  const clean = capMessageList((messages ?? []).map(capServerMessage));
  if (!clean.length) return { ok: true, ts36: "" };
  const value = JSON.stringify({ ts: Date.now(), messages: clean });
  const r = await writeVersionedVerified(kv, {
    keyFor: (v) => smsgKey(chatId, v),
    value,
    gcPrefix: smsgKey(chatId, ""),
    gcKeep: MAX_SMSG_RECORDS,
  });
  return { ok: r.ok, ts36: r.version };
}

/** Record-level view of a chat's server messages (the pull cursor). */
export async function listChatServerRecords(kv: SchedulerKV, chatId: string): Promise<ChatServerRecord[]> {
  chatId = (chatId ?? "").trim();
  if (!chatId) return [];
  try {
    const keys = await listChatKeys(kv);
    const versions = versionsOf(keys, smsgKey(chatId, ""));
    return versions.map((v) => ({ ts36: v, key: smsgKey(chatId, v) }));
  } catch {
    return [];
  }
}

/**
 * Read all server-appended messages (optionally only records AFTER the ts36
 * marker), flattened and sorted by createdAt. Reads are paced-safe (bounded
 * small concurrency — OnyxBase durability applies to WRITES; reads parallelize
 * fine, see engine loadTasks).
 */
export async function readServerMessages(
  kv: SchedulerKV,
  chatId: string,
  afterTs36?: string,
): Promise<ServerChatMessage[]> {
  chatId = (chatId ?? "").trim();
  if (!chatId) return [];
  let versions: string[];
  try {
    const keys = await listChatKeys(kv);
    versions = versionsOf(keys, smsgKey(chatId, ""));
  } catch {
    return [];
  }
  if (afterTs36) versions = versions.filter((v) => v > afterTs36);
  if (!versions.length) return [];
  const out: ServerChatMessage[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(4, versions.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= versions.length) return;
      try {
        const raw = await kv.get(smsgKey(chatId, versions[i]!));
        if (!raw) continue;
        const parsed = JSON.parse(raw) as { messages?: ServerChatMessage[] };
        if (Array.isArray(parsed?.messages)) {
          for (const m of parsed.messages) {
            if (m && typeof m.id === "string" && (m.role === "user" || m.role === "assistant")) out.push(m);
          }
        }
      } catch {
        /* skip unreadable record */
      }
    }
  });
  await Promise.all(workers);
  return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Chat meta
// ---------------------------------------------------------------------------

export async function readChatMeta(kv: SchedulerKV, chatId: string): Promise<ChatMeta | null> {
  chatId = (chatId ?? "").trim();
  if (!chatId) return null;
  try {
    const raw = await kv.get(metaKey(chatId));
    if (!raw) return null;
    const meta = JSON.parse(raw) as ChatMeta;
    if (!meta || meta.id !== chatId) return null;
    return meta;
  } catch {
    return null;
  }
}

export async function writeChatMeta(kv: SchedulerKV, chatId: string, meta: Omit<ChatMeta, "id" | "updatedAt">): Promise<void> {
  chatId = (chatId ?? "").trim();
  if (!chatId) throw new Error("writeChatMeta: chatId is required");
  const rec: ChatMeta = {
    id: chatId,
    title: (meta.title ?? "").slice(0, 300),
    kind: meta.kind === "telegram" ? "telegram" : "chat",
    createdAt: meta.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await kv.set(metaKey(chatId), JSON.stringify(rec));
}

// ---------------------------------------------------------------------------
// Agent context assembly
// ---------------------------------------------------------------------------

export interface ChatHistoryResult {
  systemPrompt?: string;
  history: ChatTurnMessage[];
}

function toTurnMessage(m: ServerChatMessage): ChatTurnMessage {
  return { id: m.id, role: m.role, content: m.content ?? "", createdAt: m.createdAt };
}

/**
 * Build the agent context for a chat execution: mirror messages + server
 * messages, DEDUPED BY MESSAGE ID (a server message merged into the browser's
 * Dexie is mirrored back later with the SAME id — dedup is mandatory to avoid
 * duplicate history entries), sorted by createdAt, capped to the last
 * `maxMessages` (default 30).
 */
export async function buildChatHistory(
  kv: SchedulerKV,
  chatId: string,
  opts?: { maxMessages?: number },
): Promise<ChatHistoryResult> {
  const max = Math.max(1, Math.min(60, opts?.maxMessages ?? 30));
  const [mirror, server] = await Promise.all([readChatMirror(kv, chatId), readServerMessages(kv, chatId)]);
  const merged: ChatTurnMessage[] = [];
  const seen = new Set<string>();
  // Mirror first (browser's canonical copy wins on id collisions)…
  for (const m of mirror?.messages ?? []) {
    if (!m?.id || seen.has(m.id)) continue;
    seen.add(m.id);
    merged.push({ id: m.id, role: m.role, content: m.content ?? "", createdAt: m.createdAt });
  }
  // …then server messages whose ids aren't already present.
  for (const m of server) {
    if (!m?.id || seen.has(m.id)) continue;
    seen.add(m.id);
    merged.push(toTurnMessage(m));
  }
  const history = merged
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    .slice(-max);
  return {
    ...(mirror?.systemPrompt ? { systemPrompt: mirror.systemPrompt } : {}),
    history,
  };
}

// ---------------------------------------------------------------------------
// Pull API (browser merge poller ⇄ server)
// ---------------------------------------------------------------------------

export interface PullChatUpdateRequest {
  chatId: string;
  /** Only records strictly AFTER this ts36 marker. */
  after?: string;
}

export interface PullChatUpdateResponse {
  chatId: string;
  messages: ServerChatMessage[];
  meta?: { title: string; kind: "chat" | "telegram" };
  /** The newest smsg marker for this chat (the next `after` cursor). */
  nextAfter?: string;
}

export interface PullChatResult {
  updates: PullChatUpdateResponse[];
  /** Newest smsg marker across the response (a coarse server clock). */
  serverTime: string;
}

/** The pull_chat action body: `{updates: [{chatId, after?}]}` → the merged
 *  server messages (+ chat meta) for each chat. */
export async function pullChatUpdates(
  kv: SchedulerKV,
  updates: PullChatUpdateRequest[],
): Promise<PullChatResult> {
  const out: PullChatUpdateResponse[] = [];
  let newest = "";
  for (const u of (updates ?? []).slice(0, 50)) {
    const chatId = (u?.chatId ?? "").trim();
    if (!chatId) continue;
    const [messages, records, meta] = await Promise.all([
      readServerMessages(kv, chatId, typeof u.after === "string" ? u.after : undefined),
      listChatServerRecords(kv, chatId),
      readChatMeta(kv, chatId),
    ]);
    const nextAfter = records[records.length - 1]?.ts36 ?? "";
    if (nextAfter > newest) newest = nextAfter;
    out.push({
      chatId,
      messages,
      ...(meta ? { meta: { title: meta.title, kind: meta.kind } } : {}),
      ...(nextAfter ? { nextAfter } : {}),
    });
  }
  return { updates: out, serverTime: newest || Date.now().toString(36) };
}

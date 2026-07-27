"use client";

/**
 * Dexie (IndexedDB) persistence layer — the backendless replacement for the
 * original PostgreSQL + SQLAlchemy backend.
 *
 * Tables mirror the cloned app's existing data model so the existing hooks,
 * services and components (which import types from `@/types`) keep working
 * without modification.
 *
 * NOTE: All files here are NEW. The cloned app's `src/lib/db.ts` (Prisma stub)
 * was removed in a prior task; this is the canonical client going forward.
 */

import Dexie, { type Table } from "dexie";
import type {
  User,
  Conversation,
  ConversationMessage,
  ConversationToolCall,
  MessageRating,
  ConversationShare,
  ChartSpec,
} from "@/types";

// ---------------------------------------------------------------------------
// Row shapes — augment the wire types with the columns the original backend
// stored but that the cloned types collapse into `unknown`/`Record<string, unknown>`.
// Every row keeps a `created_at` / `updated_at` pair so Dexie hooks can mirror
// the SQLAlchemy `TimestampMixin`.
// ---------------------------------------------------------------------------

export interface UserRow extends User {
  /** Encrypted (vault) salt + check string. Never the plaintext passphrase. */
  vault_salt: string;
  vault_check: string;
  /** First-user auto-promotion; admin UI in original app gated on this. */
  is_app_admin?: boolean;
  updated_at: string;
}

export interface ConversationRow extends Conversation {
  /** Last-message preview for sidebar — avoids a join on every list call. */
  last_message_preview?: string | null;
  last_message_at?: string | null;
}

export interface MessageRow extends ConversationMessage {
  /** Reasoning trace persisted alongside `content`. */
  thinking?: string | null;
  reasoning?: string | null;
  /** Ordered timeline (assistant turns). Serialized MessagePart[]. */
  parts?: unknown[] | null;
}

export interface ToolCallRow extends ConversationToolCall {
  /** Free-form error string (status="failed"). */
  error_message?: string | null;
}

export interface ChatFileRow {
  id: string;
  user_id: string;
  message_id?: string | null;
  conversation_id?: string | null;
  filename: string;
  mime_type: string;
  size: number;
  /** OPFS-relative path (e.g. `users/<userId>/files/<id>/<filename>`). */
  storage_path: string;
  file_type: string;
  /** Pre-parsed text content for ingestion into the agent's prompt context. */
  parsed_content?: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRatingRow extends MessageRating {
  updated_at: string;
}

export interface ConversationShareRow extends ConversationShare {}

export interface UserSlashCommandRow {
  id: string;
  user_id: string;
  name: string;
  /** null for built-in overrides; non-null for user-defined custom commands. */
  prompt: string | null;
  is_enabled: boolean;
  created_at: string;
  updated_at: string | null;
}

export interface AIProviderRow {
  id: string;
  user_id: string;
  name: string;
  base_url: string;
  /** Encrypted (vault) API key. */
  api_key_encrypted: string;
  models: string[];
  model_type: "chat" | "responses";
  tools_enabled: boolean;
  /** When true, use the base URL as-is (no /chat/completions suffix). */
  no_prefix?: boolean;
  /** When true, sends `chat_template_kwargs: {"enable_thinking": true}` in
   *  the request body (for providers like Poolside that support native
   *  thinking/reasoning tokens via this parameter). */
  thinking_enabled?: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserSettingsRow {
  id: string;
  user_id: string;
  system_prompt: string | null;
  system_prompt_enabled: boolean;
  /** Encrypted (vault) E2B sandbox key. */
  e2b_api_key_encrypted: string | null;
  /** Encrypted (vault) Tavily key. */
  tavily_api_key_encrypted: string | null;
  /** Encrypted (vault) embeddings key. */
  embeddings_api_key_encrypted: string | null;
  /** Env vars for the sandbox: `{ name: { value, is_secret_encrypted } }`. */
  env_vars: Record<string, { value: string; is_secret: boolean }>;
  /** Catch-all JSON column for future settings. */
  extra: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface MCPServerRow {
  id: string;
  user_id: string;
  name: string;
  transport: "stdio" | "sse" | "streamable_http";
  command?: string | null;
  args: string[];
  env: Record<string, string>;
  url?: string | null;
  headers: Record<string, string>;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CustomToolRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  parameters_schema: Record<string, unknown>;
  impl_kind: "http_webhook" | "python_snippet";
  http_url?: string | null;
  http_headers: Record<string, string>;
  python_source?: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface SkillRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  /** OPFS-relative directory path containing SKILL.md. */
  dir_path: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// Charts/Maps are stored as part of a tool_call's `result` JSONB column. We
// keep a side table for the chart-tool to write structured specs to (mirrors
// the original `chart_tool.py` `ChartSpec` Pydantic model) — kept light so the
// runtime can hydrate chart messages without re-parsing tool-call results.
export interface ChartSpecRow {
  id: string;
  user_id: string;
  conversation_id: string;
  message_id: string;
  tool_call_id: string;
  spec: ChartSpec;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Dexie subclass — typed tables for the whole app.
// ---------------------------------------------------------------------------

export class AppDatabase extends Dexie {
  users!: Table<UserRow, string>;
  conversations!: Table<ConversationRow, string>;
  messages!: Table<MessageRow, string>;
  tool_calls!: Table<ToolCallRow, string>;
  chat_files!: Table<ChatFileRow, string>;
  message_ratings!: Table<MessageRatingRow, string>;
  conversation_shares!: Table<ConversationShareRow, string>;
  user_slash_commands!: Table<UserSlashCommandRow, string>;
  ai_providers!: Table<AIProviderRow, string>;
  user_settings!: Table<UserSettingsRow, string>;
  mcp_servers!: Table<MCPServerRow, string>;
  custom_tools!: Table<CustomToolRow, string>;
  skills!: Table<SkillRow, string>;
  chart_specs!: Table<ChartSpecRow, string>;

  constructor(name = "agent-chat-app") {
    super(name);
    this.version(1).stores({
      // `&` = primary key, `*` = multi-entry, plain = indexed.
      users: "&id, email, is_active, created_at",
      conversations: "&id, user_id, is_archived, is_demo, created_at, updated_at, last_message_at",
      messages: "&id, conversation_id, role, created_at",
      tool_calls: "&id, message_id, tool_call_id, status, started_at",
      chat_files: "&id, user_id, message_id, conversation_id, created_at",
      message_ratings: "&id, message_id, user_id, [message_id+user_id], created_at",
      conversation_shares: "&id, conversation_id, shared_by, shared_with, share_token, created_at",
      user_slash_commands: "&id, user_id, name, [user_id+name], is_enabled",
      ai_providers: "&id, user_id, is_active, created_at",
      user_settings: "&id, user_id",
      mcp_servers: "&id, user_id, is_active, created_at",
      custom_tools: "&id, user_id, is_active, name, created_at",
      skills: "&id, user_id, name, is_active, created_at",
      chart_specs: "&id, user_id, conversation_id, message_id, tool_call_id",
    });

    // Version 2: add [user_id+name] compound index to skills table.
    // This fixes the "KeyPath [user_id+name] on object store skills is not indexed" error.
    this.version(2).stores({
      // Keep all existing stores the same, just update skills.
      users: "&id, email, is_active, created_at",
      conversations: "&id, user_id, is_archived, is_demo, created_at, updated_at, last_message_at",
      messages: "&id, conversation_id, role, created_at",
      tool_calls: "&id, message_id, tool_call_id, status, started_at",
      chat_files: "&id, user_id, message_id, conversation_id, created_at",
      message_ratings: "&id, message_id, user_id, [message_id+user_id], created_at",
      conversation_shares: "&id, conversation_id, shared_by, shared_with, share_token, created_at",
      user_slash_commands: "&id, user_id, name, [user_id+name], is_enabled",
      ai_providers: "&id, user_id, is_active, created_at",
      user_settings: "&id, user_id",
      mcp_servers: "&id, user_id, is_active, created_at",
      custom_tools: "&id, user_id, is_active, name, created_at",
      skills: "&id, user_id, name, [user_id+name], is_active, created_at",
      chart_specs: "&id, user_id, conversation_id, message_id, tool_call_id",
    });
  }
}

// ---------------------------------------------------------------------------
// Singleton + lazy accessor.
//
// `db` is created lazily on first access so SSR (where `indexedDB` is missing)
// doesn't blow up at import time. Components/Hooks should use `getDB()` so the
// creation error is thrown at call-time inside the browser, not at module-eval
// time during a server render.
// ---------------------------------------------------------------------------

let _db: AppDatabase | null = null;
let _dbError: Error | null = null;

/**
 * Lazily construct the Dexie database. Throws if IndexedDB is unavailable
 * (server-side render, private mode, etc.). Callers should catch and surface
 * a friendly "storage unavailable" message.
 */
export function getDB(): AppDatabase {
  if (_db) return _db;
  if (_dbError) throw _dbError;
  try {
    if (typeof indexedDB === "undefined") {
      throw new Error("IndexedDB is unavailable in this environment");
    }
    _db = new AppDatabase();
    return _db;
  } catch (err) {
    _dbError = err instanceof Error ? err : new Error(String(err));
    throw _dbError;
  }
}

/**
 * Convenience singleton. Returns the same instance every call after first
 * construction. Use `getDB()` if you need explicit error handling.
 */
export const db: AppDatabase = new Proxy({} as AppDatabase, {
  get(_target, prop) {
    const instance = getDB();
    // @ts-expect-error — pass through any property access on the Dexie instance
    const value = instance[prop];
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

/**
 * Wipe every table. Used by the auth "logout everywhere" / factory-reset flow.
 */
export async function wipeAllData(): Promise<void> {
  const d = getDB();
  await Promise.all([
    d.users.clear(),
    d.conversations.clear(),
    d.messages.clear(),
    d.tool_calls.clear(),
    d.chat_files.clear(),
    d.message_ratings.clear(),
    d.conversation_shares.clear(),
    d.user_slash_commands.clear(),
    d.ai_providers.clear(),
    d.user_settings.clear(),
    d.mcp_servers.clear(),
    d.custom_tools.clear(),
    d.skills.clear(),
    d.chart_specs.clear(),
  ]);
}

/**
 * Wipe a single user's data — used on account deletion. Cascades through every
 * table that carries a `user_id` foreign-key-equivalent.
 */
export async function wipeUserData(userId: string): Promise<void> {
  const d = getDB();
  // Conversation IDs first (messages/tool_calls/files reference them).
  const conversationIds = (await d.conversations
    .where("user_id")
    .equals(userId)
    .primaryKeys()) as string[];
  if (conversationIds.length > 0) {
    await d.messages.where("conversation_id").anyOf(conversationIds).delete();
    // Tool-call rows reference message_id; fetch then bulk delete.
    const messageIds = (await d.messages
      .where("conversation_id")
      .anyOf(conversationIds)
      .primaryKeys()) as string[];
    if (messageIds.length > 0) {
      await d.tool_calls.where("message_id").anyOf(messageIds).delete();
      await d.message_ratings.where("message_id").anyOf(messageIds).delete();
      await d.chart_specs.where("message_id").anyOf(messageIds).delete();
    }
    await d.conversation_shares.where("conversation_id").anyOf(conversationIds).delete();
  }
  await d.chat_files.where("user_id").equals(userId).delete();
  await d.user_slash_commands.where("user_id").equals(userId).delete();
  await d.ai_providers.where("user_id").equals(userId).delete();
  await d.user_settings.where("user_id").equals(userId).delete();
  await d.mcp_servers.where("user_id").equals(userId).delete();
  await d.custom_tools.where("user_id").equals(userId).delete();
  await d.skills.where("user_id").equals(userId).delete();
  await d.conversations.where("user_id").equals(userId).delete();
  await d.users.delete(userId);
}

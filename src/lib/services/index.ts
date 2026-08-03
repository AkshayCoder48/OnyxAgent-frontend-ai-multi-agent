"use client";

/**
 * Service layer — thin async wrappers over Dexie tables + crypto vault.
 *
 * Each service mirrors the original backend's `app/services/*.py` shape so the
 * cloned app's hooks (`use-conversations`, `use-auth`, `use-slash-commands`,
 * `use-data`, …) keep working once their `apiClient.get/post/...` calls are
 * repointed at these local services.
 *
 * Constraints:
 *   - All methods are async (even when the underlying op is sync) so the
 *     caller can swap in a server backend later without touching call sites.
 *   - Encrypted columns (api_key, e2b_key, env-var secrets) are decrypted
 *     lazily by the caller via `vaultDecrypt` — services never expose
 *     plaintext in returned rows.
 *   - IDs are generated with `nanoid` (already in the cloned app's deps).
 */

import { nanoid } from "nanoid";
import { db, getDB, wipeUserData, type AIProviderRow, type ConversationRow, type ToolCallRow, type UserSettingsRow } from "@/lib/db";
import {
  createVault,
  unlockVault,
  setVault,
  isVaultUnlocked,
  vaultEncrypt,
  vaultDecrypt,
  requireVault,
} from "@/lib/crypto/vault";
// Lazy-load the E2B sandbox client . The class lives at
// `@/lib/e2b/client` for back-compat with the existing import paths; it
// now talks to E2B's REST API instead of the old proxy.
let _evictAllE2BClients: (() => void) | null = null;
async function evictAllE2BClients() {
  if (!_evictAllE2BClients) {
    try {
      const mod = await import("@/lib/e2b/client");
      _evictAllE2BClients = mod.evictAllE2BClients;
    } catch {
      // Sandbox client not available — no-op.
      return;
    }
  }
  _evictAllE2BClients();
}
/** Alias for forward-compat — clears all cached sandbox clients. */
const evictAllSandboxClients = evictAllE2BClients;
import type {
  User,
  Conversation,
  ConversationMessage,
  ConversationShare,
  MessageRating,
} from "@/types";
import { RatingValue } from "@/types";
import type { UserSlashCommandRecord } from "@/lib/slash-commands-api";

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function nowISO(): string {
  return new Date().toISOString();
}

async function bumpConversationTimestamp(conversationId: string): Promise<void> {
  const ts = nowISO();
  await db.conversations.update(conversationId, { updated_at: ts });
}

// ---------------------------------------------------------------------------
// authService — register / login / logout / profile.
// ---------------------------------------------------------------------------

export const authService = {
  async register(
    email: string,
    fullName: string | undefined,
    passphrase: string,
  ): Promise<{ user: User; requiresUnlock: false }> {
    const d = getDB();
    email = email.trim().toLowerCase();
    if (!email) throw new Error("Email is required");
    if (!passphrase || passphrase.length < 6) {
      throw new Error("Passphrase must be at least 6 characters");
    }
    const existing = await d.users.where("email").equals(email).first();
    if (existing) {
      throw new Error("An account with this email already exists");
    }
    // First-user auto-promotion to admin (mirrors the original backend).
    const userCount = await d.users.count();
    const isFirst = userCount === 0;
    const { salt, check, key } = await createVault(passphrase);
    const id = nanoid();
    const ts = nowISO();
    const row = {
      id,
      email,
      full_name: fullName ?? null,
      is_active: true,
      role: isFirst ? "ADMIN" : "USER",
      is_app_admin: isFirst,
      created_at: ts,
      updated_at: ts,
      avatar_url: null,
      onboarding_completed_at: null,
      vault_salt: salt,
      vault_check: check,
    };
    await d.users.add(row);
    setVault(key);
    const { vault_salt, vault_check, is_app_admin, updated_at, ...user } = row;
    return { user: user as User, requiresUnlock: false };
  },

  async login(
    email: string,
    passphrase: string,
  ): Promise<User> {
    const d = getDB();
    email = email.trim().toLowerCase();
    const row = await d.users.where("email").equals(email).first();
    if (!row) throw new Error("Invalid email or passphrase");
    const key = await unlockVault(passphrase, row.vault_salt, row.vault_check);
    const { vault_salt, vault_check, is_app_admin, updated_at, ...user } = row;
    return user as User;
  },

  async logout(): Promise<void> {
    setVault(null);
    void evictAllE2BClients();
  },

  async getCurrentUser(userId: string): Promise<User | null> {
    const row = await db.users.get(userId);
    if (!row) return null;
    const { vault_salt, vault_check, is_app_admin, updated_at, ...user } = row;
    return user as User;
  },

  async completeOnboarding(userId: string): Promise<User> {
    const ts = nowISO();
    await db.users.update(userId, {
      onboarding_completed_at: ts,
      updated_at: ts,
    });
    const updated = await db.users.get(userId);
    if (!updated) throw new Error("User not found");
    const { vault_salt, vault_check, is_app_admin, updated_at, ...user } = updated;
    return user as User;
  },

  async updateProfile(
    userId: string,
    patch: { full_name?: string | null; avatar_url?: string | null; email?: string | null },
  ): Promise<User> {
    const ts = nowISO();
    const update: Record<string, unknown> = { updated_at: ts };
    if (patch.full_name !== undefined) update.full_name = patch.full_name;
    if (patch.avatar_url !== undefined) update.avatar_url = patch.avatar_url;
    if (patch.email !== undefined && patch.email !== null) {
      // Normalize + dedupe to keep the column unique-by-convention.
      update.email = patch.email.trim().toLowerCase();
    }
    await db.users.update(userId, update);
    const updated = await db.users.get(userId);
    if (!updated) throw new Error("User not found");
    const { vault_salt, vault_check, is_app_admin, updated_at: _u, ...user } = updated;
    return user as User;
  },

  async deleteAccount(userId: string): Promise<void> {
    await wipeUserData(userId);
    setVault(null);
    void evictAllE2BClients();
  },

  isVaultUnlocked,
  requireVault,
};

// ---------------------------------------------------------------------------
// conversationService — list / get / create / update / archive / delete +
//   message + tool-call persistence.
// ---------------------------------------------------------------------------

export interface AddMessageInput {
  role: "user" | "assistant" | "system";
  content: string;
  thinking?: string;
  reasoning?: string;
  /** Ordered timeline parts (assistant turns). Persisted as JSON in `parts`. */
  parts?: import("@/types/chat").MessagePart[];
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    result?: unknown;
    status?: "pending" | "running" | "completed" | "error";
  }>;
  fileIds?: string[];
  modelName?: string;
  tokensUsed?: number;
}

export const conversationService = {
  async list(
    userId: string,
    opts: { includeArchived?: boolean; limit?: number; skip?: number } = {},
  ): Promise<Conversation[]> {
    const { includeArchived = true, limit = 50, skip = 0 } = opts;
    let collection = db.conversations.where("user_id").equals(userId);
    const all = await collection.toArray();
    let filtered = includeArchived ? all : all.filter((c) => !c.is_archived);
    filtered.sort((a, b) =>
      (b.updated_at ?? "").localeCompare(a.updated_at ?? ""),
    );
    return filtered.slice(skip, skip + limit).map(toConversation);
  },

  async get(id: string, userId: string): Promise<Conversation | null> {
    const row = await db.conversations.get(id);
    if (!row || row.user_id !== userId) return null;
    return toConversation(row);
  },

  async create(userId: string, title?: string): Promise<Conversation> {
    const id = nanoid();
    const ts = nowISO();
    const row: ConversationRow = {
      id,
      user_id: userId,
      title: title ?? undefined,
      created_at: ts,
      updated_at: ts,
      is_archived: false,
      is_demo: false,
      last_message_preview: null,
      last_message_at: null,
    };
    await db.conversations.add(row);
    return toConversation(row);
  },

  async update(
    id: string,
    patch: Partial<Pick<Conversation, "title" | "is_archived" | "is_demo" | "active_knowledge_base_ids">>,
  ): Promise<void> {
    const update: Partial<ConversationRow> = { updated_at: nowISO() };
    if (patch.title !== undefined) update.title = patch.title;
    if (patch.is_archived !== undefined) update.is_archived = patch.is_archived;
    if (patch.is_demo !== undefined) update.is_demo = patch.is_demo;
    if (patch.active_knowledge_base_ids !== undefined) {
      update.active_knowledge_base_ids = patch.active_knowledge_base_ids;
    }
    await db.conversations.update(id, update);
  },

  async archive(id: string, archived: boolean): Promise<void> {
    await this.update(id, { is_archived: archived });
  },

  async delete(id: string): Promise<void> {
    const messageIds = (await db.messages.where("conversation_id").equals(id).primaryKeys()) as string[];
    if (messageIds.length > 0) {
      await db.tool_calls.where("message_id").anyOf(messageIds).delete();
      await db.message_ratings.where("message_id").anyOf(messageIds).delete();
      await db.chart_specs.where("message_id").anyOf(messageIds).delete();
    }
    await db.messages.where("conversation_id").equals(id).delete();
    await db.conversation_shares.where("conversation_id").equals(id).delete();
    await db.conversations.delete(id);
  },

  async getMessages(conversationId: string): Promise<ConversationMessage[]> {
    const rows = await db.messages
      .where("conversation_id")
      .equals(conversationId)
      .sortBy("created_at");
    // Load tool calls for all these messages in one query.
    const messageIds = rows.map((r) => r.id);
    const toolRows = messageIds.length > 0
      ? await db.tool_calls.where("message_id").anyOf(messageIds).toArray()
      : [];
    const toolsByMessage = new Map<string, typeof toolRows>();
    for (const tr of toolRows) {
      const arr = toolsByMessage.get(tr.message_id) ?? [];
      arr.push(tr);
      toolsByMessage.set(tr.message_id, arr);
    }
    return rows.map((m) => {
      const myTools = toolsByMessage.get(m.id) ?? [];
      return {
        ...m,
        thinking: m.thinking ?? null,
        reasoning: m.reasoning ?? null,
        parts: m.parts, // keep persisted parts (JSON array)
        tool_calls: myTools.map((t) => ({
          id: t.id,
          message_id: t.message_id,
          tool_call_id: t.tool_call_id,
          tool_name: t.tool_name,
          args: t.args,
          result: t.result,
          status: t.status as ConversationToolCallStatus,
          started_at: t.started_at,
          completed_at: t.completed_at,
          duration_ms: t.duration_ms,
        })),
      } as ConversationMessage;
    });
  },

  async addMessage(
    conversationId: string,
    userId: string,
    input: AddMessageInput,
  ): Promise<ConversationMessage> {
    const id = nanoid();
    const ts = nowISO();
    // Persist message row.
    const messageRow = {
      id,
      conversation_id: conversationId,
      role: input.role,
      content: input.content,
      created_at: ts,
      model_name: input.modelName,
      tokens_used: input.tokensUsed,
      tool_calls: [],
      files: [],
      thinking: input.thinking ?? null,
      reasoning: input.reasoning ?? null,
      parts: input.parts ?? null,
    };
    await db.messages.add(messageRow);
    await bumpConversationTimestamp(conversationId);
    // Update last-message preview on the conversation.
    await db.conversations.update(conversationId, {
      last_message_preview: input.content.slice(0, 200),
      last_message_at: ts,
    });
    // Persist tool calls if any.
    if (input.toolCalls && input.toolCalls.length > 0) {
      const toolRows: ToolCallRow[] = input.toolCalls.map((tc): ToolCallRow => ({
        id: nanoid(),
        message_id: id,
        tool_call_id: tc.id,
        tool_name: tc.name,
        args: tc.args,
        result:
          typeof tc.result === "string" ? tc.result : JSON.stringify(tc.result ?? null),
        status: (tc.status ?? "completed") === "error" ? "failed" : "completed",
        started_at: ts,
        completed_at: ts,
        duration_ms: 0,
      }));
      await db.tool_calls.bulkAdd(toolRows);
      // Attach to the returned message shape.
      (messageRow as ConversationMessage).tool_calls = toolRows.map((t) => ({
        id: t.id,
        message_id: t.message_id,
        tool_call_id: t.tool_call_id,
        tool_name: t.tool_name,
        args: t.args,
        result: t.result,
        status: t.status as ConversationToolCallStatus,
        started_at: t.started_at,
        completed_at: t.completed_at,
        duration_ms: t.duration_ms,
      }));
    }
    // Link attached file IDs.
    if (input.fileIds && input.fileIds.length > 0) {
      await db.chat_files
        .where("id")
        .anyOf(input.fileIds)
        .modify({ message_id: id, conversation_id: conversationId });
    }
    // Return message — keep thinking/reasoning/parts now that
    // ConversationMessage exposes them.
    return messageRow as unknown as ConversationMessage;
  },

  async deleteMessage(conversationId: string, messageId: string): Promise<void> {
    await db.tool_calls.where("message_id").equals(messageId).delete();
    await db.message_ratings.where("message_id").equals(messageId).delete();
    await db.messages.delete(messageId);
    await bumpConversationTimestamp(conversationId);
  },
};

type ConversationToolCallStatus = "pending" | "running" | "completed" | "failed";

function toConversation(row: {
  id: string;
  user_id?: string;
  title?: string | null;
  created_at: string;
  updated_at: string;
  is_archived: boolean;
  is_demo: boolean;
  active_knowledge_base_ids?: string[];
  last_message_preview?: string | null;
  last_message_at?: string | null;
}): Conversation {
  const {
    id,
    user_id,
    title,
    created_at,
    updated_at,
    is_archived,
    is_demo,
    active_knowledge_base_ids,
  } = row;
  return {
    id,
    user_id,
    title: title ?? undefined,
    created_at,
    updated_at,
    is_archived,
    is_demo,
    active_knowledge_base_ids,
  };
}

// ---------------------------------------------------------------------------
// ratingService — message likes/dislikes.
// ---------------------------------------------------------------------------

export const ratingService = {
  async rate(
    messageId: string,
    userId: string,
    rating: RatingValue,
    comment?: string,
  ): Promise<MessageRating> {
    const existing = await db.message_ratings
      .where("[message_id+user_id]")
      .equals([messageId, userId])
      .first();
    const ts = nowISO();
    if (existing) {
      await db.message_ratings.update(existing.id, {
        rating,
        comment: comment ?? null,
        updated_at: ts,
      });
      const updated = await db.message_ratings.get(existing.id);
      return updated as MessageRating;
    }
    const id = nanoid();
    const row: MessageRating = {
      id,
      message_id: messageId,
      user_id: userId,
      rating,
      comment: comment ?? null,
      created_at: ts,
      updated_at: ts,
    };
    await db.message_ratings.add({ ...row, updated_at: ts });
    return row;
  },

  async remove(messageId: string, userId: string): Promise<void> {
    const existing = await db.message_ratings
      .where("[message_id+user_id]")
      .equals([messageId, userId])
      .first();
    if (existing) await db.message_ratings.delete(existing.id);
  },

  async getMessageRatings(messageId: string): Promise<{
    likes: number;
    dislikes: number;
    user_rating: RatingValue | null;
  }> {
    const rows = await db.message_ratings.where("message_id").equals(messageId).toArray();
    return {
      likes: rows.filter((r) => r.rating === RatingValue.LIKE).length,
      dislikes: rows.filter((r) => r.rating === RatingValue.DISLIKE).length,
      user_rating: null,
    };
  },
};

// ---------------------------------------------------------------------------
// shareService — conversation sharing (local + lz-string URL hash).
// ---------------------------------------------------------------------------

export const shareService = {
  async share(
    conversationId: string,
    sharedBy: string,
    opts: { sharedWith?: string; permission?: "view" | "edit" } = {},
  ): Promise<ConversationShare> {
    const id = nanoid();
    const ts = nowISO();
    const row: ConversationShare = {
      id,
      conversation_id: conversationId,
      shared_by: sharedBy,
      shared_with: opts.sharedWith,
      share_token: opts.sharedWith ? undefined : nanoid(32),
      permission: opts.permission ?? "view",
      created_at: ts,
    };
    await db.conversation_shares.add(row);
    return row;
  },

  async listForConversation(conversationId: string, ownerId: string): Promise<ConversationShare[]> {
    const conv = await db.conversations.get(conversationId);
    if (!conv || conv.user_id !== ownerId) return [];
    return db.conversation_shares.where("conversation_id").equals(conversationId).toArray();
  },

  async revoke(shareId: string, ownerId: string): Promise<void> {
    const share = await db.conversation_shares.get(shareId);
    if (!share) return;
    const conv = await db.conversations.get(share.conversation_id);
    if (!conv || conv.user_id !== ownerId) return;
    await db.conversation_shares.delete(shareId);
  },

  async listSharedWithMe(userId: string): Promise<ConversationShare[]> {
    return db.conversation_shares.where("shared_with").equals(userId).toArray();
  },

  async getByToken(token: string): Promise<ConversationShare | null> {
    const share = await db.conversation_shares.where("share_token").equals(token).first();
    return share ?? null;
  },
};

// ---------------------------------------------------------------------------
// slashCommandService — list / createCustom / update / toggleBuiltin / delete
//   + seedBuiltinSlashCommands (summarize, translate, explain, improve, debug).
// ---------------------------------------------------------------------------

const BUILTIN_SLASH_COMMANDS = [
  { name: "summarize", prompt: "Please give me a concise summary of our conversation so far — key topics, decisions, and any open questions." },
  { name: "translate", prompt: "Translate the following text into the language I specify. If I don't specify a language, ask me which one I want." },
  { name: "explain", prompt: "Explain your last response again, in simpler terms — assume I don't have technical background." },
  { name: "improve", prompt: "Improve the writing of the following text — fix grammar, tighten prose, and keep the original meaning." },
  { name: "debug", prompt: "Help me debug the following code or error. Walk through what's likely wrong and propose a fix." },
];

export const slashCommandService = {
  async list(userId: string): Promise<UserSlashCommandRecord[]> {
    const rows = await db.user_slash_commands.where("user_id").equals(userId).toArray();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      prompt: r.prompt,
      is_enabled: r.is_enabled,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
  },

  async createCustom(
    userId: string,
    input: { name: string; prompt: string; is_enabled?: boolean },
  ): Promise<UserSlashCommandRecord> {
    const name = input.name.trim().replace(/^\/+/, "");
    if (!name) throw new Error("Command name is required");
    const existing = await db.user_slash_commands
      .where("[user_id+name]")
      .equals([userId, name])
      .first();
    if (existing) throw new Error(`Command /${name} already exists`);
    const id = nanoid();
    const ts = nowISO();
    const row = {
      id,
      user_id: userId,
      name,
      prompt: input.prompt,
      is_enabled: input.is_enabled ?? true,
      created_at: ts,
      updated_at: ts,
    };
    await db.user_slash_commands.add(row);
    return row;
  },

  async update(
    id: string,
    patch: { name?: string; prompt?: string; is_enabled?: boolean },
  ): Promise<UserSlashCommandRecord> {
    const existing = await db.user_slash_commands.get(id);
    if (!existing) throw new Error("Slash command not found");
    const update: Record<string, unknown> = { updated_at: nowISO() };
    if (patch.name !== undefined) update.name = patch.name.trim().replace(/^\/+/, "");
    if (patch.is_enabled !== undefined) update.is_enabled = patch.is_enabled;
    // Built-in overrides can't have their prompt updated.
    if (patch.prompt !== undefined && existing.prompt !== null) {
      update.prompt = patch.prompt;
    }
    await db.user_slash_commands.update(id, update);
    const updated = await db.user_slash_commands.get(id);
    return updated as UserSlashCommandRecord;
  },

  async toggleBuiltin(
    userId: string,
    name: string,
    isEnabled: boolean,
  ): Promise<UserSlashCommandRecord> {
    const existing = await db.user_slash_commands
      .where("[user_id+name]")
      .equals([userId, name])
      .first();
    if (existing) {
      await db.user_slash_commands.update(existing.id, {
        is_enabled: isEnabled,
        updated_at: nowISO(),
      });
      return (await db.user_slash_commands.get(existing.id)) as UserSlashCommandRecord;
    }
    const id = nanoid();
    const ts = nowISO();
    const row = {
      id,
      user_id: userId,
      name,
      prompt: null,
      is_enabled: isEnabled,
      created_at: ts,
      updated_at: ts,
    };
    await db.user_slash_commands.add(row);
    return row;
  },

  async delete(id: string): Promise<void> {
    await db.user_slash_commands.delete(id);
  },

  /**
   * Seed the five built-in slash commands as `is_enabled: true` overrides so
   * they show up in `mergeWithUserCommands` even before the user toggles
   * anything. Idempotent — skips rows that already exist for this user.
   */
  async seedBuiltinSlashCommands(userId: string): Promise<void> {
    for (const cmd of BUILTIN_SLASH_COMMANDS) {
      const existing = await db.user_slash_commands
        .where("[user_id+name]")
        .equals([userId, cmd.name])
        .first();
      if (existing) continue;
      const id = nanoid();
      const ts = nowISO();
      await db.user_slash_commands.add({
        id,
        user_id: userId,
        name: cmd.name,
        prompt: cmd.prompt,
        is_enabled: true,
        created_at: ts,
        updated_at: ts,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// aiProviderService — list / create / update / delete / test.
// ---------------------------------------------------------------------------

export interface AIProviderInput {
  name: string;
  base_url: string;
  api_key: string;
  models: string[];
  model_type?: "chat" | "responses";
  tools_enabled?: boolean;
  no_prefix?: boolean;
  thinking_enabled?: boolean;
  is_active?: boolean;
}

export const aiProviderService = {
  async list(userId: string, activeOnly = false): Promise<AIProviderRow[]> {
    let collection = db.ai_providers.where("user_id").equals(userId);
    const rows = await collection.toArray();
    return activeOnly ? rows.filter((r) => r.is_active) : rows;
  },

  async create(userId: string, input: AIProviderInput): Promise<AIProviderRow> {
    const encryptedKey = input.api_key ? await vaultEncrypt(input.api_key) : "";
    const id = nanoid();
    const ts = nowISO();
    const row: AIProviderRow = {
      id,
      user_id: userId,
      name: input.name,
      base_url: input.base_url,
      api_key_encrypted: encryptedKey,
      models: input.models,
      model_type: input.model_type ?? "chat",
      tools_enabled: input.tools_enabled ?? true,
      no_prefix: input.no_prefix ?? false,
      thinking_enabled: input.thinking_enabled ?? false,
      is_active: input.is_active ?? true,
      created_at: ts,
      updated_at: ts,
    };
    await db.ai_providers.add(row);
    return row;
  },

  async update(id: string, patch: Partial<AIProviderInput>): Promise<AIProviderRow> {
    const existing = await db.ai_providers.get(id);
    if (!existing) throw new Error("Provider not found");
    const update: Partial<AIProviderRow> = { updated_at: nowISO() };
    if (patch.name !== undefined) update.name = patch.name;
    if (patch.base_url !== undefined) update.base_url = patch.base_url;
    if (patch.models !== undefined) update.models = patch.models;
    if (patch.model_type !== undefined) update.model_type = patch.model_type;
    if (patch.tools_enabled !== undefined) update.tools_enabled = patch.tools_enabled;
    if (patch.no_prefix !== undefined) update.no_prefix = patch.no_prefix;
    if (patch.thinking_enabled !== undefined) update.thinking_enabled = patch.thinking_enabled;
    if (patch.is_active !== undefined) update.is_active = patch.is_active;
    // api_key: empty string clears, non-empty rotates.
    if (patch.api_key !== undefined) {
      if (patch.api_key === "") {
        update.api_key_encrypted = "";
      } else {
        update.api_key_encrypted = await vaultEncrypt(patch.api_key);
      }
    }
    await db.ai_providers.update(id, update);
    return (await db.ai_providers.get(id)) as AIProviderRow;
  },

  async delete(id: string): Promise<void> {
    await db.ai_providers.delete(id);
  },

  async getDecryptedApiKey(id: string): Promise<string> {
    const row = await db.ai_providers.get(id);
    if (!row) throw new Error("Provider not found");
    if (!row.api_key_encrypted) return "";
    return vaultDecrypt(row.api_key_encrypted);
  },

  /**
   * Probe a provider with a 16-token "Reply pong" Chat Completions request.
   * Routes through `/api/chat-proxy` for CORS. Returns `{ ok, status_code,
   * detail, sample_response }` — same shape as the original backend's
   * `AIProviderTestResult`.
   */
  async test(
    id: string,
    model?: string,
  ): Promise<{
    ok: boolean;
    status_code: number;
    detail: string;
    sample_response: string;
  }> {
    const provider = await db.ai_providers.get(id);
    if (!provider) throw new Error("Provider not found");
    const apiKey = provider.api_key_encrypted
      ? await vaultDecrypt(provider.api_key_encrypted)
      : "";
    const targetModel = model ?? provider.models[0] ?? "gpt-4o-mini";
    const base = provider.base_url.replace(/\/$/, "");
    const targetUrl = provider.no_prefix ? base : `${base}/chat/completions`;
    try {
      const res = await fetch(`/api/chat-proxy?url=${encodeURIComponent(targetUrl)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-target-url": targetUrl,
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: targetModel,
          messages: [{ role: "user", content: "Reply pong" }],
          max_tokens: 16,
          stream: false,
        }),
      });
      const text = await res.text();
      let sample = "";
      try {
        const obj = JSON.parse(text);
        sample = obj.choices?.[0]?.message?.content ?? text.slice(0, 200);
      } catch {
        sample = text.slice(0, 200);
      }
      return {
        ok: res.ok,
        status_code: res.status,
        detail: res.ok ? "OK" : `HTTP ${res.status}`,
        sample_response: sample,
      };
    } catch (err) {
      return {
        ok: false,
        status_code: 0,
        detail: err instanceof Error ? err.message : String(err),
        sample_response: "",
      };
    }
  },
};

// ---------------------------------------------------------------------------
// settingsService — system prompt + env vars + E2B sandbox key.
//
// The DB column is still called `e2b_api_key_encrypted` for back-compat
// (renaming it would require a migration). All public methods have both a
// `*`*E2BKey` legacy name AND a `*SandboxKey` alias so call sites can use
// either.
// ---------------------------------------------------------------------------

export interface UserSettings {
  system_prompt: string | null;
  system_prompt_enabled: boolean;
  /** Present-mapped alias for `sandbox_api_key_present`. Both fields are
   *  always equal — kept for back-compat with code that reads the legacy
   *  `e2b_api_key_present` name. */
  e2b_api_key_present: boolean;
  /** Whether an E2B sandbox API key is stored (encrypted). */
  sandbox_api_key_present: boolean;
  tavily_api_key_present: boolean;
  embeddings_api_key_present: boolean;
  /** Whether a SkillsMP marketplace API key is stored (encrypted in
   *  `extra.skillsmp_api_key_encrypted`). Optional — anonymous access works
   *  for basic search (50 req/day), an API key raises the limit to 500/day. */
  skillsmp_api_key_present: boolean;
  /** Whether a LangSearch web-search API key is stored (encrypted in
   *  `extra.langsearch_api_key_encrypted`). When present, the `web_search`
   *  and `news_search` tools route through LangSearch's hybrid search API
   *  (https://api.langsearch.com/v1/web-search) instead of the default
   *  DuckDuckGo scraper — yielding richer summaries and better recall.
   *  When absent, the tools transparently fall back to DuckDuckGo. */
  langsearch_api_key_present: boolean;
  env_vars: Array<{ name: string; is_secret: boolean; value_present: boolean }>;
  /** When true, the agent runtime skips HITL approval for tools flagged
   *  `requires_approval` (e.g. `run_terminal`). Stored under `extra`. */
  auto_approve_tools: boolean;
  /** "auto" (default — uses E2B sandbox if key set, else local), "local"
   *  (always local), "hopx" (legacy alias for E2B sandbox — errors if no key).
   *  Stored under `extra.file_system_mode`. */
  file_system_mode?: "auto" | "local" | "hopx";
  /** Sandbox allocation strategy: "shared" (default — one sandbox per
   *  API key, reused across all conversations) or "separate" (one
   *  sandbox per conversation — isolation at the cost of more sandboxes).
   *  Stored under `extra.sandbox_mode`. */
  sandbox_mode?: "shared" | "separate";
  /** AI framework preset — changes the system prompt to match the framework's
   *  conventions. "default" = generic assistant, "pydantic_ai" = PydanticAI,
   *  "langchain" = LangChain, "autogen" = AutoGen, "crewai" = CrewAI.
   *  Stored under `extra.ai_framework`. */
  ai_framework?: string;
}

export const settingsService = {
  async get(userId: string): Promise<UserSettings> {
    let row = await db.user_settings.where("user_id").equals(userId).first();
    if (!row) {
      // Lazy-create the row on first access.
      const id = nanoid();
      const ts = nowISO();
      row = {
        id,
        user_id: userId,
        system_prompt: null,
        system_prompt_enabled: false,
        e2b_api_key_encrypted: null,
        tavily_api_key_encrypted: null,
        embeddings_api_key_encrypted: null,
        env_vars: {},
        extra: {},
        created_at: ts,
        updated_at: ts,
      };
      await db.user_settings.add(row);
    }
    return {
      system_prompt: row.system_prompt,
      system_prompt_enabled: row.system_prompt_enabled,
      e2b_api_key_present: !!row.e2b_api_key_encrypted,
      sandbox_api_key_present: !!row.e2b_api_key_encrypted,
      tavily_api_key_present: !!row.tavily_api_key_encrypted,
      embeddings_api_key_present: !!row.embeddings_api_key_encrypted,
      skillsmp_api_key_present: !!row.extra?.skillsmp_api_key_encrypted,
      langsearch_api_key_present: !!row.extra?.langsearch_api_key_encrypted,
      env_vars: Object.entries(row.env_vars ?? {}).map(([name, v]) => ({
        name,
        is_secret: v.is_secret,
        value_present: !!v.value,
      })),
      // `extra.auto_approve_tools` defaults to false — the HITL approval gate
      // is on by default for safety. The settings page can flip it on.
      auto_approve_tools: !!row.extra?.auto_approve_tools,
      file_system_mode: (row.extra?.file_system_mode as "auto" | "local" | "hopx") ?? "auto",
      sandbox_mode: (row.extra?.sandbox_mode as "shared" | "separate") ?? "shared",
      ai_framework: (row.extra?.ai_framework as string) ?? "default",
    };
  },

  async update(userId: string, patch: Partial<UserSettings>): Promise<UserSettings> {
    let row = await db.user_settings.where("user_id").equals(userId).first();
    if (!row) {
      // Create on first update.
      await this.get(userId);
      row = await db.user_settings.where("user_id").equals(userId).first();
      if (!row) throw new Error("Could not initialize user settings");
    }
    const update: Partial<UserSettingsRow> = { updated_at: nowISO() };
    if (patch.system_prompt !== undefined) update.system_prompt = patch.system_prompt;
    if (patch.system_prompt_enabled !== undefined) {
      update.system_prompt_enabled = patch.system_prompt_enabled;
    }
    if (patch.default_model !== undefined) {
      update.extra = { ...(row.extra ?? {}), default_model: patch.default_model };
    }
    if (patch.default_temperature !== undefined) {
      update.extra = { ...(update.extra ?? row.extra ?? {}), default_temperature: patch.default_temperature };
    }
    if (patch.default_thinking_enabled !== undefined) {
      update.extra = { ...(update.extra ?? row.extra ?? {}), default_thinking_enabled: patch.default_thinking_enabled };
    }
    if (patch.default_thinking_effort !== undefined) {
      update.extra = { ...(update.extra ?? row.extra ?? {}), default_thinking_effort: patch.default_thinking_effort };
    }
    // Handle env_vars — the settings page sends Record<string, string>,
    // but the DB stores Record<string, { value, is_secret }>. Convert.
    if (patch.env_vars !== undefined) {
      const envVarsRecord: Record<string, { value: string; is_secret: boolean }> = {};
      for (const [name, value] of Object.entries(patch.env_vars)) {
        envVarsRecord[name] = { value: String(value), is_secret: false };
      }
      update.env_vars = envVarsRecord;
    }
    await db.user_settings.update(row.id, update);
    return this.get(userId);
  },

  async setSystemPrompt(userId: string, prompt: string | null, enabled: boolean): Promise<void> {
    let row = await db.user_settings.where("user_id").equals(userId).first();
    if (!row) {
      await this.get(userId);
      row = await db.user_settings.where("user_id").equals(userId).first();
    }
    await db.user_settings.update(row!.id, {
      system_prompt: prompt,
      system_prompt_enabled: enabled,
      updated_at: nowISO(),
    });
  },

  async setEnvVars(
    userId: string,
    envVars: Record<string, { value: string; is_secret: boolean }>,
  ): Promise<void> {
    let row = await db.user_settings.where("user_id").equals(userId).first();
    if (!row) {
      await this.get(userId);
      row = await db.user_settings.where("user_id").equals(userId).first();
    }
    // Encrypt secret values.
    const encrypted: Record<string, { value: string; is_secret: boolean }> = {};
    for (const [name, v] of Object.entries(envVars)) {
      if (v.is_secret && v.value) {
        encrypted[name] = { value: await vaultEncrypt(v.value), is_secret: true };
      } else {
        encrypted[name] = { value: v.value, is_secret: v.is_secret };
      }
    }
    await db.user_settings.update(row!.id, {
      env_vars: encrypted,
      updated_at: nowISO(),
    });
  },

  /** Returns the decrypted env-var dict (for the agent runtime). */
  async getDecryptedEnvVars(userId: string): Promise<Record<string, string>> {
    const row = await db.user_settings.where("user_id").equals(userId).first();
    if (!row) return {};
    const out: Record<string, string> = {};
    for (const [name, v] of Object.entries(row.env_vars ?? {})) {
      if (!v.value) continue;
      if (v.is_secret) {
        try {
          out[name] = await vaultDecrypt(v.value);
        } catch {
          // skip — vault locked or corrupted.
        }
      } else {
        out[name] = v.value;
      }
    }
    return out;
  },

  /** Store (or clear, when key is null) the E2B sandbox API key, encrypted
   *  with the user's vault key. The legacy name `set`*E2BKey` is kept as an
   *  alias — both write the same DB column (`e2b_api_key_encrypted`). */
  async setSandboxKey(userId: string, key: string | null): Promise<void> {
    let row = await db.user_settings.where("user_id").equals(userId).first();
    if (!row) {
      await this.get(userId);
      row = await db.user_settings.where("user_id").equals(userId).first();
    }
    const encrypted = key ? await vaultEncrypt(key) : null;
    await db.user_settings.update(row!.id, {
      e2b_api_key_encrypted: encrypted,
      updated_at: nowISO(),
    });
  },

  /** Legacy alias — same as `setSandboxKey`. */
  async setE2BKey(userId: string, key: string | null): Promise<void> {
    return this.setSandboxKey(userId, key);
  },

  /** Decrypt + return the E2B sandbox API key, or null if none is stored.
   *  Tries to restore the vault from session before decrypting. */
  async getDecryptedSandboxKey(userId: string): Promise<string | null> {
    const row = await db.user_settings.where("user_id").equals(userId).first();
    if (!row || !row.e2b_api_key_encrypted) return null;
    try {
      // Try to restore vault from session if not already unlocked.
      if (!isVaultUnlocked()) {
        const { restoreVaultFromSession } = await import("@/lib/crypto/vault");
        await restoreVaultFromSession();
      }
      return await vaultDecrypt(row.e2b_api_key_encrypted);
    } catch {
      return null;
    }
  },

  /** Legacy alias — same as `getDecryptedSandboxKey`. */
  async getDecryptedE2BKey(userId: string): Promise<string | null> {
    return this.getDecryptedSandboxKey(userId);
  },

  async setTavilyKey(userId: string, key: string | null): Promise<void> {
    let row = await db.user_settings.where("user_id").equals(userId).first();
    if (!row) {
      await this.get(userId);
      row = await db.user_settings.where("user_id").equals(userId).first();
    }
    const encrypted = key ? await vaultEncrypt(key) : null;
    await db.user_settings.update(row!.id, {
      tavily_api_key_encrypted: encrypted,
      updated_at: nowISO(),
    });
  },

  async setEmbeddingsKey(userId: string, key: string | null): Promise<void> {
    let row = await db.user_settings.where("user_id").equals(userId).first();
    if (!row) {
      await this.get(userId);
      row = await db.user_settings.where("user_id").equals(userId).first();
    }
    const encrypted = key ? await vaultEncrypt(key) : null;
    await db.user_settings.update(row!.id, {
      embeddings_api_key_encrypted: encrypted,
      updated_at: nowISO(),
    });
  },

  /** Store (or clear, when key is null) the SkillsMP marketplace API key,
   *  encrypted with the user's vault key. Stored under
   *  `extra.skillsmp_api_key_encrypted` so we don't need a schema migration.
   *  Anonymous access works for basic search (50 req/day); a key raises the
   *  limit to 500 req/day and unlocks authenticated-only endpoints. */
  async setSkillsMPApiKey(userId: string, key: string | null): Promise<void> {
    let row = await db.user_settings.where("user_id").equals(userId).first();
    if (!row) {
      await this.get(userId);
      row = await db.user_settings.where("user_id").equals(userId).first();
    }
    if (!row) throw new Error("Could not initialize user settings");
    const encrypted = key ? await vaultEncrypt(key) : null;
    const extra = { ...(row.extra ?? {}), skillsmp_api_key_encrypted: encrypted };
    await db.user_settings.update(row.id, {
      extra,
      updated_at: nowISO(),
    });
  },

  /** Decrypt + return the SkillsMP API key, or null if none is stored. */
  async getDecryptedSkillsMPApiKey(userId: string): Promise<string | null> {
    const row = await db.user_settings.where("user_id").equals(userId).first();
    if (!row) return null;
    const encrypted = row.extra?.skillsmp_api_key_encrypted;
    if (typeof encrypted !== "string" || !encrypted) return null;
    try {
      return await vaultDecrypt(encrypted);
    } catch {
      return null;
    }
  },

  /** Store (or clear, when key is null) the LangSearch web-search API key,
   *  encrypted with the user's vault key. Stored under
   *  `extra.langsearch_api_key_encrypted` so we don't need a schema migration.
   *  When set, `web_search` / `news_search` route through LangSearch's hybrid
   *  API; when unset, they fall back to the DuckDuckGo scraper. */
  async setLangSearchKey(userId: string, key: string | null): Promise<void> {
    let row = await db.user_settings.where("user_id").equals(userId).first();
    if (!row) {
      await this.get(userId);
      row = await db.user_settings.where("user_id").equals(userId).first();
    }
    if (!row) throw new Error("Could not initialize user settings");
    const encrypted = key ? await vaultEncrypt(key) : null;
    const extra = { ...(row.extra ?? {}), langsearch_api_key_encrypted: encrypted };
    await db.user_settings.update(row.id, {
      extra,
      updated_at: nowISO(),
    });
  },

  /** Decrypt + return the LangSearch API key, or null if none is stored.
   *  Tries to restore the vault from session before decrypting. */
  async getDecryptedLangSearchApiKey(userId: string): Promise<string | null> {
    const row = await db.user_settings.where("user_id").equals(userId).first();
    if (!row) return null;
    const encrypted = row.extra?.langsearch_api_key_encrypted;
    if (typeof encrypted !== "string" || !encrypted) return null;
    try {
      // Try to restore vault from session if not already unlocked.
      if (!isVaultUnlocked()) {
        const { restoreVaultFromSession } = await import("@/lib/crypto/vault");
        await restoreVaultFromSession();
      }
      return await vaultDecrypt(encrypted);
    } catch {
      return null;
    }
  },

  /**
   * Read the auto-approve-tools flag from `extra`. When true the agent runtime
   * skips the HITL approval gate for tools flagged `requires_approval` (e.g.
   * `run_terminal`, `run_python`). Off by default — surfaces in the Config
   * settings page as "Auto-approve tool calls".
   */
  async getAutoApproveTools(userId: string): Promise<boolean> {
    const row = await db.user_settings.where("user_id").equals(userId).first();
    if (!row) return false;
    return !!row.extra?.auto_approve_tools;
  },

  async setAutoApproveTools(userId: string, enabled: boolean): Promise<void> {
    let row = await db.user_settings.where("user_id").equals(userId).first();
    if (!row) {
      await this.get(userId);
      row = await db.user_settings.where("user_id").equals(userId).first();
    }
    if (!row) throw new Error("Could not initialize user settings");
    const extra = { ...(row.extra ?? {}), auto_approve_tools: enabled };
    await db.user_settings.update(row.id, {
      extra,
      updated_at: nowISO(),
    });
  },

  /** Set the file system mode: "auto", "local", or "hopx" (legacy alias for
   *  the E2B sandbox). */
  async setFileSystemMode(userId: string, mode: "auto" | "local" | "hopx"): Promise<void> {
    let row = await db.user_settings.where("user_id").equals(userId).first();
    if (!row) {
      await this.get(userId);
      row = await db.user_settings.where("user_id").equals(userId).first();
    }
    if (!row) throw new Error("Could not initialize user settings");
    const extra = { ...(row.extra ?? {}), file_system_mode: mode };
    await db.user_settings.update(row.id, {
      extra,
      updated_at: nowISO(),
    });
  },

  /** Get the file system mode. Returns "auto" by default. */
  async getFileSystemMode(userId: string): Promise<"auto" | "local" | "hopx"> {
    const settings = await this.get(userId);
    return settings.file_system_mode ?? "auto";
  },

  /** Set the sandbox allocation mode: "shared" (one sandbox for all
   *  conversations) or "separate" (one sandbox per conversation). */
  async setSandboxMode(userId: string, mode: "shared" | "separate"): Promise<void> {
    let row = await db.user_settings.where("user_id").equals(userId).first();
    if (!row) {
      await this.get(userId);
      row = await db.user_settings.where("user_id").equals(userId).first();
    }
    if (!row) throw new Error("Could not initialize user settings");
    const extra = { ...(row.extra ?? {}), sandbox_mode: mode };
    await db.user_settings.update(row.id, {
      extra,
      updated_at: nowISO(),
    });
  },

  /** Get the sandbox allocation mode. Returns "shared" by default. */
  async getSandboxMode(userId: string): Promise<"shared" | "separate"> {
    const settings = await this.get(userId);
    return settings.sandbox_mode ?? "shared";
  },

  /** Set the AI framework preset. */
  async setAIFramework(userId: string, framework: string): Promise<void> {
    let row = await db.user_settings.where("user_id").equals(userId).first();
    if (!row) {
      await this.get(userId);
      row = await db.user_settings.where("user_id").equals(userId).first();
    }
    if (!row) throw new Error("Could not initialize user settings");
    const extra = { ...(row.extra ?? {}), ai_framework: framework };
    await db.user_settings.update(row.id, {
      extra,
      updated_at: nowISO(),
    });
  },

  /** Get the AI framework preset. Returns "default" by default. */
  async getAIFramework(userId: string): Promise<string> {
    const settings = await this.get(userId);
    return settings.ai_framework ?? "default";
  },
};

// ---------------------------------------------------------------------------
// mcpService — basic CRUD for MCP server configs.
//   (stdio servers can't actually run in-browser; this stores the config so
//   the settings UI works and future sse/streamable_http transports can use it.)
// ---------------------------------------------------------------------------

export const mcpService = {
  async list(userId: string, activeOnly = false) {
    const rows = await db.mcp_servers.where("user_id").equals(userId).toArray();
    return activeOnly ? rows.filter((r) => r.is_active) : rows;
  },

  async create(
    userId: string,
    input: {
      name: string;
      transport: "stdio" | "sse" | "streamable_http";
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
      headers?: Record<string, string>;
      is_active?: boolean;
    },
  ) {
    const id = nanoid();
    const ts = nowISO();
    const row = {
      id,
      user_id: userId,
      name: input.name,
      transport: input.transport,
      command: input.command ?? null,
      args: input.args ?? [],
      env: input.env ?? {},
      url: input.url ?? null,
      headers: input.headers ?? {},
      is_active: input.is_active ?? true,
      created_at: ts,
      updated_at: ts,
    };
    await db.mcp_servers.add(row);
    return row;
  },

  async update(id: string, patch: Record<string, unknown>) {
    const update = { ...patch, updated_at: nowISO() };
    await db.mcp_servers.update(id, update);
    return db.mcp_servers.get(id);
  },

  async delete(id: string) {
    await db.mcp_servers.delete(id);
  },
};

// ---------------------------------------------------------------------------
// customToolService — basic CRUD.
// ---------------------------------------------------------------------------

export const customToolService = {
  async list(userId: string, activeOnly = false) {
    const rows = await db.custom_tools.where("user_id").equals(userId).toArray();
    return activeOnly ? rows.filter((r) => r.is_active) : rows;
  },

  async create(
    userId: string,
    input: {
      name: string;
      description: string;
      parameters_schema: Record<string, unknown>;
      impl_kind: "http_webhook" | "python_snippet";
      http_url?: string;
      http_headers?: Record<string, string>;
      python_source?: string;
      is_active?: boolean;
    },
  ) {
    const id = nanoid();
    const ts = nowISO();
    const row = {
      id,
      user_id: userId,
      name: input.name,
      description: input.description,
      parameters_schema: input.parameters_schema,
      impl_kind: input.impl_kind,
      http_url: input.http_url ?? null,
      http_headers: input.http_headers ?? {},
      python_source: input.python_source ?? null,
      is_active: input.is_active ?? true,
      created_at: ts,
      updated_at: ts,
    };
    await db.custom_tools.add(row);
    return row;
  },

  async update(id: string, patch: Record<string, unknown>) {
    const update = { ...patch, updated_at: nowISO() };
    await db.custom_tools.update(id, update);
    return db.custom_tools.get(id);
  },

  async delete(id: string) {
    await db.custom_tools.delete(id);
  },
};

// ---------------------------------------------------------------------------
// skillService — installed skill catalog (OPFS-backed).
// ---------------------------------------------------------------------------

export const skillService = {
  async listInstalled(userId: string) {
    return db.skills.where("user_id").equals(userId).toArray();
  },

  /** Alias for `listInstalled` — matches the naming convention used by the other CRUD services. */
  async list(userId: string) {
    return db.skills.where("user_id").equals(userId).toArray();
  },

  async install(userId: string, name: string, description: string | null, dirPath: string) {
    const existing = await db.skills
      .where("[user_id+name]")
      .equals([userId, name])
      .first();
    if (existing) {
      // Update the description + dir_path in case the user is re-installing
      // an updated version of the same skill.
      const updated = {
        ...existing,
        description: description ?? existing.description,
        dir_path: dirPath,
        is_active: true,
        updated_at: nowISO(),
      };
      await db.skills.put(updated);
      return updated;
    }
    const id = nanoid();
    const ts = nowISO();
    const row = {
      id,
      user_id: userId,
      name,
      description,
      dir_path: dirPath,
      is_active: true,
      created_at: ts,
      updated_at: ts,
    };
    await db.skills.add(row);
    return row;
  },

  async uninstall(userId: string, name: string) {
    const existing = await db.skills
      .where("[user_id+name]")
      .equals([userId, name])
      .first();
    if (existing) await db.skills.delete(existing.id);
  },

  /** Delete an installed skill row by id (alternative to `uninstall(userId, name)`). */
  async delete(id: string) {
    await db.skills.delete(id);
  },

  /** Toggle the `is_active` flag for a skill (used by the catalog UI). */
  async setActive(id: string, isActive: boolean) {
    await db.skills.update(id, { is_active: isActive, updated_at: nowISO() });
    return db.skills.get(id);
  },

  /** Update skill metadata (description, dir_path, is_active, etc.). */
  async update(id: string, patch: Partial<{ description: string | null; dir_path: string; is_active: boolean }>) {
    await db.skills.update(id, { ...patch, updated_at: nowISO() });
    return db.skills.get(id);
  },

  /** Look up an installed skill by name (case-sensitive). Returns null if missing. */
  async getByName(userId: string, name: string) {
    const row = await db.skills
      .where("[user_id+name]")
      .equals([userId, name])
      .first();
    return row ?? null;
  },
};

// ---------------------------------------------------------------------------
// fileService — chat attachment metadata + OPFS storage coordination.
// ---------------------------------------------------------------------------

export const fileService = {
  /**
   * Insert a chat-attachment metadata row. Callers MAY pass `id` to keep the
   * Dexie row id in sync with an OPFS path / blob URL cache key generated
   * upstream (e.g. `uploadFile` in `file-api.ts` mints the id up-front so the
   * OPFS path matches). When omitted, a fresh `nanoid()` is generated —
   * matching the historical behavior.
   */
  async create(
    userId: string,
    input: {
      id?: string;
      filename: string;
      mime_type: string;
      size: number;
      storage_path: string;
      file_type: string;
      parsed_content?: string | null;
    },
  ) {
    const id = input.id ?? nanoid();
    const ts = nowISO();
    const row = {
      id,
      user_id: userId,
      message_id: null,
      conversation_id: null,
      filename: input.filename,
      mime_type: input.mime_type,
      size: input.size,
      storage_path: input.storage_path,
      file_type: input.file_type,
      parsed_content: input.parsed_content ?? null,
      created_at: ts,
      updated_at: ts,
    };
    await db.chat_files.add(row);
    return row;
  },

  async get(id: string, userId: string) {
    const row = await db.chat_files.get(id);
    if (!row || row.user_id !== userId) return null;
    return row;
  },

  async delete(id: string, userId: string) {
    const row = await db.chat_files.get(id);
    if (!row || row.user_id !== userId) return;
    await db.chat_files.delete(id);
  },

  async linkToMessage(messageId: string, fileIds: string[]) {
    await db.chat_files
      .where("id")
      .anyOf(fileIds)
      .modify({ message_id: messageId });
  },
};

// ---------------------------------------------------------------------------
// Barrel.
// ---------------------------------------------------------------------------

export const services = {
  auth: authService,
  conversation: conversationService,
  rating: ratingService,
  share: shareService,
  slashCommand: slashCommandService,
  aiProvider: aiProviderService,
  settings: settingsService,
  mcp: mcpService,
  customTool: customToolService,
  skill: skillService,
  file: fileService,
};

export type Services = typeof services;

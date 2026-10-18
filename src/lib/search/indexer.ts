"use client";

/**
 * MESSAGE SEARCH INDEXER (Task 2-b, PRD §11 — Semantic Search).
 *
 * Maintains the `message_search_index` Dexie table (schema owned by Task 1-a):
 * one row per message (pk = message_id, upsert semantics), holding the
 * markdown-stripped plain text (lexical half), an optional embedding vector
 * (semantic half, best-effort) and the conversation's project/title cache.
 *
 * DESIGN RULES (hard):
 *   - NEVER in the streaming path. All entry points are fire-and-forget
 *     (`void …` + catch-all) and debounced/idle-scheduled; nothing here may
 *     block a turn, a render, or the search itself.
 *   - Lexical ALWAYS works. Embeddings are a strictly optional enhancement
 *     routed through the user's own connected Pollinations account
 *     (`/api/pollinations/generate` kind="embeddings", mirroring the
 *     media_generation tool's request shape). ANY failure marks rows
 *     `embed_state: "failed"` and search degrades to keyword-only — never a
 *     fake "semantic" result.
 *   - Idempotent upserts: re-indexing an unchanged message preserves its
 *     embedding; a text change resets it to "none" for a re-embed.
 */

import { db } from "@/lib/db";
import { tokenize } from "@/lib/search/score";
import { logWarn } from "@/lib/client-logger";
import type { MessageSearchRow } from "@/types";
import type { MessageRow } from "@/lib/db";

// ---------------------------------------------------------------------------
// Pure helpers — stripMarkdown (exported for tests)
// ---------------------------------------------------------------------------

/** Cap on the indexed plain-text per message (PRD schema contract). */
export const INDEX_TEXT_CAP = 4000;
/** Max characters sent per text in one embeddings batch. */
export const EMBED_TEXT_CAP = 4000;
/** Max rows per embeddings request (the API route caps input at 32). */
export const EMBED_BATCH_LIMIT = 32;
/** Cooldown after a failed embeddings call before trying again (in-memory). */
export const EMBED_RETRY_COOLDOWN_MS = 60_000;
/** Auto-backfill cap on first search when the index is empty. */
export const AUTO_BACKFILL_MESSAGE_CAP = 2000;

/**
 * Strip markdown SYNTAX (fences markers, emphasis, links, headers, quotes,
 * list bullets, tables, html tags) while KEEPING the human/code text — code
 * inside fences stays searchable, only the fence markers themselves go.
 * Pure: same input → same output, no dependencies.
 */
export function stripMarkdown(raw: string): string {
  let text = raw ?? "";
  if (!text) return "";

  // Fenced code blocks: drop the fence marker lines (``` / ~~~), keep the
  // language label + the code body verbatim (searchable!).
  text = text.replace(/^[ \t]*(```+|~~~+)([^\n]*)$/gm, (_m, _fence: string, lang: string) =>
    (lang ?? "").trim() ? `\n${(lang as string).trim()}\n` : "\n",
  );

  // Images: keep the alt text, drop the url.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Links: keep the label, drop the url.
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Reference-style link labels.
  text = text.replace(/^\s*\[([^\]]+)\]:\s*\S+\s*$/gm, "");

  // Bold / italic / strikethrough markers.
  text = text.replace(/(\*\*\*|\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/g, "$2");
  text = text.replace(/(\*|_)(?=\S)(.+?)(?<=\S)\1/g, "$2");
  // Inline code backticks.
  text = text.replace(/`([^`]*)`/g, "$1");

  // Headings: drop the leading #'s (keep the words).
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
  // Blockquotes: drop the leading > (keep the quote).
  text = text.replace(/^[ \t]{0,3}>[ \t]?/gm, "");
  // Horizontal rules (---, ***, ___).
  text = text.replace(/^[ \t]{0,3}([-*_])[ \t]*\1[ \t]*\1[\s\-*_]*$/gm, "");
  // Task-list markers (BEFORE the generic bullet strip consumes the dash).
  text = text.replace(/^\s*[-+*]\s*\[[ xX]\][ \t]*/gm, "");
  // List bullets (unordered + ordered) at line start.
  text = text.replace(/^[ \t]{0,6}[-+*][ \t]+/gm, "");
  text = text.replace(/^[ \t]{0,6}\d{1,3}[.)][ \t]+/gm, "");
  // Table row pipes + separator lines (keep the cell text).
  text = text.replace(/^[ \t]{0,3}\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, "");
  text = text.replace(/[ \t]*\|[ \t]*/g, " ");
  // Bare html tags (opening/closing, not the content).
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, "");

  // Collapse blank-line runs; trim each line; trim the whole text.
  text = text
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();

  return text.slice(0, INDEX_TEXT_CAP);
}

/** Token count of the stripped text (the shared tokenizer — no engine here). */
export function countTokens(text: string): number {
  return tokenize(text).length;
}

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

/** The Dexie messages-table row subset the indexer reads. */
export type IndexableMessage = Pick<MessageRow, "id" | "conversation_id" | "role" | "content" | "created_at">;

/** Build a search row from a message + its conversation metadata. PURE. */
export function buildSearchRow(
  message: IndexableMessage,
  meta: { projectId: string | null; title: string },
): MessageSearchRow {
  const text = stripMarkdown(message.content ?? "");
  return {
    message_id: message.id,
    conversation_id: message.conversation_id,
    project_id: meta.projectId,
    role: message.role,
    text,
    title_cache: meta.title,
    token_count: countTokens(text),
    embedding: null,
    embed_model: null,
    embed_state: "none",
    created_at: message.created_at,
    updated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Core index operations
// ---------------------------------------------------------------------------

/**
 * Upsert one message's search row (pk = message_id). Preserves an existing
 * embedding when the text is unchanged; a text change resets it for re-embed.
 * Resolves the conversation's project_id + title at index time.
 */
export async function indexMessage(message: IndexableMessage): Promise<void> {
  const content = (message.content ?? "").trim();
  if (!content || message.role === "system") return; // nothing searchable
  const conv = await db.conversations.get(message.conversation_id).catch(() => undefined);
  const row = buildSearchRow(message, {
    projectId: conv?.project_id ?? null,
    title: conv?.title ?? "",
  });
  const existing = await db.message_search_index.get(message.id).catch(() => undefined);
  if (
    existing &&
    existing.text === row.text &&
    existing.project_id === row.project_id &&
    existing.title_cache === row.title_cache
  ) {
    return; // unchanged — keep the row (and its embedding) as-is
  }
  await db.message_search_index.put({
    ...row,
    // Text unchanged → keep the embedding work; changed → reset for re-embed.
    embedding:
      existing && existing.text === row.text && existing.embedding ? existing.embedding : null,
    embed_model:
      existing && existing.text === row.text && existing.embedding ? existing.embed_model ?? null : null,
    embed_state:
      existing && existing.text === row.text && existing.embed_state === "ready" ? "ready" : "none",
  });
}

export async function indexConversationMessages(conversationId: string): Promise<number> {
  return indexConversationMessagesBounded(conversationId, Number.POSITIVE_INFINITY);
}

/**
 * (Re)index one conversation with a per-call WRITE cap — the unit the
 * turn-end hook and the backfill both use. Upserts changed rows, removes
 * index rows whose message no longer exists (delete cascade), and stamps
 * every surviving row's title_cache/project_id from the live conversation.
 */
async function indexConversationMessagesBounded(
  conversationId: string,
  maxWrites: number,
): Promise<number> {
  if (maxWrites <= 0) return 0;
  const conv = await db.conversations.get(conversationId).catch(() => undefined);
  if (!conv) {
    await removeConversationFromIndex(conversationId);
    return 0;
  }
  const messages = await db.messages.where("conversation_id").equals(conversationId).toArray();
  const searchable = messages.filter((m) => m.role !== "system" && (m.content ?? "").trim());
  const existing = await db.message_search_index
    .where("conversation_id")
    .equals(conversationId)
    .toArray();
  const existingById = new Map(existing.map((r) => [r.message_id, r]));
  const liveIds = new Set(searchable.map((m) => m.id));

  // 1) Remove rows for messages that no longer exist.
  const staleIds = existing.filter((r) => !liveIds.has(r.message_id)).map((r) => r.message_id);
  if (staleIds.length > 0) await db.message_search_index.bulkDelete(staleIds);

  // 2) Upsert (or refresh) every live message — newest-first so a bounded
  //    pass keeps the freshest history.
  searchable.reverse();
  let touched = 0;
  const meta = { projectId: conv.project_id ?? null, title: conv.title ?? "" };
  for (const m of searchable) {
    if (touched >= maxWrites) break;
    const row = buildSearchRow(m, meta);
    const prev = existingById.get(m.id);
    if (
      prev &&
      prev.text === row.text &&
      prev.project_id === row.project_id &&
      prev.title_cache === row.title_cache
    ) {
      continue; // identical — no write, embedding untouched
    }
    await db.message_search_index.put({
      ...row,
      embedding: prev && prev.text === row.text ? prev.embedding ?? null : null,
      embed_model: prev && prev.text === row.text ? prev.embed_model ?? null : null,
      embed_state: prev && prev.text === row.text && prev.embed_state === "ready" ? "ready" : "none",
    });
    touched++;
  }
  return touched;
}

/** Remove every index row of one conversation (conversation deleted). */
export async function removeConversationFromIndex(conversationId: string): Promise<void> {
  await db.message_search_index.where("conversation_id").equals(conversationId).delete();
}

/** Remove one message's index row (message deleted). */
export async function removeMessageFromIndex(messageId: string): Promise<void> {
  await db.message_search_index.delete(messageId);
}

/** Light-touch rename propagation: refresh title_cache for a conversation's
 *  rows WITHOUT touching text/embeddings (bulk modify). */
export async function updateConversationTitleCache(
  conversationId: string,
  title: string,
): Promise<void> {
  await db.message_search_index
    .where("conversation_id")
    .equals(conversationId)
    .modify({ title_cache: title, updated_at: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

export interface BackfillProgress {
  conversationsScanned: number;
  messagesIndexed: number;
  /** True when the message cap stopped the pass early. */
  capped: boolean;
}

/**
 * Iterate the user's conversations + messages, indexing missing/stale rows
 * (staleness = conversation.updated_at newer than the newest index row's
 * updated_at for that conversation, or no rows at all). Idempotent — running
 * it twice touches nothing the second time. `messageCap` bounds the work
 * (auto path uses AUTO_BACKFILL_MESSAGE_CAP; the manual rebuild passes a
 * much higher cap).
 */
export async function backfillAllIndexes(
  userId: string,
  opts: { messageCap?: number; onProgress?: (p: BackfillProgress) => void } = {},
): Promise<BackfillProgress> {
  const cap = opts.messageCap ?? Number.POSITIVE_INFINITY;
  const convs = await db.conversations
    .where("user_id")
    .equals(userId)
    .toArray()
    .catch(() => []);
  // Newest activity first — under a cap the freshest history gets indexed.
  convs.sort((a, b) => (b.updated_at || b.created_at).localeCompare(a.updated_at || a.created_at));

  const progress: BackfillProgress = {
    conversationsScanned: 0,
    messagesIndexed: 0,
    capped: false,
  };
  for (const conv of convs) {
    if (progress.messagesIndexed >= cap) {
      progress.capped = true;
      break;
    }
    progress.conversationsScanned++;
    // Staleness probe: the newest index-row updated_at vs the conversation's
    // own updated_at (bumped on every message save) — missing rows = stale.
    const rows = await db.message_search_index
      .where("conversation_id")
      .equals(conv.id)
      .toArray()
      .catch(() => []);
    const newestIndexed = rows.reduce((m, r) => ((r.updated_at ?? "") > m ? r.updated_at ?? "" : m), "");
    const stale = rows.length === 0 || (conv.updated_at ?? "") > newestIndexed;
    if (!stale) continue;
    const remaining = Number.isFinite(cap) ? cap - progress.messagesIndexed : Number.POSITIVE_INFINITY;
    const touched = await indexConversationMessagesBounded(conv.id, remaining);
    progress.messagesIndexed += touched;
    opts.onProgress?.({ ...progress });
  }
  return progress;
}

/**
 * Opportunistic population check for the search UI: when the index has
 * fewer rows than the messages table (fresh boot, or new device), run the
 * bounded auto-backfill so the first searches are honest. Returns the
 * progress so callers can surface it.
 */
export async function ensureIndexPopulated(userId: string): Promise<BackfillProgress> {
  const [messageCount, indexCount] = await Promise.all([
    db.messages.count().catch(() => 0),
    db.message_search_index.count().catch(() => 0),
  ]);
  if (indexCount >= messageCount || messageCount === 0) {
    return { conversationsScanned: 0, messagesIndexed: 0, capped: false };
  }
  return backfillAllIndexes(userId, { messageCap: AUTO_BACKFILL_MESSAGE_CAP });
}

/** Manual "Rebuild search index": wipe + full backfill (uncapped by default). */
export async function rebuildSearchIndex(
  userId: string,
  opts: { messageCap?: number; onProgress?: (p: BackfillProgress) => void } = {},
): Promise<BackfillProgress> {
  await db.message_search_index.clear().catch(() => {});
  return backfillAllIndexes(userId, {
    messageCap: opts.messageCap ?? 100_000,
    onProgress: opts.onProgress,
  });
}

// ---------------------------------------------------------------------------
// Embeddings — best-effort semantic half via the user's Pollinations account
// ---------------------------------------------------------------------------

/** Resolved embedding-call preconditions. */
export interface EmbeddingCapability {
  available: boolean;
  token: string | null;
  model: string | null;
}

/** In-memory cooldown state (failed calls back off; never persisted). */
let embedCooldownUntil = 0;
let resolvedModelCache: { model: string | null; at: number } | null = null;
const MODEL_CACHE_TTL_MS = 5 * 60_000;

/**
 * Resolve whether semantic embedding is possible RIGHT NOW: a connected,
 * non-expired Pollinations account + an embedding-capable model id
 * (user default → live catalogue pick, cached for 5 minutes).
 */
export async function resolveEmbeddingCapability(): Promise<EmbeddingCapability> {
  const { usePollinationsStore } = await import("@/lib/pollinations/store");
  const state = usePollinationsStore.getState();
  const token = state.token;
  if (!token || state.connectionStatus === "expired") {
    return { available: false, token: null, model: null };
  }
  const meta = state.connectionMeta;
  if (meta?.expiresAt && new Date(meta.expiresAt).getTime() <= Date.now()) {
    return { available: false, token: null, model: null };
  }
  if (Date.now() < embedCooldownUntil) {
    return { available: false, token, model: null };
  }

  let model: string | null = null;
  if (resolvedModelCache && Date.now() - resolvedModelCache.at < MODEL_CACHE_TTL_MS) {
    model = resolvedModelCache.model;
  } else {
    const preferred = state.defaults?.embedding;
    if (preferred) {
      model = preferred;
    } else {
      // Live catalogue pick (public fetch, in-flight deduped) — same rules
      // the media_generation tool uses for the embedding task.
      try {
        const { compatibleModels, pickDefaultModel } = await import("@/lib/pollinations/capabilities");
        let models = state.models;
        if (models.length === 0) {
          models = await usePollinationsStore.getState().refreshModels();
        }
        const list = compatibleModels(models, "embedding");
        model = pickDefaultModel(list, "embedding")?.name ?? null;
      } catch {
        model = null;
      }
    }
    resolvedModelCache = { model, at: Date.now() };
  }
  if (!model) return { available: false, token, model: null };
  return { available: true, token, model };
}

/** Call the Pollinations embeddings proxy (exact request shape of the
 *  media_generation tool's generateEmbeddings): POST /api/pollinations/generate
 *  {kind:"embeddings", params:{model, input}} with the account bearer key.
 *  Exported for the query-side embedding in search.ts. */
export async function embedTexts(
  texts: string[],
  opts: { signal?: AbortSignal } = {},
): Promise<{ vectors: number[][]; model: string } | null> {
  if (texts.length === 0) return null;
  const cap = await resolveEmbeddingCapability();
  if (!cap.available || !cap.token || !cap.model) return null;
  try {
    const res = await fetch("/api/pollinations/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cap.token}`,
      },
      body: JSON.stringify({
        kind: "embeddings",
        params: { model: cap.model, input: texts.map((t) => t.slice(0, EMBED_TEXT_CAP)) },
      }),
      cache: "no-store",
      signal: opts.signal,
    });
    if (!res.ok) {
      embedCooldownUntil = Date.now() + EMBED_RETRY_COOLDOWN_MS;
      return null;
    }
    const body = (await res.json()) as {
      ok?: boolean;
      result?: { data?: Array<{ embedding?: number[] }> };
    };
    const data = body.result?.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      embedCooldownUntil = Date.now() + EMBED_RETRY_COOLDOWN_MS;
      return null;
    }
    const vectors = data.map((d) => (Array.isArray(d?.embedding) ? d.embedding : null));
    if (vectors.some((v) => !v || v.length === 0)) {
      embedCooldownUntil = Date.now() + EMBED_RETRY_COOLDOWN_MS;
      return null;
    }
    return { vectors: vectors as number[][], model: cap.model };
  } catch {
    embedCooldownUntil = Date.now() + EMBED_RETRY_COOLDOWN_MS;
    return null;
  }
}

/** Embed a single query string (semantic search half). Null = unavailable. */
export async function embedQuery(query: string): Promise<{ vector: number[]; model: string } | null> {
  const out = await embedTexts([query]);
  if (!out || !out.vectors[0]) return null;
  return { vector: out.vectors[0], model: out.model };
}

/**
 * Background pass: embed rows with embed_state "none"/"failed", in batches of
 * ≤EMBED_BATCH_LIMIT. On success: store embedding + embed_model + "ready".
 * On ANY failure: mark the batch "failed" (lexical search is unaffected) and
 * cool down. Fire-and-forget — callers never await this in a UI path.
 */
export async function embedPendingMessages(limit = EMBED_BATCH_LIMIT * 2): Promise<number> {
  const cap = await resolveEmbeddingCapability();
  if (!cap.available) return 0;
  const pending = await db.message_search_index
    .filter((r) => r.embed_state === "none" || r.embed_state === "failed")
    .limit(Math.min(limit, EMBED_BATCH_LIMIT * 4))
    .toArray()
    .catch(() => []);
  if (pending.length === 0) return 0;

  let embedded = 0;
  for (let i = 0; i < pending.length; i += EMBED_BATCH_LIMIT) {
    const batch = pending.slice(i, i + EMBED_BATCH_LIMIT)!;
    if (batch.length === 0) break;
    const texts = batch.map((r) => (r.text || "").slice(0, EMBED_TEXT_CAP) || " ");
    const out = await embedTexts(texts);
    if (!out) {
      // Honest failure: mark the batch failed; the cooldown prevents hammering.
      await db.message_search_index
        .bulkPut(batch.map((r) => ({ ...r, embed_state: "failed" as const })))
        .catch(() => {});
      break;
    }
    const rows = batch.map((r, idx) => ({
      ...r,
      embedding: out.vectors[idx] ?? null,
      embed_model: out.model,
      embed_state: "ready" as const,
      updated_at: new Date().toISOString(),
    }));
    await db.message_search_index.bulkPut(rows).catch(() => {});
    embedded += rows.length;
  }
  return embedded;
}

// ---------------------------------------------------------------------------
// Scheduling — debounced, idle-time, fire-and-forget
// ---------------------------------------------------------------------------

const INDEX_DEBOUNCE_MS = 2500;
const indexTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** requestIdleCallback with a setTimeout fallback (SSR-safe). */
function scheduleIdle(cb: () => void): void {
  if (typeof window !== "undefined" && "requestIdleCallback" in window) {
    window.requestIdleCallback(() => cb(), { timeout: 800 });
  } else {
    setTimeout(cb, 32);
  }
}

/**
 * Debounced (trailing, 2.5s) re-index of a conversation, then a best-effort
 * embedding pass — called from the event-processor's turn-end hooks.
 * NEVER throws, never blocks: all work is background + swallowed.
 */
export function scheduleSearchIndexing(conversationId: string | null | undefined): void {
  if (!conversationId) return;
  const prev = indexTimers.get(conversationId);
  if (prev) clearTimeout(prev);
  indexTimers.set(
    conversationId,
    setTimeout(() => {
      indexTimers.delete(conversationId);
      scheduleIdle(() => {
        void indexConversationMessages(conversationId)
          .then(() => embedPendingMessages())
          .catch((err) => {
            logWarn("search", `indexing conversation ${conversationId} failed`, {
              context: { error: err instanceof Error ? err.message : String(err) },
            });
          });
      });
    }, INDEX_DEBOUNCE_MS),
  );
}

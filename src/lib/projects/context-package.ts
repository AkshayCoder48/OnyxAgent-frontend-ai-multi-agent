"use client";

/**
 * PROJECT CONTEXT PACKAGE (Task 2-d / PRD §7.1 + §7.3) — the block appended
 * to the system prompt for PROJECT conversations (general chats are never
 * touched).
 *
 * Composition (always, for a resolved project):
 *   ## PROJECT CONTEXT
 *   - Project name, goal, instructions (explicit instructions — the highest
 *     authority in the block).
 *   - Project memory (when memory_settings.enabled): pinned items always +
 *     relevant others via 1-a's budgeted `retrieveMemories` (lexical overlap
 *     + recency, hard stop at the project's context_budget_chars).
 *   - Cross-chat retrieval (when memory_settings.cross_chat_retrieval):
 *     excerpts from the project's OTHER conversations, ranked by the shared
 *     lexical scorer (src/lib/search/score.ts — the same one 2-b's hybrid
 *     search reuses). Primary source: the `message_search_index` table
 *     (2-b's indexer fills it); when the index has no rows for those
 *     conversations yet, a DIRECT Dexie scan fallback (last 30 days, cap 40
 *     messages, lexical top-5) keeps the feature honest from day one.
 *   - A fixed instruction line telling the agent where this context came
 *     from, to cite sources when using them, and that the `project_memory`
 *     tool exists for durable facts.
 *
 * Retrieval respects the project's `context_budget_chars` (default 4000) as
 * a shared budget across the memory + cross-chat sections.
 */

import { db } from "@/lib/db";
import { getProject } from "./service";
import { retrieveMemories } from "./memory";
import { bestWindowExcerpt, rankDocuments } from "@/lib/search/score";
import { DEFAULT_RETRIEVAL_BUDGET_CHARS } from "./memory";
import type { Project } from "@/types";

// ---------------------------------------------------------------------------
// Tunables (exported for tests)
// ---------------------------------------------------------------------------

/** Cross-chat fallback scan window (direct Dexie scan when the search index
 * is empty for the project's other conversations). */
export const CROSS_CHAT_SCAN_WINDOW_DAYS = 30;
/** Max messages the fallback scan reads before ranking. */
export const CROSS_CHAT_SCAN_CAP = 40;
/** Lexical top-K excerpts that make it into the package. */
export const CROSS_CHAT_TOP_K = 5;
/** Max chars of one excerpt. */
export const CROSS_CHAT_EXCERPT_CHARS = 400;

/** The fixed instruction line inside the block (compact by design). */
export const CONTEXT_INSTRUCTION_LINE =
  "This context is assembled from this project's saved memory and its past conversations. " +
  "When you rely on it, cite the source (e.g. the conversation title or memory category). " +
  "The project_memory tool is available to save durable project facts (decisions, constraints, preferences, known bugs, file references).";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One cross-chat excerpt with its source conversation title. */
export interface CrossChatExcerpt {
  conversationId: string;
  conversationTitle: string;
  excerpt: string;
  score: number;
  /** Where the row came from ("index" = message_search_index,
   *  "scan" = direct Dexie fallback). */
  source: "index" | "scan";
}

/** Resolved inputs + built sections (the pure half of the builder — unit
 * tested without touching Dexie). */
export interface ContextPackageSections {
  header: string;
  memorySection: string | null;
  crossChatSection: string | null;
}

// ---------------------------------------------------------------------------
// Pure section builders (exported for tests)
// ---------------------------------------------------------------------------

/** The always-present header: name, goal, instructions. */
export function buildProjectHeader(project: Project): string {
  const lines: string[] = [
    `Project: ${project.name}`,
    `Goal: ${project.goal || "(no goal set)"}`,
  ];
  if (project.instructions && project.instructions.trim()) {
    lines.push(`Instructions:\n${project.instructions.trim()}`);
  }
  return lines.join("\n");
}

/** Render the retrieved memory items as one markdown section (null when
 * there is nothing to show). */
export function buildMemorySection(
  items: Array<{ id: string; category: string; content: string; pinned?: boolean }>,
): string | null {
  if (items.length === 0) return null;
  const lines = items.map(
    (m) => `- [${m.category}${m.pinned ? " · pinned" : ""}] ${m.content.replace(/\s+/g, " ").trim()}`,
  );
  return `### Project memory\n${lines.join("\n")}`;
}

/** Render the cross-chat excerpts as one markdown section with source
 * conversation titles in brackets (null when there is nothing to show). */
export function buildCrossChatSection(excerpts: CrossChatExcerpt[]): string | null {
  if (excerpts.length === 0) return null;
  const lines = excerpts.map(
    (e) => `- [from: ${e.conversationTitle || "untitled chat"}] ${e.excerpt.replace(/\s+/g, " ").trim()}`,
  );
  return `### Relevant excerpts from other project chats\n${lines.join("\n")}`;
}

/** Assemble the final package text from the sections. */
export function assemblePackage(sections: ContextPackageSections): string {
  const parts = [`## PROJECT CONTEXT\n${sections.header}`];
  if (sections.memorySection) parts.push(sections.memorySection);
  if (sections.crossChatSection) parts.push(sections.crossChatSection);
  parts.push(CONTEXT_INSTRUCTION_LINE);
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Cross-chat retrieval
// ---------------------------------------------------------------------------

/** The project's OTHER conversation ids (excluding the current one). */
async function otherProjectConversationIds(
  projectId: string,
  currentConversationId: string | null,
): Promise<string[]> {
  const rows = await db.conversations.where("project_id").equals(projectId).toArray();
  return rows.map((c) => c.id).filter((id) => id !== currentConversationId);
}

/**
 * Rank indexed rows (message_search_index) for the project's other
 * conversations with the shared lexical scorer. Pure post-filtering —
 * callers hand in the candidate rows.
 */
export function rankIndexedRows(
  query: string,
  rows: Array<{
    message_id: string;
    conversation_id: string;
    title_cache: string;
    text: string;
  }>,
): CrossChatExcerpt[] {
  const ranked = rankDocuments(query, rows, {
    textOf: (r) => r.text,
    idOf: (r) => r.message_id,
  });
  const seenText = new Set<string>();
  const out: CrossChatExcerpt[] = [];
  for (const { item, score } of ranked) {
    if (out.length >= CROSS_CHAT_TOP_K) break;
    const excerpt = bestWindowExcerpt(item.text, query, CROSS_CHAT_EXCERPT_CHARS);
    if (!excerpt) continue;
    // Dedupe near-identical excerpts across messages of one conversation.
    const dedupeKey = `${item.conversation_id}:${excerpt.slice(0, 120)}`;
    if (seenText.has(dedupeKey)) continue;
    seenText.add(dedupeKey);
    out.push({
      conversationId: item.conversation_id,
      conversationTitle: item.title_cache,
      excerpt,
      score,
      source: "index",
    });
  }
  return out;
}

/**
 * Direct Dexie scan fallback (PRD §7.3 — retrieval must work before 2-b's
 * indexer has populated the search index): the project's OTHER
 * conversations' messages from the last 30 days, capped, lexically ranked
 * top-5, each excerpted to CROSS_CHAT_EXCERPT_CHARS.
 */
export async function scanProjectMessages(
  projectId: string,
  currentConversationId: string | null,
  query: string,
  nowMs: number = Date.now(),
): Promise<CrossChatExcerpt[]> {
  const conversationIds = await otherProjectConversationIds(projectId, currentConversationId);
  if (conversationIds.length === 0) return [];
  const titles = new Map<string, string>();
  for (const id of conversationIds) {
    const conv = await db.conversations.get(id);
    titles.set(id, conv?.title ?? "");
  }
  const cutoff = nowMs - CROSS_CHAT_SCAN_WINDOW_DAYS * 86_400_000;
  const candidates: Array<{ id: string; conversationId: string; text: string; createdAtMs: number }> = [];
  for (const id of conversationIds) {
    const rows = await db.messages.where("conversation_id").equals(id).toArray();
    for (const row of rows) {
      if (row.role === "system") continue;
      const content = (row.content ?? "").trim();
      if (!content) continue;
      const createdMs = Date.parse(row.created_at);
      if (Number.isFinite(createdMs) && createdMs < cutoff) continue;
      candidates.push({
        id: row.id,
        conversationId: id,
        text: content,
        createdAtMs: Number.isFinite(createdMs) ? createdMs : 0,
      });
      if (candidates.length >= CROSS_CHAT_SCAN_CAP) break;
    }
    if (candidates.length >= CROSS_CHAT_SCAN_CAP) break;
  }
  if (candidates.length === 0) return [];
  // Newest-first before the cap bite, so the freshest context competes.
  candidates.sort((a, b) => b.createdAtMs - a.createdAtMs);
  const capped = candidates.slice(0, CROSS_CHAT_SCAN_CAP);
  const ranked = rankDocuments(query, capped, {
    textOf: (c) => c.text,
    idOf: (c) => c.id,
  });
  const seenText = new Set<string>();
  const out: CrossChatExcerpt[] = [];
  for (const { item, score } of ranked) {
    if (out.length >= CROSS_CHAT_TOP_K) break;
    const excerpt = bestWindowExcerpt(item.text, query, CROSS_CHAT_EXCERPT_CHARS);
    if (!excerpt) continue;
    const dedupeKey = `${item.conversationId}:${excerpt.slice(0, 120)}`;
    if (seenText.has(dedupeKey)) continue;
    seenText.add(dedupeKey);
    out.push({
      conversationId: item.conversationId,
      conversationTitle: titles.get(item.conversationId) ?? "",
      excerpt,
      score,
      source: "scan",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

/**
 * Build the project context package for a conversation, or null when the
 * conversation doesn't belong to a project (general chats are unchanged).
 *
 * @param conversationId the conversation whose project should inform the
 *   turn. Null/unknown → null (no package) unless `opts.projectId` pins the
 *   project explicitly — the FIRST turn of a brand-new project chat has no
 *   conversation row yet, and use-chat passes the ACTIVE project id there.
 * @param userMessage the turn's user message — the retrieval query.
 */
export async function buildProjectContextPackage(
  conversationId: string | null | undefined,
  userMessage: string,
  opts: { projectId?: string | null } = {},
): Promise<string | null> {
  // 1. Resolve the conversation → its project. The row (when it exists) is
  //    authoritative — a GENERAL chat never gets a package even if a stale
  //    `opts.projectId` hint is still set (the selection-sync clears
  //    activeProjectId on general chats, but the turn may race that effect).
  //    The hint only applies when there is no row to ask: the FIRST turn of
  //    a brand-new project chat (the conversation is created mid-turn by
  //    the runtime, AFTER the system prompt was assembled).
  let projectId: string | null = null;
  let resolvedFromConversation = false;
  if (conversationId) {
    const conv = await db.conversations.get(conversationId).catch(() => null);
    if (conv) {
      projectId = conv.project_id ?? null;
      resolvedFromConversation = true;
    }
  }
  if (!resolvedFromConversation && opts.projectId) {
    projectId = opts.projectId;
  }
  if (!projectId) return null;
  const project = await getProject(projectId).catch(() => null);
  if (!project || project.status === "archived") return null;

  const budget = Math.max(
    500,
    project.memory_settings?.context_budget_chars ?? DEFAULT_RETRIEVAL_BUDGET_CHARS,
  );
  const query = (userMessage ?? "").trim();

  // 2. Memory section (pinned always + relevant others, budgeted).
  let memorySection: string | null = null;
  let used = 0;
  if (project.memory_settings?.enabled !== false) {
    try {
      const memories = await retrieveMemories(project.id, query, budget);
      memorySection = buildMemorySection(memories);
      if (memorySection) used += memorySection.length;
    } catch {
      memorySection = null; // retrieval failure never blocks the turn
    }
  }

  // 3. Cross-chat retrieval — index first, direct-scan fallback.
  let crossChatSection: string | null = null;
  if (project.memory_settings?.cross_chat_retrieval !== false) {
    try {
      const otherIds = await otherProjectConversationIds(project.id, conversationId ?? null);
      let excerpts: CrossChatExcerpt[] = [];
      if (otherIds.length > 0) {
        const indexedRows = await db.message_search_index
          .where("project_id")
          .equals(project.id)
          .toArray();
        const foreignCurrent = indexedRows.filter(
          (r) => r.conversation_id !== (conversationId ?? "") && otherIds.includes(r.conversation_id),
        );
        if (foreignCurrent.length > 0) {
          excerpts = rankIndexedRows(query, foreignCurrent);
        }
      }
      if (excerpts.length === 0) {
        excerpts = await scanProjectMessages(project.id, conversationId ?? null, query);
      }
      // Budget cap: shrink the excerpt list until the section fits the
      // remaining budget (never below one excerpt — cross-chat context is
      // the feature's core promise; a small overshoot is preferred over
      // silently dropping it).
      while (excerpts.length > 0) {
        const candidate = buildCrossChatSection(excerpts);
        if (candidate && used + candidate.length <= budget) {
          crossChatSection = candidate;
          break;
        }
        if (excerpts.length === 1) {
          crossChatSection = candidate; // keep the single best excerpt
          break;
        }
        excerpts = excerpts.slice(0, excerpts.length - 1);
      }
    } catch {
      crossChatSection = null; // best-effort — never blocks the turn
    }
  }

  return assemblePackage({ header: buildProjectHeader(project), memorySection, crossChatSection });
}

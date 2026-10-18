"use client";

/**
 * Project memory (PRD §7.2, §9.3) — structured, persistent, deduplicated.
 *
 * Behaviors:
 *   - `saveMemory` dedupes: when a NON-SUPERSEDED item in the same category
 *     has >0.9 normalized content similarity, the new item SUPERSEDES it
 *     (chains `superseded_by`) instead of creating a near-duplicate, and
 *     inherits its source-conversation provenance.
 *   - `retrieveMemories` builds the budgeted context slice: pinned items are
 *     ALWAYS included first, the rest are ranked by lexical overlap with the
 *     query plus a small recency boost, and the walk stops when the
 *     character budget is exhausted.
 *
 * The scoring/selection logic is pure and exported so the agent-side
 * retrieval (Task 2-d context packages) and the tests share one
 * implementation.
 */

import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import type { ProjectMemoryCategory, ProjectMemoryItem } from "@/types";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type MemoryServiceErrorCode = "invalid_content" | "invalid_input" | "not_found";

export class MemoryServiceError extends Error {
  readonly code: MemoryServiceErrorCode;

  constructor(code: MemoryServiceErrorCode, message: string) {
    super(message);
    this.name = "MemoryServiceError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Constants + pure helpers (exported for tests / shared scoring)
// ---------------------------------------------------------------------------

/** Above this Jaccard similarity (strictly greater), a same-category save
 *  supersedes the existing item instead of duplicating it. */
export const MEMORY_SIMILARITY_THRESHOLD = 0.9;

/** Default retrieval budget when the caller doesn't read it off the
 *  project's memory_settings.context_budget_chars. */
export const DEFAULT_RETRIEVAL_BUDGET_CHARS = 4000;

/** Recency boost weight — a fresh zero-overlap item (0.05) outranks a stale
 *  zero-overlap one but never a real lexical hit (≥ ~0.06). */
export const MEMORY_RECENCY_WEIGHT = 0.05;

/** Lowercase word tokens (alphanumeric runs) — the shared tokenizer for
 *  similarity + retrieval scoring. */
export function tokenizeContent(text: string): Set<string> {
  const out = new Set<string>();
  for (const token of (text ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length > 0) out.add(token);
  }
  return out;
}

/** Normalized similarity between two texts: Jaccard overlap of their token
 *  sets (1 = identical token sets, 0 = disjoint). Two empty texts = 1. */
export function contentSimilarity(a: string, b: string): number {
  const ta = tokenizeContent(a);
  const tb = tokenizeContent(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) {
    if (tb.has(t)) intersection++;
  }
  return intersection / (ta.size + tb.size - intersection);
}

/** Lexical-overlap + recency score for one memory item against a query. */
export function scoreMemoryItem(
  item: Pick<ProjectMemoryItem, "content" | "updated_at">,
  queryTokens: ReadonlySet<string>,
  nowMs: number = Date.now(),
): number {
  const itemTokens = tokenizeContent(item.content);
  let hits = 0;
  for (const token of queryTokens) {
    if (itemTokens.has(token)) hits++;
  }
  const overlap = queryTokens.size > 0 ? hits / queryTokens.size : 0;
  const updated = Date.parse(item.updated_at);
  const ageDays = Number.isFinite(updated)
    ? Math.max(0, (nowMs - updated) / 86_400_000)
    : Number.POSITIVE_INFINITY;
  const recency = 1 / (1 + ageDays);
  return overlap + recency * MEMORY_RECENCY_WEIGHT;
}

/**
 * Budgeted selection: pinned items ALWAYS come first, then the remaining
 * items in (score desc, updated_at desc) order; the walk STOPS at the first
 * non-pinned item that no longer fits the budget. Pinned items count toward
 * the running total but are included even when they alone exceed it.
 */
export function selectMemoriesWithinBudget(
  items: ProjectMemoryItem[],
  queryText: string,
  budgetChars: number = DEFAULT_RETRIEVAL_BUDGET_CHARS,
  nowMs: number = Date.now(),
): ProjectMemoryItem[] {
  const queryTokens = tokenizeContent(queryText);
  const ranked = [...items].sort((a, b) => {
    if (!!b.pinned !== !!a.pinned) return a.pinned ? -1 : 1;
    const sa = scoreMemoryItem(a, queryTokens, nowMs);
    const sb = scoreMemoryItem(b, queryTokens, nowMs);
    if (sb !== sa) return sb - sa;
    return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
  });
  const out: ProjectMemoryItem[] = [];
  let used = 0;
  for (const item of ranked) {
    const length = item.content.length;
    if (item.pinned) {
      out.push(item);
      used += length;
      continue;
    }
    if (used + length > budgetChars) break;
    out.push(item);
    used += length;
  }
  return out;
}

function nowISO(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** All memories of a project. By default superseded (chained-out) items are
 *  excluded — pass `{ includeSuperseded: true }` for the full history. */
export async function listMemories(
  projectId: string,
  opts: { includeSuperseded?: boolean } = {},
): Promise<ProjectMemoryItem[]> {
  const rows = await db.project_memories.where("project_id").equals(projectId).toArray();
  const filtered = opts.includeSuperseded ? rows : rows.filter((m) => !m.superseded_by);
  filtered.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
  return filtered;
}

// ---------------------------------------------------------------------------
// Save (dedupe / supersede)
// ---------------------------------------------------------------------------

export interface SaveMemoryInput {
  category: ProjectMemoryCategory;
  content: string;
  source_conversation_ids?: string[];
  /** 0..1. */
  confidence?: number;
  pinned?: boolean;
}

export interface SaveMemoryResult {
  /** The newly created item (always created — writes never mutate in place,
   *  so provenance is preserved). */
  item: ProjectMemoryItem;
  /** The item this save superseded (similarity > threshold), if any. */
  superseded: ProjectMemoryItem | null;
}

/**
 * Save a memory. Dedupe rule: when an existing NON-SUPERSEDED item in the
 * same category has >0.9 normalized content similarity, the old item is
 * chained out (`superseded_by` → the new id) and the new item inherits the
 * union of both items' source-conversation ids — instead of duplicating.
 */
export async function saveMemory(
  projectId: string,
  input: SaveMemoryInput,
): Promise<SaveMemoryResult> {
  if (!projectId) {
    throw new MemoryServiceError("invalid_input", "A project id is required to save a memory.");
  }
  const content = (input?.content ?? "").trim();
  if (!content) {
    throw new MemoryServiceError("invalid_content", "Memory content must not be empty.");
  }

  const ts = nowISO();
  const id = nanoid();

  // Dedupe check against same-category, non-superseded items.
  const existing = await db.project_memories.where("project_id").equals(projectId).toArray();
  let superseded: ProjectMemoryItem | null = null;
  let bestSimilarity = 0;
  for (const candidate of existing) {
    if (candidate.superseded_by || candidate.category !== input.category) continue;
    const similarity = contentSimilarity(candidate.content, content);
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      superseded = candidate;
    }
  }
  const shouldSupersede =
    superseded !== null && bestSimilarity > MEMORY_SIMILARITY_THRESHOLD;

  // Provenance: inherit the superseded item's sources (union, deduped).
  const sources = new Set<string>(input.source_conversation_ids ?? []);
  if (shouldSupersede && superseded) {
    for (const sid of superseded.source_conversation_ids ?? []) sources.add(sid);
  }

  const item: ProjectMemoryItem = {
    id,
    project_id: projectId,
    category: input.category,
    content,
    source_conversation_ids: [...sources],
    confidence:
      typeof input.confidence === "number"
        ? Math.min(1, Math.max(0, input.confidence))
        : undefined,
    pinned: input.pinned ?? false,
    superseded_by: null,
    created_at: ts,
    updated_at: ts,
  };
  await db.project_memories.add(item);

  if (shouldSupersede && superseded) {
    await db.project_memories.update(superseded.id, {
      superseded_by: id,
      updated_at: ts,
    });
  }

  return { item, superseded: shouldSupersede ? superseded : null };
}

// ---------------------------------------------------------------------------
// Update / delete / pin
// ---------------------------------------------------------------------------

export type UpdateMemoryPatch = Partial<
  Pick<ProjectMemoryItem, "category" | "content" | "confidence" | "pinned" | "source_conversation_ids">
>;

/** Patch a memory's editable fields. Returns null when the id is unknown. */
export async function updateMemory(
  id: string,
  patch: UpdateMemoryPatch,
): Promise<ProjectMemoryItem | null> {
  const current = await db.project_memories.get(id);
  if (!current) return null;
  const update: Partial<ProjectMemoryItem> = { updated_at: nowISO() };
  if (patch.category !== undefined) update.category = patch.category;
  if (patch.content !== undefined) {
    const content = patch.content.trim();
    if (!content) {
      throw new MemoryServiceError("invalid_content", "Memory content must not be empty.");
    }
    update.content = content;
  }
  if (patch.confidence !== undefined) {
    update.confidence = Math.min(1, Math.max(0, patch.confidence));
  }
  if (patch.pinned !== undefined) update.pinned = patch.pinned;
  if (patch.source_conversation_ids !== undefined) {
    update.source_conversation_ids = [...new Set(patch.source_conversation_ids)];
  }
  await db.project_memories.update(id, update);
  return (await db.project_memories.get(id)) ?? null;
}

export async function deleteMemory(id: string): Promise<void> {
  await db.project_memories.delete(id);
}

/** Pin (or unpin) a memory — pinned items are always retrieved first. */
export async function pinMemory(
  id: string,
  pinned: boolean,
): Promise<ProjectMemoryItem | null> {
  return updateMemory(id, { pinned });
}

// ---------------------------------------------------------------------------
// Budgeted retrieval
// ---------------------------------------------------------------------------

/**
 * Retrieve the project-memory slice for a query: pinned first, then ranked
 * by lexical overlap + recency, stopped at `budgetChars` (defaults to
 * DEFAULT_RETRIEVAL_BUDGET_CHARS — callers that have the project row should
 * pass its `memory_settings.context_budget_chars`).
 * Superseded items are never retrieved.
 */
export async function retrieveMemories(
  projectId: string,
  queryText: string,
  budgetChars: number = DEFAULT_RETRIEVAL_BUDGET_CHARS,
): Promise<ProjectMemoryItem[]> {
  const active = await listMemories(projectId);
  return selectMemoriesWithinBudget(active, queryText, budgetChars);
}

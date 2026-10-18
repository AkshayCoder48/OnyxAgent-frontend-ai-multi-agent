"use client";

/**
 * HYBRID CHAT SEARCH (Task 2-b, PRD §11) — lexical + best-effort semantic
 * over the `message_search_index` table, fused with Reciprocal Rank Fusion.
 *
 * Layering:
 *   - PURE (unit-tested, no Dexie): cosineSimilarity, reciprocalRankFusion,
 *     filterRowsForScope, buildExcerpt (query-relevant <mark>-highlighted
 *     snippet), escapeHtml.
 *   - Dexie-backed: searchChats — candidate fetch (scope + date filter,
 *     newest-first, scan cap), orphan reconciliation (lazy delete cascade),
 *     live title/project join, lexical ranking via the SHARED scorer
 *     (src/lib/search/score.ts), optional query embedding + cosine ranking,
 *     RRF merge.
 *
 * Honesty rules: `semanticAvailable` is true ONLY when the query embedding
 * actually succeeded; without it the lexical order stands and the UI labels
 * the mode "Keyword search". No result is ever fabricated.
 */

import { db } from "@/lib/db";
import { rankDocuments, tokenize } from "@/lib/search/score";
import { embedQuery } from "@/lib/search/indexer";
import type { MessageSearchRow } from "@/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Search scope: everything / general chats only / one project's chats. */
export type SearchScope = "all" | "general" | { projectId: string };

export interface SearchOptions {
  scope: SearchScope;
  userId: string;
  /** Max hits returned (default 30). */
  limit?: number;
  /** Inclusive created_at bounds (ISO date "YYYY-MM-DD" or full ISO). */
  dateFilter?: { from?: string; to?: string };
}

export interface SearchHit {
  messageId: string;
  conversationId: string;
  conversationTitle: string;
  projectId: string | null;
  projectName: string | null;
  /** Project accent hex (for the badge dot) — null for general chats. */
  projectAccent: string | null;
  role: "user" | "assistant" | "system";
  createdAt: string;
  /** ≤240 chars around the best term match, query terms <mark>-highlighted. */
  excerpt: string;
  /** Fused score (RRF when both halves ran; lexical score otherwise). */
  score: number;
  matchedBy: "lexical" | "semantic" | "both";
}

export interface SearchResults {
  hits: SearchHit[];
  /** True only when the query embedding succeeded (semantic half live). */
  semanticAvailable: boolean;
  /** Candidate rows actually scanned (pre-ranking, post-scope/date filter). */
  scannedMessages: number;
}

/** Max candidate rows scanned per query (newest-first before the cap). */
export const SEARCH_SCAN_CAP = 5000;
/** Max chars of one result excerpt. */
export const EXCERPT_MAX_CHARS = 240;
/** RRF constant (standard k=60). */
export const RRF_K = 60;
/** Queries with fewer RAW words than this skip the semantic half. */
export const SEMANTIC_MIN_WORDS = 3;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Cosine similarity of two vectors (0 when lengths differ/are zero). */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface RrfEntry {
  id: string;
  /** 0-based rank in its own list (best = 0). */
  rank: number;
}

export interface RrfFused {
  id: string;
  score: number;
  matchedBy: "lexical" | "semantic" | "both";
}

/**
 * Reciprocal Rank Fusion: score(d) = Σ_lists 1 / (k + rank). Rows appearing
 * in both lists are "both"; single-list rows keep their side. Ties break by
 * lexical rank first, then id (stable output). Pure.
 */
export function reciprocalRankFusion(
  lexical: readonly RrfEntry[],
  semantic: readonly RrfEntry[],
  k: number = RRF_K,
): RrfFused[] {
  const scores = new Map<string, { score: number; by: "lexical" | "semantic" | "both"; lexRank: number }>();
  const add = (list: readonly RrfEntry[], side: "lexical" | "semantic") => {
    for (const entry of list) {
      const cur = scores.get(entry.id);
      const inc = 1 / (k + entry.rank + 1);
      if (!cur) {
        scores.set(entry.id, {
          score: inc,
          by: side,
          lexRank: side === "lexical" ? entry.rank : Number.MAX_SAFE_INTEGER,
        });
      } else {
        cur.score += inc;
        cur.by = "both";
        if (side === "lexical") cur.lexRank = Math.min(cur.lexRank, entry.rank);
      }
    }
  };
  add(lexical, "lexical");
  add(semantic, "semantic");
  return [...scores.entries()]
    .map(([id, v]) => ({ id, score: v.score, matchedBy: v.by }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ra = scores.get(a.id)?.lexRank ?? Number.MAX_SAFE_INTEGER;
      const rb = scores.get(b.id)?.lexRank ?? Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      return a.id.localeCompare(b.id);
    });
}

/** HTML-escape a text run (excerpts render as trusted <mark> markup). */
export function escapeHtml(text: string): string {
  return (text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Pure scope predicate over index rows (general = project_id null; project =
 * exact id; all = everything). Exported for tests + the search path.
 */
export function filterRowsForScope(rows: readonly MessageSearchRow[], scope: SearchScope): MessageSearchRow[] {
  if (scope === "all") return [...rows];
  if (scope === "general") return rows.filter((r) => !r.project_id);
  return rows.filter((r) => r.project_id === scope.projectId);
}

/** Inclusive created_at bounds from the (possibly date-only) filter values. */
export function dateBounds(filter: { from?: string; to?: string } | undefined): {
  fromMs: number | null;
  toMs: number | null;
} {
  const from = filter?.from ? new Date(filter.from.length === 10 ? `${filter.from}T00:00:00` : filter.from) : null;
  const to = filter?.to ? new Date(filter.to.length === 10 ? `${filter.to}T23:59:59.999` : filter.to) : null;
  return {
    fromMs: from && !Number.isNaN(from.getTime()) ? from.getTime() : null,
    toMs: to && !Number.isNaN(to.getTime()) ? to.getTime() : null,
  };
}

/**
 * Build a ≤maxChars excerpt around the DENSEST cluster of query-term matches,
 * ellipsized at both cut ends, with every term occurrence wrapped in
 * <mark>…</mark>. The non-mark text is HTML-escaped; matches are whole-word,
 * case-insensitive. Semantic-only hits (no term match) fall back to the head
 * of the text. Pure + deterministic.
 */
export function buildExcerpt(text: string, query: string, maxChars: number = EXCERPT_MAX_CHARS): string {
  const normalized = (text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxChars) return markTerms(escapeHtml(normalized), query);

  const terms = [...new Set(tokenize(query))].filter((t) => t.length > 1);
  // Character hits of query terms (word boundaries).
  const lower = normalized.toLowerCase();
  const hits: number[] = [];
  if (terms.length > 0) {
    const re = new RegExp(`\\b(${terms.map(escapeRegExp).join("|")})\\b`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower)) !== null) hits.push(m.index);
  }

  let start = 0;
  if (hits.length > 0) {
    // Densest window: for each hit, the window STARTING there; keep the best.
    let bestCount = 0;
    for (let i = 0; i < hits.length; i++) {
      const s = Math.max(0, Math.min(hits[i]!, normalized.length - maxChars));
      const count = hits.filter((h) => h >= s && h < s + maxChars).length;
      if (count > bestCount) {
        bestCount = count;
        start = s;
      }
    }
  }
  const end = Math.min(normalized.length, start + maxChars);
  // Prefer cutting at a word boundary at the tail (start is already one).
  const raw = normalized.slice(start, end);
  const lastSpace = raw.lastIndexOf(" ");
  const slice = start > 0 && lastSpace > maxChars * 0.6 ? raw.slice(0, lastSpace) : raw;
  const prefix = start > 0 ? "…" : "";
  const suffix = end < normalized.length ? "…" : "";
  return `${prefix}${markTerms(escapeHtml(slice.trim()), query)}${suffix}`;
}

/** Wrap whole-word case-insensitive occurrences of query terms in <mark>.
 *  Adjacent marks separated only by a hyphen joiner merge into ONE mark, so
 *  a hyphenated query like "xylophone-project-note" highlights as a single
 *  contiguous <mark>xylophone-project-note</mark> instead of three fragments. */
function markTerms(escapedHtml: string, query: string): string {
  const terms = [...new Set(tokenize(query))].filter((t) => t.length > 1);
  if (terms.length === 0) return escapedHtml;
  const re = new RegExp(`\\b(${terms.map(escapeRegExp).join("|")})\\b`, "gi");
  return escapedHtml
    .replace(re, (match) => `<mark>${match}</mark>`)
    .replace(/<\/mark>(-{1,2})<mark>/g, "$1");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Raw whitespace-word count of a query (semantic-half eligibility). */
export function wordCount(query: string): number {
  return (query ?? "").trim().split(/\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// searchChats — the Dexie-backed hybrid query
// ---------------------------------------------------------------------------

/**
 * Search the user's chat history. ALWAYS runs the lexical half (shared
 * scorer); the semantic half joins only when the query is non-trivial
 * (≥ SEMANTIC_MIN_WORDS raw words) AND the query embedding succeeds via the
 * user's connected Pollinations account. Orphaned index rows (conversation
 * deleted) are lazily removed — the honest delete cascade for any deletion
 * path that didn't hook the indexer.
 */
export async function searchChats(query: string, opts: SearchOptions): Promise<SearchResults> {
  const trimmed = (query ?? "").trim();
  const empty: SearchResults = { hits: [], semanticAvailable: false, scannedMessages: 0 };
  if (!trimmed) return empty;
  if (tokenize(trimmed).length === 0) return empty;

  // ── 1) Candidates: scope → date filter → newest-first → scan cap ──────
  let candidates: MessageSearchRow[];
  try {
    if (opts.scope === "all") {
      candidates = await db.message_search_index.toArray();
    } else if (opts.scope === "general") {
      try {
        candidates = await db.message_search_index.where("project_id").equals(null).toArray();
      } catch {
        // Engines that reject null keys — full scan + pure filter below.
        candidates = await db.message_search_index.toArray();
      }
    } else {
      candidates = await db.message_search_index
        .where("project_id")
        .equals(opts.scope.projectId)
        .toArray();
    }
  } catch {
    return empty;
  }
  candidates = filterRowsForScope(candidates, opts.scope);

  const { fromMs, toMs } = dateBounds(opts.dateFilter);
  if (fromMs !== null || toMs !== null) {
    candidates = candidates.filter((r) => {
      const t = Date.parse(r.created_at);
      if (Number.isNaN(t)) return false;
      if (fromMs !== null && t < fromMs) return false;
      if (toMs !== null && t > toMs) return false;
      return true;
    });
  }
  candidates.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  const scanned = candidates.length;
  if (candidates.length > SEARCH_SCAN_CAP) candidates = candidates.slice(0, SEARCH_SCAN_CAP);
  if (candidates.length === 0) return empty;

  // ── 2) Orphan reconciliation + live metadata join ─────────────────────
  const conversationIds = [...new Set(candidates.map((r) => r.conversation_id))];
  const conversations = await db.conversations.bulkGet(conversationIds).catch(() => []);
  const convById = new Map<string, { title?: string | null }>();
  for (const c of conversations) if (c) convById.set(c.id, c as { id: string; title?: string | null });

  let rows = candidates;
  const orphanConvIds = conversationIds.filter((id) => !convById.has(id));
  if (orphanConvIds.length > 0) {
    // The conversation is gone (deleted from any path) — drop + purge rows.
    rows = rows.filter((r) => !orphanConvIds.includes(r.conversation_id));
    try {
      await db.message_search_index.where("conversation_id").anyOf(orphanConvIds).delete();
    } catch {
      // Non-fatal — next search retries the purge.
    }
  }

  const projectIds = [...new Set(rows.map((r) => r.project_id).filter((p): p is string => !!p))];
  const projects = projectIds.length
    ? await db.projects.bulkGet(projectIds).catch(() => [])
    : [];
  const projectById = new Map<string, { name: string; accent_color?: string | null }>();
  for (const p of projects) {
    if (p) projectById.set(p.id, { name: p.name, accent_color: p.accent_color ?? null });
  }

  if (rows.length === 0) return { ...empty, scannedMessages: scanned };

  // ── 3) Lexical ranking (shared scorer — score.ts) ─────────────────────
  const lexicalRanked = rankDocuments(trimmed, rows, {
    textOf: (r) => r.text,
    idOf: (r) => r.message_id,
  });
  const rowById = new Map(rows.map((r) => [r.message_id, r]));
  const lexicalScoreById = new Map(lexicalRanked.map(({ item, score }) => [item.message_id, score]));

  // ── 4) Semantic half (best-effort) ────────────────────────────────────
  let semanticAvailable = false;
  let semanticRanked: Array<{ id: string; score: number }> = [];
  let semanticModel: string | null = null;
  let queryVector: number[] | null = null;
  if (wordCount(trimmed) >= SEMANTIC_MIN_WORDS) {
    try {
      const embedded = await embedQuery(trimmed);
      if (embedded && embedded.vector.length > 0) {
        semanticAvailable = true;
        semanticModel = embedded.model;
        queryVector = embedded.vector;
      }
    } catch {
      semanticAvailable = false; // lexical always stands
    }
  }
  if (semanticAvailable && queryVector) {
    const cosines: Array<{ id: string; score: number }> = [];
    for (const r of rows) {
      // Same-model vectors only — mixing embedding spaces is dishonest math.
      if (r.embed_state !== "ready" || !r.embedding || !r.embed_model) continue;
      if (semanticModel && r.embed_model !== semanticModel) continue;
      const sim = cosineSimilarity(queryVector, r.embedding);
      if (sim > 0.05) cosines.push({ id: r.message_id, score: sim });
    }
    cosines.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    semanticRanked = cosines.slice(0, 100); // top slice feeds the fusion
  }

  // ── 5) Fusion: RRF over both rankings; lexical-only order stands alone ─
  const limit = Math.max(1, opts.limit ?? 30);
  let ordered: Array<{ id: string; score: number; matchedBy: "lexical" | "semantic" | "both" }>;
  if (semanticRanked.length > 0) {
    ordered = reciprocalRankFusion(
      lexicalRanked.map((r, i) => ({ id: r.item.message_id, rank: i })),
      semanticRanked.map((r, i) => ({ id: r.id, rank: i })),
    );
  } else {
    // No semantic candidates → pure lexical order (semanticAvailable may still
    // be true — the mode label reflects the QUERY embedding success, and hits
    // whose only match was semantic simply don't exist in that case).
    ordered = lexicalRanked.map((r) => ({
      id: r.item.message_id,
      score: r.score,
      matchedBy: "lexical" as const,
    }));
  }

  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const entry of ordered) {
    if (hits.length >= limit) break;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const row = rowById.get(entry.id);
    if (!row) continue;
    const conv = convById.get(row.conversation_id);
    const project = row.project_id ? projectById.get(row.project_id) : undefined;
    hits.push({
      messageId: row.message_id,
      conversationId: row.conversation_id,
      conversationTitle: (conv?.title ?? row.title_cache ?? "").trim(),
      projectId: row.project_id,
      projectName: project?.name ?? null,
      projectAccent: project?.accent_color ?? null,
      role: row.role,
      createdAt: row.created_at,
      excerpt: buildExcerpt(row.text, trimmed),
      score: Number(entry.score.toFixed(6)),
      matchedBy: entry.matchedBy,
    });
  }

  return { hits, semanticAvailable, scannedMessages: scanned };
}

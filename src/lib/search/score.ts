/**
 * Shared lexical scorer (Tasks 2-b + 2-d — PRD §7.3 / semantic search).
 *
 * PURE functions only — no Dexie, no network, no embeddings. Everything here
 * is deterministic and safe to call from the agent runtime, the search
 * dialog, the context-package builder, and unit tests alike.
 *
 * What lives here (and what 2-b should REUSE instead of re-implementing):
 *
 *   - `tokenize()` / `tokenSet()` — the canonical lowercase word tokenizer
 *     (alphanumeric runs) with stopword handling. The SAME tokenization is
 *     used by the lexical half of 2-b's hybrid search, by the cross-chat
 *     retrieval fallback in `context-package.ts`, and by tests.
 *   - `tfMap()` — term frequencies for TF scoring.
 *   - `lexicalScore()` — normalized term-frequency overlap between a query
 *     and a document (0..1). This is the BM25-ish lexical half; 2-b merges it
 *     with cosine similarity via its own RRF fusion.
 *   - `rankDocuments()` — score + sort a batch of `{ id, text }` documents
 *     against one query (ties broken deterministically by id so results are
 *     stable across renders).
 *   - `bestWindowExcerpt()` — the highest-matching window of a document,
 *     used to build compact retrieval excerpts (context packages today,
 *     search-result excerpts in 2-b).
 *
 * Embedding/cosine/RRF do NOT live here — 2-b owns those (they need the
 * embeddings API + vector math); this module stays lexical and dependency
 * free on purpose.
 */

/** Small English stopword set — removed from BOTH query and document tokens
 *  so filler words never dominate the overlap score. Kept conservative: a
 *  missing stopword only slightly deflates specificity, an over-eager list
 *  would drop domain words ("run", "set", "use"). */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "if",
  "in", "into", "is", "it", "its", "of", "on", "or", "that", "the",
  "their", "then", "there", "these", "this", "to", "was", "were", "will",
  "with", "what", "when", "where", "which", "who", "whom", "why", "how",
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "they", "them",
  "do", "does", "did", "so", "than", "too", "very", "can", "just", "about",
]);

/**
 * Lowercase word tokens (alphanumeric runs), duplicates KEPT (term
 * frequency matters). Optional stopword filtering — leave `keepStopwords`
 * falsy for scoring, truthy when the raw token stream is needed verbatim.
 */
export function tokenize(text: string, opts?: { keepStopwords?: boolean }): string[] {
  const out: string[] = [];
  const keep = opts?.keepStopwords === true;
  for (const token of (text ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (!token) continue;
    if (!keep && STOPWORDS.has(token)) continue;
    out.push(token);
  }
  return out;
}

/** Unique token set of a text (order-insensitive membership checks). */
export function tokenSet(text: string, opts?: { keepStopwords?: boolean }): Set<string> {
  return new Set(tokenize(text, opts));
}

/** Term frequencies of a token array. */
export function tfMap(tokens: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/**
 * Normalized TF overlap between a query and a document: the fraction of the
 * QUERY's term mass that also appears in the document (weighted by the
 * document's own term frequency, damped, so a term repeated 50× in one doc
 * cannot drown out everything else).
 *
 *   score = Σ_over_shared_terms qtf · (1 + log(1 + dtf)) / Σ_all_terms qtf
 *
 * Returns 0 for an empty query (nothing to match) — callers decide whether
 * an empty query means "return nothing" or "most recent first".
 */
export function lexicalScore(
  queryTokens: readonly string[],
  documentTokens: readonly string[],
): number {
  if (queryTokens.length === 0) return 0;
  const docTf = tfMap(documentTokens);
  let queryMass = 0;
  for (const freq of tfMap(queryTokens).values()) queryMass += freq;
  if (queryMass === 0) return 0;
  let hitMass = 0;
  for (const [term, freq] of tfMap(queryTokens)) {
    const dtf = docTf.get(term);
    if (!dtf) continue;
    hitMass += freq * (1 + Math.log(1 + dtf));
  }
  // Normalize hit mass by the RAW query mass (a full match of every distinct
  // query term scores ≈1 + log damping; cap at 1 so the value stays a clean
  // 0..1-ish signal for blending).
  return Math.min(1, hitMass / queryMass);
}

/** Convenience: `lexicalScore` over raw strings. */
export function lexicalScoreText(query: string, document: string): number {
  return lexicalScore(tokenize(query), tokenize(document));
}

export interface ScoredDocument<T> {
  item: T;
  score: number;
}

/**
 * Score + rank a batch of documents against one query. Ties break
 * deterministically by `idOf` (stable output across renders/retries).
 * Documents with score 0 are DROPPED (no relevance → no result).
 */
export function rankDocuments<T>(
  query: string,
  documents: readonly T[],
  opts: {
    textOf: (item: T) => string;
    idOf?: (item: T) => string;
  },
): Array<ScoredDocument<T>> {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];
  const idOf = opts.idOf ?? ((_item: T) => "");
  const scored = documents.map((item) => ({
    item,
    score: lexicalScore(queryTokens, tokenize(opts.textOf(item))),
  }));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(idOf(a.item)).localeCompare(String(idOf(b.item)));
  });
  return scored.filter((s) => s.score > 0);
}

/**
 * The highest-scoring contiguous window of `maxChars` characters around the
 * document's best query-term cluster — a compact, query-relevant excerpt.
 * Prefers windows starting at a token boundary; ellipsizes both ends when
 * the window doesn't cover the whole text. Pure + deterministic.
 */
export function bestWindowExcerpt(
  document: string,
  query: string,
  maxChars: number = 280,
): string {
  const text = (document ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return `${text.slice(0, maxChars - 1)}…`;

  // Character-position hits for every query term occurrence.
  const lower = text.toLowerCase();
  const hits: number[] = [];
  const re = /[a-z0-9]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower)) !== null) {
    if (queryTokens.has(m[0])) hits.push(m.index);
  }
  if (hits.length === 0) return `${text.slice(0, maxChars - 1)}…`;

  // Slide a window of maxChars and keep the one covering the most hits.
  // (Each hit index is already a word boundary — the regex matched a token.)
  let bestStart = 0;
  let bestCount = 0;
  for (let i = 0; i < hits.length; i++) {
    const start = Math.max(0, Math.min(hits[i]!, text.length - maxChars));
    const count = hits.filter((h) => h >= start && h < start + maxChars).length;
    if (count > bestCount) {
      bestCount = count;
      bestStart = start;
    }
  }
  const end = Math.min(text.length, bestStart + maxChars);
  const prefix = bestStart > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(bestStart, end).trim()}${suffix}`;
}

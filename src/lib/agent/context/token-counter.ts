/**
 * Fast heuristic token estimation (Onyx Infinite Context PRD §9).
 *
 * There is no exact tokenizer available for every OpenAI-compatible provider
 * in the browser, and shipping per-vendor tokenizers would bloat the bundle.
 * This estimator is deliberately CONSERVATIVE (it errs high) so budget
 * decisions never over-commit a provider's real context window:
 *
 *   - CJK-heavy text counts ~1 token per ~1.5 chars (dense tokens)
 *   - Latin text counts ~1 token per ~3.5 chars (GPT-style averages 3.5–4)
 *   - Whitespace runs compress but still count
 *
 * A small LRU memo cache keeps repeated estimations of the same strings
 * (system prompts, tool schemas, stable history) O(1) after the first pass.
 */

const ESTIMATE_CACHE_MAX = 512;
const cache = new Map<string, number>();

/**
 * Estimate the token count of a string. Conservative by design — see the
 * module doc. Cheap enough to call on every history message per turn.
 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  const hit = cache.get(text);
  if (hit !== undefined) {
    // LRU refresh.
    cache.delete(text);
    cache.set(text, hit);
    return hit;
  }
  let cjk = 0;
  let other = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // CJK Unified Ideographs + common fullwidth ranges + Hangul + Kana.
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  // Conservative rounding: always round UP on the mixed estimate.
  const estimate = Math.ceil(cjk / 1.5 + other / 3.5);
  const bounded = Math.max(1, estimate);
  if (cache.size >= ESTIMATE_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(text, bounded);
  return bounded;
}

/** Estimate the token weight of a tool definition (name + description + schema). */
export function estimateToolTokens(tool: {
  name?: string;
  description?: string;
  parameters?: unknown;
}): number {
  const static_ = estimateTokens(tool.name ?? "") + estimateTokens(tool.description ?? "");
  const schema = JSON.stringify(tool.parameters ?? {});
  return static_ + estimateTokens(schema);
}

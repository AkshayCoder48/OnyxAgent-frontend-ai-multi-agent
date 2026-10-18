/**
 * Export feature — small isomorphic formatting helpers shared by the
 * Markdown builder (`markdown.ts`) and the server-side PDF/DOCX builders
 * (`/api/export/route.ts`), so all three formats render identical
 * timestamps/durations.
 */

/**
 * Format an ISO timestamp as a deterministic, timezone-independent string:
 * `YYYY-MM-DD HH:MM UTC`. Deterministic output matters — the Markdown
 * builder is unit-tested and the same value is stamped into every format.
 * Falls back to the raw string when it does not look like an ISO date.
 */
export function formatExportTimestamp(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]} UTC` : iso;
}

/** Human duration for tool-call summaries: `123 ms`, `1.2 s`. */
export function formatExportDuration(ms?: number): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Cap a single-line excerpt at `max` chars with an ellipsis. */
export function excerptText(text: string | null | undefined, max = 200): string | null {
  if (!text) return null;
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (!oneLine) return null;
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1).trimEnd() + "…";
}

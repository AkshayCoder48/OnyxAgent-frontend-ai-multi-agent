/**
 * Stream guards — shared detection of error payloads INSIDE an SSE stream.
 *
 * Free/community gateways (Pollinations community routes, freeaixyz4all,
 * g4f relays…) often return HTTP 200 and then deliver the REAL failure as a
 * JSON error payload inside the stream body:
 *
 *   data: {"error": {"message": "upstream busy", "code": 503}}
 *   data: {"detail": "Not authenticated"}
 *   data: {"success": false, "error": {...}}
 *
 * Without this guard those chunks are silently dropped (no `choices` →
 * extractDelta returns null), the stream ends empty, and the agent loop
 * treats "no content + no tool calls" as a NORMAL final response — the AI
 * just "auto stops" with no error anywhere. These helpers turn that silent
 * stop into an explicit, logged, retryable error.
 */

/** Extract a human-readable error message from a stream chunk, or null when
 *  the chunk is a normal completion chunk (has choices/usage, no error). */
export function extractStreamError(chunk: Record<string, unknown>): string | null {
  // A usable chunk always carries choices or usage — never classify those
  // as errors even when extra fields ride along.
  const hasChoices = Array.isArray(chunk.choices) && chunk.choices.length > 0;
  if (hasChoices || chunk.usage) return null;

  const error = chunk.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object") {
    const e = error as { message?: unknown; code?: unknown; detail?: unknown };
    const msg =
      typeof e.message === "string" && e.message.trim()
        ? e.message.trim()
        : typeof e.detail === "string"
          ? e.detail
          : "";
    const code = typeof e.code === "string" || typeof e.code === "number" ? ` (code ${e.code})` : "";
    if (msg) return `${msg}${code}`;
    try {
      return `stream error object: ${JSON.stringify(error).slice(0, 300)}`;
    } catch {
      return "stream error object (unserializable)";
    }
  }

  // FastAPI-style validation errors: {"detail": "..."} or {"detail": [{...}]}
  const detail = chunk.detail;
  if (typeof detail === "string" && detail.trim()) return detail.trim();
  if (Array.isArray(detail) && detail.length > 0) {
    try {
      return `validation error: ${JSON.stringify(detail).slice(0, 300)}`;
    } catch {
      return "validation error (unserializable)";
    }
  }

  // Typed error events: {"type": "error", "message": "..."}
  if (chunk.type === "error") {
    const msg = chunk.message;
    if (typeof msg === "string" && msg.trim()) return msg.trim();
    return "typed stream error event";
  }

  // Last resort: a bare {"message": "..."} with no choices/usage. Only treat
  // it as an error when the payload has nothing else useful.
  if (typeof chunk.message === "string" && chunk.message.trim() && Object.keys(chunk).length <= 3) {
    return chunk.message.trim();
  }

  return null;
}

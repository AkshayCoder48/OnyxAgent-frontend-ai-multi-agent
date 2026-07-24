/**
 * Extract a human-readable error message from any backend error format.
 *
 * The FastAPI backend returns three different error shapes depending on what
 * raised:
 *
 * 1. `AppException` (domain errors like AlreadyExistsError):
 *    `{ error: { code, message, details } }`
 *    — uses `error.message`.
 *
 * 2. Pydantic validation errors (FastAPI's default 422 handler):
 *    `{ detail: [{ type, loc, msg, input, ctx }, ...] }`
 *    — join the per-field `msg` strings, or fall back to "Validation error".
 *
 * 3. Plain `{ detail: "some string" }` (Starlette HTTPException):
 *    — use the string directly.
 *
 * The Next.js API proxy routes previously only handled case (3), so any
 * domain error (e.g. "Email already registered") was silently replaced with
 * a generic "Registration failed" / "Login failed" string. This helper
 * surfaces the real backend message instead.
 */
export function extractBackendErrorMessage(
  data: unknown,
  fallback: string,
): string {
  if (!data || typeof data !== "object") return fallback;
  const d = data as Record<string, unknown>;

  // Case 1: { error: { message } }
  if (d.error && typeof d.error === "object") {
    const inner = d.error as Record<string, unknown>;
    if (typeof inner.message === "string" && inner.message.trim()) {
      return inner.message;
    }
  }

  // Case 2: { detail: [...] } (Pydantic validation array)
  if (Array.isArray(d.detail) && d.detail.length > 0) {
    const messages = d.detail
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>;
          if (typeof obj.msg === "string") {
            // Include the field name when available — "email: value is not a valid email address"
            const loc = Array.isArray(obj.loc) ? obj.loc : null;
            const field =
              loc && loc.length > 1 && typeof loc[loc.length - 1] === "string"
                ? String(loc[loc.length - 1])
                : null;
            return field ? `${field}: ${obj.msg}` : obj.msg;
          }
        }
        return null;
      })
      .filter((s): s is string => Boolean(s));
    if (messages.length > 0) return messages.join("; ");
  }

  // Case 3: { detail: "string" }
  if (typeof d.detail === "string" && d.detail.trim()) {
    return d.detail;
  }

  // Case 4: top-level message
  if (typeof d.message === "string" && d.message.trim()) {
    return d.message;
  }

  return fallback;
}

// ============================================================================
// Composio args coercion — SERVER-SAFE, no client imports.
//
// Lives here (not in lib/tools/composio_tools.ts) so the server route
// /api/composio/tools/execute can import it WITHOUT pulling the browser tool
// registry into a Node context (composio_tools.ts imports registerTool from
// the "use client" registry — a top-level call that breaks `next build`:
// "Attempted to call registerTool() from the server but registerTool is on
// the client"). That build failure is why deploys went stale and users kept
// hitting the pre-fix guard; see worklog Task 45.
// ============================================================================

/**
 * Coerce the model's `args` payload into a plain object (user report
 * 2026-11-24: "args must be an object matching the tool's inputSchema" on
 * EVERY composio call). OpenAI-compatible gateways deliver tool arguments
 * in degenerate shapes that the old hard guard rejected outright:
 *
 *   1. DOUBLE-STRINGIFIED — "args": "{\"channel\":\"C123\"}" (the nested
 *      object arrived as a JSON string; some providers re-encode every
 *      object-valued parameter).
 *   2. ALIAS KEY — arguments/parameters/params/input instead of `args`
 *      (the model renamed the field after the Composio API's own wording).
 *   3. FLATTENED — the tool's fields ride the TOP level of our own tool
 *      call: {"toolName": "SLACK_SEND_MESSAGE", "channel": "C123", …} —
 *      the provider dropped one level of nesting.
 *   4. MISSING + extras — zero-field tools (`{}` inputSchema) are called
 *      with no args at all; also accepts `args: null`.
 *
 * The object is what Composio's execute endpoint expects — its `arguments`
 * field is documented as a real JSON object (verified against
 * docs.composio.dev, POST /api/v3/tool_router/session/{sid}/execute; v3.1 is
 * the current release, v3 frozen but supported), never a JSON-encoded string.
 *
 * Shared by the execute tool (full logic: alias + string + flatten) and the
 * route (parse-only, so the wire stays an object — see route.ts).
 */
export function coerceComposioArgs(
  raw: unknown,
  extra: Record<string, unknown> = {},
): Record<string, unknown> | null {
  // Alias keys: accept whichever object-valued alias the model chose.
  let candidate: unknown = raw;
  if (candidate == null) {
    // (4) missing/null → start from extras (flattened fields, if any)
    candidate = Object.keys(extra).length ? { ...extra } : {};
  }

  // (1) double-stringified JSON — parse once; on failure it's garbage.
  if (typeof candidate === "string") {
    const t = candidate.trim();
    if (!t) candidate = {};
    else {
      try {
        candidate = JSON.parse(t);
      } catch {
        return null; // unparseable string — genuinely bad payload
      }
    }
  }

  // Parsed from string OR native object — extras (the flattened tool fields
  // that rode the TOP level of our own call) always survive underneath: a
  // string args + flattened call keeps BOTH ({args:'{"text":"hi"}',
  // channel:"C8"} → {text, channel}).
  const mergeWithExtras = (obj: Record<string, unknown>): Record<string, unknown> => {
    const merged: Record<string, unknown> = { ...extra };
    for (const [k, v] of Object.entries(obj)) {
      if (v !== undefined) merged[k] = v;
    }
    return merged;
  };

  if (Array.isArray(candidate)) return null; // arrays are never the inputSchema
  if (candidate !== null && typeof candidate === "object" && !(candidate instanceof Date)) {
    const obj = candidate as Record<string, unknown>;
    // Alias unwrap ONE level: {args: {...}} / {arguments: {...}} wrapped
    // AGAIN by the model (string args inside an object, etc.).
    const inner = obj.args ?? obj.arguments ?? obj.parameters ?? obj.params ?? obj.input;
    if (inner != null && typeof inner === "string") {
      try {
        const parsed = JSON.parse(inner.trim());
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return mergeWithExtras(parsed as Record<string, unknown>);
        }
      } catch {
        return null;
      }
    }
    // (2) alias key at OUR level: {arguments: {...}} → use the inner object
    if (inner != null && typeof inner === "object" && !Array.isArray(inner)) {
      return mergeWithExtras(inner as Record<string, unknown>);
    }
    // Plain object — merge extras so flattened fields survive.
    return mergeWithExtras(obj);
  }
  return null;
}

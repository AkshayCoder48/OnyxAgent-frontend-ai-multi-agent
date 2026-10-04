/**
 * REQUEST-SCOPED TOOL EXPOSURE (Runtime PRD §71/§72)
 *
 * The registry holds ~70+ tools, but NOT every request should carry every
 * definition. The foreground OnyxAgent turn never sees the CODING surface:
 *
 *  - category "exec" (run_python / run_terminal) and category "code" tools
 *    (reserved for sandbox-side/background use),
 *  - the file-AUTHORING helpers (create_file / write_file / edit_file /
 *    verify_path + the chunked writer trio).
 *
 * Files (read/list/send/upload/delete), Connectors and everything else the
 * agent uses remain available. Background sandbox jobs build their own
 * native tool surface (see e2b/bg-native-tools.ts) and are not affected by
 * this filter.
 *
 * The filter is PURE and cheap (name/category set lookups) — safe to call
 * once per round.
 */

import type { ToolDefinition } from "./registry";

/** Tool categories excluded from normal OnyxAgent turns (coding surface). */
const AGENT_EXCLUDED_CATEGORIES = new Set(["code", "exec"]);

/** Shared-category tools that are nonetheless excluded from agent turns:
 * the file-AUTHORING helpers (create_file / write_file / edit_file + the
 * chunked writer trio) are the coding write path. Reading, listing,
 * browsing, sending, deleting and uploading files stays available — that is
 * the Files capability. */
const AGENT_EXCLUDED_TOOL_NAMES = new Set([
  "create_file",
  "write_file",
  "edit_file",
  "verify_path",
  "create_file_chunk",
  "read_file_section",
]);

export interface RequestToolScope {
  /** The latest user message text. Optional (unused by the current filter,
   * kept for call-site compatibility). */
  lastUserText?: string | null;
  /** Tool names already used earlier in this conversation. Optional (kept
   * for call-site compatibility). */
  usedToolNames?: Iterable<string>;
}

/** Filter a registry snapshot for one request. NEVER mutates the input. */
export function filterToolsForRequest(
  tools: ToolDefinition[],
  _scope?: RequestToolScope,
): ToolDefinition[] {
  return tools.filter(
    (t) =>
      !(t.category && AGENT_EXCLUDED_CATEGORIES.has(t.category)) &&
      !AGENT_EXCLUDED_TOOL_NAMES.has(t.name),
  );
}

/** Collect the tool names used in a conversation's message history —
 * accepts the Dexie message rows' `tool_calls` arrays. */
export function usedToolNamesFromHistory(
  messages: Array<{ tool_calls?: Array<{ tool_name?: string; name?: string }> | null }>,
): Set<string> {
  const names = new Set<string>();
  for (const m of messages) {
    if (!m.tool_calls || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      const n = tc?.tool_name ?? tc?.name;
      if (typeof n === "string" && n) names.add(n);
    }
  }
  return names;
}

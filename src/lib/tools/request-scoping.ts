/**
 * REQUEST-SCOPED TOOL EXPOSURE (Runtime PRD §71/§72 — since retired).
 *
 * History: this module used to strip the CODING surface (category "exec"
 * tools + the file-authoring helpers create_file / write_file / edit_file /
 * verify_path / create_file_chunk / read_file_section) from normal
 * OnyxAgent turns — the OnyxCode PRD reserved coding for Code Mode chats,
 * subagents and sandbox-side jobs. OnyxCode was later deleted entirely
 * (commit de15168) and the isolation became self-contradictory:
 *
 *  - the TOOL DIGEST injected into EVERY turn still documented the coding
 *    tools, so models kept calling them;
 *  - foreground turns executed those calls fine (the runtime looks tools up
 *    in the FULL registry) but never advertised them on the wire;
 *  - background turns — the default execution path — refused them with
 *    "Unknown tool in background mode: write_file".
 *
 * The isolation is now fully retired: the main agent receives the complete
 * registry on every turn, identical to the subagent runtime, the sandbox
 * background runner (BG_NATIVE_TOOL_NAMES) and the digest. The filter is
 * kept as a pass-through seam so a future scoping policy has one place to
 * land without touching call sites.
 */

import type { ToolDefinition } from "./registry";

export interface RequestToolScope {
  /** The latest user message text. Optional (unused by the current filter,
   * kept for call-site compatibility). */
  lastUserText?: string | null;
  /** Tool names already used earlier in this conversation. Optional (kept
   * for call-site compatibility). */
  usedToolNames?: Iterable<string>;
}

/** Filter a registry snapshot for one request. NEVER mutates the input.
 * Currently a pass-through — see the module header for why the coding
 * surface is no longer excluded. */
export function filterToolsForRequest(
  tools: ToolDefinition[],
  _scope?: RequestToolScope,
): ToolDefinition[] {
  return tools;
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

/**
 * REQUEST-SCOPED TOOL EXPOSURE (OnyxBase Database PRD §13 + Runtime PRD §71/§72)
 *
 * The registry holds ~70+ tools, but NOT every request should carry every
 * definition:
 *
 *  - MODE GATING: tools registered with category "code" (create_app,
 *    start_preview, manage_preview, the kv / storage database suite, …)
 *    exist ONLY for OnyxCode. A normal OnyxAgent turn never sees them
 *    (OnyxBase PRD §22: "The normal Agent must not receive them merely
 *    because they exist in OnyxCode"). Agent-mode background jobs never gain
 *    Code Database access (§34).
 *
 *  - DATABASE INTENT GATING (§13 "Intelligent Tool Exposure"): inside Code
 *    mode, the DISCOVERY half of the database suite (inspect_database,
 *    kv_get, kv_list, storage_list, storage_read, storage_metadata) always
 *    rides along — it is how the agent learns the app's persistent data
 *    context — while the WRITE half (kv_set, kv_delete, storage_write,
 *    storage_delete, schema_upsert, manage_database) is included only when
 *    the request plausibly needs it: the user's message mentions data /
 *    storage / persistence / schema, OR a database tool was already used in
 *    this conversation (the "latch" — once the app has a database context,
 *    it keeps the full suite). This keeps "create a landing page" requests
 *    light without ever hiding capabilities mid-project.
 *
 * The filter is PURE and cheap (name/category set lookups) — safe to call
 * once per round.
 */

import type { ToolDefinition } from "./registry";

/** Read-only database discovery tools — always offered in Code Mode. */
const DB_DISCOVERY_TOOLS = new Set([
  "inspect_database",
  "kv_get",
  "kv_list",
  "storage_list",
  "storage_read",
  "storage_metadata",
]);

/** Mutating database/storage tools — intent-gated (below). */
const DB_WRITE_TOOLS = new Set([
  "kv_set",
  "kv_delete",
  "storage_write",
  "storage_delete",
  "schema_upsert",
  "manage_database",
]);

/** Any database/storage tool name (discovery ∪ write). */
const ANY_DB_TOOL = new Set([...DB_DISCOVERY_TOOLS, ...DB_WRITE_TOOLS]);

/** Generous intent signal: data / persistence / schema / upload wording in
 *  the user's request. False positives are cheap (a few extra tool
 *  definitions); false negatives are what §13 forbids. */
const DB_INTENT_RE =
  /\b(kv|key[- ]?value|database|db\b|storage|persist|persisten\w*|schema|record|records|entity|entities|user data|users?|settings|preference|upload|uploads|save data|store data|load data|retrieve|saved|stores?|profile|account|login|auth|form|todo)\b/i;

export interface RequestToolScope {
  /** True when the turn belongs to an OnyxCode (Code Mode) conversation. */
  codeMode: boolean;
  /** The latest user message text (intent detection). Optional. */
  lastUserText?: string | null;
  /** Tool names already used earlier in this conversation (the latch). */
  usedToolNames?: Iterable<string>;
}

/** Filter a registry snapshot for one request. NEVER mutates the input. */
export function filterToolsForRequest(
  tools: ToolDefinition[],
  scope: RequestToolScope,
): ToolDefinition[] {
  const { codeMode, lastUserText, usedToolNames } = scope;

  // Latch: once ANY database tool ran in this conversation, the full suite
  // stays available for the project's lifetime.
  let dbLatched = false;
  if (usedToolNames) {
    for (const name of usedToolNames) {
      if (ANY_DB_TOOL.has(name)) {
        dbLatched = true;
        break;
      }
    }
  }
  const dbIntent = dbLatched || DB_INTENT_RE.test(lastUserText ?? "");

  if (!codeMode) {
    // Agent mode: drop EVERYTHING category "code" (OnyxBase PRD §22/§34).
    return tools.filter((t) => t.category !== "code");
  }

  // Code mode: keep everything, gate only the database WRITE half.
  if (dbIntent) return tools;
  return tools.filter((t) => !DB_WRITE_TOOLS.has(t.name));
}

/** Collect the tool names used in a conversation's message history (the
 *  latch input) — accepts the Dexie message rows' `tool_calls` arrays. */
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

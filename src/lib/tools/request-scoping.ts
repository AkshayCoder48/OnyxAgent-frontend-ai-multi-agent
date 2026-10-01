/**
 * REQUEST-SCOPED TOOL EXPOSURE (OnyxBase Database PRD §13 + Runtime PRD §71/§72)
 *
 * The registry holds ~70+ tools, but NOT every request should carry every
 * definition:
 *
 *  - MODE GATING (OnyxCode PRD §2/§3): the Code-only surface — category
 *    "code" (create_app, start_preview, the kv/env/storage database suite,
 *    browser_eval, diagnostics…), category "exec" (run_python/run_terminal)
 *    and the file-AUTHORING helpers (create_file/write_file/edit_file +
 *    the chunked writer trio) — exists ONLY for OnyxCode. A normal
 *    OnyxAgent turn never sees them (OnyxBase PRD §22: "The normal Agent
 *    must not receive them merely because they exist in OnyxCode"). Agent-
 *    mode background jobs never gain Code Database access (§34). Files
 *    (read/list/send/upload) and Connectors are SHARED capabilities and
 *    remain available in both modes.
 *
 *  - DATABASE INTENT GATING (§13 "Intelligent Tool Exposure"): inside Code
 *    mode, the DISCOVERY half of the database suite (inspect_database,
 *    kv_get, kv_list, env_list, env_get, storage_list, storage_read,
 *    storage_metadata) always
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

/** Tool categories that exist ONLY inside OnyxCode (OnyxCode PRD §3):
 *  - "code" — the OnyxCode suite (create_app, previews, web sessions,
 *    the kv / env / storage / schema database tools, browser_eval, the
 *    diagnostics/testing suite).
 *  - "exec" — E2B code execution (run_python, run_terminal).
 *  A normal OnyxAgent turn NEVER sees either category — not in the
 *  provider payload, not callable, not discoverable (OnyxBase PRD §22/§34:
 *  "The normal Agent must not receive them merely because they exist in
 *  OnyxCode"). */
const CODE_ONLY_CATEGORIES = new Set(["code", "exec"]);

/** Shared-category tools that are nonetheless Code-only: the file-AUTHORING
 *  helpers (create_file / write_file / edit_file + the chunked writer trio)
 *  are the coding write path. Reading, listing, browsing, sending, deleting
 *  and uploading files stays shared — that is the Files capability
 *  (OnyxCode PRD §2: "Files and Connectors must remain available in BOTH
 *  modes"). */
const CODE_ONLY_TOOL_NAMES = new Set([
  "create_file",
  "write_file",
  "edit_file",
  "verify_path",
  "create_file_chunk",
  "read_file_section",
]);

/** Read-only database discovery tools — always offered in Code Mode. */
const DB_DISCOVERY_TOOLS = new Set([
  "inspect_database",
  "kv_get",
  "kv_list",
  "env_list",
  "env_get",
  "storage_list",
  "storage_read",
  "storage_metadata",
]);

/** Mutating database/storage tools — intent-gated (below). */
const DB_WRITE_TOOLS = new Set([
  "kv_set",
  "kv_delete",
  "env_set",
  "env_delete",
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
  /\b(kv|key[- ]?value|database|db\b|storage|persist|persisten\w*|schema|record|records|entity|entities|env(?:ironment)?[ -]?vars?|secrets?|credentials?|user data|users?|settings|preference|upload|uploads|save data|store data|load data|retrieve|saved|stores?|profile|account|login|auth|form|todo)\b/i;

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
    // Agent mode: drop EVERY Code-only surface (OnyxCode PRD §3 — the
    // model request must not contain coding tools, E2B execution, browser
    // eval, or the Code-only database tools). Files (read/list/send/upload)
    // and Connectors stay — they are shared capabilities.
    return tools.filter(
      (t) =>
        !(t.category && CODE_ONLY_CATEGORIES.has(t.category)) &&
        !CODE_ONLY_TOOL_NAMES.has(t.name),
    );
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

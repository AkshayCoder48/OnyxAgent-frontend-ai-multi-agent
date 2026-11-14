/**
 * TOOL STACK SUMMARIES — the per-tool captions of the combined tools row
 * (2026-11-14 directive: "change the basic docs icon tools to docs icon
 * 'Created N Files, Used N Tools, Created N Todos' … for every tool present
 * in our app; custom tools show 'Used N Tools'").
 *
 * Every settled stack of tool calls folds into ONE disclosure row
 *
 *     [doc icon] Created 3 Files · Created 5 Todos · Used 2 Tools    ›
 *
 * Each tool family carries a {verb, singular, plural} rule, so the caption
 * always says WHAT the run did and HOW MANY times — in the user's own
 * phrasing. Unknown names (user-created custom tools, per-turn MCP tools)
 * aggregate into the "Used N Tools" bucket, always last.
 *
 * Pure data + pure functions — no React, no registry import (umbrella
 * resolution comes from tool-umbrella.ts) — safe in any client component.
 */

import type { ToolCall } from "@/types";
import { effectiveToolName } from "@/lib/agent/tool-umbrella";

/** One summary rule: "Created" + 1 → "File", n → "Files". */
export interface SummaryRule {
  verb: string;
  one: string;
  many: string;
}

const rule = (verb: string, one: string, many?: string): SummaryRule => ({
  verb,
  one,
  many: many ?? `${one}s`,
});

/**
 * Per-tool rules for every registered tool in the app. Keyed by the
 * EFFECTIVE (granular) tool name — umbrella calls are resolved through
 * effectiveToolName() first.
 */
export const TOOL_SUMMARY_RULES: Readonly<Record<string, SummaryRule>> = {
  // Files
  create_file: rule("Created", "File"),
  write_file: rule("Created", "File"),
  create_file_chunk: rule("Created", "File"),
  edit_file: rule("Edited", "File"),
  delete_file: rule("Deleted", "File"),
  read_file: rule("Read", "File"),
  read_file_section: rule("Read", "File"),
  read_uploaded_file: rule("Read", "File"),
  create_folder: rule("Created", "Folder"),
  delete_folder: rule("Deleted", "Folder"),
  list_folder: rule("Listed", "Folder"),
  list_uploaded_files: rule("Listed", "Upload"),
  move_file: rule("Moved", "File"),
  verify_path: rule("Prepared", "Path"),
  send_file: rule("Sent", "File"),
  send_folder: rule("Sent", "Folder"),
  ocr_document: rule("Scanned", "Document"),
  search_documents: rule("Searched", "Document"),

  // Web
  web_search: rule("Ran", "Web Search", "Web Searches"),
  image_search: rule("Ran", "Image Search", "Image Searches"),
  video_search: rule("Ran", "Video Search", "Video Searches"),
  web_fetch: rule("Fetched", "Page"),
  use_browser: rule("Browsed", "Page"),
  inspect_elements: rule("Inspected", "Page"),
  bypass_cloudflare: rule("Bypassed", "Cloudflare Check"),
  solve_captcha: rule("Solved", "Captcha"),
  manage_web_session: rule("Managed", "Web Session"),
  start_web_session: rule("Started", "Web Session"),
  code_web_session: rule("Ran", "Web Session"),

  // Code exec & app building
  run_python: rule("Ran", "Python Script", "Python Scripts"),
  run_terminal: rule("Ran", "Command"),
  webcmd: rule("Ran", "Command"),
  background_task: rule("Started", "Background Task", "Background Tasks"),
  create_app: rule("Created", "App"),
  run_build: rule("Ran", "Build"),
  run_tests: rule("Ran", "Test Suite", "Test Suites"),
  run_lint: rule("Ran", "Lint Check", "Lint Checks"),
  run_typecheck: rule("Ran", "Typecheck"),
  run_diagnostics: rule("Ran", "Diagnostic"),
  code_diagnostics: rule("Ran", "Diagnostic"),
  inspect_database: rule("Inspected", "Database"),
  manage_database: rule("Managed", "Database"),
  schema_upsert: rule("Upserted", "Schema", "Schemas"),
  code_preview: rule("Previewed", "App"),
  start_preview: rule("Started", "Preview"),
  manage_preview: rule("Previewed", "App"),
  preview_html: rule("Previewed", "HTML Page", "HTML Pages"),
  preview_image: rule("Previewed", "Image"),
  inspect_image: rule("Inspected", "Image"),

  // Todos
  show_todo: rule("Showed", "Todo List", "Todo Lists"),
  clear_todo: rule("Cleared", "Todo List", "Todo Lists"),

  // Subagents
  spawn_subagent: rule("Spawned", "Subagent"),
  list_subagents: rule("Listed", "Subagent"),
  set_subagent_config: rule("Configured", "Subagent"),
  query_subagent: rule("Messaged", "Subagent"),
  steer_subagent: rule("Steered", "Subagent"),
  complete_subagent: rule("Completed", "Subagent"),
  cancel_subagent: rule("Cancelled", "Subagent"),
  manage_subagent_chat: rule("Managed", "Subagent Chat", "Subagent Chats"),

  // Schedules
  schedule_agent_task: rule("Scheduled", "Task"),
  list_scheduled_tasks: rule("Listed", "Schedule"),
  remove_scheduled_task: rule("Removed", "Scheduled Task", "Scheduled Tasks"),

  // Integrations & MCP
  mcp_search_tools: rule("Searched", "MCP Tool", "MCP Tools"),
  mcp_call_tool: rule("Called", "MCP Tool", "MCP Tools"),
  manage_mcp: rule("Managed", "MCP Server", "MCP Servers"),
  composio_search_tools: rule("Searched", "Integration"),
  composio_connect_platform: rule("Connected", "Platform"),
  composio_execute_tool: rule("Ran", "Integration Tool", "Integration Tools"),

  // Chats & memory
  read_chat: rule("Read", "Chat"),
  chat_inspect: rule("Inspected", "Chat"),
  manage_chats: rule("Managed", "Chat"),
  manage_memory: rule("Updated", "Memory", "Memories"),
  project_memory: rule("Updated", "Project Memory", "Project Memories"),

  // Workspace
  analyze_workspace: rule("Analyzed", "Workspace"),
  security_audit: rule("Ran", "Security Audit", "Security Audits"),
  push_workspace: rule("Synced", "Workspace"),
  retrieve_workspace: rule("Synced", "Workspace"),
  env_get: rule("Read", "Env Var", "Env Vars"),
  env_set: rule("Set", "Env Var", "Env Vars"),
  env_list: rule("Listed", "Env Var", "Env Vars"),
  env_delete: rule("Deleted", "Env Var", "Env Vars"),
  manage_env_var: rule("Managed", "Env Var", "Env Vars"),
  kv_get: rule("Read", "KV Entry", "KV Entries"),
  kv_set: rule("Set", "KV Entry", "KV Entries"),
  kv_list: rule("Listed", "KV Entry", "KV Entries"),
  kv_delete: rule("Deleted", "KV Entry", "KV Entries"),
  storage_read: rule("Managed", "Storage Object", "Storage Objects"),
  storage_write: rule("Managed", "Storage Object", "Storage Objects"),
  storage_list: rule("Managed", "Storage Object", "Storage Objects"),
  storage_delete: rule("Managed", "Storage Object", "Storage Objects"),
  storage_metadata: rule("Managed", "Storage Object", "Storage Objects"),

  // Media, charts & reasoning
  media_generation: rule("Generated", "Media Asset", "Media Assets"),
  generate_image: rule("Generated", "Image"),
  create_chart: rule("Created", "Chart"),
  ask_user: rule("Asked", "Question"),
  counterfactual: rule("Ran", "Counterfactual"),
  decision: rule("Ran", "Decision Analysis", "Decision Analyses"),
  current_datetime: rule("Checked", "Date"),

  // Custom tools management (the tools that CREATE custom tools)
  create_custom_tool: rule("Created", "Custom Tool", "Custom Tools"),
  manage_custom_tool: rule("Managed", "Custom Tool", "Custom Tools"),
  workflow: rule("Ran", "Workflow"),
};

/** Action-aware overrides for multi-function tools whose `action` changes
 *  the verb (manage_todo — the user's "Created N Todos" example — and the
 *  Knowledge Base, whose actions read better as doc verbs). */
const ACTION_RULES: Readonly<Record<string, Readonly<Record<string, SummaryRule>>>> = {
  manage_todo: {
    create: rule("Created", "Todo"),
    update: rule("Updated", "Todo"),
    delete: rule("Deleted", "Todo"),
    clear: rule("Cleared", "Todo List", "Todo Lists"),
    list: rule("Listed", "Todo"),
  },
  knowledge_base: {
    search: rule("Searched", "Document"),
    get: rule("Read", "Document"),
    save: rule("Saved", "Document"),
    update: rule("Updated", "Document"),
    delete: rule("Deleted", "Document"),
    list: rule("Listed", "Document"),
  },
};

const TODO_RULE = rule("Updated", "Todo");
const KB_RULE = rule("Updated", "Document");

/**
 * Mirror of the manage_todo handler's payload inference (see
 * src/lib/tools/todos.ts): `{title}` → create, `{id,status}` → update,
 * `{id}` → delete, `{}` → list — so the caption shows the SAME action the
 * tool actually executed even when the model omitted the verb.
 */
function todoActionOf(args: Record<string, unknown>): string {
  const explicit = String(args?.action ?? args?.operation ?? "")
    .trim()
    .toLowerCase();
  if (explicit) return explicit;
  const hasId = Boolean(String(args?.todo_id ?? args?.todoId ?? args?.id ?? "").trim());
  const hasTitle = Boolean(String(args?.title ?? args?.content ?? "").trim());
  if (hasId && (args?.status !== undefined || hasTitle)) return "update";
  if (hasId) return "delete";
  if (hasTitle && args?.status !== undefined) return "update";
  if (hasTitle) return "create";
  return "list";
}

/** The rule for one call — action-aware where the tool needs it, null for
 *  unknown names (custom tools, MCP tools) which fall into the Used bucket. */
function ruleForCall(name: string, args: Record<string, unknown>): SummaryRule | null {
  if (name === "manage_todo") {
    return ACTION_RULES.manage_todo![todoActionOf(args)] ?? TODO_RULE;
  }
  const actionRules = ACTION_RULES[name];
  if (actionRules) {
    const action = String(args?.action ?? args?.operation ?? "").toLowerCase();
    return actionRules[action] ?? KB_RULE;
  }
  return TOOL_SUMMARY_RULES[name] ?? null;
}

/** Only calls that actually landed count toward the summary — failed calls
 *  are reported by the "· N failed" suffix, never as work done. */
function landed(tc: ToolCall): boolean {
  return tc.status !== "error";
}

/**
 * The ordered summary segments for a stack: each tool family that did work
 * contributes "Verb N Noun(s)"; unknown names aggregate into "Used N Tools"
 * (always last). Empty array ⇒ nothing landed (the caller shows the plain
 * "Tools" label with the failure count).
 */
export function stackSummarySegments(
  toolCalls: readonly ToolCall[],
): string[] {
  const counts = new Map<string, { rule: SummaryRule; n: number }>();
  let usedCount = 0;

  for (const tc of toolCalls) {
    if (!landed(tc)) continue;
    const name = effectiveToolName(tc.name, tc.args);
    const r = ruleForCall(name, tc.args ?? {});
    if (!r) {
      // Custom tools (user-created) and per-turn MCP tools — the generic
      // bucket the user asked for.
      usedCount += 1;
      continue;
    }
    const key = `${r.verb}|${r.one}`;
    const entry = counts.get(key);
    if (entry) entry.n += 1;
    else counts.set(key, { rule: r, n: 1 });
  }

  const segments: string[] = [];
  for (const { rule: r, n } of counts.values()) {
    segments.push(`${r.verb} ${n} ${n === 1 ? r.one : r.many}`);
  }
  if (usedCount > 0) {
    segments.push(`Used ${usedCount} ${usedCount === 1 ? "Tool" : "Tools"}`);
  }
  return segments;
}

/**
 * The full caption of the combined row: the segments joined with " · ",
 * falling back to "Tools" when nothing landed. (The "· N failed" suffix is
 * appended by the row component — it is not part of this label.)
 */
export function stackSummaryLabel(toolCalls: readonly ToolCall[]): string {
  const segments = stackSummarySegments(toolCalls);
  return segments.length > 0 ? segments.join(" · ") : "Tools";
}

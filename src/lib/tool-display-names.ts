/**
 * TOOL DISPLAY NAMES — the UI-only plain-language labels for tool names.
 *
 * USER DIRECTIVE (2026-11-01): "replace code-ish name like manage_custom_tool,
 * edit_tool … to plain, UI only not in background where it execs, and using
 * custom tools are saying custom_tools at name looking too ugly". The
 * REGISTRY names (what the model calls, what dispatches, what persists) are
 * untouched — this module only changes what the UI RENDERS when a name
 * would otherwise leak into a human-facing surface (tool-call card titles,
 * timeline verbs, live captions, friendly sentences, the subagent sidebar).
 *
 * Two layers:
 *   1. EXACT PLAIN NAMES for the code-ish families the user called out —
 *      `custom_tools` / `manage_custom_tool` / `edit_tool` render as
 *      "Custom Tools"; every other manage_* umbrella family gets its plain
 *      noun ("Skills", "MCP Servers", "Memory" …).
 *   2. A HUMANIZING FALLBACK for everything else (user-created custom tools
 *      with snake_case names included): split on underscores, title-case the
 *      words — `my_weather_widget` → "My Weather Widget" — never a raw
 *      code identifier on screen.
 *
 * Dependency-free — safe to import anywhere in the UI.
 */

/** Exact plain-name overrides: registry name → what the UI shows. */
export const TOOL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  // ── Custom tools (the called-out family) ──────────────────────────────
  // The umbrella (`custom_tools`), the manager (`manage_custom_tool`), and
  // the legacy granulars all render as the same plain noun; the per-call
  // nuance (create / edit / delete) already rides the argument chip.
  custom_tools: "Custom Tools",
  manage_custom_tool: "Custom Tools",
  create_custom_tool: "Custom Tools",
  create_tool: "Custom Tools",
  edit_tool: "Custom Tools",
  delete_tool: "Custom Tools",

  // ── Merged multi-function families → plain nouns ──────────────────────
  manage_skill: "Skills",
  manage_mcp: "MCP Servers",
  manage_memory: "Memory",
  manage_env_var: "Environment Variables",
  manage_chats: "Past Chats",
  manage_subagent_chat: "Subagent Chats",
  manage_web_session: "Web Session",
  start_web_session: "Web Session",
  manage_todo: "Todos",
  manage_todos: "Todos",
  show_todo: "Todos",

  // ── Scheduling / workspace / background ───────────────────────────────
  schedule_agent_task: "Scheduled Task",
  list_scheduled_tasks: "Scheduled Tasks",
  remove_scheduled_task: "Scheduled Tasks",
  background_task: "Background Task",
  analyze_workspace: "Workspace Scan",
  security_audit: "Security Audit",
  ocr_document: "Document Reader",

  // ── Subagent orchestration ────────────────────────────────────────────
  spawn_subagent: "Subagent",
  list_subagents: "Subagents",
  set_subagent_config: "Subagent Setup",
  query_subagent: "Subagent Chat",
  steer_subagent: "Subagent Chat",
  complete_subagent: "Subagent",
  cancel_subagent: "Subagent",

  // ── Skills / knowledge ────────────────────────────────────────────────
  load_skill: "Skill",
  list_skills: "Skills",
  read_skill: "Skill",
  knowledge_base: "Knowledge Base",
  search_knowledge_base: "Knowledge Base",
  search_documents: "Documents",
  project_memory: "Project Memory",
  workflow: "Workflow",
};

/**
 * The plain UI label for a tool name. Exact overrides win; anything else
 * humanizes (snake_case → Title Case words) so no raw code identifier —
 * not even a user-created custom tool's `my_cool_widget` — ever renders.
 */
export function toolDisplayName(name: string): string {
  const exact = TOOL_DISPLAY_NAMES[name];
  if (exact) return exact;
  if (!name) return name;
  const words = name
    .replace(/_(tool|tools)$/i, "")
    .split(/[\s_]+/)
    .filter(Boolean);
  if (words.length === 0) return name;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

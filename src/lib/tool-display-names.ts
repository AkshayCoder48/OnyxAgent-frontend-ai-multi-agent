/**
 * Plain display names for tool calls — UI-ONLY (PRD: display layer never
 * changes execution identifiers). The registry, the runner, and the model
 * keep the real snake_case names; the chat card header shows these.
 *
 * The umbrella names (`files`, `web`, `custom_tools`, …) and merged
 * management tools (`manage_custom_tool`, `edit_tool` legacy, …) map to
 * plain phrases, and ANY unknown name — a user-created custom tool, an MCP
 * slug, a new backend tool — falls back to a humanized Title Case of the
 * real name, so a custom tool called `weather_fetch` renders as
 * "Weather Fetch" instead of the raw snake_case.
 */

const EXACT_NAMES: Record<string, string> = {
  // Umbrella tools (tool-count consolidation) — the model-facing surface.
  files: "Files",
  web: "Web",
  code_exec: "Code",
  subagents: "Subagents",
  schedule: "Schedule",
  integrations: "Integrations",
  chats: "Chats",
  memory: "Memory",
  todos: "To-dos",
  media: "Media",
  workspace: "Workspace",
  custom_tools: "Custom Tools",
  // Custom-tool management (merged family; `edit_tool` is a legacy alias).
  manage_custom_tool: "Custom Tools",
  edit_tool: "Custom Tools",
  create_tool: "Custom Tools",
  delete_tool: "Custom Tools",
  create_custom_tool: "Custom Tools",
  // Search + read (the DDG family stays DDG only underneath — display only).
  web_search: "Web Search",
  web_search_tool: "Web Search",
  search_web: "Web Search",
  image_search: "Image Search",
  video_search: "Video Search",
  web_fetch: "Web Page",
  fetch_url: "Web Page",
  // Files.
  read_file_section: "Read File",
  create_file_chunk: "Write File",
  verify_path: "Path Check",
  list_workspace_files: "Files",
  list_uploaded_files: "Files",
  read_uploaded_file: "Files",
  // Code + tasks.
  run_terminal: "Terminal",
  background_task: "Background Task",
  // Subagents.
  spawn_subagent: "Subagent",
  query_subagent: "Subagent",
  steer_subagent: "Subagent",
  manage_subagent_chat: "Subagent Chat",
  // Schedule.
  schedule_agent_task: "Scheduled Tasks",
  list_scheduled_tasks: "Scheduled Tasks",
  remove_scheduled_task: "Scheduled Tasks",
  // Integrations.
  mcp_search_tools: "MCP Tools",
  mcp_call_tool: "MCP Tool",
  composio_search_tools: "App Integrations",
  composio_connect_platform: "App Connection",
  composio_execute_tool: "App Integration",
  // Skills, memory, env, MCP management.
  manage_skill: "Skills",
  load_skill: "Skill",
  list_skills: "Skills",
  read_skill: "Skill",
  manage_memory: "Memory",
  project_memory: "Memory",
  manage_env_var: "Environment",
  set_env_var: "Environment",
  manage_mcp: "MCP Servers",
  manage_web_session: "Web Session",
  start_web_session: "Web Session",
  // Misc.
  ocr_document: "OCR",
  search_documents: "Documents",
  knowledge_base: "Knowledge Base",
  create_map: "Map",
  create_map_tool: "Map",
  decision: "Decision",
  security_audit: "Security Audit",
  analyze_workspace: "Workspace",
  get_current_datetime: "Date & Time",
  current_datetime: "Date & Time",
  counterfactual: "What-if",
};

/** `weather_fetch` → "Weather Fetch" (custom tools, MCP slugs, new tools). */
export function humanizeToolName(name: string): string {
  const stem = name.replace(/_tool$/, "");
  const words = stem.split("_").filter(Boolean);
  if (words.length === 0) return name;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/**
 * The plain name a tool-call card shows for `name`. Known tools get their
 * curated phrase; anything else (user-created custom tools included) gets a
 * humanized Title Case of the real name. Never throws, never empty.
 */
export function toolDisplayName(name: string): string {
  if (!name) return "Tool";
  const exact = EXACT_NAMES[name];
  if (exact) return exact;
  return humanizeToolName(name);
}

/**
 * Human-readable captions narrating what the agent is doing "under the hood"
 * while a tool runs. Used by the live agent-step animation to label each step
 * in plain language. Dependency-free — safe to use anywhere in the UI.
 */

const EXACT_CAPTIONS: Record<string, string> = {
  search_knowledge_base: "Searching the knowledge base",
  search_documents: "Searching the documents",
  web_search_tool: "Searching the web",
  search_web: "Searching the web",
  fetch_url: "Reading a web page",
  get_current_datetime: "Checking the date and time",
  current_datetime: "Checking the date and time",
  run_python: "Running calculations",
  create_chart_tool: "Creating a chart",
  create_map_tool: "Drawing a map",
  ask_user: "Asking you a question",
  load_skill: "Loading a skill",
  send_file: "Preparing a file for download",
  send_folder: "Preparing a folder for download",
  list_skills: "Listing available skills",
  read_skill: "Reading a skill",
  create_file: "Creating a file",
  read_file: "Reading a file",
  write_file: "Writing a file",
  edit_file: "Editing a file",
  delete_file: "Deleting a file",
  list_files: "Listing files",
  create_folder: "Creating a folder",
  delete_folder: "Deleting a folder",
  run_terminal: "Running a terminal command",
  set_env_var: "Setting an environment variable",
  list_chats: "Looking up past chats",
  read_chat: "Reading a past chat",
  create_tool: "Creating a custom tool",
  edit_tool: "Editing a custom tool",
  delete_tool: "Deleting a custom tool",
  // Todo toolset (pydantic_ai_todo) — surfaced in the live plan panel.
  read_todos: "Reading the plan",
  write_todos: "Writing the plan",
  add_todo: "Adding a step to the plan",
  update_todo_status: "Updating step status",
  update_todo_statuses: "Updating step statuses",
  remove_todo: "Removing a step",
  add_subtask: "Adding a subtask",
  set_dependency: "Setting a dependency",
  get_available_tasks: "Finding available tasks",
  // Agent Todo system (PRD) — manage_todo / show_todo.
  manage_todo: "Managing todos",
  manage_todos: "Managing todos",
  show_todo: "Showing the todo list",
  // Long-term memory (OPFS) — surfaced by the AgentStatus live pill.
  memory_save: "Saving a memory",
  memory_list: "Reading memories",
  memory_search: "Searching memories",
  // Merged multi-function tools (tool-count cap) — names map to the old
  // families they absorbed; live captions stay generic.
  manage_memory: "Working with memories",
  manage_env_var: "Managing environment variables",
  manage_skill: "Managing skills",
  manage_mcp: "Managing MCP servers",
  manage_custom_tool: "Managing custom tools",
  manage_subagent_chat: "Managing a subagent chat",
  manage_chats: "Looking up past chats",
  ocr_document: "Reading text from a document",
};

/** Prefix-based fallbacks for tools like `generate_*`. */
const PREFIX_CAPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["generate_", "Generating a chart"],
  ["search_", "Searching"],
  ["create_", "Creating"],
  ["fetch_", "Fetching data"],
  ["get_", "Looking that up"],
  ["list_", "Looking that up"],
];

function humanizeToolName(name: string): string {
  const words = name
    .replace(/_tool$/, "")
    .split("_")
    .filter(Boolean);
  if (words.length === 0) return name;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/**
 * Present-tense phrase describing what the agent is doing while `toolName` runs.
 * Falls back to "Running <Tool Name>" for unknown tools.
 */
export function toolCaption(toolName: string): string {
  const exact = EXACT_CAPTIONS[toolName];
  if (exact) return exact;
  for (const [prefix, caption] of PREFIX_CAPTIONS) {
    if (toolName.startsWith(prefix)) return caption;
  }
  return `Running ${humanizeToolName(toolName)}`;
}

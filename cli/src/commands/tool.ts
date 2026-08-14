export async function listTools(): Promise<void> {
  // This is a stub — in production, tools would be imported from the shared
  // registry. For now, list the known tool categories.
  const tools = [
    "list_folder", "read_file", "create_file", "write_file", "edit_file",
    "delete_file", "create_folder", "delete_folder", "move_file", "rename_file",
    "run_python", "run_terminal", "web_search", "image_search", "video_search",
    "web_fetch", "ocr_image", "ocr_pdf", "preview_image", "create_chart",
    "ask_user", "current_datetime", "search_documents", "analyze_workspace",
    "list_env_vars", "set_env_var", "memory_save", "memory_search",
    "manage_todos", "workflow", "spawn_subagent", "query_subagent",
  ];
  console.log(`Available tools (${tools.length}):\n`);
  for (const t of tools) {
    console.log(`  ${t}`);
  }
}

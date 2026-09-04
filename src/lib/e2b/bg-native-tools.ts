/**
 * Tool names implemented NATIVELY inside the sandbox runner (the TOOLS array
 * in bg-agent-script.ts). At launch, `startBackgroundTurn` seeds
 * state.browserTools with every REGISTERED browser tool whose name is NOT in
 * this set — the runner exposes those to the LLM as bridged tools that
 * execute back in the browser. This is what gives background turns the SAME
 * tool surface as the in-browser runtime (Settings → Tools).
 *
 * Kept in its own tiny module (NOT inside bg-agent-script.ts) so client
 * code can import the names without bundling the ~100KB runner script
 * string into the browser chunk. Keep this list in sync with the script's
 * TOOLS array.
 */
export const BG_NATIVE_TOOL_NAMES: ReadonlySet<string> = new Set([
  // v2 native set
  "read_file",
  "write_file",
  "create_file",
  "edit_file",
  "delete_file",
  "list_folder",
  "create_folder",
  "move_file",
  "run_terminal",
  "run_python",
  "web_fetch",
  "web_search",
  "manage_todo",
  "show_todo",
  // v3 native additions
  "manage_todos",
  "current_datetime",
  "create_chart",
  "delete_folder",
  "rename_file",
  "send_file",
  "send_folder",
  "verify_path",
  "create_file_chunk",
  "read_file_section",
  "search_documents",
  "image_search",
  "video_search",
  "preview_image",
  "ocr_image",
  "ocr_pdf",
  "counterfactual",
]);

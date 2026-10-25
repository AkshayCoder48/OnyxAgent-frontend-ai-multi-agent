/**
 * UMBRELLA TOOLS — the consolidated model-facing toolset.
 *
 * The registry still holds every granular tool (they stay REGISTERED and
 * callable — old conversations and muscle-memory calls keep executing), but
 * the model-visible list collapses ~55 granular tools into 12 action-based
 * umbrella tools (plus 10 keepers) so requests carry a small, high-accuracy
 * tool surface instead of ~64 definitions (~20k tokens).
 *
 * Each umbrella takes ONE required `action` argument whose value is the EXACT
 * granular tool name; all other arguments pass straight through to that
 * tool's own handler (which validates them with its own schema).
 *
 * This module is the SINGLE SOURCE OF TRUTH for the umbrella→actions map:
 *  - `src/lib/tools/consolidated.ts` registers the umbrella tools from it,
 *  - UI surfaces (tool-call cards, captions, sources, file tree, timeline)
 *    resolve `(name, args) → effective granular call` through it so every
 *    specialized renderer keeps working for umbrella calls.
 *
 * Pure data + pure functions — no registry import (avoids cycles), safe to
 * import from any client component.
 */

// ---------------------------------------------------------------------------
// The map.
// ---------------------------------------------------------------------------

/** umbrella name → granular tool names it absorbs (the `action` enum). */
export const UMBRELLA_TOOLS: Readonly<Record<string, readonly string[]>> = {
  files: [
    "list_folder", "read_file", "read_file_section", "create_file", "write_file",
    "edit_file", "delete_file", "delete_folder", "create_folder", "move_file",
    "send_file", "send_folder", "verify_path", "create_file_chunk",
    "list_uploaded_files", "read_uploaded_file", "search_documents", "ocr_document",
  ],
  web: ["web_search", "image_search", "video_search", "web_fetch"],
  code_exec: ["run_python", "run_terminal", "background_task"],
  subagents: [
    "spawn_subagent", "list_subagents", "set_subagent_config", "query_subagent",
    "steer_subagent", "complete_subagent", "cancel_subagent", "manage_subagent_chat",
  ],
  schedule: ["schedule_agent_task", "list_scheduled_tasks", "remove_scheduled_task"],
  integrations: [
    "mcp_search_tools", "mcp_call_tool",
    "composio_search_tools", "composio_connect_platform", "composio_execute_tool",
  ],
  chats: ["read_chat", "manage_chats"],
  memory: ["manage_memory", "project_memory"],
  todos: ["manage_todo", "show_todo"],
  media: ["media_generation", "create_chart", "preview_image"],
  workspace: ["analyze_workspace", "security_audit", "manage_env_var"],
  custom_tools: ["create_custom_tool", "manage_custom_tool"],
};

/** Fast lookup: umbrella name → set of its action values. */
const UMBRELLA_ACTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries(UMBRELLA_TOOLS).map(([name, actions]) => [name, new Set(actions)]),
);

/** Reverse lookup: granular name → its umbrella (for captions/diagnostics). */
const ACTION_TO_UMBRELLA: ReadonlyMap<string, string> = new Map(
  Object.entries(UMBRELLA_TOOLS).flatMap(([umbrella, actions]) =>
    actions.map((a) => [a, umbrella] as const),
  ),
);

/** True when `name` is one of the 12 umbrella tools. */
export function isUmbrellaTool(name: string): boolean {
  return UMBRELLA_ACTIONS.has(name);
}

/** The umbrella a granular tool was folded into (or null for keepers). */
export function umbrellaFor(action: string): string | null {
  return ACTION_TO_UMBRELLA.get(action) ?? null;
}

/**
 * The effective granular tool name for a call. For an umbrella call
 * (`files` + `action: "read_file"`) that is the action value; anything else
 * returns the name unchanged. Never throws.
 */
export function effectiveToolName(
  name: string | undefined | null,
  args: unknown,
): string {
  if (!name || !UMBRELLA_ACTIONS.has(name)) return name ?? "";
  const action = umbrellaActionOf(name, args);
  return action ?? name;
}

/** Extract + validate the action of an umbrella call (or null). */
function umbrellaActionOf(umbrella: string, args: unknown): string | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const action = (args as Record<string, unknown>).action;
  if (typeof action !== "string" || !action) return null;
  return UMBRELLA_ACTIONS.get(umbrella)?.has(action) ? action : null;
}

// ---------------------------------------------------------------------------
// Effective tool-call resolver.
// ---------------------------------------------------------------------------

/**
 * Resolve an umbrella call into its granular equivalent so every
 * name-matching UI surface (renderers, captions, verbs, sources, file tree)
 * keeps working unchanged:
 *
 *   { name: "files", args: { action: "read_file", path: "a.txt" } }
 *     → { name: "read_file", args: { path: "a.txt" } }
 *
 * Returns the ORIGINAL object reference (identity-preserving — safe for
 * React.memo and dependency arrays) whenever the call is not an umbrella
 * call, so the overwhelmingly common non-umbrella path costs two map checks.
 *
 * Generic + cast-based so any tool-call shape (store rows, UI ToolCall,
 * partial streaming calls) passes through without structural constraints.
 */
export function resolveEffectiveToolCall<T>(toolCall: T): T {
  if (!toolCall || typeof toolCall !== "object") return toolCall;
  const tc = toolCall as { name?: unknown; args?: unknown };
  const name = tc.name;
  if (typeof name !== "string" || !UMBRELLA_ACTIONS.has(name)) return toolCall;
  const action = umbrellaActionOf(name, tc.args);
  if (!action) return toolCall;
  const args =
    tc.args && typeof tc.args === "object" && !Array.isArray(tc.args)
      ? Object.fromEntries(
          Object.entries(tc.args as Record<string, unknown>).filter(
            ([k]) => k !== "action",
          ),
        )
      : {};
  return { ...(toolCall as object), name: action, args } as T;
}

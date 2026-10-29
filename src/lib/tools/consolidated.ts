"use client";

// UMBRELLA CONSOLIDATION — one action-based tool per family (user directive:
// "sort other tools into single tools for smaller and low tool counts").
//
// The model-visible surface collapses from ~64 granular definitions to 12
// umbrellas + 10 keepers (22 total). Each umbrella takes ONE required
// `action` argument — the EXACT granular tool name — and every other
// argument passes through to that tool's own handler, which validates them
// with its own schema. The granular tools stay REGISTERED (umbrella dispatch
// + legacy calls from old conversations keep executing) but are HIDDEN from
// listTools() — the model-visible list and the system-prompt digest.
//
// UI parity is preserved by src/lib/agent/tool-umbrella.ts: renderers,
// captions, verbs, sources and file-tree views resolve umbrella calls back
// to their granular equivalents before name-matching.
//
// IMPORT ORDER: this module must be imported AFTER the granular tools
// (it hides them by name and dispatches to their handlers) — it is the LAST
// import in tools/index.ts.

import { registerTool, hideTool, getTool } from "./registry";
import { UMBRELLA_TOOLS } from "@/lib/agent/tool-umbrella";

// ---------------------------------------------------------------------------
// Per-umbrella descriptions (also mirrored in the Onyx.md tool digest).
// ---------------------------------------------------------------------------

interface UmbrellaSpec {
  category: string;
  description: string;
}

const SPECS: Record<keyof typeof UMBRELLA_TOOLS & string, UmbrellaSpec> = {
  files: {
    category: "files",
    description: `Read and manage files in the user's workspace (E2B sandbox /home/user) plus the uploads registry. ONE tool, ONE \`action\` parameter — the action is the exact operation; pass only the fields that action needs:
- "list_folder" (path?) — what's in a directory (default: workspace root).
- "read_file" (path) — full contents of a UTF-8 text file.
- "read_file_section" (path, start, end) — a 0-based line range (verify chunks, resume writes).
- "create_file" (path, content, overwrite?) — create; refuses to overwrite unless overwrite:true.
- "write_file" (path, content) — overwrite/replace the whole file.
- "edit_file" (path, find, replace, replace_all?) — targeted find-and-replace.
- "delete_file" (path) / "delete_folder" (path) — remove.
- "create_folder" (path) — mkdir -p.
- "move_file" (source, destination) — move or rename.
- "send_file" (path) — deliver a file to the chat as a download.
- "send_folder" (path) — deliver a folder as a ZIP download.
- "verify_path" (path) — pre-create/verify dirs before writing.
- "create_file_chunk" (path, content, mode: "create"|"append", chunk_index) — write big files incrementally (>200 lines). FIRST chunk: mode "create" + chunk_index 0; following chunks: mode "append" + increasing indexes.
- "list_uploaded_files" () — the uploads registry (stable file_ids, sizes).
- "read_uploaded_file" (file_id | name) — read an uploaded file (text → contents; binary → base64 preview).
- "search_documents" (query) — semantic search over uploaded documents; cite as [1], [2].
- "ocr_document" (url | base64) — extract text from an image or PDF.`,
  },
  web: {
    category: "web",
    description: `Search and read the web. ONE tool, ONE \`action\` parameter:
- "web_search" (query) — text web search; titles, URLs, snippets. The first step for finding information.
- "image_search" (query) — pictures: URLs, thumbnails, dimensions, sources.
- "video_search" (query) — videos: titles, URLs, thumbnails, durations, channels.
- "web_fetch" (url) — read a page's full text — the DEFAULT way to READ any page (try /llms.txt for docs). For pages that need real interaction (clicks, login, JS, anti-bot) use the use_browser tool instead.`,
  },
  code_exec: {
    category: "exec",
    description: `Run code and commands in the E2B sandbox (workspace files are already there). ONE tool, ONE \`action\` parameter:
- "run_python" (code) — Python 3: data analysis, calculations, file processing, ML. 60s timeout, live streaming output.
- "run_terminal" (command, background?) — shell with |, &&, ;, >. 120s timeout, 256KB cap. Pass background:true for jobs that would exceed it (durable, up to 30 min).
- "background_task" (action, …) — durable background runs (create / status / list / cancel) that survive tab close.`,
  },
  subagents: {
    category: "orchestration",
    description: `Delegate work to subagents. ONE tool, ONE \`action\` parameter:
- "spawn_subagent" (subagent_name, description, task_type, role?, disposable?) — delegate a task.
- "list_subagents" (include_all?) — active tasks (pending/running/waiting/retrying).
- "set_subagent_config" (…) — give a subagent its own AI (provider/model).
- "query_subagent" (…) — message a subagent, get its reply (it may call tools).
- "steer_subagent" (…) — mid-run course correction.
- "complete_subagent" (…) — finish a task.
- "cancel_subagent" (…) — cancel a task.
- "manage_subagent_chat" (action, …) — persistent subagent chat sessions.`,
  },
  schedule: {
    category: "automation",
    description: `Cron-schedule scripts in the sandbox. ONE tool, ONE \`action\` parameter:
- "schedule_agent_task" (cron_expression, script_name) — schedule a workspace script (create it with files first). Output appends to /home/user/cron_output.log.
- "list_scheduled_tasks" () — the crontab + cron_output.log tail.
- "remove_scheduled_task" (script_name | all:true) — remove entries.`,
  },
  integrations: {
    category: "integrations",
    description: `External integrations — MCP servers + Composio (250+ platforms). ONE tool, ONE \`action\` parameter:
- "mcp_search_tools" (query) — discover tools on the user's configured MCP servers; FIRST STEP for integration tasks.
- "mcp_call_tool" (server, tool, args) — execute a discovered MCP tool.
- "composio_search_tools" (query) — describe the use case plainly; returns matching Composio actions + platforms.
- "composio_connect_platform" (platform) — get the OAuth link for a platform (slug like "slack").
- "composio_execute_tool" (toolName, args) — execute a discovered Composio action.`,
  },
  chats: {
    category: "chats",
    description: `Recall past conversations. ONE tool, ONE \`action\` parameter:
- "manage_chats" (action: "list"|"read", …) — list conversations ("what did we talk about?") and read transcripts.
- "read_chat" (…) — inspect any chat's CURRENT output — a subagent's live reply or a transcript.`,
  },
  memory: {
    category: "memory",
    description: `Durable memory. ONE tool, ONE \`action\` parameter:
- "manage_memory" (action: "save"|"search"|"list"|"delete", …) — persistent facts about the USER (preferences, decisions) that survive across conversations.
- "project_memory" (action: "save"|"list"|"update"|"delete"|"pin", …) — the CURRENT project's durable facts. Project chats only.`,
  },
  todos: {
    category: "planning",
    description: `Plan multi-step work. ONE tool, ONE \`action\` parameter:
- "manage_todo" (action: "create"|"update"|"delete"|"list"|"clear", …) — create returns a stable ID like todo_8f42 — quote it later.
- "show_todo" (ids | all:true) — render the todo table for the user (after creating/updating).`,
  },
  media: {
    category: "media",
    description: `Generate and show media. ONE tool, ONE \`action\` parameter:
- "media_generation" (operation, …) — unified Pollinations AI: image/video/audio/3D/embeddings generation. Chargeable generations need explicit two-step user confirmation.
- "create_chart" (data, x_key, series, style?) — line/bar/pie/area/scatter charts from structured data; renders inline.
- "preview_image" (url | base64, alt?) — show an image inline in the chat.`,
  },
  workspace: {
    category: "system",
    description: `Workspace-level operations. ONE tool, ONE \`action\` parameter:
- "analyze_workspace" () — full workspace scan (files, skills, MCPs, env vars, subagents, memories). Run it FIRST on a new task.
- "security_audit" () — scan the workspace for vulnerabilities and risky patterns.
- "manage_env_var" (action: "list"|"get"|"add"|"set"|"edit"|"delete", …) — sandbox env vars; list shows names only.`,
  },
  custom_tools: {
    category: "tools",
    description: `Build reusable custom tools. ONE tool, ONE \`action\` parameter:
- "manage_custom_tool" (action: "create"|"edit"|"delete", …) — http_webhook (POSTs args as JSON) or python_snippet (runs run(**params)) tools.
- "create_custom_tool" (…) — create a specialized capability on the fly (e.g. for a subagent).`,
  },
};

// ---------------------------------------------------------------------------
// Registration + hiding.
// ---------------------------------------------------------------------------

for (const [umbrella, actions] of Object.entries(UMBRELLA_TOOLS)) {
  const spec = SPECS[umbrella];
  if (!spec) continue; // every umbrella must have a spec — type-enforced, runtime-guarded

  registerTool(
    umbrella,
    spec.description,
    {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [...actions],
          description: `The exact operation to run. One of: ${actions.join(", ")}.`,
        },
      },
      required: ["action"],
      // Granular parameters ride alongside `action` — the target tool's own
      // handler validates them (its schema is the source of truth).
      additionalProperties: true,
    },
    async (args, ctx) => {
      const action = typeof args.action === "string" ? args.action : "";
      if (!action || !actions.includes(action)) {
        return {
          error: `Unknown or missing action '${action}' for ${umbrella}.`,
          valid_actions: actions,
          fix: `Call ${umbrella} with action set to one of: ${actions.join(", ")}, passing that operation's parameters alongside.`,
        };
      }
      const target = getTool(action);
      if (!target) {
        return {
          error: `Action '${action}' is not available right now.`,
          fix: `It may need configuration (e.g. an MCP server or integration connection) — check with the matching discovery action, or tell the user honestly.`,
        };
      }
      // Strip `action` and pass the rest through — the granular handler
      // validates its own required fields and streams via ctx unchanged.
      const { action: _drop, ...rest } = args as Record<string, unknown>;
      return target.handler(rest, ctx);
    },
    false,
    spec.category,
  );

  // Hide the granular tools this umbrella absorbed (by name — covers
  // late-registering tools too, e.g. the per-turn MCP meta-tools).
  for (const granular of actions) hideTool(granular);
}

// AUTO-GENERATED from /Onyx.md — DO NOT EDIT BY HAND.
// Regenerate with: bun run scripts/gen-onyx-md.ts
//
// The TOOL DIGEST — a compact (<8192 bytes) always-injected
// block listing EVERY registered tool by exact name + one-line capability,
// derived from the "## Tool Compendium" tables in Onyx.md. This is the
// anti-hallucination companion to the full manual (onyx-md.ts / the
// /home/user/Onyx.md sandbox file): models that skip reading Onyx.md still
// know their complete tool surface, and the availability rules make
// "I don't have that tool" claims about registered tools a prompt violation.
//
// Parity with the live registry (src/lib/tools) is enforced by
// src/lib/agent/onyx-md-digest.test.ts — every registry tool must be in the
// digest and vice versa. After adding/removing/renaming a tool: update the
// Onyx.md compendium, then re-run the generator.

/** Must start with this heading — injection sites use it as the idempotency marker. */
export const ONYX_MD_DIGEST = `## TOOL DIGEST — every registered tool (62 total)

Ground truth for what you can do. Your ACTIVE TOOL DEFINITIONS are the final word on what is callable THIS turn.

### Multi-function tools — one tool, one action parameter
- manage_todo [create / update / delete / list / clear] — Planning multi-step work. create (title) returns a stable ID like todo_8f42 — quote it in later calls. Statuses: not_planned / in_progress / done / not_done.
- show_todo — Render the todo table for the user — after creating or updating todos. Pass IDs, or all: true.
- manage_memory [save / search / list / delete] — Persistent facts about the user ("remember that…", preferences, decisions). Survives across conversations.
- manage_skill [list / read / create / edit / delete] — Installed skills (SKILL.md instruction files). read a skill before applying it.
- manage_mcp [list / create / edit / delete] — MCP server configs (sse / streamable_http transports; stdio unsupported). Find ids with list.
- manage_custom_tool [create / edit / delete] — Build reusable custom tools: http_webhook (POSTs args as JSON) or python_snippet (runs run(**params) in the sandbox).
- manage_env_var [list / get / add / set / edit / delete] — Sandbox env vars. list shows names only; get returns the real value. Tools receive them automatically.
- manage_chats [list / read] — Recall past conversations ("what did we talk about earlier?"). list → conversation_id → read the transcript.
- manage_subagent_chat [create / delete / edit_title / pin] — Persistent chat sessions with subagents (auto-creates the subagent). Message them via query_subagent.
- workflow [create / list / get / edit / delete / run] — Multi-step pipelines where each step is an AI prompt or a tool call.
- ocr_document [(kind auto-detected)] — Extract text from an image OR a PDF. Pass url or base64.
- move_file [(move or rename)] — Move a file to a new path, or rename in place (same dir + new name = rename).

### Files & workspace (E2B sandbox — /home/user)
- list_folder — Discover what exists in a directory.
- read_file — Read a UTF-8 text file — full content, no truncation.
- read_uploaded_file — Read a user-uploaded file by name/file_id from the uploads registry (text → contents; binary → base64 preview).
- list_uploaded_files — List the uploads registry (stable file_ids, sizes).
- read_file_section — Read a line range (0-based). Verify chunks, resume large writes.
- create_file — Create a new file (refuses to overwrite unless overwrite: true).
- write_file — Overwrite/replace entire file content.
- edit_file — Targeted find-and-replace inside a file (replace_all default).
- delete_file — Remove a file / a folder and its contents.
- delete_folder — Remove a file / a folder and its contents.
- create_folder — mkdir -p a directory.
- send_file — Deliver a file to the user as a download (base64 data URL for binaries).
- send_folder — Deliver a folder as a ZIP download.
- verify_path — Pre-create/verify dirs + empty files before writing.
- create_file_chunk — Write/append large files in chunks — for files >200 lines (see Writing Policy).
- analyze_workspace — Full workspace scan. Run FIRST on every task.

### Code execution
- run_python — Python 3: data analysis, calculations, file processing, ML. 60s timeout, live streaming output.
- run_terminal — Shell with |, &&, ;, >: git, npm/pip, grep, system queries. 120s timeout, 256 KB cap.

### Web & search
- web_search — Text web search (LangSearch if configured, else Miklium). Titles, URLs, snippets.
- image_search — Find pictures / videos: URLs, thumbnails, dimensions, sources.
- video_search — Find pictures / videos: URLs, thumbnails, dimensions, sources.
- web_fetch — Read a URL's full text — deep-read AFTER web_search.

### Subagent orchestration
- spawn_subagent — Delegate a task: subagent_name, description, task_type (research/code/analysis/writing/general), role, disposable.
- set_subagent_config — Give a subagent its own AI: provider_id + model, or custom_base_url + custom_model + custom_api_key.
- query_subagent — Message a subagent, get its reply (it may call tools).
- steer_subagent — Mid-run course correction or extra guidance.
- complete_subagent — Finish (auto-disposes if disposable) / abort a task.
- cancel_subagent — Finish (auto-disposes if disposable) / abort a task.
- list_subagents — Active tasks (pending/running/waiting/retrying).
- create_custom_tool — Give a subagent a specialized capability on the fly.

### Knowledge, perception & reasoning
- search_documents — Semantic search over the user's uploaded documents.
- ask_user — Ask a clarifying question when context is missing — never guess user intent.
- counterfactual — Structured "what if X had been different" analysis.
- security_audit — Scan the workspace for vulnerabilities and risky patterns.

### Media, charts & time
- create_chart — Line/bar/pie/area/scatter charts from structured data — renders inline.
- preview_image — Show an image inline in the chat (http(s) URL, base64, or a workspace path such as uploads/photo.jpg).
- current_datetime — Current UTC date/time in ISO 8601 — whenever time matters.

### Cloud workspace persistence (OnyxBase KV)
- push_workspace — Synchronize the COMPLETE workspace to the persistent cloud (id workspace_default). Call after EVERY meaningful task that changes files — even small ones. Overwrites the cloud…
- retrieve_workspace — Restore the persistent cloud workspace into the current sandbox. mode "check" probes the cloud; mode "restore" (default) writes the files and verifies SHA-256 per file. Call…

### External apps (Composio — 250+ platforms)
- composio_search_tools — FIRST STEP for external-app tasks: natural-language tool discovery (e.g. "send a slack message"). Returns tool slugs + input schemas + which platforms are connected. Search before…
- composio_connect_platform — Get the OAuth authorization link for a platform (slug like slack, github). Share it with the user and WAIT — you cannot authorize yourself.
- composio_execute_tool — Execute a discovered tool: toolName + args matching its schema. CONNECTION_REQUIRED → share a connect link and wait; never fabricate results.

### Scheduled tasks & automation (8 tools)
- create_scheduled_task — Turn any recurring/future intent into automation. The task gets its own dedicated chat (the name becomes its title). Args: name, instructions (the COMPLETE agent job, executed…
- update_scheduled_task — Change name/description/instructions/schedule/enabled by task id. Find ids with list_scheduled_tasks.
- delete_scheduled_task — Permanently remove a task + its history (its dedicated chat stays as a normal conversation).
- pause_scheduled_task — Stop executions / resume the schedule.
- resume_scheduled_task — Stop executions / resume the schedule.
- run_scheduled_task_now — Execute immediately (background sandbox) without touching future runs — the result lands in the task's chat.
- list_scheduled_tasks — All tasks with id/name/schedule/timezone/status/next+last run/dedicated chat — filter active/paused/failed/upcoming.
- get_scheduled_task_history — Execution history: time, duration, status, error, result, files changed, tool calls (the full result messages live in the task's chat). "Did my morning task run?" → this.

### Availability rules (anti-hallucination)
- EVERY tool listed above is REAL and CALLABLE. If a tool is in your tool definitions, you HAVE it — NEVER say "I don't have access to that tool" or "I forgot I had those tools" without trying the call first.
- Tool availability is defined ONLY by your active tool definitions this turn — not by your memory, not by this digest alone, not by Onyx.md alone. Dynamic tools (MCP \`mcp_<server>__<tool>\`, custom tools) appear in your definitions when they are active.
- Be honest BOTH ways: never deny a tool you have; never claim or call a tool that is absent from your definitions this turn.
- Detailed usage, execution policies and the full GenUI reference: \`/home/user/Onyx.md\` — \`read_file\` it when you need more than this digest.`;

/** Every tool name parsed from the Onyx.md compendium (digest ⇄ registry parity is test-enforced). */
export const ONYX_MD_DIGEST_TOOLS: readonly string[] = ["manage_todo","show_todo","manage_memory","manage_skill","manage_mcp","manage_custom_tool","manage_env_var","manage_chats","manage_subagent_chat","workflow","ocr_document","move_file","list_folder","read_file","read_uploaded_file","list_uploaded_files","read_file_section","create_file","write_file","edit_file","delete_file","delete_folder","create_folder","send_file","send_folder","verify_path","create_file_chunk","analyze_workspace","run_python","run_terminal","web_search","image_search","video_search","web_fetch","spawn_subagent","set_subagent_config","query_subagent","steer_subagent","complete_subagent","cancel_subagent","list_subagents","create_custom_tool","search_documents","ask_user","counterfactual","security_audit","create_chart","preview_image","current_datetime","push_workspace","retrieve_workspace","composio_search_tools","composio_connect_platform","composio_execute_tool","create_scheduled_task","update_scheduled_task","delete_scheduled_task","pause_scheduled_task","resume_scheduled_task","run_scheduled_task_now","list_scheduled_tasks","get_scheduled_task_history"];

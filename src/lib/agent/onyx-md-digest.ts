// AUTO-GENERATED from /Onyx.md — DO NOT EDIT BY HAND.
// Regenerate with: bun run scripts/gen-onyx-md.ts
//
// The TOOL DIGEST — a compact (<8192 bytes) always-injected
// block listing EVERY MODEL-VISIBLE tool by exact name + one-line capability.
// This is the anti-hallucination companion to the full manual (onyx-md.ts /
// the /home/user/Onyx.md sandbox file): models that skip reading Onyx.md still
// know their complete tool surface, and the availability rules make
// "I don't have that tool" claims about registered tools a prompt violation.
//
// UMBRELLA CONSOLIDATION: the surface is 21 tools — 12 action-based
// umbrella tools + 9 standalone keepers. Each umbrella takes ONE
// required `action` argument whose value is the exact granular operation
// name. The granular tools remain REGISTERED + callable (umbrella dispatch,
// legacy calls) but are hidden from the model-visible list. The generator
// maps the granular Onyx.md compendium onto the umbrella surface using the
// UMBRELLAS map inlined in scripts/gen-onyx-md.ts (mirrors
// src/lib/agent/tool-umbrella.ts).
//
// Parity with the live registry's VISIBLE tools (listTools()) is enforced by
// src/lib/agent/onyx-md-digest.test.ts — every visible registry tool must be
// in the digest and vice versa. After adding/removing/renaming a tool:
// update the Onyx.md compendium AND (if the umbrella surface changed) the
// UMBRELLAS map + src/lib/agent/tool-umbrella.ts, then re-run the generator.

/** Must start with this heading — injection sites use it as the idempotency marker. */
export const ONYX_MD_DIGEST = `## TOOL DIGEST — every model-visible tool (21 total)

Ground truth for what you can do. Your ACTIVE TOOL DEFINITIONS are the final word on what is callable THIS turn.

### Umbrella tools — one name, one \`action\` parameter (the action value is the exact operation)
- files [list_folder / read_file / read_file_section / create_file / write_file / edit_file / delete_file / delete_folder / create_folder / move_file / send_file / send_folder / verify_path / create_file_chunk / list_uploaded_files / read_uploaded_file / search_documents / ocr_document] — Everything file-shaped in the workspace (E2B sandbox /home/user) + uploads + OCR. Pass the operation's parameters alongside \`action\`.
- web [web_search / image_search / video_search / web_fetch] — Search and read the web. web_fetch is the DEFAULT reader (try /llms.txt for docs).
- code_exec [run_python / run_terminal / background_task] — Python, shell, durable background runs in the sandbox.
- subagents [spawn_subagent / list_subagents / set_subagent_config / query_subagent / steer_subagent / complete_subagent / cancel_subagent / manage_subagent_chat] — Delegate work to subagents.
- schedule [schedule_agent_task / list_scheduled_tasks / remove_scheduled_task] — Cron-schedule sandbox scripts; output lands in /home/user/cron_output.log.
- integrations [mcp_search_tools / mcp_call_tool / composio_search_tools / composio_connect_platform / composio_execute_tool] — External integrations: the user's MCP servers + Composio (250+ platforms). Search FIRST, then call.
- chats [read_chat / manage_chats] — Recall past conversations; read_chat also inspects a subagent's live reply.
- memory [manage_memory / project_memory] — Persistent facts: user-level (survives chats) and current-project.
- todos [manage_todo / show_todo] — Plan multi-step work. create returns a stable ID like todo_8f42 — quote it later.
- media [media_generation / create_chart / preview_image] — Generate media (Pollinations; chargeable generations need explicit two-step confirmation), charts, inline images.
- workspace [analyze_workspace / security_audit / manage_env_var] — Workspace scan (run FIRST on every task), security scan, sandbox env vars.
- custom_tools [create_custom_tool / manage_custom_tool] — Build reusable tools: http_webhook or python_snippet.

### Single-purpose tools
- knowledge_base [search / get / save / update / delete / list / file hosting] — Workspace Knowledge Base (OnyxBase) — survives chats. search when prior knowledge helps.
- manage_skill [list / read / create / edit / delete / catalog / search_marketplace / install_from_marketplace] — Skills — list shows ALL (55-skill library + user's); search_marketplace/install_from_marketplace = live SkillsMP directory.
- manage_mcp [list / create / edit / delete / market] — Remote MCP server configs (HTTP/SSE — via mcp_search_tools; sandbox stdio: run its CLI there). market = MCPMarket catalog.
- workflow [create / list / get / edit / delete / run] — Multi-step pipelines where each step is an AI prompt or a tool call.
- use_browser — ONLY for pages needing real interaction (click, type, login, JS); plain reading is web_fetch's job.
- ask_user — Ask a clarifying question when context is missing — never guess user intent.
- counterfactual — Structured "what if X had been different" analysis.
- decision — Structured decision engine (JEV systemone): pass a state + queries (choice / noul 0..1 / score on a legend) and get probability-backed verdicts — never a coin flip.
- current_datetime — Current UTC date/time in ISO 8601 — whenever time matters.

### Availability rules (anti-hallucination)
- EVERY tool listed above is REAL and CALLABLE. If a tool is in your tool definitions, you HAVE it — NEVER say "I don't have access to that tool" or "I forgot I had those tools" without trying the call first.
- Tool availability is defined ONLY by your active tool definitions this turn — not by your memory, not by this digest alone, not by Onyx.md alone. Dynamic tools (MCP \`mcp_<server>__<tool>\`, custom tools) appear in your definitions when they are active.
- Be honest BOTH ways: never deny a tool you have; never claim or call a tool that is absent from your definitions this turn.
- Detailed usage, execution policies and the full GenUI reference: \`/home/user/Onyx.md\` — read it (the files umbrella's read_file action) when you need more than this digest.`;

/** Every model-visible tool name: the 12 umbrellas + 9 keepers
 * (digest ⇄ registry parity is test-enforced against listTools() — hidden
 * granular tools are excluded by design). */
export const ONYX_MD_DIGEST_TOOLS: readonly string[] = ["files","web","code_exec","subagents","schedule","integrations","chats","memory","todos","media","workspace","custom_tools","knowledge_base","manage_skill","manage_mcp","workflow","use_browser","ask_user","counterfactual","decision","current_datetime"];

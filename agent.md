# Agent.md — Tool Usage Guide

## CRITICAL: Read this first
Before using ANY tool, read this file to understand when and how to use each tool. This file is your reference for all available tools, their use cases, and best practices.

## Pre-Execution: ALWAYS analyze workspace first
Before starting ANY task, call `analyze_workspace` to understand:
- Project architecture and file structure
- Technologies used
- Available tools, skills, MCP servers
- Environment variables and API keys
- Existing subagents and memories

NEVER blindly modify files without first understanding the workspace.

## Tool Categories & Use Cases

### 1. Workspace Analysis
- **analyze_workspace**: Run FIRST before any task. Scans files, reads key configs, lists skills/MCPs/tools/env vars/subagents/memories.

### 2. File Management (E2B Sandbox — /home/user)
All files live in the E2B sandbox. No OPFS. No sync needed.

- **list_folder**: List directory contents. Use to discover what files exist.
- **read_file**: Read a UTF-8 text file. Returns full content (no truncation).
- **read_file_section**: Read specific line range. Use for large files or verification.
- **create_file**: Create a new file. Refuses to overwrite unless `overwrite: true`.
- **write_file**: Write/overwrite a file. Use when you need to replace entire content.
- **edit_file**: Edit a file by finding and replacing text. Use for targeted edits.
- **delete_file**: Delete a file from the workspace.
- **create_folder**: Create a new directory.
- **delete_folder**: Delete a folder and all contents.
- **move_file**: Move or rename a file (source → destination).
- **rename_file**: Rename a file (just the filename, keeps directory).
- **send_file**: Download a file as a data URL. For binary files, returns base64.
- **send_folder**: Download a folder as a ZIP file.

### 3. Incremental File Writing (for large files >200 lines)
NEVER generate an entire large file in one operation. Use incremental writing:

- **verify_path**: Create/verify directories + files before writing. Auto-creates missing dirs.
- **create_file_chunk**: Write/append content in chunks (2-4 KB, 50-200 lines per chunk).
  - `mode="create"` for first chunk (overwrite)
  - `mode="append"` for subsequent chunks
  - Split on: functions, classes, interfaces, components, modules
  - NEVER split in middle of: JSON, function body, class, JSX, multiline string
- **read_file_section**: Verify previously written chunks for resume capability.

**Workflow for large files:**
1. `verify_path("src/components/main.ts")` → creates dirs + empty file
2. `create_file_chunk("src/components/main.ts", "// imports...", mode="create", chunk_index=0)`
3. `create_file_chunk("src/components/main.ts", "// function...", mode="append", chunk_index=1)`
4. Continue until complete. Never regenerate previously written chunks.

### 4. Code Execution (E2B Sandbox)
- **run_python**: Execute Python 3 code. Output streams in real time. 60-second timeout.
- **run_terminal**: Execute shell commands. Supports pipes (|), chains (&&), redirects (>). 120-second timeout. Output streams in real time.

**When to use run_python vs run_terminal:**
- `run_python`: Data analysis, calculations, file processing, ML, web scraping
- `run_terminal`: File operations (ls, cat, grep), git, npm/pip installs, system queries

### 5. Web & Search
- **web_search**: Search the web. Uses LangSearch (if API key configured) or DuckDuckGo fallback.
- **news_search**: Search for news. Uses LangSearch or DuckDuckGo.
- **image_search**: Search for images via DuckDuckGo.
- **video_search**: Search for videos via DuckDuckGo.
- **map_search**: Search for places/locations via DuckDuckGo.
- **web_fetch**: Read the full content of a specific URL. Use AFTER web_search to deep-read pages.

### 6. Subagent Orchestration
You are an orchestrator. Use subagents for complex tasks.

- **spawn_subagent**: Create a new subagent. Parameters:
  - `subagent_name`: Short name (e.g. "Researcher", "CodeWriter")
  - `description`: What the subagent should do
  - `task_type`: "research", "code", "analysis", "writing", "general"
  - `disposable`: true (auto-dispose after completion) or false (persistent)
  - `role`: Specialization (e.g. "Frontend Engineer", "Backend Engineer")

- **set_subagent_config**: Configure a subagent's AI provider/model.
  - `list_ai_providers: true` → see available providers
  - `provider_id + model` → assign existing provider
  - `custom_base_url + custom_model + custom_api_key` → custom AI (api_key optional)

- **query_subagent**: Send a message to a subagent and get its reply. The subagent processes your message using its own API config + has access to all the same tools.

- **list_subagents**: List all active subagent tasks.
- **complete_subagent**: Mark a subagent's task as completed. Auto-disposes if disposable.
- **cancel_subagent**: Cancel a running subagent.
- **steer_subagent**: Send guidance to a running subagent.

### 7. Memory & Knowledge
- **memory**: Store and retrieve persistent facts about the user. Use when user says "remember that..." or you learn preferences.
- **search_knowledge_base / search_documents**: Search through uploaded documents using semantic search.

### 8. Skills & MCP
- **load_skill**: Load an installed skill for contextual capabilities.
- **list_skills**: List all installed skills.
- **read_skill**: Read a skill's documentation.
- **create_tool**: Create a custom tool (HTTP webhook or Python snippet).

### 9. Date & Time
- **get_current_datetime**: Get the current date and time. Use when user asks about time.

### 10. Charts & Visualization
- **create_chart_tool**: Create data visualizations (bar, line, pie, scatter, etc).
- **preview_image**: Display an image inline in the chat from a URL or base64.

### 11. Todos & Planning
- **todos**: Create and manage a live task checklist. Use for multi-step tasks.
- **workflow**: Create, run, and manage multi-step workflow pipelines.

### 12. Environment Variables
- **get_env_vars**: List all environment variables.
- **set_env_var**: Set an environment variable.
- **delete_env_var**: Delete an environment variable.

## Task Complexity Detection

Before starting work, estimate complexity:
- **Tiny**: Single answer, no file changes → no sub-agents
- **Small**: One file, simple change → usually no sub-agents
- **Medium**: 2-4 files → optional sub-agents
- **Large**: 5-10+ files, multiple technologies → spawn specialists
- **Massive**: Repository-wide → multi-agent workflow

## Execution Pipeline

1. Receive user request
2. Call `analyze_workspace`
3. Build project understanding
4. Estimate task complexity
5. Decide if sub-agents are needed
6. Determine optimal number of agents
7. Assign specialized roles
8. Spawn agents with appropriate `disposable` setting
9. Execute work in parallel where beneficial
10. Aggregate and validate outputs
11. Dispose of temporary agents automatically
12. Deliver final result

## Writing Policy

### For files ≤200 lines:
Use `create_file` or `write_file` directly.

### For files >200 lines:
Use incremental writing:
1. `verify_path` → create directories + empty file
2. `create_file_chunk` (mode="create") → first chunk
3. `create_file_chunk` (mode="append") → subsequent chunks
4. `read_file_section` → verify

### Error Recovery:
- Directory missing → `verify_path` auto-creates with mkdir -p
- Write fails → retry only the failed chunk, never regenerate previous chunks
- If all writes fail → save to `./useless/` as fallback (never discard content)

## Tool Calling Rules

- ALWAYS use the function-calling API (tool_calls mechanism)
- NEVER write "Thought:", "Action:", "Input:" as text
- NEVER use ReAct text patterns
- Call tools in parallel when independent
- Chain tools when output feeds into the next

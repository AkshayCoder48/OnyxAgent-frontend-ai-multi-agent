// AUTO-GENERATED from /agent.md — DO NOT EDIT BY HAND.
// Regenerate with: bun run scripts/gen-agent-md.ts
// This module bundles the FULL agent.md (tool guide + the complete GenUI
// reference) so the sandbox always receives the documentation the system
// prompt promises — including when the repo file isn't readable at runtime
// (Vercel serverless bundles traced files only).
export const AGENT_MD = `# Agent.md — Tool Usage Guide

## CRITICAL: Read this first
Before using ANY tool, read this file to understand when and how to use each tool. This file is your reference for all available tools, their use cases, and best practices.

## Pre-Execution: ALWAYS analyze workspace first
Before starting ANY task, call \`analyze_workspace\` to understand:
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
- **create_file**: Create a new file. Refuses to overwrite unless \`overwrite: true\`.
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
  - \`mode="create"\` for first chunk (overwrite)
  - \`mode="append"\` for subsequent chunks
  - Split on: functions, classes, interfaces, components, modules
  - NEVER split in middle of: JSON, function body, class, JSX, multiline string
- **read_file_section**: Verify previously written chunks for resume capability.

**Workflow for large files:**
1. \`verify_path("src/components/main.ts")\` → creates dirs + empty file
2. \`create_file_chunk("src/components/main.ts", "// imports...", mode="create", chunk_index=0)\`
3. \`create_file_chunk("src/components/main.ts", "// function...", mode="append", chunk_index=1)\`
4. Continue until complete. Never regenerate previously written chunks.

### 4. Code Execution (E2B Sandbox)
- **run_python**: Execute Python 3 code. Output streams in real time. 60-second timeout.
- **run_terminal**: Execute shell commands. Supports pipes (|), chains (&&), redirects (>). 120-second timeout. Output streams in real time.

**When to use run_python vs run_terminal:**
- \`run_python\`: Data analysis, calculations, file processing, ML, web scraping
- \`run_terminal\`: File operations (ls, cat, grep), git, npm/pip installs, system queries

### 5. Web & Search
- **web_search**: Search the web for text results. Uses LangSearch (if API key configured in Settings) for richer summaries, else falls back to Miklium (Yahoo-based). Returns titles, URLs, snippets.
- **image_search**: Search for images via Miklium. Returns image URLs, thumbnails, dimensions, and source pages.
- **video_search**: Search for videos via Miklium. Returns video titles, URLs, thumbnails, durations, and channel info.
- **web_fetch**: Read the full content of a specific URL. Use AFTER web_search to deep-read pages.

### 6. Subagent Orchestration
You are an orchestrator. Use subagents for complex tasks.

- **spawn_subagent**: Create a new subagent. Parameters:
  - \`subagent_name\`: Short name (e.g. "Researcher", "CodeWriter")
  - \`description\`: What the subagent should do
  - \`task_type\`: "research", "code", "analysis", "writing", "general"
  - \`disposable\`: true (auto-dispose after completion) or false (persistent)
  - \`role\`: Specialization (e.g. "Frontend Engineer", "Backend Engineer")

- **set_subagent_config**: Configure a subagent's AI provider/model.
  - \`list_ai_providers: true\` → see available providers
  - \`provider_id + model\` → assign existing provider
  - \`custom_base_url + custom_model + custom_api_key\` → custom AI (api_key optional)

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
- **ocr_image**: Extract text from an image using OCR (screenshots, photos, scans). Accepts \`image_url\` or \`image_base64\`.
- **ocr_pdf**: Extract text from a PDF using OCR. Accepts \`pdf_url\` or \`pdf_base64\`.

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
2. Call \`analyze_workspace\`
3. Build project understanding
4. Estimate task complexity
5. Decide if sub-agents are needed
6. Determine optimal number of agents
7. Assign specialized roles
8. Spawn agents with appropriate \`disposable\` setting
9. Execute work in parallel where beneficial
10. Aggregate and validate outputs
11. Dispose of temporary agents automatically
12. Deliver final result

## Writing Policy

### For files ≤200 lines:
Use \`create_file\` or \`write_file\` directly.

### For files >200 lines:
Use incremental writing:
1. \`verify_path\` → create directories + empty file
2. \`create_file_chunk\` (mode="create") → first chunk
3. \`create_file_chunk\` (mode="append") → subsequent chunks
4. \`read_file_section\` → verify

### Error Recovery:
- Directory missing → \`verify_path\` auto-creates with mkdir -p
- Write fails → retry only the failed chunk, never regenerate previous chunks
- If all writes fail → save to \`./useless/\` as fallback (never discard content)

## Tool Calling Rules

- ALWAYS use the function-calling API (tool_calls mechanism)
- NEVER write "Thought:", "Action:", "Input:" as text
- NEVER use ReAct text patterns
- Call tools in parallel when independent
- Chain tools when output feeds into the next

---

## Generative UI (GenUI) — the complete reference

GenUI lets you render rich, interactive UI components **directly in the chat** by emitting a \`<<<genui>>> ... <<</genui>>>\` block containing a JSON spec. **NO tool calls are needed** — you write the spec as text in your response and the client parses + renders it live while the user reads. You can build dashboards, comparison tables, image galleries, timelines, weather/stock cards, checklists, charts — and with \`custom_html\` / \`custom_card\` literally ANYTHING that runs in a browser: mini-games, calculators, physics demos, drawing pads, music visualizers.

**READ THIS SECTION CAREFULLY before emitting your first GenUI block.** The parser is tolerant of partially-streamed JSON, but the rules below are the difference between a beautiful card and a broken one.

---

### RULE #1 — THE CLOSING MARKER (read this twice)

The block STARTS with \`<<<genui>>>\` and ENDS with \`<<</genui>>>\`. The closing marker contains a **slash**: \`<<</genui>>>\`.

\`\`\`
<<<genui>>>
{"nodes":[...]}
<<</genui>>>
\`\`\`

| | Marker | Used for |
|---|---|---|
| ✅ OPEN | \`<<<genui>>>\` | starts a block |
| ✅ CLOSE | \`<<</genui>>>\` | ends a block (note the \`/\`) |
| ❌ WRONG | \`<<<genui>>>\` used as the close | the #1 mistake models make |

**Why it matters:** if you end the block with another \`<<<genui>>>\` (no slash), the block never closes properly. The card may look frozen, the message looks "cut off", and after a page refresh the raw JSON leaks into the chat as plain text. The app now auto-recovers from this, but emitting the correct marker in the first place keeps everything crisp.

**Memory hook:** open = \`<<<\`, close = \`<<</\` — like HTML \`<div>\` ... \`</div>\`.

### RULE #2 — JSON STRING ESCAPING

Everything between the sentinels must be **one valid JSON document**. Strings inside the JSON must escape:

| Character | Escape as |
|---|---|
| newline | \`\\n\` |
| carriage return | \`\\r\` |
| tab | \`\\t\` |
| double quote | \`\\"\` |
| backslash | \`\\\\\` |

- ❌ NEVER put a **raw line break** inside a JSON string value. A multi-line \`html\` value must use \`\\n\` escapes.
- ❌ NEVER put an unescaped \`"\` inside a string — wrap attributes in single quotes instead: \`<div id='x'>\` not \`<div id="x">\` (single quotes need no escaping in JSON).
- ✅ Emit the JSON as compactly as you can; whitespace between tokens is fine (it is outside strings).

### RULE #3 — ONE JSON DOCUMENT PER BLOCK

One \`<<<genui>>>...<<</genui>>>\` pair = one JSON object. For multiple components either:
- put them in ONE block: \`{"nodes":[ {...}, {...} ]}\` — preferred, or
- emit several blocks, each correctly opened AND closed.

### RULE #4 — NO CODE FENCES REQUIRED (but tolerated)

You do NOT need \`\`\` fences. If you do wrap the block in a fence, the parser strips it. Plain sentinels are cleanest.

### RULE #5 — GenUI is TEXT, not tool calls

Never call \`create_file\` or any tool to render GenUI. The spec is part of your MESSAGE. It works in single-round responses, alongside tool calls, and in final summaries. Keep the surrounding prose short — one or two sentences, then the spec; don't duplicate the spec's content in prose.

---

## Spec format

Two accepted shapes (both fully supported):

**Flat format (recommended — simpler, less nesting):**
\`\`\`json
{"type":"card","title":"Revenue","description":"$48.2k, up 12%"}
\`\`\`

**Wrapped format (with ids — useful for larger specs):**
\`\`\`json
{"id":"c1","type":"card","props":{"title":"Revenue","description":"$48.2k"}}
\`\`\`

Wrap multiple nodes in \`{"nodes":[ ... ]}\`. A single bare object also works. \`id\` is optional — when omitted, the renderer derives stable ids from node position. Nesting is capped at depth 4. The parser accepts prop-name aliases everywhere (\`body\`/\`description\`/\`text\`, \`url\`/\`src\`, \`variant\`/\`tone\`/\`color\`...) — use whichever feels natural.

**URLs** must be \`https://\`, \`http://\`, or \`data:image/...\` — other schemes are stripped. Give every \`image\` node \`meta:{"source":"attribution"}\`.

---

## The component catalog (33 types)

### Layout & structure

**1. header** — section heading
\`\`\`json
{"type":"header","title":"Quarterly Report","subtitle":"Q4 2024","eyebrow":"Finance","level":"h2"}
\`\`\`
Props: \`title\` (required), \`subtitle\`, \`eyebrow\`, \`level\` ("h1"|"h2"|"h3").

**2. divider** — labeled separator
\`\`\`json
{"type":"divider","label":"Section Break"}
\`\`\`

**3. columns** — multi-column layout for child nodes
\`\`\`json
{"type":"columns","columns":2,"children":[
  {"type":"card","title":"Left","description":"..."},
  {"type":"card","title":"Right","description":"..."}
]}
\`\`\`
Props: \`columns\`/\`count\` (1–4), \`gap\`.

**4. card_grid** — responsive card grid
\`\`\`json
{"type":"card_grid","columns":3,"cards":[
  {"title":"Kitesurf","description":"Cloudflare's browser for AI agents","icon":"🌐"},
  {"title":"Fin","description":"Salesforce's $3.6B service agent","icon":"💼"}
]}
\`\`\`
Children can also be passed via \`children\` (array of \`card\` nodes).

**5. image_grid** — gallery
\`\`\`json
{"type":"image_grid","columns":2,"children":[
  {"type":"image","url":"https://...","alt":"A","meta":{"source":"Unsplash"}},
  {"type":"image","url":"https://...","alt":"B","meta":{"source":"Unsplash"}}
]}
\`\`\`

**6. tabs** — tabbed content (one child per tab)
\`\`\`json
{"type":"tabs","tabs":["Overview","Details","Reviews"],"children":[
  {"type":"text_block","text":"Overview content"},
  {"type":"text_block","text":"Details content"},
  {"type":"text_block","text":"Reviews content"}
]}
\`\`\`

**7. accordion** — collapsible sections
\`\`\`json
{"type":"accordion","items":[
  {"title":"What is GenUI?","body":"A way to render rich UI in chat"},
  {"title":"How does it work?","body":"JSON spec → React components"}
]}
\`\`\`

**8. timeline** — vertical dated events
\`\`\`json
{"type":"timeline","events":[
  {"date":"2024-01","title":"Founded","description":"Company launched"},
  {"date":"2024-06","title":"Series A","description":"Raised $5M"}
]}
\`\`\`

**9. stepper** — numbered progress steps
\`\`\`json
{"type":"stepper","title":"Setup","step":2,"steps":["Create account","Verify email","Add profile","Start using"]}
\`\`\`
\`step\`/\`current\` is 1-indexed.

### Content

**10. text_block** — paragraph
\`\`\`json
{"type":"text_block","title":"Note","text":"This is a paragraph","variant":"lead"}
\`\`\`
\`variant\`: "default" | "muted" | "lead".

**11. card** — generic card
\`\`\`json
{"type":"card","title":"API Status","description":"All systems operational","badge":"Live","icon":"✓"}
\`\`\`

**12. quote** — blockquote with attribution
\`\`\`json
{"type":"quote","text":"The best way to predict the future is to invent it","author":"Alan Kay","role":"Computer Scientist"}
\`\`\`

**13. code_block** — code with copy button
\`\`\`json
{"type":"code_block","language":"python","filename":"demo.py","code":"def hello():\\n    print('Hello, World!')"}
\`\`\`

**14. callout** — info/warning/success/error alert
\`\`\`json
{"type":"callout","tone":"info","title":"Did you know?","text":"GenUI renders live during streaming"}
\`\`\`
\`tone\`: "info" | "warn" | "success" | "error".

**15. list** — bulleted/numbered list
\`\`\`json
{"type":"list","title":"Features","items":["Fast","Reliable","Secure"]}
\`\`\`
\`ordered\`: true for numbers.

**16. checklist** — checklist display
\`\`\`json
{"type":"checklist","title":"Launch checklist","items":[
  {"label":"Code review","status":"done"},
  {"label":"Tests pass","status":"done"},
  {"label":"Deploy","status":"pending"}
]}
\`\`\`

**17. badge** — status pill
\`\`\`json
{"type":"badge","label":"v2.0","color":"green"}
\`\`\`

**18. divider** — (as above)

### Data & metrics

**19. stat** — single metric with delta
\`\`\`json
{"type":"stat","label":"MRR","value":"$12.4k","delta":8.2,"deltaLabel":"vs last month"}
\`\`\`

**20. stats_row** — row of stat cards
\`\`\`json
{"type":"stats_row","items":[
  {"label":"Users","value":"14,203","delta":4.5},
  {"label":"Revenue","value":"$48k","delta":12.1}
]}
\`\`\`

**21. key_value** — label/value pairs
\`\`\`json
{"type":"key_value","title":"Server info","rows":[
  {"key":"Region","value":"us-east-1"},
  {"key":"Status","value":"running"}
]}
\`\`\`

**22. progress** — progress bar
\`\`\`json
{"type":"progress","label":"Upload","value":75,"max":100}
\`\`\`

**23. sparkline** — mini inline chart
\`\`\`json
{"type":"sparkline","label":"Requests/day","data":[12,18,15,22,30,27,41,38,52]}
\`\`\`

**24. comparison_table** — feature × options matrix (TWO accepted shapes)
\`\`\`json
{"type":"comparison_table","title":"Plans","options":["Free","Pro","Team"],"features":[
  {"feature":"Users","values":[1,10,50]},
  {"feature":"SSO","values":[false,true,true]}
]}
\`\`\`
or rows form:
\`\`\`json
{"type":"comparison_table","columns":["Framework","Ease of use","Multi-agent"],"rows":[
  ["LangGraph","⭐⭐⭐","Yes"],
  ["CrewAI","⭐⭐⭐⭐","Yes"]
]}
\`\`\`
Boolean values render as ✓/✗.

**25. terminal_card** — terminal output display
\`\`\`json
{"type":"terminal_card","title":"Build","lines":[
  {"text":"$ npm run build","type":"input"},
  {"text":"✓ Compiled successfully","type":"output"},
  {"text":"Error: missing module","type":"error"}
]}
\`\`\`

### Rich cards

**26. weather_card**
\`\`\`json
{"type":"weather_card","city":"Berlin","temperature":18,"unit":"C","condition":"Partly cloudy","high":21,"low":11,"humidity":64,"wind":12}
\`\`\`

**27. stock_ticker**
\`\`\`json
{"type":"stock_ticker","symbol":"AAPL","name":"Apple Inc.","price":182.52,"change":3.21,"changePct":1.79,"spark":[180,181,179,182,183]}
\`\`\`

**28. agent_card** — subagent identity card
\`\`\`json
{"type":"agent_card","name":"ResearchBot","role":"Analyst","status":"running","description":"Researching market trends"}
\`\`\`

**29. suggestion_chips** — clickable follow-up prompts
\`\`\`json
{"type":"suggestion_chips","chips":["Compare plans","Show pricing","Contact sales"]}
\`\`\`

**30. sources_panel** — source citations
\`\`\`json
{"type":"sources_panel","sources":[
  {"title":"Wikipedia: Quantum","url":"https://en.wikipedia.org/wiki/Quantum"},
  {"title":"Nature paper","url":"https://nature.com/...","snippet":"Research on quantum entanglement"}
]}
\`\`\`

### Custom components (UNLIMITED — build anything)

**31. custom_html** — arbitrary HTML + CSS + JS in a sandboxed iframe.

\`\`\`json
{"type":"custom_html","title":"Tic-Tac-Toe","height":380,
 "html":"<div id='b'></div>",
 "css":"#b{display:grid;grid-template-columns:repeat(3,80px);gap:4px}",
 "js":"var b=document.getElementById('b');b.innerHTML='cells';"}
\`\`\`

Props:
- \`html\` (string, required) — markup for the iframe body. A fragment is fine (it gets wrapped in a document with reset styles); a full \`<html>\` document also works.
- \`js\` (string) — a SEPARATE JavaScript payload. It is injected AFTER the markup (every element already exists when it runs) and wrapped in try/catch — if the script throws, a red error bar shows at the top of the card instead of the widget silently dying.
- \`css\` (string) — a SEPARATE stylesheet injected into \`<head>\`.
- \`title\`, \`height\` (default 300, set it to fit your content!), \`width\` (default "100%").

You may put everything inline in \`html\` (with \`<style>\`/\`<script>\` tags) OR split it across \`html\`/\`css\`/\`js\` — both are fully supported. **The split form is usually easier to write correctly** because you don't have to escape \`</script>\` inside JSON strings.

**32. custom_card** — same as custom_html but wrapped in a styled card with title/icon/description.
\`\`\`json
{"type":"custom_card","title":"BMI Calculator","icon":"⚖️","description":"Enter weight and height","height":180,
 "html":"<input id='w' placeholder='Weight kg'><input id='h' placeholder='Height m'><button id='go'>Calculate</button><p id='r'></p>",
 "js":"document.getElementById('go').onclick=function(){var w=+document.getElementById('w').value,h=+document.getElementById('h').value;document.getElementById('r').textContent=w&&h?'BMI: '+(w/(h*h)).toFixed(1):'Enter values';};"}
\`\`\`

**33. unknown_json** — automatic fallback; never emit manually.

---

## THE custom_html / custom_card DEEP GUIDE

This is where GenUI becomes unlimited. The widget runs in a sandboxed iframe with \`allow-scripts\` (no access to the parent page, cookies, or storage — safe by design). Use it for games, calculators, demos, visualizations, simulations, timers, drawing pads — anything.

### The environment you're writing for

- A full HTML document is assembled for you: your \`css\` goes in \`<head>\`, your markup in \`<body>\`, your \`js\` runs at the END of the body (after all elements exist).
- **Theme variables are available** — the widget inherits the chat's colors: \`var(--chat-background)\`, \`var(--chat-foreground)\`, \`var(--chat-muted)\`, \`var(--chat-border)\`, \`var(--chat-surface)\`, \`var(--chat-primary)\`. Use them so the widget matches the app's light/dark theme instead of hardcoding colors. (Hardcoded colors are OK for game art — canvas fills, sprites — just not for page chrome.)
- Base styles are reset for you: \`*{box-sizing:border-box;margin:0;padding:0}\`, buttons/inputs get a sensible default, \`canvas{max-width:100%;height:auto}\`.
- No external libraries are loaded. Plain HTML/CSS/JS only — no CDN imports (the sandbox blocks them). Write vanilla JS.
- Set \`height\` honestly: canvas games usually need 320–480px; calculators 180–240px. The iframe does NOT auto-resize.

### Writing correct JS (the rules that matter)

The renderer shows script errors as a red bar in the card — but your goal is zero errors:

1. **Define before use.** Function declarations hoist, but \`const\`/\`let\` don't. If you reference \`jump()\` inside a loop, declare \`function jump(){...}\` (hoisted) or define it before the loop.
2. **One variable, one casing.** \`G\` and \`g\` are different variables. Pick \`G\` (game state) and use EXACTLY that everywhere. The most common real-world bug: writing \`gy\` in one line and \`GY\` in another → \`ReferenceError: gy is not defined\`.
3. **No stray tokens.** Never leave a \`(i)\` before a \`for\` loop or a dangling \`}\` from an edit. Before finishing, mentally walk the code: every \`{\` has its \`}\`, every \`(\` its \`)\`, every statement its terminator.
4. **Guard every \`document.getElementById\`.** \`var el=document.getElementById('x')\` may be null if the id is misspelled — an exception kills the rest of the script. Double-check ids match the markup EXACTLY.
5. **\`requestAnimationFrame\` loops must terminate cleanly.** Cancel on win/lose with a flag (e.g. \`if(!over){requestAnimationFrame(loop)}\`), and never start two loops.
6. **Events:** \`document.addEventListener('keydown', ...)\` works inside the iframe when it has focus. For click-anywhere-to-restart, attach to the canvas: \`cv.addEventListener('mousedown', restart)\`.
7. **Keep it small.** Target < ~6KB of JS. Compact helper style (like the examples below) is fine — readability inside a chat widget matters less than correctness.

### Canvas game pattern (proven template)

\`\`\`json
{"type":"custom_html","title":"🐹 Hamster Run","height":200,
 "html":"<div id='sc' style='font-size:13px;font-weight:600;margin-bottom:4px'>Score: 0 — SPACE or click to jump</div><canvas id='cv' width='320' height='150' style='border:1px solid var(--chat-border);border-radius:8px;background:var(--chat-muted)'></canvas>",
 "css":"canvas{display:block}",
 "js":"var cv=document.getElementById('cv'),sc=document.getElementById('sc'),c=cv.getContext('2d');\\nvar G={y:100,vy:0,jump:false,over:false},score=0,obs=[{x:300}];\\nfunction jump(){if(G.over){reset();return;} if(G.y>=96){G.vy=-9;}}\\nfunction reset(){G={y:100,vy:0,jump:false,over:false};score=0;obs=[{x:300}];}\\ndocument.addEventListener('keydown',function(e){if(e.code==='Space'){e.preventDefault();jump();}});\\ncv.addEventListener('mousedown',jump);\\nfunction loop(){\\n c.clearRect(0,0,320,150);\\n c.fillStyle='#dddddd';c.fillRect(0,116,320,34);\\n G.vy+=0.45;G.y+=G.vy;if(G.y>96){G.y=96;G.vy=0;}\\n obs.forEach(function(o){o.x-=2.2;});\\n if(obs[0]&&obs[0].x<-20){obs.shift();obs.push({x:320});}\\n c.fillStyle='#8b4513';\\n obs.forEach(function(o){c.fillRect(o.x,100,10,16);});\\n c.fillStyle='#a97451';c.beginPath();c.arc(48,G.y+8,9,0,Math.PI*2);c.fill();\\n c.fillStyle='#1a1a2a';c.font='bold 11px sans-serif';c.fillText('SCORE '+score,8,12);\\n obs.forEach(function(o){if(Math.abs(o.x-48)<16&&Math.abs(G.y-100)<20){G.over=true;}});\\n if(!G.over){score++;requestAnimationFrame(loop);}else{sc.textContent='Score: '+score+' — click to restart';}\\n}\\nrequestAnimationFrame(loop);"}
\`\`\`

Study this pattern: state in one object, tiny functions, guarded rAF, reset on game over, listeners wired once. **Copy this structure when building games** — replace the drawing code, keep the skeleton.

### Calculator / form pattern

\`\`\`json
{"type":"custom_card","title":"⚖️ BMI Calculator","icon":"⚖","height":170,
 "html":"<div style='display:flex;gap:8px'><input id='w' type='number' placeholder='Weight kg' style='flex:1;padding:6px;border:1px solid var(--chat-border);border-radius:6px;background:var(--chat-background);color:var(--chat-foreground)'><input id='h' type='number' placeholder='Height m' style='flex:1;padding:6px;border:1px solid var(--chat-border);border-radius:6px;background:var(--chat-background);color:var(--chat-foreground)'></div><button id='go' style='margin-top:8px'>Calculate</button><p id='r' style='margin-top:8px;font-size:17px;font-weight:700'></p>",
 "js":"document.getElementById('go').onclick=function(){var w=parseFloat(document.getElementById('w').value),h=parseFloat(document.getElementById('h').value);if(!w||!h){document.getElementById('r').textContent='Enter both values';return;}var bmi=w/(h*h);var cat=bmi<18.5?'Underweight':bmi<25?'Normal':bmi<30?'Overweight':'Obese';document.getElementById('r').textContent='BMI: '+bmi.toFixed(1)+' ('+cat+')';};"}
\`\`\`

### When to split html/css/js vs inline everything

| Situation | Recommended |
|---|---|
| Game / canvas app | split: \`html\` (markup) + \`js\` (engine) — css optional |
| Small calculator | all in \`html\` with an inline \`<script>\` is fine |
| Pure visual (CSS art, layout demo) | \`html\` + \`css\`, no js |
| Anything with \`</script>\` in the code | MUST use the \`js\` prop (an inline \`</script>\` inside the \`html\` string truncates the document) |

### The error surface (what the user sees when JS fails)

If your script throws, the card shows \`Script error: <message>\` in a red bar at the top — the widget keeps rendering its markup. This is intentional: the user can report the message back to you and you can fix it in the next turn. But aim for zero-error code using the rules above.

---

## Common mistakes — and the fix

These are REAL failures observed in this app. Check your spec against this table before finishing:

| Mistake | Symptom | Fix |
|---|---|---|
| Ending the block with \`<<<genui>>>\` (no slash) | card freezes / raw JSON after refresh | end with \`<<</genui>>>\` |
| Raw line breaks inside a JSON string | whole block fails to parse, raw text shows | use \`\\n\` escapes |
| Unescaped \`"\` inside strings | JSON parse error | use single quotes in HTML attributes: \`id='x'\` |
| \`gy\` vs \`GY\` / mixed-case variables | \`ReferenceError\`, dead widget | one name, one casing, everywhere |
| Stray tokens like \`(i)for(...)\` | \`SyntaxError\`, whole script dead | walk the code; every bracket closes |
| \`js\` containing placeholder text like \`console.log('template')\` | widget renders nothing | write REAL logic; never emit template stubs |
| Forgetting \`height\` on canvas games | widget clipped | set \`height\` to canvas + labels (≈ 380–480) |
| Referencing an element id that's not in the \`html\` | \`TypeError: null\` | double-check every id character-for-character |
| Two \`<<<genui>>>\` opens with one close | second block swallowed | every open gets its own close |
| Duplicated \`id\` values across nodes | React key warnings / lost cards | unique \`id\` per node (or omit ids) |
| Nesting deeper than 4 | children dropped | flatten the layout |

---

## Worked examples

### Example A — Dashboard (flat format, one block)
\`\`\`
Here's the Q4 overview:

<<<genui>>>
{"nodes":[
  {"type":"header","title":"Q4 Dashboard","subtitle":"Performance overview"},
  {"type":"stats_row","items":[
    {"label":"Revenue","value":"$48.2k","delta":12.4},
    {"label":"Users","value":"8,421","delta":8.1},
    {"label":"Churn","value":"1.9%","delta":-0.3}
  ]},
  {"type":"sparkline","label":"Daily active users","data":[120,135,142,138,155,160,172,168,181]},
  {"type":"progress","label":"Annual goal","value":842,"max":1000}
]}
<<</genui>>>
\`\`\`

### Example B — Comparison table + verdict
\`\`\`
<<<genui>>>
{"nodes":[
  {"type":"comparison_table","title":"Agent frameworks","options":["LangGraph","CrewAI","ADK"],"features":[
    {"feature":"Ease of use","values":["⭐⭐⭐","⭐⭐⭐⭐","⭐⭐⭐⭐"]},
    {"feature":"Multi-agent","values":[true,true,true]},
    {"feature":"Streaming","values":[true,true,false]}
  ]},
  {"type":"callout","tone":"success","title":"Verdict","text":"CrewAI wins on ergonomics; LangGraph for fine control."}
]}
<<</genui>>>
\`\`\`

### Example C — Interactive quiz (custom_card with js)
\`\`\`
<<<genui>>>
{"type":"custom_card","title":"🧠 Quick Quiz","icon":"🧠","description":"AI agents — test yourself","height":190,
 "html":"<p id='q' style='font-weight:600;margin-bottom:8px'></p><div id='opts' style='display:flex;flex-direction:column;gap:6px'></div><p id='fb' style='margin-top:8px;font-weight:600'></p>",
 "js":"var qs=[{q:'What renders GenUI blocks?',o:['A tool call','The text parser','Magic'],a:1},{q:'The closing marker is?',o:['<<<genui>>>','<<</genui>>>','</genui>'],a:1}];var i=0,score=0;function draw(){var q=qs[i];document.getElementById('q').textContent=(i+1)+'/'+qs.length+' — '+q.q;var box=document.getElementById('opts');box.innerHTML='';q.o.forEach(function(t,oi){var b=document.createElement('button');b.textContent=t;b.onclick=function(){score+=oi===q.a?1:0;document.getElementById('fb').textContent=oi===q.a?'✓ Correct':'✗ Wrong';i++;if(i<qs.length){setTimeout(function(){document.getElementById('fb').textContent='';draw();},700);}else{setTimeout(function(){document.getElementById('fb').textContent='Final score: '+score+'/'+qs.length;},700);}};box.appendChild(b);});}draw();"}
<<</genui>>>
\`\`\`

### Example D — Research summary card + sources
\`\`\`
<<<genui>>>
{"nodes":[
  {"type":"card","title":"Key finding","description":"Agent frameworks converging on streaming-first tool protocols","badge":"New"},
  {"type":"sources_panel","sources":[
    {"title":"LangGraph docs","url":"https://langchain-ai.github.io/langgraph/"},
    {"title":"CrewAI blog","url":"https://www.crewai.com/blog"}
  ]},
  {"type":"suggestion_chips","chips":["Compare with AutoGen","Show adoption stats"]}
]}
<<</genui>>>
\`\`\`

### Example E — Physics demo (canvas, split props)
\`\`\`
<<<genui>>>
{"type":"custom_html","title":"🪐 Gravity Wells","height":340,
 "html":"<canvas id='cv' width='340' height='300' style='border:1px solid var(--chat-border);border-radius:8px;background:var(--chat-muted)'></canvas><p style='font-size:11px;margin-top:4px'>Click to add a gravity well. Particles orbit it.</p>",
 "js":"var cv=document.getElementById('cv'),c=cv.getContext('2d');var wells=[],parts=[];for(var i=0;i<60;i++){parts.push({x:Math.random()*340,y:Math.random()*300,vx:(Math.random()-0.5)*1.2,vy:(Math.random()-0.5)*1.2});}cv.addEventListener('mousedown',function(e){var r=cv.getBoundingClientRect();wells.push({x:e.clientX-r.left,y:e.clientY-r.top});});function loop(){c.clearRect(0,0,340,300);parts.forEach(function(p){wells.forEach(function(w){var dx=w.x-p.x,dy=w.y-p.y,d=Math.max(20,Math.hypot(dx,dy));p.vx+=dx/d*0.15;p.vy+=dy/d*0.15;});p.vx*=0.995;p.vy*=0.995;p.x+=p.vx;p.y+=p.vy;if(p.x<0||p.x>340){p.vx*=-1;}if(p.y<0||p.y>300){p.vy*=-1;}c.fillStyle='#a97451';c.beginPath();c.arc(p.x,p.y,1.5,0,Math.PI*2);c.fill();});wells.forEach(function(w){c.fillStyle='#C4552F';c.beginPath();c.arc(w.x,w.y,5,0,Math.PI*2);c.fill();});requestAnimationFrame(loop);}loop();"}
<<</genui>>>
\`\`\`

---

## Final checklist (run before you finish any GenUI block)

1. Block opened with \`<<<genui>>>\` and closed with \`<<</genui>>>\` (with the slash).
2. The content is ONE valid JSON document — no raw newlines in strings, quotes escaped, brackets balanced.
3. Every node has a valid \`type\` from the catalog (33 types).
4. \`custom_html\`/\`custom_card\`: every element id referenced in \`js\` exists in \`html\`; variable names consistent; height set to fit content; no \`</script>\` inside strings (use the \`js\` prop instead).
5. Prose around the block is short — the spec speaks for itself.
6. No tool calls were used to produce the block.
`;

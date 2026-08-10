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
- **web_search**: Search the web for text results. Uses LangSearch (if API key configured in Settings) for richer summaries, else falls back to Miklium (Yahoo-based). Returns titles, URLs, snippets.
- **image_search**: Search for images via Miklium. Returns image URLs, thumbnails, dimensions, and source pages.
- **video_search**: Search for videos via Miklium. Returns video titles, URLs, thumbnails, durations, and channel info.
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
- **ocr_image**: Extract text from an image using OCR (screenshots, photos, scans). Accepts `image_url` or `image_base64`.
- **ocr_pdf**: Extract text from a PDF using OCR. Accepts `pdf_url` or `pdf_base64`.

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

---

## Generative UI (GenUI)

GenUI lets you render rich interactive UI components **directly in the chat** by emitting a `<<<genui>>>...<<</genui>>>` block with a JSON spec. **NO tool calls are needed** — just write the spec as text in your response and it renders live as the user reads.

### CRITICAL: GenUI does NOT require tool calls
GenUI blocks are **pure text** — you emit them as part of your message, not via `create_file` or any tool. The parser detects `<<<genui>>>` sentinels in your text and renders the JSON spec as React components inline. This means:
- You can emit GenUI in **single-round mode** (no tool calls at all)
- You can emit GenUI **alongside** tool calls (text + tools in the same response)
- You can emit GenUI **after** tool calls complete (in the final summary)
- GenUI renders **live during streaming** — the user sees it build in real time

### Spec format
```
<<<genui>>>
{"nodes":[{"id":"unique-id","type":"node_type","props":{...},"children":[...]}]}
<<</genui>>>
```
- `id`: unique string within the spec (used as React key)
- `type`: one of the 33 types listed below
- `props`: type-specific properties (see each type's docs)
- `children`: optional array of child nodes (for containers like `card_grid`, `columns`, `tabs`)
- The parser is **tolerant** — partial JSON during streaming is fine (cut strings, missing brackets all handled)
- You CAN wrap the block in a ```json code fence — the parser strips it automatically
- Nesting is capped at depth 4

### When to use GenUI vs markdown
- **Use GenUI** when the answer is fundamentally visual/structured: comparison tables, image grids, stat dashboards, timelines, interactive checklists, weather/stock cards, mini-games, calculators, educational demos
- **Use markdown** for prose, simple lists, short answers, code snippets
- **Keep prose short beside a spec** — a sentence or two of context, then the spec. Don't duplicate the spec's content in prose

### Prop name aliases
The renderer accepts many prop name aliases — use whichever feels natural:
- Content: `body` / `description` / `text` / `content` all work for card/text body
- Images: `src` / `url` both work for image source
- Colors: `variant` / `tone` / `color` / `type` all work for callout/badge coloring
- Labels: `label` / `text` / `title` are interchangeable in many types
- You can use `step` instead of `current`, `columns` instead of `count`, `city` instead of `location`, `changePct` instead of `changePercent`, etc.

### URL rules
- URLs must be `https://`, `http://`, or `data:image/` — other schemes are stripped
- Every `image` node should include `meta: { source: "attribution" }` for credit

---

### All 33 Node Types

#### Layout & Structure

**1. header** — Section heading
```json
{"id":"h1","type":"header","props":{"title":"Quarterly Report","subtitle":"Q4 2024","eyebrow":"Finance","level":"h2"}}
```
Props: `title` (required), `subtitle`, `eyebrow` (small label above), `level` ("h1"|"h2"|"h3")

**2. divider** — Labeled separator line
```json
{"id":"d1","type":"divider","props":{"label":"Section Break"}}
```
Props: `label` (optional — if omitted, plain line)

**3. columns** — Multi-column layout
```json
{"id":"cols","type":"columns","props":{"columns":2},"children":[
  {"id":"c1","type":"card","props":{"title":"Left","description":"Left content"}},
  {"id":"c2","type":"card","props":{"title":"Right","description":"Right content"}}
]}
```
Props: `columns`/`count` (1-4, default 2), `gap` (px). Children: any nodes.

**4. card_grid** — Responsive grid of cards
```json
{"id":"cg","type":"card_grid","props":{"columns":3},"children":[
  {"id":"c1","type":"card","props":{"title":"Card 1","description":"..."}},
  {"id":"c2","type":"card","props":{"title":"Card 2","description":"..."}}
]}
```
Props: `columns`/`count` (1-4), `gap`. Children: typically `card` nodes.

**5. image_grid** — Responsive image gallery
```json
{"id":"ig","type":"image_grid","props":{"columns":2},"children":[
  {"id":"im1","type":"image","props":{"url":"https://...","alt":"A","meta":{"source":"Unsplash"}}},
  {"id":"im2","type":"image","props":{"url":"https://...","alt":"B","meta":{"source":"Unsplash"}}}
]}
```
Props: `columns`/`count` (1-4), `gap`. Children: `image` nodes.

**6. tabs** — Tabbed content
```json
{"id":"tabs","type":"tabs","props":{"tabs":["Overview","Details","Reviews"]},"children":[
  {"id":"t1","type":"text_block","props":{"text":"Overview content"}},
  {"id":"t2","type":"text_block","props":{"text":"Details content"}},
  {"id":"t3","type":"text_block","props":{"text":"Reviews content"}}
]}
```
Props: `tabs` (array of strings or `{label,value}` objects). Children: one per tab.

**7. accordion** — Collapsible sections
```json
{"id":"acc","type":"accordion","props":{"items":[
  {"title":"What is GenUI?","body":"A way to render rich UI in chat"},
  {"title":"How does it work?","body":"JSON spec → React components"}
]}}
```
Props: `items`/`sections` (array of `{title, body/description/text/content}`). Or use children.

**8. timeline** — Vertical dated events
```json
{"id":"tl","type":"timeline","props":{"events":[
  {"date":"2024-01","title":"Founded","description":"Company launched"},
  {"date":"2024-06","title":"Series A","description":"Raised $5M"}
]}}
```
Props: `events`/`items` (array of `{date, title, description/body/text}`)

**9. stepper** — Numbered progress steps
```json
{"id":"sp","type":"stepper","props":{"title":"Setup","step":2,"steps":["Create account","Verify email","Add profile","Start using"]}}
```
Props: `title`, `current`/`step`/`activeStep` (1-indexed), `steps` (array of strings or `{title, description}`)

#### Content

**10. text_block** — Paragraph of text
```json
{"id":"tb","type":"text_block","props":{"title":"Note","text":"This is a paragraph","variant":"default"}}
```
Props: `content`/`text`/`body`, `title`, `variant` ("default"|"muted"|"lead")

**11. card** — Generic card with title + body + optional children
```json
{"id":"c1","type":"card","props":{"title":"API Status","description":"All systems operational","badge":"Live","icon":"✓"}}
```
Props: `title`, `body`/`description`/`text`, `badge`/`label`, `icon` (emoji), `href`/`url`. Children: optional.

**12. quote** — Blockquote with attribution
```json
{"id":"q1","type":"quote","props":{"text":"The best way to predict the future is to invent it","author":"Alan Kay","role":"Computer Scientist"}}
```
Props: `text` (required), `author`/`source`/`citation`, `role`

**13. code_block** — Code with copy button + syntax label
```json
{"id":"cb","type":"code_block","props":{"language":"python","filename":"demo.py","code":"def hello():\n    print('Hello, World!')"}}
```
Props: `code` (required), `language`/`lang`, `filename`/`title`, `showLineNumbers`

**14. callout** — Info/warning/success/error alert
```json
{"id":"ca","type":"callout","props":{"tone":"info","title":"Did you know?","text":"GenUI renders live during streaming"}}
```
Props: `variant`/`tone`/`type`/`color` ("info"|"warn"|"success"|"error"), `title`, `body`/`text`/`description`

**15. list** — Bulleted or numbered list
```json
{"id":"ls","type":"list","props":{"title":"Features","items":["Fast","Reliable","Secure"]}}
```
Props: `title`, `ordered` (bool), `items` (array of strings or `{text/label, icon, href, status}`)

**16. checklist** — Interactive checklist
```json
{"id":"cl","type":"checklist","props":{"title":"Launch checklist","items":[
  {"label":"Code review","status":"done"},
  {"label":"Tests pass","status":"done"},
  {"label":"Deploy","status":"pending"}
]}}
```
Props: `title`, `items` (array of strings or `{text/label/title, status}` where status = "done"|"pending"|"complete"|"checked")

**17. badge** — Status pill
```json
{"id":"b1","type":"badge","props":{"label":"v2.0","color":"green"}}
```
Props: `text`/`label`, `variant`/`color`/`tone` ("default"|"green"|"red"|"yellow"|"blue"|"secondary"|"destructive")

**18. divider** — (see above)

#### Data & Metrics

**19. stat** — Single metric with delta
```json
{"id":"s1","type":"stat","props":{"label":"MRR","value":"$12.4k","delta":8.2,"deltaLabel":"vs last month"}}
```
Props: `label`, `value` (string or number), `delta`/`trend` (number), `deltaLabel`

**20. stats_row** — Row of stat cards
```json
{"id":"sr","type":"stats_row","children":[
  {"id":"s1","type":"stat","props":{"label":"Users","value":"14,203","delta":4.5}},
  {"id":"s2","type":"stat","props":{"label":"Revenue","value":"$48k","delta":12.1}}
]}
```
Props: `gap`. Children: `stat` nodes.

**21. key_value** — Label/value pairs
```json
{"id":"kv","type":"key_value","props":{"title":"Server info","rows":[
  {"key":"Region","value":"us-east-1"},
  {"key":"Status","value":"running"},
  {"key":"Uptime","value":"99.9%"}
]}}
```
Props: `title`, `pairs`/`rows`/`items`/`entries` (array of `{label/key, value}`)

**22. progress** — Progress bar(s)
```json
{"id":"pg","type":"progress","props":{"label":"Upload","value":75,"max":100}}
```
Props: `label`, `value` (0-max), `max` (default 100). Or use `current`/`total` to compute percentage.

**23. sparkline** — Mini inline chart
```json
{"id":"sk","type":"sparkline","props":{"label":"Requests/day","data":[12,18,15,22,30,27,41,38,52]}}
```
Props: `data`/`values`/`points` (number[]), `label`, `color`

**24. comparison_table** — Feature × options matrix
```json
{"id":"ct","type":"comparison_table","props":{"title":"Plans","options":["Free","Pro","Team"],"features":[
  {"feature":"Users","values":[1,10,50]},
  {"feature":"Storage","values":["1GB","50GB","1TB"]},
  {"feature":"SSO","values":[false,true,true]}
]}}
```
Props: `title`, `options` (string[]), `features` (array of `{feature, values}`). Values can be boolean (✓/✗), string, or number.

**25. terminal_card** — Terminal output display
```json
{"id":"tc","type":"terminal_card","props":{"title":"Build","lines":[
  {"text":"$ npm run build","type":"input"},
  {"text":"✓ Compiled successfully","type":"output"},
  {"text":"Error: missing module","type":"error"}
]}}
```
Props: `title`, `prompt` (default "$"), `lines`/`commands`/`output` (array of strings or `{text, type}` where type = "input"|"output"|"error")

#### Rich Cards

**26. weather_card** — Weather display
```json
{"id":"wc","type":"weather_card","props":{"city":"Berlin","temperature":18,"unit":"C","condition":"Partly cloudy","high":21,"low":11}}
```
Props: `location`/`city`, `temperature`/`temp`, `unit` ("C"|""F"), `condition`, `icon` ("sun"|"cloud"|"rain"|"snow"|"wind"), `high`, `low`, `humidity`, `wind`

**27. stock_ticker** — Stock price with sparkline
```json
{"id":"st","type":"stock_ticker","props":{"symbol":"AAPL","name":"Apple Inc.","price":182.52,"change":3.21,"changePct":1.79,"spark":[180,181,179,182,183]}}
```
Props: `symbol`, `name`, `price`, `currency` (default "$"), `change`, `changePercent`/`changePct`, `spark`/`sparkline` (number[])

**28. agent_card** — Subagent identity card
```json
{"id":"ac","type":"agent_card","props":{"name":"ResearchBot","role":"Analyst","status":"running","prompt":"Researching market trends"}}
```
Props: `name`, `role`, `description`/`prompt`/`task`, `avatar`/`avatarUrl`, `href`/`url`, `status`/`state` ("running"|"working"|"completed"|"done"|"failed"|"idle")

**29. suggestion_chips** — Clickable follow-up prompts
```json
{"id":"sc","type":"suggestion_chips","props":{"chips":["Compare plans","Show pricing","Contact sales"]}}
```
Props: `title`, `chips`/`items`/`suggestions` (array of strings or `{text/label, href}`)

**30. sources_panel** — Source citations with favicons
```json
{"id":"sp","type":"sources_panel","props":{"sources":[
  {"title":"Wikipedia: Quantum","url":"https://en.wikipedia.org/wiki/Quantum"},
  {"title":"Nature paper","url":"https://nature.com/...","snippet":"Research on quantum entanglement"}
]}}
```
Props: `title` (default "Sources"), `sources`/`items` (array of `{url, title, snippet, domain, favicon, type}`)

#### Custom Components (UNLIMITED — build anything)

**31. custom_html** — Arbitrary HTML/CSS/JS in a sandboxed iframe
```json
{"id":"ch","type":"custom_html","props":{"title":"Tic-Tac-Toe","height":350,"html":"<canvas id='c' width='300' height='300'></canvas><script>/* game logic */</script>"}}
```
Props: `html` (required — any HTML/CSS/JS), `title`, `height` (default 300), `width` (default "100%")

The HTML runs in a sandboxed iframe with `allow-scripts` — JavaScript works but it CANNOT access the parent page's DOM, cookies, or localStorage. Safe by design.

**Use cases (unlimited — not just games):**
- Mini-games: tic-tac-toe, memory match, snake, quiz, wordle, 2048
- Calculators: mortgage, BMI, tip, unit converter, scientific
- Educational demos: solar system, DNA helix, physics simulation, chemical bonds
- Interactive charts: custom D3/SVG/canvas visualizations
- Animations: CSS art, particle systems, canvas animations
- Forms: custom input widgets, surveys, polls
- Simulations: ecosystem, population growth, wave interference
- Timers/clocks: pomodoro, world clock, countdown
- Canvas drawing: sketchpad, graph plotter, fractal explorer
- Music/audio: visualizer, piano keyboard, beat maker
- Presentations: interactive slides, product demos
- Data viewers: JSON tree, table sorter, filter UI

**32. custom_card** — Card-wrapped custom HTML widget
```json
{"id":"cc","type":"custom_card","props":{"title":"BMI Calculator","icon":"📊","description":"Calculate your Body Mass Index","height":200,"html":"<input id='w' placeholder='Weight kg'><input id='h' placeholder='Height m'><button onclick='calc()'>Calc</button><p id='r'></p><script>function calc(){var w=+document.getElementById('w').value;var h=+document.getElementById('h').value;var bmi=w/(h*h);document.getElementById('r').textContent='BMI: '+bmi.toFixed(1)}}</script>"}}
```
Props: `title`, `html` (required), `body`/`description`/`text`, `icon`, `height` (default 250)

**33. unknown_json** — (automatic fallback for unknown types — don't emit manually)

---

### GenUI Examples

The parser accepts TWO JSON formats:
1. **Flat format** (simpler, recommended): `{"type":"header","title":"...","subtitle":"..."}`
2. **Wrapped format**: `{"id":"h1","type":"header","props":{"title":"...","subtitle":"..."}}`

You can emit a single bare object, or wrap multiple nodes in `{"nodes":[...]}`. Both work.

#### Example 1: Header + text + card (flat format, separate blocks)
```
Here's a summary:

<<<genui>>>
{"type":"header","title":"Q4 Report","subtitle":"Performance overview"}
<<</genui>>>

<<<genui>>>
{"type":"text_block","body":"Key metrics for this quarter are below."}
<<</genui>>>

<<<genui>>>
{"type":"card","title":"Revenue","description":"$48.2k, up 12% from Q3","icon":"💰"}
<<</genui>>>
```

#### Example 2: Stats row + sparkline (flat format, one block with nodes array)
```
<<<genui>>>
{"nodes":[
  {"type":"stats_row","items":[
    {"label":"Users","value":"8,421","delta":"+8%"},
    {"label":"Revenue","value":"$48k","delta":"+12%"}
  ]},
  {"type":"sparkline","label":"Daily active users","data":[120,135,142,138,155,160,172]}
]}
<<</genui>>>
```

#### Example 3: Card grid with items (flat format)
```
<<<genui>>>
{"type":"card_grid","columns":3,"cards":[
  {"title":"Kitesurf","description":"Cloudflare's browser for AI agents","icon":"🌐"},
  {"title":"Fin","description":"Salesforce's $3.6B service agent","icon":"💼"},
  {"title":"Astra","description":"OpenAI model paused on cyber-risk","icon":"⚠️"}
]}
<<</genui>>>
```

#### Example 4: Comparison table (columns + rows format)
```
<<<genui>>>
{"type":"comparison_table","columns":["Framework","Ease of use","Multi-agent","Popularity"],"rows":[
  ["LangGraph","⭐⭐⭐","Yes","High"],
  ["CrewAI","⭐⭐⭐⭐","Yes","High"],
  ["Google ADK","⭐⭐⭐⭐","Yes","Growing"]
]}
<<</genui>>>
```

#### Example 5: Interactive BMI calculator (custom_html)
```
<<<genui>>>
{"type":"custom_card","title":"BMI Calculator","icon":"⚖️","description":"Enter weight and height","height":180,"html":"<div style='display:flex;gap:8px'><input id='w' type='number' placeholder='Weight kg' style='padding:6px;border:1px solid #ccc;border-radius:6px;flex:1'><input id='h' type='number' placeholder='Height m' style='padding:6px;border:1px solid #ccc;border-radius:6px;flex:1'></div><button onclick='calc()' style='margin-top:8px;padding:6px 16px;background:#6366f1;color:white;border:none;border-radius:6px;cursor:pointer'>Calculate</button><p id='r' style='margin-top:8px;font-size:18px;font-weight:bold'></p><script>function calc(){var w=+document.getElementById('w').value;var h=+document.getElementById('h').value;if(!w||!h){document.getElementById('r').textContent='Enter values';return}var bmi=w/(h*h);var cat=bmi<18.5?'Underweight':bmi<25?'Normal':bmi<30?'Overweight':'Obese';document.getElementById('r').textContent='BMI: '+bmi.toFixed(1)+' ('+cat+')'}</script>"}
<<</genui>>>
```

#### Example 6: Custom HTML game (tic-tac-toe)
```
<<<genui>>>
{"type":"custom_html","title":"Tic-Tac-Toe","height":380,"html":"<div id='s' style='text-align:center;font-size:20px;font-weight:bold;margin-bottom:8px'>Your turn (X)</div><div id='b' style='display:grid;grid-template-columns:repeat(3,80px);gap:4px;justify-content:center'></div><button onclick='reset()' style='margin-top:8px;padding:6px 16px;border:1px solid #ccc;border-radius:6px;cursor:pointer'>Reset</button><script>var b=document.getElementById('b'),s=document.getElementById('s'),g=Array(9).fill(''),p='X',over=false;function draw(){b.innerHTML='';g.forEach((v,i)=>{var d=document.createElement('div');d.style.cssText='width:80px;height:80px;display:flex;align-items:center;justify-content:center;font-size:32px;cursor:pointer;border:1px solid #ccc;border-radius:6px';d.textContent=v;d.onclick=()=>play(i);b.appendChild(d)})}function play(i){if(over||g[i])return;g[i]=p;check();p=p=='X'?'O':'X';s.textContent=over?s.textContent:'Your turn ('+p+')';draw()}function check(){var w=[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];for(var l of w){if(g[l[0]]&&g[l[0]]==g[l[1]]&&g[l[0]]==g[l[2]]){over=true;s.textContent=g[l[0]]+' wins!';return}}if(!g.includes('')){over=true;s.textContent='Draw!'}}function reset(){g=Array(9).fill('');p='X';over=false;s.textContent='Your turn (X)';draw()}draw()</script>"}
<<</genui>>>
```

#### Example 7: Dashboard with multiple nodes (wrapped format)
```
<<<genui>>>
{"nodes":[
  {"id":"h","type":"header","props":{"title":"Q4 Dashboard","subtitle":"Performance overview"}},
  {"id":"sr","type":"stats_row","children":[
    {"id":"s1","type":"stat","props":{"label":"Revenue","value":"$48.2k","delta":12.4,"deltaLabel":"vs Q3"}},
    {"id":"s2","type":"stat","props":{"label":"Users","value":"8,421","delta":8.1,"deltaLabel":"vs Q3"}}
  ]},
  {"id":"pg","type":"progress","props":{"label":"Annual goal","value":842,"max":1000}}
]}
<<</genui>>>
```

### GenUI Rules
1. **No tool calls needed** — GenUI is pure text in your response
2. **Unique IDs** — every node needs a unique `id` within the spec
3. **Depth ≤ 4** — don't nest deeper than 4 levels
4. **Image attribution** — every `image` should include `meta: { source: "..." }`
5. **URLs** — must be `https://`, `http://`, or `data:image/`
6. **Keep specs focused** — one concept per block, don't cram everything
7. **Custom HTML is unlimited** — `custom_html` and `custom_card` can build ANYTHING: games, calculators, demos, visualizations, simulations. The only limit is your imagination
8. **Prop aliases are flexible** — use `description` or `body` or `text`, `url` or `src`, `tone` or `variant` — all work

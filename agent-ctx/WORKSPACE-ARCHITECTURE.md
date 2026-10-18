# Workspace PRD — Architecture & Task Plan (read me first)

PRD source of truth: `/home/z/my-project/upload/Pasted Content_1792325820047.txt` (read your feature's
section before coding). This doc maps the PRD onto the existing OnyxAgent architecture and assigns
strict file ownership so parallel agents never conflict.

## Global rules for every agent

- **ALL writing in ENGLISH** (replies, code comments, worklog entries). Never Chinese.
- Read `/home/z/my-project/worklog.md` BEFORE working. APPEND your section after (template inside).
- **Do NOT run `git commit` / `git push`** — the lead agent verifies and commits once at the end.
- No mocks, no placeholder buttons, no fake data. Every visible control performs its real function.
- Reuse shadcn/ui components from `src/components/ui`, lucide-react icons, existing Tailwind tokens.
- Responsive: mobile 390px must not overflow. Sticky footer rules apply where a footer exists.
- Reduced-motion: respect `prefers-reduced-motion` in every animation you add.
- `bun run lint` must stay at 0 errors for files you touch. `bun run test` (vitest) must stay green.
- The dev server runs on port 3000 (`bun run dev`, log at `dev.log`). Check `tail -50 dev.log` after
  your changes compile. Use the `agent-browser` skill/CLI for E2E verification of your feature.
- Verify your feature in the browser at http://localhost:3000 (login as the local dev account if the
  auth wall appears — check existing screenshots/ notes in worklog for how prior agents did it).

## Existing architecture (verified facts)

- **Persistence**: Dexie (IndexedDB) in `src/lib/db/index.ts`, class `AppDatabase`, latest version
  **3**. Singleton via `getDB()` / `db` proxy. Wipe functions at bottom must be extended for new tables.
- **Conversation model**: `src/types/conversation.ts` — `Conversation` has NO project field yet.
  Messages/tool-calls are separate tables (`messages`, `tool_calls`).
- **Sidebar**: `src/components/layout/conversation-sidebar.tsx` (header, title-filter search, list,
  footer). Mounted by `src/components/layout/app-shell.tsx` / `sidebar.tsx` (desktop aside + mobile
  Sheet). Conversations come from `src/hooks/use-conversations.ts` (Dexie service).
- **Chat store**: `src/stores/chat-store.ts` (881 lines) — messages, streaming, tool events.
  `src/hooks/use-chat.ts` drives runs via `src/lib/agent/execution-hub.ts` → `src/lib/agent/runtime.ts`
  (foreground) or `background-turn.ts` (E2B bg). `src/lib/agent/event-processor.ts` turns WSEvents
  into store state.
- **Tools**: registered via side-effect imports in `src/lib/tools/index.ts` into a central registry
  (`src/lib/tools/registry.ts`). Tool scope per request built in `src/lib/tools/request-scoping.ts`.
  MCP tools register per-turn. Tool dispatch sites: `runtime.ts` (fg), `subagent-runtime.ts` (2 sites),
  `bg-agent-script.ts` (E2B background, plain-JS mirror — see `tool-call-normalize.ts` precedent for
  how plain-JS mirrors are written).
- **ask_user pause pattern**: `src/lib/agent/ask-user-wait.ts` — emit WSEvent, wait for a
  `window` CustomEvent response. Approval gates copy this pattern exactly.
- **WSEvent union**: `src/types/chat.ts` (add new event types there).
- **Orb**: `src/components/assistant-ui/elements/orb.tsx` — pure CSS lattice, 25 variants (S/G/C/B/M
  families), `OrbVariant` type, `ORB_TASKS` labels, `Orb.module.css`. Used via `response-orb.ts` /
  `thinking-indicator.tsx` / `agent-status.tsx`. Agent activity state: `src/hooks/use-agent-activity.ts`.
- **Settings pages**: `src/app/[locale]/(dashboard)/settings/*` pages composed of
  `src/components/settings/section-*.tsx` panels. Appearance: `section-appearance` (verify name).
- **Providers**: user-configured AI providers in `ai_providers` table; Pollinations connected-account
  proxy at `/api/pollinations/generate` (kind "embeddings" → POST /v1/embeddings; used for semantic
  search embeddings when the user's Pollinations account is connected — best effort, lexical fallback).
- **i18n**: `next-intl`, messages in `messages/en.json` + `pl.json`. UI copy in this app is mostly
  hardcoded English in components — follow the existing pattern (hardcoded English is fine).

## New data model — Dexie version 4 (owned by Task 1-a)

New/changed tables (add `this.version(4).stores(...)` in `AppDatabase`; only list changed/new stores):

```
conversations: "&id, user_id, is_archived, is_demo, created_at, updated_at, last_message_at, project_id",
projects: "&id, user_id, status, pinned, sort_order, updated_at, last_activity_at",
project_memories: "&id, project_id, category, pinned, updated_at",
approval_requests: "&id, status, conversation_id, project_id, created_at",
message_search_index: "&message_id, conversation_id, project_id, [conversation_id+created_at], updated_at",
```

(`Conversation` type gains `project_id?: string | null`; rows without it = general chats.)

### Types — new file `src/types/project.ts`, re-exported from `src/types/index.ts`

```ts
export type ProjectResourceType = "tool" | "mcp_server" | "mcp_tool" | "skill" | "directory" | "terminal" | "browser" | "connector";
export type ResourcePermission = "allowed" | "approval_required" | "denied";

export interface ProjectResourceRule {
  resource_type: ProjectResourceType;
  resource_id: string; // tool name | mcp server id | "serverId:toolName" | skill id | dir path
  permission: ResourcePermission;
  updated_at: string;
}

export interface ProjectMemorySettings {
  enabled: boolean;              // project memory on/off
  cross_chat_retrieval: boolean; // retrieve from other project chats
  automatic_updates: boolean;    // agent may write memories
  context_budget_chars: number;  // retrieval budget, default 4000
}

export interface Project {
  id: string;
  user_id: string;
  name: string;
  description?: string | null;
  goal: string;
  instructions: string;
  icon?: string | null;            // key into the fixed icon set the UI offers
  accent_color?: string | null;    // hex
  status: "active" | "archived";
  pinned?: boolean;
  sort_order?: number;
  memory_settings: ProjectMemorySettings;
  model_preferences?: { preferred_model?: string | null };
  resources: ProjectResourceRule[]; // inline on the row (atomic reads at execution time)
  instructions_history: Array<{ content: string; saved_at: string }>; // cap 20
  created_at: string;
  updated_at: string;
  last_activity_at?: string | null;
}

export interface ProjectMemoryItem {
  id: string;
  project_id: string;
  category: "overview" | "decision" | "preference" | "constraint" | "task" | "reference" | "bug" | "file_ref";
  content: string;
  source_conversation_ids: string[];
  confidence?: number;      // 0..1
  pinned?: boolean;
  superseded_by?: string | null; // newer item that replaced this one
  created_at: string;
  updated_at: string;
}

export interface ApprovalRequest {
  id: string;
  project_id: string | null;
  conversation_id: string;
  operation_type: string;   // human label, e.g. "Run terminal command"
  tool_name: string;
  operation_parameters: Record<string, unknown>;
  params_hash: string;      // sha256 hex of canonical JSON — approval binds to EXACT params
  status: "pending" | "approved" | "rejected" | "cancelled" | "expired" | "completed" | "failed";
  risk_note?: string | null;
  result_summary?: string | null;
  created_at: string;
  expires_at?: string | null;   // default +15min for pending
  resolved_at?: string | null;
}

export interface MessageSearchRow {
  message_id: string; // pk
  conversation_id: string;
  project_id: string | null;
  role: "user" | "assistant" | "system";
  text: string;             // markdown-stripped plain text, cap 4000 chars
  title_cache: string;      // conversation title at index time
  token_count: number;
  embedding?: number[] | null;
  embed_model?: string | null;
  embed_state: "none" | "pending" | "ready" | "failed";
  created_at: string;
  updated_at: string;
}
```

## File ownership per task (STRICT — do not edit files you don't own)

### Task 1-a — Foundation data layer (Wave 1)
- `src/lib/db/index.ts` (v4 schema + wipe fns), `src/types/project.ts`, `src/types/conversation.ts`
  (add project_id), `src/types/index.ts` (export), `src/types/chat.ts` ONLY to add the new WSEvent
  types `approval_request` and `project_update` (coordinate: pure additive).
- NEW `src/lib/projects/service.ts` (CRUD + cascade delete + archive + reorder + instructions
  history), `src/lib/projects/permissions.ts` (policy resolution), `src/lib/projects/memory.ts`
  (memory CRUD + budgeted retrieval), `src/lib/projects/approvals.ts` (approval rows + params-hash +
  expire sweep), `src/lib/projects/store.ts` (zustand `useProjectsStore` with persist: projects cache,
  activeProjectId, sidebarCollapsed, drawerOpen, sort mode; actions wired to service).
- NEW `src/lib/projects/service.test.ts` — vitest unit tests (in-memory fake Dexie via `new Dexie`
  test double or pure-function tests; follow existing test patterns in `src/lib`).
- Extend `use-conversations.ts` service layer ONLY to support a `projectId` filter on fetch/create —
  coordinate with 1-b via the API surface you expose (do not touch components).

### Task 2-a — Orb personalities (Wave 1, independent)
- NEW `src/lib/orb/personalities.ts` (presets professional/friendly/focused/playful/custom, per-state
  variant map, intensity 0..1, reduced-motion behavior, reaction-state enum), NEW
  `src/stores/orb-personality-store.ts` (persist), NEW `src/components/assistant-ui/elements/orb-personality-settings.tsx`.
- OWN `src/components/assistant-ui/elements/orb.tsx` + `Orb.module.css` (extend, don't break the 25
  variants), `response-orb.ts`, `thinking-indicator.tsx`, `agent-status.tsx` as needed to consume the
  personality store. Add the settings panel into the Appearance settings page section component.
- Reaction states (map to REAL signals from `use-agent-activity.ts` / run state): idle, user_typing,
  submitted, thinking, tool_running, awaiting_approval (leave a stub export for 2-d to trigger),
  success, error, cancelled.

### Task 2-c — Export (Wave 1, independent)
- NEW `src/app/api/export/route.ts` (POST {format, layout, options, conversation} → file stream;
  PDF via `pdfmake`, DOCX via `docx` — `bun add docx pdfmake && bun add -d @types/pdfmake`), NEW
  `src/lib/export/markdown.ts` (client-side MD builder, shared shape), NEW
  `src/components/export/export-dialog.tsx` (format, layout Clean/Professional/Compact/Technical,
  content toggles: timestamps, speaker names, tool-call summaries, code blocks, file names, TOC,
  page numbers; title override; honest progress + error states), entry-point menu item + wiring in
  `src/components/chat/chat-controls.tsx` (or the chat header menu component — find the existing
  conversation actions menu) and the sidebar row dropdown (`conversation-sidebar.tsx` — coordinate:
  additive menu item only).
- Long-conversation safe: stream from the client the already-loaded conversation; the API route is
  stateless. No secrets in exports.

### Task 1-b — Projects UI (Wave 2, after 1-a) [STATUS UPDATE from lead]
**The REAL chat sidebar is `src/components/chat/conversation-sidebar.tsx` (1058 lines — used by
chat-workspace.tsx via `@/components/chat`). The layout one (`src/components/layout/conversation-sidebar.tsx`,
534 lines) is a secondary surface. Integrate the Projects section into BOTH (shared section component),
primary testing on the chat one.** Export entry points were already added to both sidebars + chat-workspace
top bar by Task 2-c — do not duplicate them. Task 2-a integrated PersonalityOrb into
thinking-indicator/agent-status/response-orb and `src/components/settings/section-appearance.tsx` — reuse
`<PersonalityOrb state="idle" />` in the project empty state for the project orb.
- OWN `src/components/chat/conversation-sidebar.tsx` (PRIMARY: projects collapsible section + general list
  filter `!project_id`), `src/components/layout/conversation-sidebar.tsx` (same shared section), plus
  `src/components/layout/sidebar.tsx` / `app-shell.tsx` ONLY if mounting requires it.
- NEW `src/components/projects/project-section.tsx`, `create-project-dialog.tsx` (create + edit:
  name, goal, instructions, icon picker from fixed set, accent color, memory settings, resources tab
  using `permissions.ts` + installed skills/MCP/connector listings from existing stores/services),
  `project-empty-state.tsx` (unique workspace screen: orb + name + goal + welcome + composer + 3
  suggested prompts that populate the input + Chat History button + config shortcut),
  `project-history-drawer.tsx` (Sheet/drawer: header with back arrow that plays a PULLING animation
  tied to the drawer transform — arrow rotates & drawer slides with connected spring; search within
  project; new project chat; rename/delete/pin conversations; date grouping; active indicator;
  lazy list), `project-chrome.tsx` (persistent project header above chat: icon, name, activity dot,
  drawer button, settings button).
- Wire project mode into the chat page: `src/app/[locale]/(dashboard)/chat/page.tsx` + its container
  component (find it — likely `src/components/chat/*` chat container) so that with
  `useProjectsStore.activeProjectId` set: project chrome shows, empty state shows when no
  conversation selected, new chats get `project_id`, and switching away clears it. Use
  `use-conversations` projectId filter API from 1-a.
- Project context menu in section rows: Rename, Edit, Manage Access, Archive/Restore, Delete
  (confirm dialog: deletes project's chats too — honest copy), Duplicate (config only), pin + drag
  reorder (dnd-kit is installed).

### Task 2-d — Execution layer: permissions, approvals, project context (Wave 2, after 1-a)
- OWN `src/lib/agent/runtime.ts`, `src/lib/agent/subagent-runtime.ts`,
  `src/lib/tools/request-scoping.ts`, `src/lib/agent/event-processor.ts`,
  `src/types/chat.ts` (if 1-a hasn't landed the event types yet, add them — coordinate),
  `src/components/assistant-ui/elements/tool-call.tsx` (approval card render for pending approval
  status with Approve/Reject buttons + real params display), NEW
  `src/lib/agent/approval-gate.ts` (wait pattern copied from ask-user-wait; CustomEvent
  `agent:approval-response`), NEW `src/lib/tools/project_memory.ts` (agent tool: save/list/update/
  delete/pin memories scoped to CURRENT project via conversation→project lookup; registers in
  tools/index.ts), NEW `src/lib/projects/context-package.ts` (buildProjectContextPackage: goal +
  instructions + pinned memories + budgeted cross-chat retrieval via message_search_index
  lexical+embedding — same scorer as 2-b, so put the shared scorer in `src/lib/search/score.ts` and
  tell 2-b to reuse it), and the system-prompt injection point (study `context-manager.ts` /
  `use-chat.ts` — inject the package as a clearly-delimited section ONLY for project conversations).
- Enforcement (ALL dispatch sites): resolve permission = strictest(global policy from user_settings
  extra `approval_policies`, project.resources for the conversation's project). denied → corrective
  tool result, never executes. approval_required → create ApprovalRequest row, emit
  `approval_request` WSEvent, await CustomEvent (15-min expiry; params-hash verified at execution;
  reject → tool result "user rejected"; bg/E2B runner: approval-required tools in unattended mode →
  denied with honest message). Wire the orb `awaiting_approval` state (2-a leaves the export).
- Defaults for the global policy (permissions.ts, owned by 1-a but you consume): composio tools,
  env_vars write/delete, e2b file delete ops → approval_required; everything else allowed. Settings
  UI: NEW `src/components/settings/section-approvals.tsx` (tri-state per registered tool + policy
  list + approval queue table with links to conversations) mounted in Settings → Tools page.

### Task 2-b — Semantic search (Wave 3, after 1-a + 1-b)
- NEW `src/lib/search/indexer.ts` (message upsert/delete; embed via `/api/pollinations/generate`
  kind=embeddings best-effort with backoff to lexical-only + honest `embed_state`), NEW
  `src/lib/search/search.ts` (hybrid query: lexical BM25-ish + cosine on embeddings, RRF merge,
  scope: all | project:<id> | general, excerpt + highlight generation), NEW
  `src/components/search/global-search-dialog.tsx` (cmdk-style dialog; scope chips; results grouped
  by conversation with project badge, timestamp, speaker, excerpt; Enter opens the conversation at
  that message — coordinate the "open at message" mechanism with chat-store scroll/anchor), index
  maintenance hooks where messages are persisted (find in chat-store/event-processor; debounced,
  idle-time, never blocks streaming), and upgrade the sidebar search input to open the dialog
  (keeps quick title filter) + project drawer search uses the same engine scoped to the project.
- Honest status: when no embeddings available, label results "keyword search" — never fake semantic.

## Verification definition (lead agent, final)

lint 0 errors; vitest all green; agent-browser E2E: create project (full form), see empty state,
chat in project, drawer arrow animation, general/project isolation after refresh, approval flow
end-to-end (a composio-style approval_required tool — use env_vars write), export all 3 formats
download + valid files, semantic search finds message content by meaning, orb personalities switch
+ reaction states, mobile 390px, reduced-motion honored. Commit + push once.

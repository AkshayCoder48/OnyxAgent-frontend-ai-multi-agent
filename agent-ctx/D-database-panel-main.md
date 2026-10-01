# Task D — OnyxCode Database panel rebuild (OnyxBase Database PRD §6–§10, §15, §27–§32)

Agent: main (implementing) · Task ID: **D**

**Status:** complete. `bunx tsc --noEmit` clean · `bun run lint` 0 errors / 31 pre-existing warnings (none in my files) · dev.log shows no compile errors (only ✓ Compiled lines). Note: an earlier interrupted run of Task D left in-flight versions of my three deliverable files on disk; I reviewed them end-to-end against the PRD slice + Task C's layer, tightened one §30 violation (see "Fixes I made"), and verified everything — they are now final.

## Files changed (mine)

- `src/stores/code-database-store.ts` — NEW dedicated zustand store (narrow, isolated).
- `src/components/code/database-panel.tsx` — REWRITTEN as the sectioned developer console (component name + zero-props contract kept; `chat-workspace.tsx` still renders `<DatabasePanel />` inside the `id="database-panel"` DockedPanel — untouched).
- `src/components/chat/tool-results/database.tsx` — NEW rich card for `kind:"database"` payloads.
- `src/components/chat/tool-call-card.tsx` — minimal dispatch ONLY (re-read immediately before finalizing; Task E's image-inspection edits intact): ① import line 56, ② `databaseResultSpec` memo (lines 679–686, parses any COMPLETED tool result whose payload carries `kind:"database"` — legacy `manage_database` keeps `kind:"code_database"` and does NOT match), ③ `hasSpecialRenderer` + friendlyName "Database" + `Database` icon, ④ one render branch beside PreviewResult/WebSessionResult (lines 1010–1011). No simple-line/inline changes.

## Store shape + actions (`useCodeDatabaseStore`)

State: `{ conversationId, phase: idle|loading|ready|not-configured|error, error, sectionBusy{overview,kv,storage,schema,activity}, overview (CodeDatabaseOverview|null), kv{entries,query}, storage{files}, thumbnails{path→{dataUrl,updatedAt}}, thumbnailFailed{path}, schema (CodeSchema|null), activity (CodeActivityEvent[] ≤50), editorOpenFor, lastFetchedAt }`.

Actions: `refreshAll(conversationId)` — module-scope `refreshSeq` monotonic guard (stale responses dropped), in-flight dedupe per conversation, `Promise.allSettled` over overview/kvList/storageList/schemaGet/activityList with ONE resolved client, partial failures → `phase:"ready"` + honest `error` banner; individual `refreshOverview/Kv/Storage/Schema/Activity`; §32 targeted updates `upsertKvLocal / removeKvLocal / upsertFileLocal / removeFileLocal / setSchemaLocal / removeSchemaEntityLocal / appendActivityLocal` (all conversation-scoped — a late update for a previous chat can never paint over the current one); `setKvQuery`, `setEditorOpenFor`, `ensureThumbnail`. **No timers** — the panel owns refresh timing (§31). `refreshAll`/`runSection` early-return while `editorOpenFor` is set (background refresh can never clobber an open editor).

## Panel

- **Header**: DATABASE + reachability dot (from `overview.onyxbase.reachable`, unknown/online/unreachable states) + "This app's storage" + Refresh.
- **Tabs** (compact shadcn Tabs, border-border/rounded-lg/muted tokens, no indigo/blue): Overview · KV · Files · Schema · Search · Activity.
- **Overview**: Project (conversation title), OnyxBase connected/unreachable (real reason in title), Records, Files (+bytes), Schema entities, Storage usage, Last update, key-pattern + entity chips, legacy-records hint — all from `databaseOverview`; "—"/retry while missing; not-configured → Settings → Cloud (`ROUTES.SETTINGS_CLOUD`).
- **KV**: client-side filter; rows: key, auto type badge (String/Number/Boolean/Null/JSON Object/JSON Array), size, honest recency via the activity log (`lastKvTouchAt` — "—" when the record predates the 50-event log); actions: edit / copy key / copy value / delete (confirm). Editor dialog: key input (locked in edit), type selector, JSON validation BEFORE save (invalid JSON blocks the button + inline parse error), per-type coercion (`serializeDraft` — plain strings that parse as JSON are stored quoted so they round-trip as String), real OnyxBase errors surfaced, copy key/value, Format JSON. After a confirmed write: `upsertKvLocal` + `appendActivityLocal(actor:"user")` — no refetch.
- **Files**: dashed note separating Application storage (persistent, OnyxBase) from Workspace files (E2B, temporary); rows: path, mime, size, chunks, updated + lazy image thumbnails (IntersectionObserver → `storageRead` → data URL cached in the store per path, freshness keyed on `updatedAt`, ≤2 MB eligibility, fail-once no-retry); actions: download (payload reconstructed + browser download; object-URL revoke for text), metadata popover (FRESH `storageMetadata` read with own loading/error), delete (confirm). Upload: hidden file input → FileReader data URL → size pre-check vs `CODE_STORAGE_MAX_PAYLOAD_CHARS` → `storageWrite({base64})` (mime sniffed) → `upsertFileLocal` + activity.
- **Schema**: per-entity tables (field/type/required/notes + updatedAt), header note "Application schema metadata — stored in OnyxBase (not native database tables)"; entity editor dialog (name + repeatable field rows with type/notes/required); empty state points at the agent's `schema_upsert` — no fake entities.
- **Search**: one input; client-side over the loaded state across KV names+values, storage paths+mimes, schema entities+fields; honestly labeled ("use Refresh to pick up the latest changes"); grouped results; clicking a KV/Files result opens that tab pre-filtered (`setKvQuery`/`setFilesQuery` + tab switch).
- **Activity**: last 50 events newest-first — time (relative + absolute title), actor badge (agent/user), op, target, ok/error; updated by refreshAll + every local §32 append.
- **Lifecycle** (calmest §31 option): refresh on panel open when stale (30 s window), on conversation switch while open, on tab-visible regain while open (visibilitychange listener attached only while active), manual Refresh, and post-op targeted updates. No interval. Editors guard refreshes both in the panel effect and in the store.
- **Mobile**: scrollable tab strip, wrapping metadata rows, truncated monospace cells — fits the 340 px DockedPanel min-width / ~380 px mobile sheet.

## §30 isolation fix I made on top of the in-flight code

The in-flight panel pulled the project title via `useConversations()` — which subscribes to the whole conversation store (incl. `currentMessages` loads). Replaced with a deduped, title-only `useQuery` on the SAME `qk.conversations.list` key the sidebar uses (one cached fetch; `select` narrows the subscription to just this chat's title). The panel now subscribes to: its own database store, `useConversationStore((s) => s.currentConversationId)` primitive, `useCodePanelStore((s) => s.open === "database")` primitive, and the title query. Token streaming / message saves can never re-render it, and database updates never touch chat/sidebar/preview stores.

## Tool card (`tool-results/database.tsx`)

`parseDatabaseResult` accepts object or JSON-string results (runtime stringifies handler returns — same pattern as preview/image-inspection). Per-op rendering: inspect → overview stats + sample keys + reachability chip + "Open database panel" (`useCodePanelStore.setOpen("database")`); kv_get → value preview (`<pre>` max-h-40) + JSON/Text + size + truncation note; kv_set/kv_delete → saved/deleted line; kv_list/storage_list → count + first-6 chips (+prefix/search/adopted notes); storage_read → text preview or "Image/Binary payload · mime · bytes · chunks"; storage_write/delete/metadata → compact real stats; schema_upsert → field count + entity chips + "not native tables" label. Failure (§28): op title + target + the REAL OnyxBase reason, destructive styling.

## Integration notes for next agents

- Do NOT import chat/message state into the panel — keep it on the dedicated store + primitive selectors (§30).
- Local update helpers take `conversationId` FIRST and no-op on scope mismatch — call them only AFTER a helper (`kvSet`, `storageWrite`, `schemaUpsert`, …) resolves (§28: never claim success before the backend confirms).
- KV entries carry no updatedAt by design (Task C's canonical raw-value shape); recency in the UI is derived from the activity log and is honestly "—" when unknown.
- Thumbnails are intentionally NOT part of tool results (LLM context protection) — the panel reads them from the library layer.
- The store never refreshes while `editorOpenFor` is set; if you add another dialog whose contents a refresh could clobber, set that flag while it is open.
- Untouched per instructions: preview-panel.tsx, preview-ops.ts, code_preview.ts, background-turn.ts, runtime.ts, browser-tool-bridge.ts, request-scoping.ts, local_chats.ts, inspect_image.ts, image-sources.ts, api/vision, tool-results/image-inspection.tsx.

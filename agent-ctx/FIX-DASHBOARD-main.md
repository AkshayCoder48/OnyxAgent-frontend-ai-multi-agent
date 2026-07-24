# Task: FIX-DASHBOARD — Dashboard & sidebar backendless cleanup

**Task ID:** FIX-DASHBOARD
**Agent:** main (Z.ai Code orchestrator)
**Scope:** Remove every remaining `apiClient` call from the dashboard surface and the file sidebar; replace with backendless services (Dexie + Hopx client) or static empty states.

## Context

The app was rebuilt from a clone of `agent-chat-app` and edited to run backendless
(see worklog entries `BE-1`, `BE-FOUNDATION`, `EDIT-LIB-HOOKS`, `REBUILD-FROM-CLONE`,
`VERCEL-DEPLOY`). The `apiClient` shim now throws
`ApiError(501, "apiClient.get() is not available in backendless mode…")` on every
call — its only remaining purpose is to make unmigrated components fail loudly.

Before this task, ~15 components still imported `apiClient` directly. The dashboard
was the most visible offender: opening `/dashboard` triggered `apiClient.get("/health")`
which immediately rejected, causing the page to render the "API offline" red dot and
log a noisy `501` to the console. The dashboard also exposed an "API docs" quick action
that linked to `${BACKEND_URL}/docs` — a backend that doesn't exist.

The fix is purely client-side data-fetching rewrites; no UI/styling changes.

## Files Read (for context — not edited)

- `/home/z/my-project/worklog.md` — full task history (1507 lines)
- `/home/z/my-project/src/lib/services/index.ts` — backendless service layer
  (authService, conversationService, settingsService, …). Key shapes:
  - `conversationService.list(userId, { includeArchived?, limit?, skip? })` → `Conversation[]`
  - `settingsService.getDecryptedHopxKey(userId)` → `string | null`
- `/home/z/my-project/src/lib/db/index.ts` — Dexie schema + `db` Proxy singleton.
  `db.conversations.where("user_id").equals(userId).count()` is the cheapest
  conversations-count path.
- `/home/z/my-project/src/stores/auth-store.ts` — `useAuthStore` provides `user`
  (loaded from Dexie on init via `authService.getCurrentUser(userId)`).
- `/home/z/my-project/src/hooks/use-auth.ts` — `useAuth()` re-export, returns `user`.
- `/home/z/my-project/src/lib/api-client.ts` — confirms `apiClient.get` rejects with
  `ApiError(501, …not available in backendless mode…)` on every call.
- `/home/z/my-project/src/lib/rag-api.ts` — `listCollections()` / `getCollectionInfo()`
  are best-effort stubs that route through the Hopx sandbox; `listSyncLogs` /
  `listKBSyncSourceLogs` / `listOrgIntegrationLogs` all return empty
  `{ items: [], total: 0 }`.
- `/home/z/my-project/src/lib/hopx/client.ts` — `HopxClient` class with `listFiles`,
  `readFile`, `createFolder`, etc. `getHopxClient(apiKey)` returns a cached instance.
- `/home/z/my-project/src/lib/tools/hopx_files.ts` — reference implementation for
  Hopx-based file listing + zip-folder download (used `fflate`'s `zipSync` +
  `strToU8` for in-browser zipping).
- `/home/z/my-project/src/lib/storage/opfs.ts` — OPFS helpers (not used in the final
  file-sidebar rewrite — Hopx-only path is sufficient and avoids per-user path juggling).
- `/home/z/my-project/src/components/states/empty-state.tsx` — `EmptyState` props
  shape (icon, title, description, cta, fill).

## Files Edited (6)

### 1. `src/app/[locale]/(dashboard)/dashboard/page.tsx`

**Removed:**
- `import { apiClient } from "@/lib/api-client"` and the entire `health` query.
- The `HealthResponse` type import (no longer used).
- The `healthy` boolean and the "API offline" red-dot branch in the status banner.
- The version label (`health.data?.version`).

**Replaced:**
- Conversations count query: was
  `apiClient.get<ConversationsResponse>("/conversations?limit=1")` → now
  `db.conversations.where("user_id").equals(user.id).count()` with a
  `conversationService.list(user.id, { limit: 1 })` fallback if Dexie is
  mid-init. Query is `enabled: !!user?.id` and keyed on `user.id`.
- RAG stats query: kept `listCollections()` + `getCollectionInfo(name)` but
  wrapped the entire `queryFn` body in `try/catch` returning
  `{ collections: 0, vectors: 0 }` on any error. (`listCollections` is already
  best-effort inside `rag-api.ts`, but this belt-and-suspenders guard ensures
  a Hopx hiccup never takes down the dashboard.)

**Added:**
- A static "Backendless mode" status indicator (always emerald, always
  "Operational"-equivalent). No version label.

### 2. `src/components/dashboard/quick-actions.tsx`

**Removed:**
- The "API docs" entry from `ACTIONS` (was linking to `${BACKEND_URL}/docs`).
- `BACKEND_URL` from the `@/lib/constants` import (only `ROUTES` is needed now).
- `BookOpen` from the `lucide-react` import (only used by the removed action).

**Kept:** "Start a chat", "Skills", "Settings" actions. The `external` branch in
`ActionPill` is preserved (defensive — future actions may opt in) but no current
action uses it.

### 3. `src/components/dashboard/recent-activity.tsx`

**Removed:**
- `import { apiClient } from "@/lib/api-client"`.
- The entire `Promise.allSettled` block that hit `/conversations?limit=5` AND
  `/billing/me/credits/transactions?limit=5`. The billing/credits branch was
  producing a silent 501 on every dashboard load.
- The `CreditTx` interface, the `Coins` / `Receipt` / `Sparkles` icon imports
  (only used by the removed credit rows), and the `humanizeTxType` helper.

**Replaced:**
- Conversations fetch: now `conversationService.list(user.id, { limit: 5 })`
  (sliced to 4 in the events array, matching the original UI density).
- The `load` function depends on `user?.id` and re-runs when the user signs in.

**Kept:** The `ActivityItem` shape, `ActivityRow` component, sorting by timestamp
desc, the limit slice, the empty/error/loading states, the "View all →" link.

### 4. `src/components/dashboard/usage-timeline.tsx`

**Removed:** The entire fetch + state machine — `apiClient`, `ApiError`,
`useEffect`, `useMemo`, `useState`, `dynamic` (Recharts chart was deleted),
`SegmentedControl`, `LoadingState`, `ErrorState`, `UsageTimelineChart`,
`UsageBucket`, `UsageTimelineRead`, `RANGES`, `Metric`, `METRIC_LABELS`,
`formatDayLabel`. The chart sub-component (`usage-timeline-chart.tsx`) is no
longer imported but left on disk — removing it would be a separate task in case
other pages reference it.

**Replaced with:** A static card matching the original visual shape (header
"Usage over time" + "—" total + "credits" unit + a 56-px-tall chart area
showing an `EmptyState` titled "Usage tracking is not available in backendless
mode"). The component is still exported as `UsageTimeline` so any page that
imports it keeps compiling.

### 5. `src/components/rag/sync-source-logs.tsx`

**Removed:**
- `import { apiClient } from "@/lib/api-client"`.
- `import { Spinner } from "@/components/ui"` — replaced the `Spinner` usage with
  the already-imported `Loader2` (already spinning) so the visual is identical
  without an extra UI dep.

**Replaced:**
- `apiClient.get<RAGSyncLogList>(logsPath)` → a static
  `{ items: [], total: 0 }` literal. In backendless mode there's no scheduler
  and no sync-source log table — `listSyncLogs` / `listKBSyncSourceLogs` /
  `listOrgIntegrationLogs` in `rag-api.ts` all return the same empty shape.

**Kept:** The `SyncSourceLogsProps.logsPath` prop (kept for backward compat
with existing call sites but prefixed `_logsPath` to mark it unused). The
expand/collapse toggle, the "Sync history" label, the count badge, the
`LogRow` renderer (now never invoked since logs is always `[]`, but the
component stays self-consistent for future use).

### 6. `src/components/chat/file-sidebar.tsx`

**Removed:**
- `import { apiClient } from "@/lib/api-client"`.
- The `fetch("/api/workspace/files/download?path=…")` and
  `fetch("/api/workspace/files/download-folder?path=…")` calls (no such API
  routes exist in backendless mode).
- The unused `File as FileIcon`, `Upload` icon imports.

**Replaced:**
- Listing: `apiClient.get("/workspace/files?path=…")` → `client.listFiles(path)`
  via the per-user Hopx client. The client is resolved once on mount via
  `settingsService.getDecryptedHopxKey(user.id)` + `getHopxClient(apiKey)` and
  cached in component state. A `clientLoaded` flag distinguishes "still
  resolving" from "no key configured" so we don't flash "No sandbox" before the
  async settings lookup completes.
- File download: `fetch("/api/workspace/files/download")` →
  `client.readFile(fullPath)` + `new Blob([content], …)`. Hopx's `readFile`
  returns UTF-8 text only (sandbox REST API limitation) — binary files will
  be mangled, but text files (the common case for an AI-edited workspace)
  download correctly.
- Folder download: `fetch("/api/workspace/files/download-folder")` → recursive
  walk via `client.listFiles(subPath)`, collect every file's text content,
  zip in-browser with `fflate`'s `zipSync` + `strToU8` (already a dep). The
  fflate import is dynamic (`await import("fflate")`) so it stays out of the
  dashboard's initial bundle.

**Added:**
- A `noSandbox` empty state (rendered when `clientLoaded && !client`) with a
  `ServerOff` icon, "No sandbox available" title, and a one-line hint pointing
  the user to Settings → Agent Settings. The search input and refresh button
  are disabled in this state.
- A `parentOf(path)` helper and a `hopxFilesToListing(path, files)` adapter
  that maps `HopxFile[]` → `WorkspaceListing` (computing `parent` and
  stabilizing sort order: dirs first, then alphabetical).
- A `useEffect` that resolves the Hopx client on `user.id` change. Cancels
  properly on unmount to avoid setState-after-unmount warnings.

**Kept:** The entire file list UI (breadcrumbs, search, dir/file rows,
extension-icon mapping, footer stats), the `tool_result` window-event listener
for auto-refresh on agent file ops, the `onRefreshKey` prop contract.

## Verification

- `bunx tsc --noEmit --skipLibCheck` reports **ZERO errors** in any of the 6
  edited files. The only remaining `src/` errors are pre-existing test files
  (`button.test.tsx`, `utils.test.ts`, `auth-store.test.ts`) that need `vitest`
  types installed — unrelated to this task.
- `rg "apiClient"` in the 6 edited files returns **ZERO matches** (only
  intentional comments mentioning the old endpoints remain).
- The `BACKEND_URL` import is gone from `quick-actions.tsx`.
- Dev server logs (`tail dev.log`) show no compile errors related to the
  dashboard (the most recent compiles shown are `/register`, `/login`, `/chat`
  — `/dashboard` wasn't re-hit during the edit window but the type-check is
  authoritative).

## Files Edited (summary list)

1. `src/app/[locale]/(dashboard)/dashboard/page.tsx`
2. `src/components/dashboard/quick-actions.tsx`
3. `src/components/dashboard/recent-activity.tsx`
4. `src/components/dashboard/usage-timeline.tsx`
5. `src/components/rag/sync-source-logs.tsx`
6. `src/components/chat/file-sidebar.tsx`

## Notes for orchestrator

- The `usage-timeline-chart.tsx` component is now orphaned (nothing imports it
  after this task). Left on disk in case other pages (e.g. `/billing/usage`)
  still reference it; a future cleanup task can delete it.
- The file-sidebar's folder download is text-only (Hopx `readFile` returns
  UTF-8 strings). Binary file downloads will produce corrupt output. This
  matches the existing `send_folder` tool behavior in `lib/tools/hopx_files.ts`
  — the limitation is consistent across the app. A proper fix would need a
  binary-download endpoint on the Hopx REST API (out of scope).
- The dashboard no longer renders `<UsageTimeline />` (it wasn't rendered in
  the original either — only `<RecentActivity />` is in the grid). The
  component is kept for any other page that might import it; a grep confirmed
  no other active importers.

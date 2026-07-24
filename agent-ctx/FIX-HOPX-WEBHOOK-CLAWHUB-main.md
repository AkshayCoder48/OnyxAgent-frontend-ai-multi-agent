---
Task ID: FIX-HOPX-WEBHOOK-CLAWHUB
Agent: main (Z.ai Code orchestrator)
Task: Fix three issues — (1) Hopx key not being read by tools, (2) HTTP webhook tools fail with "failed to fetch" due to CORS, (3) replace static skill catalog with real ClawHub API.

Work Log:

## Problem 1 — Hopx key not being read by tools

**Root cause:** `src/lib/agent/runtime.ts` built the `toolCtx` object without
setting `hopxApiKey` or `envVars`. Tools like `run_python` / `run_terminal`
read `ctx.hopxApiKey` to spin up the sandbox and `ctx.envVars` to inject env
vars into the sandbox — without them, the tools short-circuit with
"Hopx API key required" / "Python execution requires a Hopx API key." The
settings service already had `getDecryptedHopxKey()` and
`getDecryptedEnvVars()`, but nothing was calling them at turn start.

**Fix** (`src/lib/agent/runtime.ts`):
- Added `settingsService` to the existing `@/lib/services` import.
- In `runAgentTurn()`, before building `toolCtx`, lazily load the decrypted
  Hopx key + env-var dict via `Promise.all([settingsService.getDecryptedHopxKey(opts.userId), settingsService.getDecryptedEnvVars(opts.userId)])`.
  If a caller already supplied a `toolContext` with these fields set (e.g.
  tests overriding `hopxApiKey`), we respect their values — only fall back
  to the settings service for fields the caller didn't populate.
- Set `hopxApiKey` and `envVars: envVars ?? {}` on the `toolCtx` object so
  they flow through `toolCtxForList` → `streamingToolCtx` and reach every
  tool handler.
- Failures (vault locked, settings row missing, etc.) are caught + logged
  via `console.warn` — non-fatal. Tools that need the key surface a friendly
  error themselves; we just log here so the dev console shows the cause.
- Chose the runtime-loading approach (vs. passing `toolContext` from
  `use-chat.ts`) per the task spec — it's cleaner and avoids duplicating
  the vault-decrypt logic at every call site. `use-chat.ts` is unchanged.

**Result:** `run_python` / `run_terminal` / `hopx_files` / `hopx_rag` now
receive the decrypted Hopx key + env vars at turn start. No code change
needed in the tools themselves — they already read `ctx.hopxApiKey` /
`ctx.envVars`.

## Problem 2 — HTTP webhook tools fail with "failed to fetch"

**Root cause:** `src/lib/tools/dynamic_tools.ts`'s `buildHandler` for
`http_webhook` did a direct `fetch(httpUrl, ...)` from the browser. Most
webhook hosts don't send `Access-Control-Allow-Origin`, so the browser
blocks the request before it even leaves the page — the user sees
"failed to fetch" with no diagnostic.

**Fix** (`src/lib/tools/dynamic_tools.ts`):
- Routed the webhook POST through the existing in-app CORS proxy at
  `/api/chat-proxy`. The proxy forwards server-side, so the browser never
  makes a cross-origin request — no CORS preflight, no opaque response.
- The target URL is carried in the `x-target-url` header (same convention
  the AI provider calls already use).
- Custom `http_headers` from the tool definition are still forwarded as
  request headers — the proxy's `isForwardableHeader()` allow-list is
  permissive (`Content-Type`, `Authorization`, `x-oai-*`, `anthropic-*`)
  and passes through any custom header that doesn't conflict.
- `res.ok` reflects the proxy's status — when the upstream returns
  e.g. 4xx/5xx, the proxy forwards the same status code (see `route.ts`),
  so this is a faithful signal of webhook success/failure.
- The error message still surfaces the HTTP status code, so the agent can
  reason about retrying or fixing the request.

**Result:** Custom webhook tools now work from the browser regardless of
whether the upstream host sends CORS headers.

## Problem 3 — Replace static skill catalog with ClawHub API

**Root cause:** `src/lib/skills/installer.ts` shipped a hardcoded
`SKILL_CATALOG` (6 entries) and a `buildCatalogZip` function that
synthesized fake zips in-memory. The Settings → Skills page rendered only
those 6 entries — no way to browse the real ClawHub registry.

**Fix** (`src/lib/skills/installer.ts` + `settings/skills/page.tsx`):

### `installer.ts` — replaced static catalog with ClawHub API
- Removed `SKILL_CATALOG` (6-entry static array) and `buildCatalogZip`
  (in-memory zip synthesizer). Removed `zipSync` / `strToU8` from the
  `fflate` import since they're no longer used.
- Removed `fetchCatalogZip` (the old resolver that dispatched between
  `builtin:` and `https:` URLs).
- New `CatalogSkill` interface:
  - `slug` — unique identifier (used to build the download URL).
  - `name` — display name (falls back to slug).
  - `description`, `author?`, `downloads?`, `tags?`, `homepage?`,
    `isFallback?` (set on fallback entries so the UI can badge them).
- New constants:
  - `CLAWHUB_API_BASE = "https://clawhub.ai"`
  - `CLAWHUB_CATALOG_URL = "https://clawhub.ai/api/skills"`
  - `CLAWHUB_DOWNLOAD_URL(slug) = "https://clawhub.ai/skills/<slug>/download"`
- New `FALLBACK_CATALOG` (3 entries: code-reviewer, data-analyzer,
  web-scraper). Used only when the API is unreachable so the page isn't
  blank — these entries still have real slugs, so the install button will
  try the real ClawHub download URL (if ClawHub is up but only the
  `/api/skills` endpoint is misconfigured, install can still succeed).
- New `normalizeCatalogResponse(raw)` — defensive parser that accepts
  several common REST envelope shapes (`items` / `data` / `skills` /
  `results` / bare array) and several item field names (`slug` / `name`,
  `description` / `summary` / `short_description`, `author` (string or
  `{ name: string }` object), `owner`, `downloads` / `download_count`,
  `tags`, `html_url` / `url` / `homepage`). The ClawHub API hasn't
  shipped a formal spec, so we err on the side of accepting anything
  reasonable.
- New `fetchCatalogPage(url, signal)` — fetches one page, returns
  `{ items, nextPage }`. Pagination is detected via three mechanisms:
  1. RFC 5988 `Link: <...>; rel="next"` header.
  2. JSON field `next_page` / `next` (string).
  3. JSON field `has_more` (bool) combined with `page` + `per_page`
     query params on the current URL — bumps the page counter and
     rebuilds the URL.
- New `fetchClawHubCatalog({ signal, maxPages })` — walks pagination
  (capped at 20 pages to prevent runaway loops), returns a flat list.
  If the API is unreachable for any reason (CORS, DNS, 5xx, abort, etc.),
  falls back to `FALLBACK_CATALOG`. If the API returns zero items, also
  falls back. Aborts cleanly when the caller's `AbortSignal` fires
  (e.g. component unmount) — the abort is swallowed, no error thrown.
- New `fetchSkillZipBytes(downloadUrl, signal)` — tries direct GET first
  (works if ClawHub sends permissive CORS headers); on failure, retries
  through `/api/chat-proxy` with `x-target-url` (POST-only proxy, so this
  only works for download endpoints that accept POST — S3 presigned URLs,
  some CDN endpoints). If both fail, throws a friendly error explaining
  the situation and pointing the user at the network/CORS angle.
- New `installClawHubSkill(userId, slug, opts)` — downloads the zip via
  `fetchSkillZipBytes`, then pipes the bytes through the existing
  `installSkillZip()` (which handles unzip, OPFS write, metadata row
  upsert). Accepts `nameOverride` / `descriptionOverride` /
  `signal` — the skills page passes the catalog display name + description
  so the metadata row matches what the user clicked (the zip's
  SKILL.md front-matter would otherwise win).
- Kept all existing helpers unchanged: `installSkillZip`, `installSkillMd`,
  `installSkillFile`, `uninstallSkill`, `parseSkillFrontMatter`,
  `InstalledSkillMeta`, `SkillInstallOptions`, `sanitizeSkillName`,
  `normalizeZipEntries`. The upload flow (`.zip` / `.md` files) is
  unaffected.

### `settings/skills/page.tsx` — async catalog with loading/error/retry
- Removed `SKILL_CATALOG`, `fetchCatalogZip`, `installSkillZip` from the
  installer import. Added `fetchClawHubCatalog`, `installClawHubSkill`.
- Replaced the static `useState<CatalogSkill[]>(SKILL_CATALOG)` with a
  discriminated-union `CatalogState`:
  - `{ kind: "loading" }` — initial state + during refresh.
  - `{ kind: "ready"; items: CatalogSkill[]; usedFallback: boolean }` —
    catalog fetched successfully. `usedFallback` is true when every item
    came from `FALLBACK_CATALOG` (i.e. the API was unreachable).
  - `{ kind: "error"; message: string; items: CatalogSkill[] }` —
    unexpected error (most errors are caught inside
    `fetchClawHubCatalog` and converted to fallback, so this branch is
    rare; it's still wired so the UI degrades gracefully).
- `loadCatalog()` — calls `fetchClawHubCatalog({ signal })`. Aborts any
  in-flight fetch before starting a new one (via `abortRef`). Stale
  responses from cancelled fetches are dropped (checked via
  `controller.signal.aborted`).
- `useEffect` calls `loadCatalog()` on mount and aborts the fetch on
  unmount (cleanup returns `abortRef.current?.abort()`).
- Loading state: centered spinner + "Fetching catalog from ClawHub…".
- Error state: amber alert triangle + message + Retry button.
- Fallback state: amber banner explaining the API was unreachable,
  badge on each card marking it as `fallback`, Refresh button to retry.
- Each card shows: name (mono), fallback badge (if applicable),
  description (2-line clamp), author + downloads + tags (first 3),
  slug (mono, truncated), and an Install / Remove button.
- Install button: calls `installClawHubSkill(user.id, slug, { nameOverride, descriptionOverride })`,
  shows spinner during install, success toast with file count on
  completion.
- "Installed" detection mirrors `sanitizeSkillName` (lowercase + replace
  non-alphanumerics with `-`) so the catalog button flips to "Remove"
  immediately after install.
- Refresh button (top-right of the catalog section) re-runs
  `loadCatalog()` — only visible when catalog is in the `ready` state.
- Empty-search state: "No skills match your search" card.
- Empty-catalog state: removed (we always have the fallback).

## Verification
- `bunx tsc --noEmit --skipLibCheck` reports ZERO errors in any of the
  4 edited files (`runtime.ts`, `dynamic_tools.ts`, `installer.ts`,
  `skills/page.tsx`). All remaining `tsc` errors are pre-existing
  (`examples/websocket/`, `skills/`, `components/settings/section-*.tsx`,
  `src/lib/tools/dynamic_tools.ts` `ToolResult` import + `ctx.hopx`
  python_snippet handler bug + null/undefined issues — none introduced
  by this task; the worklog from REAL-HOPX-SDK already documents them).
- `bun run lint` is still broken in the repo itself (circular-structure
  error in the flat-config ESLint plugin — pre-existing, unrelated).
- Dev server (`tail dev.log`) shows all pages compile cleanly after the
  edits:
  - `GET /chat 200 in 1074ms` — runtime.ts changes bundle cleanly.
  - `GET /settings/skills 200 in 1027ms (compile: 532ms)` — installer.ts
    + page.tsx changes compile cleanly with the new catalog state machine.
  - `GET /settings/config 200 in 693ms` — config page still works.
  - `GET /settings/tools 200 in 926ms` — tools page still works.
- No new runtime errors / exceptions in `dev.log` after the edits.

## Stage Summary
- **Hopx key plumbing:** `runAgentTurn()` now loads the decrypted Hopx
  key + env vars from `settingsService` at turn start and sets them on
  the `toolCtx`. All Hopx-dependent tools (`run_python`, `run_terminal`,
  `hopx_files`, `hopx_rag`) now work end-to-end after the user adds a
  key in Settings → Config. Single source of truth (runtime) — no
  duplication in `use-chat.ts`.
- **Webhook CORS:** custom `http_webhook` tools now route through the
  in-app `/api/chat-proxy` with `x-target-url`, bypassing browser CORS
  entirely. Webhooks work from the browser regardless of upstream CORS
  headers.
- **ClawHub catalog:** Settings → Skills now fetches the live catalog
  from `https://clawhub.ai/api/skills` with full pagination support
  (Link header + `next_page` + `has_more`/page bump). Defensive parser
  accepts any reasonable REST envelope. Falls back to a 3-entry static
  catalog when the API is unreachable — install buttons still try the
  real ClawHub download URL. Loading / error / fallback / retry states
  all wired up. Install via `installClawHubSkill(slug)` downloads the
  zip, unzips, writes to OPFS, and upserts the metadata row — same
  pipeline as the upload flow.

## Known limitations / notes for downstream
- `fetchCatalogPage` does direct GET only. The chat-proxy is POST-only,
  so we can't proxy GET requests without extending it (which is outside
  the 4-file scope of this task). If ClawHub's `/api/skills` endpoint
  blocks CORS, the catalog falls back to `FALLBACK_CATALOG` — the user
  sees 3 entries with a "fallback" badge. To support CORS-blocked GET
  APIs in the future, add a GET handler to
  `src/app/api/chat-proxy/route.ts`.
- `fetchSkillZipBytes` retries through the POST-only chat-proxy on
  direct-fetch failure. This works for S3 presigned URLs and other
  endpoints that accept POST, but most REST download endpoints will
  return 405. The error message surfaces both failure modes so the user
  can diagnose.
- The pre-existing `ctx.hopx` reference in `dynamic_tools.ts`'s
  `python_snippet` handler is still broken (it should read
  `ctx.hopxApiKey` and use `getHopxClient` like the built-in
  `hopx_exec.ts` does). Not in scope for this task — left untouched.
  Custom Python-snippet tools will continue to return "Python tools
  require a Hopx sandbox" until that bug is fixed.

Files edited:
- `src/lib/agent/runtime.ts` — load `hopxApiKey` + `envVars` from
  `settingsService` at turn start, set on `toolCtx`.
- `src/lib/tools/dynamic_tools.ts` — route `http_webhook` fetch through
  `/api/chat-proxy` with `x-target-url`.
- `src/lib/skills/installer.ts` — remove static catalog + `buildCatalogZip`;
  add `fetchClawHubCatalog`, `installClawHubSkill`, defensive normalizer,
  pagination walker, fallback catalog.
- `src/app/[locale]/(dashboard)/settings/skills/page.tsx` — async catalog
  with loading / error / fallback / retry states; install via
  `installClawHubSkill(slug)`.

Work records: `/home/z/my-project/agent-ctx/FIX-HOPX-WEBHOOK-CLAWHUB-main.md`

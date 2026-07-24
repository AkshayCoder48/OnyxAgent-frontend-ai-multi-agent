---
Task ID: FIX-FILES-CAPTCHA
Agent: Fixer (Files + Captcha)
Task: Fix file upload id mismatch, file sidebar "failed to fetch", and add captcha/cloudflare bypass tools.

Work Log:
- Read worklog.md, file-api.ts, services/index.ts, file-sidebar.tsx, chat-input.tsx, opfs.ts, registry.ts, datetime.ts, chart.ts, ask_user.ts, dynamic_tools.ts.
- Root cause #1 (file upload): `uploadFile()` in `src/lib/file-api.ts` mints `id = nanoid()` up-front, writes OPFS at `files/${id}`, caches the blob URL under `id`, and returns `id`. But `fileService.create()` in `src/lib/services/index.ts` ALSO generated its own `id = nanoid()`, so the Dexie row landed under a DIFFERENT id than the one returned to the UI. The blob URL cache key matched the returned id (so the in-session card rendered), but historical retrieval (`loadFileUrl`, `readFileBytes`) failed because Dexie had a different id stored than the one on the message.
- Fix: Made `fileService.create()` accept an optional `id` parameter (defaults to `nanoid()` when omitted, preserving the old behavior for any other callers). Updated `uploadFile()` to pass `id` so the OPFS path, Dexie row, blob URL cache, and returned id all share the same identifier.
- Root cause #1b (no upload indicator): The `isUploading` spinner in `chat-input.tsx` was inside the `{attachedFiles.length > 0 && (...)}` block, so it didn't render for the FIRST upload until at least one file had been appended. Added a separate `isUploading && attachedFiles.length === 0` block that shows a small inline spinner + "Uploading file…" text so the user gets immediate feedback. Also added `animate-pulse` to the in-list upload spinner.
- Root cause #2 (file sidebar "failed to fetch"): `fetchListing()` already silently failed with no toast, and the `useEffect` already gated on `client` being non-null. The remaining gap was UX: the "No sandbox available" empty state didn't link to Settings. Added a `Link` to `/settings/config` inside the empty state with both an inline link in the message and a "Configure Hopx" button. Verified no `toast.error` calls exist on the listing path — only on user-initiated download actions (which is appropriate).
- Verified the sidebar fetch effect (line ~186) only calls `fetchListing(currentPath)` when `client` is truthy; the `else if (clientLoaded) setLoading(false)` branch ensures we don't leave the spinner spinning when no Hopx key is configured.
- Created `src/lib/tools/captcha_solver.ts` with two tools registered via `registerTool`:
  - `solve_captcha` — accepts `captcha_type` (image/hcaptcha/recaptcha_v2/recaptcha_v3/turnstile/cloudflare) + `image_url` or `image_base64` for image captchas, or `site_url`+`sitekey` for token captchas. Image captchas call the free ocr.space API (key `helloworld`, overridable via `OCR_SPACE_API_KEY` env var). Token captchas (hCaptcha/reCAPTCHA v2-v3/Turnstile) submit + poll 2captcha (preferred) or anti-captcha when their respective env var keys are configured; otherwise return a structured `not_configured` result pointing the user to Settings → Config → Env Vars. The `cloudflare` captcha_type routes the caller to the `bypass_cloudflare` tool.
  - `bypass_cloudflare` — accepts `target_url` + optional `scenario` + `user_agent`, returns recommended browser headers (full Chrome 124 nav header set), the cf_clearance cookie strategy (UA-bound, ~30min lifetime), caveats (TLS/JA3 fingerprint detection, headless-mode blocking), and ready-to-run Node (puppeteer-real-browser) + Python (playwright + playwright-stealth) snippets the agent can drive via the hopx `run_terminal` tool. Honors `ctx.signal` for abort support.
- Registered `captcha_solver` in `src/lib/tools/index.ts` (before `dynamic_tools` so the static set is in place before any custom tools load).
- All tool handlers honor `ctx.signal` (abortable sleep + AbortError handling) and read API keys via `ctx.envVars` so they pick up user-configured secrets from Settings → Config → Env Vars.

Files edited:
- `src/lib/file-api.ts` — pass `id` to `fileService.create`.
- `src/lib/services/index.ts` — `fileService.create` accepts optional `id`.
- `src/components/chat/chat-input.tsx` — moved/added spinner visibility for first-upload case.
- `src/components/chat/file-sidebar.tsx` — added `Settings` + `Link` imports, refined no-sandbox empty state with a settings link + "Configure Hopx" button, documented the no-fetch-on-null-client invariant in the effect.
- `src/lib/tools/captcha_solver.ts` — NEW.
- `src/lib/tools/index.ts` — registered `./captcha_solver`.

Verification:
- `npx tsc --noEmit` reports zero errors in any of the edited files (pre-existing errors elsewhere in the codebase are unrelated).
- `curl http://localhost:3000/chat` returns 200; dev log shows `✓ Compiled` with no warnings.
- ESLint (`bun run lint`) fails with a pre-existing circular-structure error in the flat-config plugin itself — unrelated to these changes.

Notes for downstream agents:
- The `OCR_SPACE_API_KEY`, `TWOCAPTCHA_API_KEY`, and `ANTICAPTCHA_API_KEY` env vars must be set in Settings → Config → Env Vars (the encrypted vault) for the corresponding captcha paths. The UI doesn't need changes — the existing env-vars settings section already accepts arbitrary keys.
- The `bypass_cloudflare` tool returns guidance only; it does not execute the snippets. The agent should pipe the snippet text into the hopx `run_terminal` tool to actually obtain a cf_clearance cookie. Snippets assume puppeteer-real-browser or playwright-stealth are installed in the sandbox.

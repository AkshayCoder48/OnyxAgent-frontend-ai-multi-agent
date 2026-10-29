# OnyxAgent Worklog

Shared worklog for all agents. Append sections below (never overwrite).

---
Task ID: 1
Agent: main (Z.ai Code)
Task: Migrate Pollinations integration from the OLD keyless API (text.pollinations.ai) to the NEW official gen.pollinations.ai API with auth (per uploaded API doc: gen.pollinations.ai, Bearer sk_ keys, publisher/model ids, live model catalog)

Work Log:
- Read the uploaded API doc (`upload/Pasted Content_1792947168227.txt`): base `https://gen.pollinations.ai`, `POST /v1/chat/completions` (OpenAI-compatible), `GET /v1/models` keyless, `GET /image/{prompt}?model=...`, Bearer auth, publisher/model ids
- Explored codebase: found the app already ~95% on the gen API (pollinations lib, OAuth, generate route, provider-sync) with exactly 2 old-API holdouts
- `src/lib/business/llm.ts`: REMOVED `FREE_POLLINATIONS_BASE_URL` (keyless text.pollinations.ai/openai) + `addFreePollinationsProvider` (old `openai` model seeding); ADDED `addPollinationsProvider` (requires connected BYOP key, upserts provider at gen.pollinations.ai/v1 with LIVE catalog models via provider-sync); INVERTED `migrateLegacyPollinationsGateway` — now migrates legacy text.pollinations.ai rows → gen gateway (repoint+key+live models when connected; deletes the dead keyless row when not)
- `src/app/api/status-caption/route.ts`: rewrote upstream from keyless `GET text.pollinations.ai/{prompt}?model=openai-fast` to `POST gen.pollinations.ai/v1/chat/completions`; key chain = caller's BYOP key (POST body `key`) → POLLINATIONS_API_KEY env → keyless last-resort on the free nano model (anonymous tier is hourly-budget-limited; instant-401 → local fallback, never blocks); models = `openai/gpt-5.4-nano` (free tier) + `openai/gpt-4o-mini` fallback; added User-Agent header (node fetch sends none); memo/fallback/attempts preserved
- `src/hooks/use-ai-status-phrases.ts`: now reads the connected Pollinations key via `settingsService.getPollinationsConnection` (not the zustand store — only initialized inside settings) and sends it as `key` in the POST body
- `src/components/business/business-dashboard.tsx` + `create-business-wizard.tsx`: CTA → `addPollinationsProvider`; on not-connected error → toast + `router.push(ROUTES.SETTINGS_POLLINATIONS)`; updated migration comments
- `src/lib/business/ui-text.ts`: "Use Pollinations (free, no key)" → "Connect Pollinations"; gate body + providerAdded toast updated (no more keyless claims)
- Verified live gateway contract via curl/node: model IDs valid (gpt-5.4-nano free, paid_only:false), keyless non-streaming works intermittently (hourly IP budget), keyless streaming = instant 401 (confirms auth-required surface)
- E2E verified with agent-browser: business gate CTA → navigates to /settings/pollinations; paste-key connect → "Connected with API key" + provider synced with 235 live chat models; 405 live models in catalog; provider row in Settings→Config; gate closes; disconnect cleans up; zero console/page errors; lint 0 errors

Stage Summary:
- OLD keyless API fully removed from app code (2 holdouts migrated; only intentional references left are the legacy→gen migration matcher + explanatory comments)
- All Pollinations surfaces now on the official gen.pollinations.ai API with Bearer auth: chat (BYOP provider sync), media/image/video/audio/3D (already were), models (live 405-model catalog), status captions (new)
- BYOP flow is the auth path: connect in Settings → Pollinations (OAuth or paste sk_ key) → auto-synced "Pollinations" provider with live models for chat + business mode
- Anonymous/keyless traffic is only a best-effort last resort (status captions) — instantly falls back when the hourly IP budget is exhausted

---
Task ID: 2
Agent: main (Z.ai Code)
Task: Make status captions KEYLESS Pollinations (user directive) — no BYOP key, no env key; keep Business Mode on the BYOP gen.pollinations.ai flow (addPollinationsProvider, live catalog, Bearer auth, selected chat model with its provider)

Work Log:
- Read worklog Task 1 + current code: status-caption route had a 3-step key chain (caller BYOP key → POLLINATIONS_API_KEY env → keyless); business llm.ts already fully on addPollinationsProvider/BYOP (commit eed357b)
- Verified live catalog (409 models, 122 free text): openai/gpt-5.4-nano free (paid_only:false) but openai/gpt-4o-mini is NOW paid_only:true — unusable as a keyless fallback; picked deepseek/deepseek-v4.1-flash (free, tools, /v1/chat/completions) as the second attempt
- src/app/api/status-caption/route.ts: removed the key field + sanitizeCallerKey + POLLINATIONS_API_KEY env lookup + apiKey param + Authorization header — route is now KEYLESS-ONLY (anonymous tier, free models, User-Agent kept); rewrote header docs as the KEYLESS POLICY; models = [openai/gpt-5.4-nano, deepseek/deepseek-v4.1-flash]; contract comment updated
- src/hooks/use-ai-status-phrases.ts: removed connectedPollinationsKey() + key from the POST body; dropped settingsService/useAuthStore imports; hook now fully keyless (KEYLESS BY DESIGN note in the doc comment)
- Lint: 0 errors, no warnings in either edited file
- Live verification: keyless nano completion succeeded earlier (proved the path); then the gateway's hourly anonymous IP budget exhausted for this server IP → instant 401 on all endpoints (chat + GET /text) — exactly the documented degradation: route answers 200 with local fallback phrases, never blocks
- E2E (agent-browser): app loads clean (zero page/console errors); POST /api/status-caption from browser context returns valid {phrases, source:"fallback"}; /business renders the provider gate + "Connect Pollinations" CTA (addPollinationsProvider flow) intact, no errors
- Committed 25fb948 (local main; NOT pushed — user pushes on explicit request)

Stage Summary:
- Status captions are now 100% keyless Pollinations: no key is read, sent, or stored anywhere in the feature (route + hook), so decorative micro-generations never spend BYOP credits
- Free-catalog-models-only policy (nano + deepseek flash); paid-only gpt-4o-mini removed from the surface
- Graceful degradation verified live: anonymous hourly budget exhausted → instant 401 → local fallback phrases keep the status line moving
- Business Mode untouched and re-verified: addPollinationsProvider = real gen.pollinations.ai/v1 + Bearer BYOP key + live catalog (235 live chat models), discovery/chat run on the SELECTED chat model with its provider (resolveBusinessLlmConfig chain)

---
Task ID: 3
Agent: main (Z.ai Code)
Task: Fix the business "Provider Pollinations error (HTTP 404): Model community/CloudCompile/dots-studio-dots-3-note-preview:free isn't on the Classic API" error; remove the decision model; keep every AI call on the gen.pollinations.ai endpoint (selected model with its provider) for main-agent discovery (third process) and all — except status captions (keyless)

Work Log:
- Reproduced the upstream error by curl: text.pollinations.ai/openai/chat/completions returns EXACTLY the user's 404 ("isn't on the Classic API") for the dots model — proving the business call resolved a LEGACY provider row still on the classic endpoint. gen.pollinations.ai has the model (catalog: community:true, paid_only:false, /v1/chat/completions in supported_endpoints) — the user is right
- Root cause: the chat model picker lists models from ALL providers flat, so selectedModel (dots, gen-catalog-only) can coexist with a stale selectedProviderId pointing at a legacy text.pollinations.ai row; old resolveBusinessLlmConfig then blindly sent the model to the classic base URL
- src/lib/business/llm.ts resolveBusinessLlmConfig REWRITTEN: (1) LEGACY-CLASSIC GUARD — any Pollinations row still on text.pollinations.ai triggers migrateLegacyPollinationsGateway inline (repoint-to-gen with connected key / delete when not connected) then re-lists; usable providers are additionally filtered so a classic URL is NEVER called; (2) MODEL-FIRST resolution — the chat-selected model resolves with the provider that OFFERS it (override.providerId → model owner → selectedProviderId → first active); (3) orphaned model ids fall back to the provider's first model instead of a guaranteed 404
- Decision model (JEV systemone, typesafe/jev-1.13) REMOVED: orchestrator chat-turn step-4 classify + routingHint plumbing; prompts.ts routing-hint section + RoutingHint import; deleted src/lib/business/jev.ts, src/app/api/jev-decide/route.ts, src/lib/tools/decision.ts; tools/index.ts import + comment; ONYX.md digest tool entry + name list; ui-text decisionFallback/decisionUsed keys (fixed a self-inflicted duplicate ui-text key + duplicate prompts import + invented-import slip along the way)
- decision_records Dexie table + service left inert (historical data; no runtime users remain)
- Lint 0 errors (only pre-existing warnings); tsc clean for all edited files (added the missing !provider guard + corrected ChatHistoryEntry which is defined IN prompts.ts, not types)
- E2E (agent-browser, injected the user's exact broken state into IndexedDB: legacy classic row + gen row offering the dots model, chat-store selection = legacy provider + dots model):
  * /business mount → legacy row auto-deleted (guard worked; only gen-poll-row remains)
  * wizard discovery run → config badge shows "Using Pollinations · community/CloudCompile/dots-studio-dots-3-note-preview:free" (model-first resolution proven)
  * network log: ONLY POSTs to gen.pollinations.ai/v1/chat/completions (401 with the empty test key = the honest auth error, NEVER the classic 404; with the user's connected key this call succeeds)
  * zero jev-decide calls, zero console/page errors, dev.log clean
- Committed (business-llm classic-404 fix + decision model removal)

Stage Summary:
- The Classic-API 404 is dead: legacy text.pollinations.ai rows self-heal on every business call path and classic URLs are never callable; the selected model always resolves together with the provider that offers it
- ALL business AI (discovery steps 1-3 incl. the blueprint-drafting third process, specialist agents, chat turns, regeneration) runs on the user's selected gen.pollinations.ai model via the single resolveBusinessLlmConfig path — status captions remain the one keyless exception
- The JEV decision model is fully removed from the product (business chat, agent tools, docs, UI text); no decision-engine network calls remain

---
Task ID: 4
Agent: main (Z.ai Code)
Task: Complete the Pollinations endpoint-migration PRD — finish the repository-wide audit, close the remaining gaps in the shared AI client layer (main chat, provider-test URL, background dispatch sanitizers, key pool, agent tool listing), and verify the full resolution contract end-to-end.

Work Log:
- Read worklog Tasks 1-3; audited the unlogged commit 4da657a (previous session had already built src/lib/agent/provider-resolution.ts and migrated runtime/subagent-runtime/use-chat/business-llm/orchestrator/provider-diagnostics/services/tasks onto it — verified sound, kept as-is)
- Completed the PRD §11 audit: grep text.pollinations.ai (only comments + intentional legacy-guard matchers remain), dots model ids (zero remain — all "dots" matches are UI decorations), hardcoded model defaults (zero in executable paths; only doc comments + a test fixture), duplicate base URL constants (pollinations-server GEN_BASE_URL vs provider-sync POLLINATIONS_TEXT_BASE_URL are distinct roles: server proxy root vs provider-row base — both gen), direct HTTP calls (all chat-completions fetches route through chatCompletionsUrl or the server proxy), env overrides (POLLINATIONS_API_KEY is the server-side OAuth owner secret only, never a model/key override)
- Found + fixed the MAIN CHAT gap (use-chat.ts buildTurnOptions): it still called aiProviderService.list(userId, true) without the legacy-classic guard and resolved selectedProviderId ?? providers[0] — the exact Classic-404 bug class, still live in normal chat. Now: listUsableProviders (self-heals + never returns classic rows), MODEL-FIRST chain (resolveProviderForModel → selectedProviderId → first active → providers[0]), orphaned-model recovery (selected model adopted only when the resolved provider offers it, else the provider's first model — never a hardcoded id), and the auto-router candidate loop keeps its active-only semantics
- Created src/lib/agent/provider-url.ts — the PURE leaf (zero imports) holding the ONE URL construction (chatCompletionsUrl) + the legacy matchers (isLegacyClassicRow/isLegacyClassicUrl/LEGACY_CLASSIC_HOST); provider-resolution re-exports them (all existing importers unchanged); breaks the services↔provider-resolution module cycle so services/index.ts testProvider uses the same construction as every runtime lane
- Background dispatch sanitizers: runner-config.ts + trigger-cloud.ts now drop a pinned chatUrl on the retired classic host onto the keyless bridge (a stale snapshot/schedule pin can never call text.pollinations.ai — it would only 404)
- key-pool.ts: classic-URL provider rows never contribute keys to the rotational pool; tools/subagents.ts list_ai_providers now lists via listUsableProviders (the agent can only assign gateways that serve gen-catalog models)
- Verification: lint 0 errors (51 pre-existing warnings); tsc 73 errors before = 73 after (zero new); agent-browser E2E on the user's EXACT broken state injected into IndexedDB (stale classic "Pollinations" row + gen row offering community/CloudCompile/dots-studio-dots-3-note-preview:free + selection pinned to the classic row): send → POST gen.pollinations.ai/v1/chat/completions (401 honest auth error with the empty test key — NEVER the classic 404), ZERO text.pollinations.ai requests, classic row auto-deleted, debug log "turn provider=Pollinations model=community/CloudCompile/dots-studio-dots-3-note-preview:free" (model-first proven)
- E2E resolution matrix: orphaned model id → falls to the provider's first model (openai/gpt-5.4-nano), no hardcoded switch; second provider config with custom base https://e2e-mock-gateway.example.com/v1 → URL = base + /chat/completions exactly once (custom base respected); no_prefix provider → base used as-is, no suffix appended; keyless status-caption regression → 200 + local fallback phrases; /business gate renders the honest empty state + Connect Pollinations CTA, zero page errors; dev.log clean, zero sk_ secrets leaked
- All e2e test rows/prefs cleaned from IndexedDB + localStorage afterwards

Stage Summary:
- The shared AI client layer is complete and uniform: EVERY workflow (main chat, subagents, business discovery incl. blueprint step, business chat/specialists, provider diagnostics, provider health test, background/cloud lanes, the agent provider-assignment tool) resolves provider+model+baseURL through provider-resolution/provider-url and builds URLs through the ONE chatCompletionsUrl
- The retired text.pollinations.ai endpoint is unreachable everywhere except the intentional legacy-row matchers; status captions remain the one keyless dedicated surface (on gen, free catalog models — stricter than the PRD asked)
- Model resolution priority everywhere: task-level override → agent/subagent config → shared chat-store selection (model-first with its owning provider) → provider's first model as the documented orphaned-id fallback; NO hardcoded model id survives anywhere
- Background runs carry the foreground turn's effective configuration (pinned gateway + its key leading the pool, no rotation against a pinned gateway); stale classic pins drop to the bridge instead of calling the dead endpoint

---
Task ID: 5
Agent: main (Z.ai Code)
Task: Fix the recurring business legacy-endpoint regression ("coming back changes my gen pollinations endpoint to text.pollinations") + push; then begin the E2B persistent-background-execution PRD.

Work Log:
- Pushed 821e5ef..7662ca5 (user directive: push first)
- Audited EVERY ai_providers write path: current code writes text.pollinations.ai NOWHERE — root cause found in git history: the PRE-migration bundle (821e5ef, still running in stale browser tabs) does the exact damage on /business mount — its migrateLegacyPollinationsGateway ran the OPPOSITE direction (finds the row named "Pollinations" on gen, FLIPS it onto https://text.pollinations.ai/openai with no_prefix:true) and its dashboard mount re-seeds a keyless legacy row via addFreePollinationsProvider. A stale tab re-breaks the row every time the user comes back to it
- EMERGENCY during work: the user's E2B workspace-sync resurrected 69 untracked files from an old sandbox snapshot (src/lib/db.ts Prisma stub SHADOWING the canonical src/lib/db/index.ts Dexie module → 692 TS errors + app 500; Task-3 deletions jev.ts/decision.ts/api/jev-decide back; plus parallel-work files). Killed the zombies that break the canonical tree (db.ts + jev + decision + jev-decide route) → app recovered 200; remaining ~80 tsc errors live only inside the unimported parallel-work files
- Fix 1 — migrateLegacyPollinationsGateway (business/llm.ts): heals ALL legacy rows in one pass — repoint the first to gen (connected key + live models + no_prefix reset), purge ghost extras, delete all when not connected
- Fix 2 — providers.tsx LegacyRowHealer (root controller): sweeps on boot, on authResolved flip (store subscribe), and on EVERY window focus/visibility return — the current bundle wins the write war within milliseconds of the user returning to the app; verified live: focus event on damaged rows → "[healer] repointed a legacy text.pollinations.ai provider row back to the gen gateway" + ghost rows deleted
- Fix 3 — turn-cloud-handoff.ts: legacy-pin guards on BOTH cloud dispatch sites (pagehide beacon + dispatchDetachedCloudTurn) — the retired endpoint can never be pinned into a NEW cloud run; a legacy pin drops to the keyless bridge
- Fix 4 — trigger-cloud.ts syncCloudRunIntoRow: stale runs pinned to the legacy endpoint (dispatched pre-migration) settle honestly as failed (code legacy_endpoint_pin, retry hint) instead of surfacing endless upstream Classic-404s
- Verified: lint 0 src errors; my files tsc-clean; E2E (agent-browser) healer + business gate + chat all clean, zero console errors; committed 43da0fa + pushed

Stage Summary:
- The ghost-tab write war is won deterministically: every current-app return (focus/visibility/boot/auth) re-heals any damage a stale pre-migration tab inflicted; every AI turn ALSO re-guards lazily (listUsableProviders); no new cloud run can ever pin the legacy endpoint; stale legacy-pinned runs fail honestly with a retry hint
- Business mode always runs the CHAT-SELECTED model with the provider that offers it, on gen.pollinations.ai — the only legacy exception is status captions (keyless, by design)
- The zombie resurrection (workspace-sync writing an old snapshot into src/) is a REAL hazard: src/lib/db.ts shadowing broke the whole app — flagged in the report for the user

---
Task ID: 6
Agent: main (Z.ai Code)
Task: E2B Persistent Background AI Execution PRD — audit existing infrastructure, implement the exact §4 reconnect banner, map the remaining gaps honestly.

Work Log:
- Audited the existing background-execution stack against the 16-section PRD (see Stage Summary mapping)
- use-chat.ts: the reconnecting cloud-turn bubble now shows the EXACT required §4 banner copy: "Onyx is working in the background. Wait until the task is finished to see the complete response here." (shown only while the cloud run is verifiably queued/running; the poll loop rewrites the bubble with the landed answer on completion)
- Restarted the dev server after it died mid-session (no fatal log errors; Turbopack had also panicked once when the zombie workspace-sync files landed — removing them fixed compilation)
- E2E: /chat loads with zero page/console errors; server stable 200; committed 28cfe82 + pushed (43da0fa..28cfe82)

Stage Summary (PRD §1-§16 → existing vs gap):
- §2/§3/§10 durable records + lifecycle + ownership: EXISTS — Prisma TaskRun rows (status/phase/lockHolder/attempts/finishedAt), Trigger.dev Cloud queue with claim-locks, chunked event history with seq cursors; runs survive tab close/refresh/navigation (pagehide close-handoff for chat + business turns)
- §4 leave-during-response UX: EXISTS + exact banner now in place — pagehide beacons the in-flight turn to Cloud; on return the meta re-adopts the run, the interrupted bubble shows the required banner, polls, and the finished answer lands in the ORIGINAL conversation (no duplicate chat)
- §5 event persistence + heartbeats: PARTIAL — chunked progress with persisted cursors + missed-event recovery exists; server-side execution-health heartbeats (stalled-run detection) remain a gap
- §6 scheduled tasks: EXISTS — server-side cron-scheduler dispatches durable runs with pinned provider gateway (no browser needed); duplicate-trigger protection via claim-locks; legacy-pinned schedules now drop to the bridge (Task 5 fix)
- §7 project agents / §8 business swarm: PARTIAL — business main-agent cloud lane exists (BusinessTurnSnapshot + pagehide dispatch + child specialist turns inside the run); durable PARENT↔CHILD execution records for swarm delegation + restore UI remain a gap
- §9 provider/model consistency: EXISTS — pinned gateway + pinnedApiKey lead the pool (Task 4); chat-selected model travels with the turn; no hardcoded models
- §11 tools in background: PARTIAL — the E2B runner runs terminal/file/web tools server-side; frontend-only tools are unavailable in background runs by design (the runner degrades to tools-off on 400s)
- §12 cancellation: EXISTS — cancel route + taskToken-authorized cancel/sync; business explicit cancel unregisters the handoff
- §13 security: EXISTS — taskToken sha256 server-side, keys vault-sealed + pooled server-side, no secrets in events/logs (verified)
- REMAINING for a future task: server-side heartbeat/stalled-run recovery (§5), durable swarm child-task records + swarm restore UI (§7/§8), E2B env failure auto-recovery with checkpoints (§3 last paragraph)

---
Task ID: 7
Agent: main (Z.ai Code)
Task: "It's still using fixed model not the selected model" (Business badge: Using Pollinations · community/CloudCompile/dots-studio-dots-3-note-preview:free) + "hallucinating tools and connectors … no direct option to connect them" (Stripe, AWS/GCP/Azure, Stable Diffusion API, Unity Asset Store SDK, Unreal Engine Marketplace API, Discord, Google Analytics, AI/ML engineering, …). Push first; continue the worklog.

Work Log:
- Pushed the pending auto-commit first (3d30dcc..c483fb7 — deploy/trigger-dev + public/skill-repos snapshot).
- Audited EVERY model-resolution lane again (resolveBusinessLlmConfig, buildTurnOptions, chat-controls pick/restore, settings dialog, agent creation) — all sound; no hardcoded dots model anywhere in src.
- ROOT CAUSE FOUND (the real "fixed model"): the chat selection lives in an in-memory zustand store + the persisted localStorage pref; the ONLY restore path was ChatControls' mount effect — a chat-page-only component. A fresh tab / refresh on /business boots the store as {null, null}, so resolveBusinessLlmConfig fell to the first active provider's FIRST catalog model — and in the alphabetical live Pollinations catalog that is exactly community/CloudCompile/dots-studio-dots-3-note-preview:free. The user's pick was never lost — it was never RESTORED off the chat page.
- NEW src/lib/agent/model-pref.ts — the ONE owner of onyx:selected-model: saveModelPref/loadModelPref + hydrateModelPrefFromRows (guarded: fills an EMPTY store only, provider-existence-validated so a healed/deleted legacy row never resurrects, explicit-Default honored by no-op).
- providers.tsx: root ModelPrefHydrator controller (boot on auth resolve + every focus/visibility return; idempotent, cheap Dexie read) — restores the pick on EVERY route.
- business/llm.ts resolveBusinessLlmConfig: hydrates the persisted pref against its own usable-provider list before resolving (defense in depth for direct wizard hits).
- chat-controls.tsx + code/creation-prompt.tsx now import the persistence pair from the leaf (no behavior change; single key owner).
- CONNECTORS: the discovery prompt asked for free-form recommended_connectors string[] — the model invented Stripe (payments), Discord (community), AWS / Google Cloud / Azure, Unity Asset Store SDK, Google Analytics… and the wizard rendered them as integration chips with nothing behind them. Fix: REAL_CONNECTOR_CATALOG in prompts.ts (the app's genuine capabilities: Web Search & Reading, Pollinations Media Generation, Code Execution Sandbox, Workspace Files & Knowledge Base, Scheduled & Background Tasks, Subagent Delegation, App Integrations via Composio) is now the EXACT whitelist in BOTH the discovery prompt and the section-regenerate schema; parse-time sanitizeRecommendedConnectors drops any off-catalog answer before the UI can render it (unit-verified: every entry from the user's report is dropped; decorated variants map to canonical labels); honest chip labels added (en+pl): "Built-in capabilities — already wired into the app (Composio apps connect in Settings → Integrations)" / "Team expertise — woven into the business profile"; recommended_skills now actually flow into the business profile markdown (blueprintProfileMarkdown) so they are real agent context, not decoration.
- Investigated a false alarm en route: brief sandbox-sync artifact made the wizard file LOOK syntax-corrupted in a few reads (const odelBadge) — verified with git log -S that the corruption never existed in ANY commit and bun built the file fine all along; nothing to fix.
- E2E (agent-browser, the user's exact scenario injected: gen Pollinations row with dots as models[0] + persisted pick openai/gpt-5.4, fresh direct /business visit): discovery badge shows "Using Pollinations · openai/gpt-5.4" (the pick — previously this exact state showed dots); network = ONLY gen.pollinations.ai/v1/chat/completions via the proxy (honest 401 with the empty test key); chat page picker intact; test rows + pref cleaned; dev.log clean; lint 0 src errors (21 errors only inside public/skill-repos static assets); tsc clean on all touched files.

Stage Summary:
- Business Mode now resolves the user's ACTUAL selected model on every route: the persisted pick is restored at app boot and again inside the business lane itself — the "fixed model" first-catalog fallback can only appear for users who never picked a model (and then the badge names it honestly).
- The wizard can no longer display invented connectors: prompt whitelist + parse-time sanitizer + honest labels; external services the blueprint needs are routed to risks/assumptions.
- Committed af81be7 + pushed.

---

## 2026-10-29 — "Append failed (exit -1): exit status 1" on every writefile (+ full-app 500)

Task ID: 8
Agent: main (Z.ai Code)
Task: User report — every chunked writefile fails with `{"error": "Append failed (exit -1): exit status 1", "path": ".", "chunk_index": 0, "bytes_written": 0, "created_dirs": [], "verified": false}`. Continue the worklog; push.

Work Log:
- Reproduced the exact error shape: it is create_file_chunk's own return (src/lib/tools/file_writer.ts) after `client.exec("printf %s '…' >> '.'")` — i.e. the tool tried to APPEND TO THE WORKSPACE ROOT DIRECTORY (path fell back to ".").
- ROOT CAUSE 1 (the "-1 / exit status 1"): E2B SDK v2's `commands.run()` THROWS `CommandExitError` on ANY non-zero exit (node_modules/e2b/dist — wait(): `if (exitCode !== 0) throw new CommandExitError(result)`). The /api/sandbox route's catch treated that as a generic sandbox failure → `{exit_code: -1, stderr: "exit status 1", error: …}` with the REAL stdout/stderr (e.g. "bash: .: Is a directory") and exit code DISCARDED. Affected: exec (non-stream — used by every append/probe), exec_stream (every failed run_terminal command ended as an error frame instead of its real exit code), and the run_python_stream `script -qec` fallback (a Python traceback exit became "exit status 1").
- ROOT CAUSE 2 (the path: "."): create_file_chunk ran `safePath(args.path)` with fallback "." — a missing/empty/"/" path silently targeted the workspace root directory. No validation, no actionable error. Related: the files-umbrella digest (consolidated.ts) documented the content parameter as `chunk` (wrong name) — models that followed it sent `chunk` while `content` stayed undefined (silent empty appends) or dropped params entirely.
- ROOT CAUSE 3 (found via dev.log while verifying): HEAD commit 94f40c8 (Task 7) added `src/lib/db.ts` — a 13-line Prisma stub that SHADOWED `src/lib/db/index.ts` (the Dexie client DB behind the whole app). Every client import of `@/lib/db` failed ("The export wipeUserData was not found") → GET / 500 — the entire app was down since that commit.
- FIX (route.ts): new `commandExitInfo(err)` helper (duck-types the SDK's CommandExitError: name + result.exitCode/stdout/stderr, prefers real stderr over envd's Go "exit status N" message). Applied BEFORE the dead-sandbox branch in all six catch sites (exec ×2, exec_stream ×2, run_python_stream fallback ×2, incl. the fresh-sandbox retry catches with a hoisted freshSandboxId). Legit non-zero exits now return the REAL exit code + stdout + stderr; error frames only for actual failures.
- FIX (file_writer.ts): argument validation BEFORE any sandbox work — missing/whitespace path, directory-looking path (".", "./", trailing "/", workspace root) and missing `content` each return an actionable error with an exact example call; `chunk` alias rescue (content = args.chunk when content is absent) with a self-correcting note on success; mode aliases (write/overwrite/new → create); empty append rejected (only create+chunk 0 may write empty). verify_path + read_file_section get the same missing-path guard.
- FIX (consolidated.ts): digest corrected — `create_file_chunk (path, content, mode, chunk_index)` + first-chunk create / append flow spelled out (was: `chunk`).
- FIX (bg-agent-script.ts): the sandbox-NATIVE create_file_chunk (background lane) gets the same directory guard + chunk-alias rescue + mode aliases (parity with the browser lane); embedded script syntax-verified with Bun.Transpiler (260,284 chars parse clean).
- FIX (app-down): deleted the shadowing `src/lib/db.ts`. Audited every `@/lib/db` importer (services barrel, auth-store→providers→root-layout chain, tasks, search, uploads, business, agent/*) — all Dexie consumers; the Task-7 files (jev.ts/decision.ts/jev-decide route) import `@/lib/db` NOWHERE; real Prisma users go through `@/lib/prisma/client`. GET / went 500 → 307 → /chat 200.
- VERIFIED: tsc 0 errors + eslint clean on all touched files; Bun test of commandExitInfo against the REAL installed SDK class (real exit code + "bash: .: Is a directory" stderr extracted; "exit status N" fallback; non-exit errors → null so dead-sandbox recovery still fires); Bun test of the registered create_file_chunk handler — all 6 bad-arg shapes now return actionable errors, chunk-alias calls pass validation; agent-browser: / → /chat 200, full UI renders, no page errors, console clean, Settings dialog (incl. the wipeUserData-dependent Data management + Sandbox E2B sections) fully interactive.
- OPS: the platform reaps non-daemonized processes between tool calls (took down the dev server mid-verification); relaunched double-forked (subshell + setsid → PPid 1) — stable.

Stage Summary:
- Chunked file writes can no longer produce the opaque "Append failed (exit -1): exit status 1": paths/contents are validated up front with actionable fixes, the `chunk` digest bug is gone, and any legitimately failing sandbox command now reports its REAL exit code, stdout and stderr to the model (across exec, run_terminal streaming, and the Python fallback).
- The app-down 500 from the Task-7 db.ts shadow is fixed (file deleted; Dexie module resolution restored).

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

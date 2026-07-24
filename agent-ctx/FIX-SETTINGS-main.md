# FIX-SETTINGS — settings pages backendless migration

## Task
Migrate every settings page off the legacy `apiClient` / `/api/*` proxy and onto the backendless `@/lib/services` layer. Remove the Account page (no server password / sessions in backendless mode). Strip stdio from the MCP transport picker (browsers can't spawn processes).

## Files edited (11 total)

### Service layer (`src/lib/services/index.ts`)
- Added `skillService.list(userId)` (alias for `listInstalled`) and `skillService.delete(id)`.
- Added `settingsService.setTavilyKey(userId, key|null)` and `setEmbeddingsKey(userId, key|null)` — mirror `setHopxKey`, encrypt via vaultEncrypt, write to existing columns.
- `aiProviderService.create` no longer throws when `api_key` is empty (local providers like Ollama explicitly supported by UI).
- `authService.updateProfile` accepts an optional `email` patch field (normalized to lowercase).

### Settings pages (`src/app/[locale]/(dashboard)/settings/`)
1. **config/page.tsx** — `aiProviderService` for providers; `settingsService.getDecryptedHopxKey/setHopxKey/setTavilyKey/setEmbeddingsKey` for sandbox keys; `settingsService.get/setSystemPrompt` for system prompt. Preserved the inline editor + SectionCard UI.
2. **skills/page.tsx** — `skillService.list` for installed; empty catalog + "Catalog coming soon" empty-state; install/upload → `toast.info("… coming soon")`; uninstall → `skillService.delete(id)` (UI now tracks id).
3. **mcps/page.tsx** — `mcpService.list/create/update/delete`; **removed `stdio` from transport picker** (only `sse` + `streamable_http`); added amber note "Only HTTP/SSE MCP transports are supported in backendless mode."; legacy stdio rows coerced to `sse` on load.
4. **tools/page.tsx** — `customToolService.list/create/update/delete`. Editor's `input` uses `undefined` (not `null`) for `http_url`/`python_source` to satisfy create()'s optional fields.
5. **env/page.tsx** — `settingsService.get` + `settingsService.getDecryptedEnvVars` for load; all writes (POST/PUT/DELETE) rebuild the full env-vars dict and call `settingsService.setEnvVars`. Dropped the `hopx_synced` flag.
6. **account/page.tsx** — **replaced entirely** with a SectionCard explaining account settings aren't available in backendless mode + "Go to Profile" button.
7. **profile/page.tsx** — `authService.updateProfile` (extended to accept email); avatar upload writes to OPFS at `users/<userId>/avatar/<filename>` then `updateProfile({ avatar_url: path })`; avatar `<Image src>` now uses a fresh blob URL minted via `makeBlobURL(path)`; **removed the entire Active sessions section** + Session/SessionListResponse imports + DeviceIcon helper.

### Other
8. **src/components/onboarding/onboarding-state.ts** — `apiClient.patch("/users/me")` → `authService.completeOnboarding(userId)` (userId from `useAuthStore.getState().user?.id` with localStorage fallback). Refreshes in-memory user after persisting.
9. **src/components/settings/settings-nav.tsx** — removed the "Account" entry + unused `Shield` import.

## Verification
- `bunx tsc --noEmit --skipLibCheck` → ZERO errors in any edited file. Remaining errors are pre-existing (vitest types missing in `.test.ts` files; standalone scripts in `examples/` + `skills/`).
- `grep apiClient|fetch\(|/api/(ai-providers|mcp-servers|custom-tools|skills|agent-settings|users|sessions|auth)` across `src/app/[locale]/(dashboard)/settings/` → ZERO matches.
- `grep Account|SETTINGS_ACCOUNT` in `src/components/settings/settings-nav.tsx` → ZERO matches.
- `bun run lint` is broken (pre-existing ESLint circular-structure error); verification via `tsc`.

## Notes for next agent
- The `aiProviderService.create` API-key-required check was loosened to allow empty keys (for Ollama / vLLM / LM Studio). If you re-tighten it, the config page UI text "API key (optional) — Leave blank for local providers" must also change.
- The MCP page silently coerces legacy `stdio` rows to `sse` on load so old DB rows keep rendering. If you want to actually migrate them, add a one-time upgrade step.
- The env page now holds decrypted secret values in React state so the reveal-eye can show them. If you want stricter masking (never hold decrypted secrets in memory beyond initial load), move the reveal flow to a separate "show value" button that re-queries `getDecryptedEnvVars` on demand.
- The profile page avatar uses OPFS at `users/<userId>/avatar/<filename>`. The `<Image src>` is `unoptimized` so Next.js doesn't try to proxy the blob URL through `/_next/image`.

# Task ID: EDIT-AUTH-LAYOUT
Agent: main (Z.ai Code orchestrator)
Task: Convert the cloned app's auth pages, layouts, providers, and middleware to backendless mode (local passphrase vault, no server, no JWT, no cookies).

## Context — what other agents have done
- **REMOVE-API-ROUTES** (`agent-ctx/REMOVE-API-ROUTES-api-routes-remover.md`): deleted all 69 `/api/*` proxy routes; left only `/api/chat-proxy` (stateless CORS streaming proxy). Confirmed `src/middleware.ts` is pure next-intl locale routing with `/api` excluded from its matcher — no auth checks.
- **EDIT-LIB-HOOKS** (`agent-ctx/EDIT-LIB-HOOKS-main.md`): rewrote `lib/api-client.ts` (shim, keeps `ApiError`), `stores/auth-store.ts` (vault-aware: `user`, `isAuthenticated`, `isLoading`, `vaultUnlocked`; `init()`; async `logout()`; no JWT; no persist), `hooks/use-auth.ts` (`login(email, passphrase)`, `register(email, fullName, passphrase)`, `logout()`; init effect calls `authService.getCurrentUser()` + syncs `vaultUnlocked`), `hooks/use-chat.ts` (SSE runtime via `runAgentTurn`), `hooks/use-conversations.ts` / `use-conversation-shares.ts` / `use-slash-commands.ts` (Dexie services), `hooks/use-websocket.ts` (deprecated no-op). EDIT-LIB-HOOKS explicitly listed the following as OUT OF THEIR SCOPE and expected this task to handle them: `login-form.tsx`, `register-form.tsx`, `auth-guard.tsx`, `forgot-password-form.tsx`, `reset-password-form.tsx`, `app/[locale]/auth/magic-link/page.tsx`, `app/[locale]/auth/callback/page.tsx`. ✅ All handled.
- **Foundation agent (concurrent)**: created `lib/crypto/vault.ts` (PBKDF2 + AES-GCM; `createVault`, `unlockVault`, `setVault`, `isVaultUnlocked`, `requireVault`, `vaultEncrypt`, `vaultDecrypt`), `lib/db/index.ts` (Dexie `AppDatabase` with `wipeAllData` + `wipeUserData`), `lib/storage/opfs.ts`, `lib/hopx/client.ts`. `lib/services/` and `lib/agent/runtime.ts` are STILL being created concurrently — my code is correct against the API documented in `agent-ctx/EDIT-LIB-HOOKS-main.md`, but the app won't fully run until those land. Not this task's concern.

## Approach
- Initially created `src/lib/auth-service.ts` (a self-contained IndexedDB + Web Crypto vault) but discovered the EDIT-LIB-HOOKS agent had already established a different foundation path (`@/lib/services` `authService` + `@/lib/crypto/vault`). Deleted my `auth-service.ts` to avoid conflict and aligned to the EDIT-LIB-HOOKS API.
- Read each in-scope file end-to-end before editing.
- Preserved the cloned app's UI/styling: same eyebrow + display heading + bordered inputs + ArrowRight submit button + strength meter + footer links. Only the data-fetching / auth logic changed.
- Used `useAuth()` from `@/hooks/use-auth` and `useAuthStore` from `@/stores` per the task spec.
- Marked `'use client'` on every component that uses hooks/state.

## Files edited (12 in-scope + 4 supporting)

| File | Action | Notes |
|---|---|---|
| `src/middleware.ts` | NO CHANGE | Already pure next-intl locale routing, `/api` excluded. |
| `src/app/[locale]/layout.tsx` | NO CHANGE | Already clean i18n wrapper. |
| `src/app/providers.tsx` | NO CHANGE | Already QueryClient + ThemeProvider + TooltipProvider + Toaster. No auth provider. |
| `src/app/[locale]/(auth)/layout.tsx` | NO CHANGE | Already clean marketing split-layout, no server auth. |
| `src/app/[locale]/page.tsx` | NO CHANGE | Already `redirect("/login")`. |
| `src/app/[locale]/(dashboard)/layout.tsx` | NO CHANGE | Already wraps children in `<AuthGuard>`. |
| `src/components/auth/login-form.tsx` | REWROTE | `login(email, passphrase)`, "Passphrase" label, local-first notice card. |
| `src/components/auth/register-form.tsx` | REWROTE | `register(email, fullName, passphrase)`, passphrase + confirm, local-first notice. |
| `src/components/auth/forgot-password-form.tsx` | REWROTE | Removed email input. Destructive "Reset local vault" button: `wipeAllData()` + `setVault(null)` + `logout()`. |
| `src/components/auth/reset-password-form.tsx` | REWROTE | Same as forgot-password; `token` prop ignored. |
| `src/components/auth/oauth-buttons.tsx` | REWROTE | `OAuthButtons` + `OAuthBlock` return `null`. `OAuthDivider` kept. Removed `BACKEND_URL` import. |
| `src/components/layout/auth-guard.tsx` | REWROTE | Uses `useAuth()` for `user` + `isLoading`, `useAuthStore` for `vaultUnlocked`. Redirects to `/login?next=<pathname>` if `!user || !vaultUnlocked`. No `/auth/me` call. |
| `src/app/[locale]/(auth)/magic-link-sent/page.tsx` | REWROTE | `redirect("/login")` — magic links no longer exist. |
| `src/app/[locale]/auth/magic-link/page.tsx` | REWROTE | Client component, `router.replace("/login")` in `useEffect`. |
| `src/app/[locale]/auth/callback/page.tsx` | REWROTE | Same — redirect to `/login`. No OAuth callback. |
| `src/app/[locale]/(auth)/reset-password/page.tsx` | REWROTE | Removed "Missing or expired link" branch; always renders the form. |
| `src/app/[locale]/(auth)/forgot-password/page.tsx` | MINOR | Updated metadata title/description. |
| `src/types/auth.ts` | MINOR | `LoginRequest.passphrase`, `RegisterRequest.passphrase`, simplified `LoginResponse`. |
| `messages/en.json` + `messages/pl.json` | MINOR | Added `auth.passphrase`, `auth.confirmPassphrase`, `auth.passphrasePlaceholder`, `auth.passphraseConfirmPlaceholder`, `auth.localFirstNotice`, and a `resetPassword.{resetVaultHeading,resetVaultBody,resetVaultButton,resetVaultResetting,resetVaultDone,resetVaultConfirm}` block. |

## Verification
- `bunx tsc --noEmit` — **zero type errors** in any of the edited files. (Pre-existing errors in other agents' files — `auth-store.ts`'s `lockVault` import, missing `@/lib/services` module, `use-chat.ts`'s `AgentTurnController` mismatch, `vault.ts`'s `number | undefined` issue — are out of this task's scope.)
- `bun run lint` fails with a pre-existing circular-structure error in the ESLint config (per the REMOVE-API-ROUTES worklog: "same error before/after"). Not caused by this task.
- Dev server (`bun run dev`) log is clean — no compile errors after my edits.

## Issues / Notes for orchestrator
1. **Foundation dependency**: `useAuth()` (in `@/hooks/use-auth`) imports `authService` from `@/lib/services`, which is being created by the concurrent foundation agent. Until that lands, the auth pages will throw at module-load time. My code is correct against the API documented in `agent-ctx/EDIT-LIB-HOOKS-main.md`.
2. **`auth-store.ts` has a broken `lockVault` import** (it imports `lockVault` from `@/lib/crypto/vault`, but vault.ts only exports `setVault`). This was introduced by the EDIT-LIB-HOOKS agent — between them and the foundation agent. I left `auth-store.ts` alone since EDIT-LIB-HOOKS owns it. My `forgot-password-form` and `reset-password-form` use `setVault(null)` directly (which IS exported) to avoid the broken import.
3. **`account/settings` page still calls `apiClient.post("/auth/password/change")` and `apiClient.delete("/users/${user.id}")`** — these will throw the 501 "not implemented" error in backendless mode. Out of this task's scope (settings page, not auth page). EDIT-LIB-HOOKS flagged this in their worklog item 6.
4. **`use-chat.ts` may still have a stale `fetch("/api/auth/me")` call** in its `onClose` handler (line ~430 of the original). EDIT-LIB-HOOKS rewrote `use-chat.ts` around `runAgentTurn`, but if that rewrite hasn't fully landed, the stale fetch may still be present. Worth a follow-up check.
5. **`OAuthBlock` and `OAuthButtons` always render `null`** — kept as no-op stubs so the existing `<OAuthBlock />` JSX in login-form and register-form doesn't need to be removed. If a future agent wants to fully excise OAuth, they can delete `oauth-buttons.tsx` and remove the JSX.
6. **`auth-store.test.ts` is stale** (per EDIT-LIB-HOOKS worklog item 5) — it calls `logout()` synchronously and asserts `state.user === null`, but the new `logout` is async. Not in my scope (test file).

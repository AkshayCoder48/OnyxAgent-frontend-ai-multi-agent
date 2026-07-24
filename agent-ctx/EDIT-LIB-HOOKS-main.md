# Task ID: EDIT-LIB-HOOKS
Agent: main (Z.ai Code orchestrator)
Task: Edit existing cloned app's lib files, hooks, and stores so they use the new backendless layer (Dexie/services/vault/agent-runtime) instead of `/api/*` proxy routes.

## Outcome
All 13 files in scope (A–L) edited and aligned to the actual foundation API signatures (which landed on disk concurrently). `tsc --noEmit --skipLibCheck` reports zero errors in `src/{lib,hooks,stores}/`.

## Files edited
1. `src/lib/api-client.ts` — backendless compat shim. `ApiError` class kept. `apiClient.get/post/put/patch/delete` reject with `ApiError(501, "…not available in backendless mode…")`.
2. `src/lib/server-api.ts` — deprecation stub (`export {}`).
3. `src/lib/authed-backend-fetch.ts` — deprecation stub (`export {}`).
4. `src/lib/file-api.ts` — `uploadFile` writes to OPFS via `writeFile` + creates row via `fileService.create`, caches blob URL. `getFileUrl` is sync (cache-backed). Added `loadFileUrl`/`loadFileUrls`/`readFileBytes` async helpers.
5. `src/lib/rag-api.ts` — Hopx-backed. Real implementations for `listCollections`/`createCollection`/`deleteCollection`/`deleteDocument`/`searchDocuments`/`listDocuments`/`ingestFile`/`downloadKBDocument` (all via `HopxClient` instantiated per-call from `settingsService.getDecryptedHopxKey(userId)`). Stubs for sync sources (501) + static `local` connector.
6. `src/lib/slash-commands-api.ts` — wraps `slashCommandService` (with method-name alignment: `toggleBuiltin` instead of `upsertBuiltinOverride`, `update(id, patch)` and `delete(id)` without userId arg).
7. `src/stores/auth-store.ts` — vault-aware. No JWT, no `accessToken`, no `persist` middleware. Added `vaultUnlocked` + `init()` + `setVaultUnlocked`. `logout()` is async. Persists last-user-id to localStorage so `init()` knows who to load.
8. `src/hooks/use-auth.ts` — `login(email, passphrase)`, `register(email, fullName, passphrase)`, `logout()`, `refreshToken()`. Removed all JWT/refresh logic. Delegates init to `useAuthStore.getState().init()`.
9. `src/hooks/use-chat.ts` (BIG) — Removed WebSocket transport. Uses `runAgentTurn({ userId, conversationId, userMessage, fileIds, provider, systemPrompt, emit, signal })`. `buildTurnOptions` loads AI provider config + decrypts API key + loads system prompt. `AbortController` for stop. `respondToApproval` / `respondToAskUser` for HITL. Same `WSEvent` switch handler as before (only the transport changed).
10. `src/hooks/use-conversations.ts` — Uses `conversationService.list/create/update/delete/getMessages` with the correct method signatures (no userId arg on `update`/`delete`/`getMessages`).
11. `src/hooks/use-slash-commands.ts` — Not directly edited. Transitively migrated via `slash-commands-api.ts`.
12. `src/hooks/use-conversation-shares.ts` — Uses `shareService.share/listForConversation/revoke/listSharedWithMe`. `sharedWithMe` always empty in backendless mode (no other users to share with) — cast to `Conversation[]` for backward compat.
13. `src/hooks/use-websocket.ts` — Deprecation no-op. Throws console error on mount. `connect`/`sendMessage` are no-ops. `isConnected` always `false`.

## Service API alignment (matches actual foundation signatures)
- `authService.login(email, passphrase)` → `User`
- `authService.register(email, fullName, passphrase)` → `{ user, requiresUnlock }`
- `authService.logout()` → `void` (clears vault + evicts Hopx clients)
- `authService.getCurrentUser(userId)` → `User | null`
- `conversationService.list(userId, { includeArchived?, limit?, skip? })` → `Conversation[]`
- `conversationService.create(userId, title?)` → `Conversation`
- `conversationService.update(id, patch)` → `void` (no userId arg)
- `conversationService.delete(id)` → `void` (no userId arg, named `delete` not `remove`)
- `conversationService.getMessages(id)` → `ConversationMessage[]` (no userId arg)
- `shareService.share(conversationId, sharedBy, { sharedWith?, permission? })` → `ConversationShare`
- `shareService.listForConversation(conversationId, ownerId)` → `ConversationShare[]`
- `shareService.revoke(shareId, ownerId)` → `void`
- `shareService.listSharedWithMe(userId)` → `ConversationShare[]` (flat, no pagination)
- `slashCommandService.list(userId)` → `UserSlashCommandRecord[]`
- `slashCommandService.createCustom(userId, input)` → `UserSlashCommandRecord`
- `slashCommandService.toggleBuiltin(userId, name, isEnabled)` → `UserSlashCommandRecord`
- `slashCommandService.update(id, patch)` → `UserSlashCommandRecord` (no userId arg)
- `slashCommandService.delete(id)` → `void` (no userId arg)
- `aiProviderService.list(userId, activeOnly?)` → `AIProviderRow[]`
- `aiProviderService.getDecryptedApiKey(id)` → `string`
- `settingsService.get(userId)` → `UserSettings`
- `settingsService.getDecryptedHopxKey(userId)` → `string | null`
- `fileService.create(userId, input)` → row (input includes `storage_path`)
- `fileService.get(id, userId)` → row | null
- `runAgentTurn(opts)` → `Promise<AgentTurnResult>` (NOT a controller)
  - opts: `{ userId, conversationId, userMessage, fileIds?, provider: { baseUrl, apiKey, model, modelType?, toolsEnabled? }, systemPrompt, temperature?, thinkingEffort?, emit, signal? }`
- `respondToApproval(toolCallId, decision)` — dispatches window event for HITL
- `respondToAskUser(answers)` — dispatches window event for ask_user
- `makeBlobURL(path)` → `Promise<string>` (takes a single OPFS path string)
- `writeFile(userId, subPath, filename, data)` → `Promise<string>` (returns the OPFS path)
- `getHopxClient(apiKey)` → `HopxClient` instance (NOT a singleton)

## Out-of-scope items for orchestrator
- `auth-store.test.ts` calls sync `logout()` — my new `logout` is async. Test will fail if run.
- `login-form.tsx` / `register-form.tsx` still use OLD object-form `login({email, password})` / `register({email, password, full_name})`. My new signature is positional `(email, passphrase)`. Will throw at runtime.
- `auth-guard.tsx` calls `apiClient.get("/auth/me")` — should be updated to call `useAuth()` which triggers `runInit()` on mount.
- ~12 other components still import `apiClient` directly (`command-palette`, `onboarding-state`, `dashboard/*`, `auth/forgot-password-form`, `auth/reset-password-form`, `chat/file-sidebar`, several `app/[locale]/...` pages, `components/rag/sync-source-logs`). They will throw 501 errors when used. Each needs its own service-migration pass.
- `getFileUrl(fileId)` is synchronous + cache-backed. Components rendering historical attachments (`message-item.tsx`, `file-preview-panel.tsx`) need a separate pass to call `loadFileUrls(fileIds)` after `selectConversation` resolves.

## Verification
- `bunx tsc --noEmit --skipLibCheck` reports zero errors in `src/{lib,hooks,stores}/` (excluding pre-existing test-file errors about missing `vitest` types, which are unrelated to this task).
- `bun run lint` is broken (pre-existing ESLint config circular-structure error, unrelated to this task).
- Dev server (`next dev`) still running on port 3000.

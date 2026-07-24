---
Task ID: FIX-CHAT-NAV
Agent: main (Z.ai Code orchestrator)
Task: Fix broken chat navigation — switching conversations leaks the previous conversation's messages into the new one, renders the wrong chat, and/or shows stale content temporarily.

## Root cause

When the user clicks conversation B while on conversation A, the following
interleaving was possible:

1. `selectConversation(B)` calls `setCurrentConversationId(B)` — but the
   store's `setCurrentConversationId` only updated the id, leaving
   `currentMessages` pointing at A's message array.
2. React re-rendered ChatContainer on the id change. The load-effect (the
   second `useEffect` in `chat-container.tsx`) fired BEFORE the
   `getMessages(B)` fetch resolved, saw `currentMessages` still held A's
   messages, and dutifully painted them into the chat store for B.
3. When B's fetch resolved, `setCurrentMessages(B_msgs)` fired the load-effect
   again — but the effect's "messages only grew → streaming update, skip
   reload" heuristic (comparing `currentMessages.length` against a stored
   `lastLoadedMsgCountRef`) classified the [] → N transition as a "live
   update" whenever N ≥ A's count, so it short-circuited and B's messages
   never loaded. The user was left looking at A's content (or a blank chat).

A secondary issue: rapid switching A → B → A could leave the
`loadedConvIdRef` / `lastLoadedConvRef` pointing at A from the first visit,
so the load-effect skipped re-loading A on the return trip.

A tertiary issue: `fetchConversations` (URL-?id= driven selection) had no
race protection at all — a slow `getMessages` could resolve after a newer
`selectConversation` and overwrite the wrong messages.

## Fix

### 1. `src/stores/conversation-store.ts` — atomic clear on id change

- `setCurrentConversationId(id)` now clears `currentMessages` to `[]` in the
  SAME state update that changes the id (with a no-op guard when the id is
  unchanged, so subscribers don't get a spurious re-render). This is the
  keystone fix: it guarantees that between the id change and the fetch
  resolving, `currentMessages` is empty — so the chat-container load-effect
  can never paint a stale array belonging to the previous conversation.
- Added a new `selectConversation(id, opts?)` store action that atomically
  sets id + clears messages + optionally flips `isLoading` + clears `error`
  in one `set()` call. The hook layer calls this instead of three separate
  setters so the state update is truly atomic (no intermediate state where
  the id changed but messages haven't cleared).

### 2. `src/hooks/use-conversations.ts` — request-id guard + atomic select

- Added a monotonic `selectRequestIdRef`. Every `selectConversation` /
  `fetchConversations` call increments it and captures the value; after each
  `await`, if the captured id no longer matches the latest, the result is
  dropped silently. This is defense-in-depth on top of the existing
  `AbortController` guard (the controller only flips `aborted` for the
  PREVIOUS request, but IndexedDB queries can't actually be cancelled —
  both guards together cover every interleaving, including A's fetch
  resolving after B's).
- `selectConversation` now calls `useConversationStore.getState().selectConversation(id, { loading: true })`
  (the new atomic store action) instead of `setCurrentConversationId(id)` +
  `setLoading(true)` as separate calls. The atomic clear ensures
  `currentMessages` is `[]` the instant the id changes.
- `clearMessages()` (chat-store / streaming buffer) is still called
  synchronously before the `await` so the previous conversation's streamed
  content can't bleed into the new one.
- `fetchConversations` got the same treatment: abort controller + request
  id + atomic `selectConversation` store call + supersession guards on
  every `setCurrentMessages` / `setLoading` / error path. Previously it had
  no race protection at all.

### 3. `src/components/chat/chat-container.tsx` — track conv id, not msg count

- Removed `lastLoadedMsgCountRef` entirely. The "messages only grew →
  streaming update, skip reload" heuristic was the proximate cause of the
  bug: after a switch, when the new conversation's fetch resolved, the
  message array went from [] (cleared by the store) to N messages. If
  N ≥ the previous conversation's count, the heuristic classified it as a
  "streaming update" and skipped loading — leaving the previous
  conversation's messages (or an empty store) stuck in the UI.
- Replaced `lastLoadedConvRef` with `loadedConvIdRef`, which tracks ONLY
  which conversation's messages are currently in the chat store. The
  load-effect now:
  1. Returns early if no conversation is selected (and resets the ref to
     `null` so a subsequent selection of a previously-loaded conversation
     reloads).
  2. Returns early if `loadedConvIdRef.current === currentConversationId`
     (already loaded — prevents wiping in-flight streaming messages on
     re-render).
  3. Returns early if `currentMessages.length === 0` (fetch hasn't
     completed yet — wait for it rather than loading an empty array and
     marking the conversation as loaded, which would cause the next
     `setCurrentMessages` to be skipped).
  4. Otherwise: marks loaded, clears the chat store, and loads each DB
     message via `addChatMessage`.
- Added a reset of `loadedConvIdRef.current = null` in the clear-effect
  (the first `useEffect`) on every actual conversation id change. Without
  this, rapid switching A → B → A would skip loading A on the return trip
  because `loadedConvIdRef` still held "A" from the first visit.
- Added a `if (prevId === currId) return;` no-op guard at the top of the
  clear-effect so a re-render triggered by a sibling store update (where
  `currentConversationId` is unchanged) doesn't spuriously reset the ref
  or call `setPersistedConversationId`.

### 4. `src/stores/chat-store.ts` — no changes needed

`clearMessages` is already a synchronous Zustand `set()` call (with a no-op
guard when already empty to avoid spurious re-renders). The fix was about
WHEN it's called, not HOW. With the changes above, `clearMessages()` is
now called:
- Synchronously inside `selectConversation` (before the `await`) — so the
  streaming buffer is empty the instant the user clicks a conversation.
- Synchronously inside `fetchConversations` (same reason).
- Synchronously inside the clear-effect when `shouldClear` is true — a
  belt-and-suspenders second call (no-op if already empty).
- Synchronously inside the load-effect before loading DB messages — so the
  new conversation's messages replace (not append to) any residual content.

## Trace verification

### Scenario 1: A → B (normal switch)

1. State: `currentConversationId=A`, `currentMessages=[A_msgs]`,
   `loadedConvIdRef.current=A`, chat-store has A's rendered messages.
2. `selectConversation(B)`:
   - Aborts previous controller (none).
   - New controller B, `myRequestId=1`.
   - `store.selectConversation(B, {loading:true})` → atomically sets
     `currentConversationId=B`, `currentMessages=[]`, `isLoading=true`.
   - `clearMessages()` → chat-store empty.
   - `await getMessages(B)`.
3. React processes the state updates:
   - Clear-effect: `prevId=A`, `currId=B` → `shouldClear=true` →
     `clearMessages()` (no-op); `loadedConvIdRef.current=null`;
     `prevConversationIdRef.current=B`.
   - Load-effect: `loadedConvIdRef.current=null !== B` → don't skip;
     `currentMessages.length === 0` → skip (wait for fetch).
4. `getMessages(B)` resolves:
   - Guard: controller not aborted, `selectRequestIdRef.current === myRequestId` → not superseded.
   - `setCurrentMessages(B_msgs)`.
   - Load-effect: `loadedConvIdRef.current=null !== B` → don't skip;
     `currentMessages.length > 0` → load. `loadedConvIdRef.current=B`;
     `clearMessages()` + load B_msgs.
5. `finally`: `setLoading(false)` (only the latest request owns the flag).
6. ✓ B's messages are in the chat store. A's are gone.

### Scenario 2: A → B → A (rapid, before B's fetch resolves)

1. State: on A, `loadedConvIdRef.current=A`.
2. `selectConversation(B)`: controller B, `myRequestId=1`, atomic select,
   `clearMessages()`, `loadedConvIdRef.current=null` (via clear-effect),
   `await getMessages(B)`.
3. `selectConversation(A)` (before B resolves): aborts B's controller,
   controller A, `myRequestId=2`, atomic select, `clearMessages()`,
   `loadedConvIdRef.current=null` (already null), `await getMessages(A)`.
4. B's fetch resolves: guard sees B's controller aborted → drops result.
   ✓ B's messages never set.
5. A's fetch resolves: guard passes (`myRequestId=2 === selectRequestIdRef.current`).
   `setCurrentMessages(A_msgs)`. Load-effect: `loadedConvIdRef.current=null !== A` →
   load. `loadedConvIdRef.current=A`. ✓ A's messages loaded.

### Scenario 3: null → X (new chat being saved mid-turn)

1. State: `currentConversationId=null`, chat-store has
   `[user_msg, assistant_msg_streaming]`, `loadedConvIdRef.current=null`.
2. Runtime emits `conversation_created` → `setCurrentConversationId(X)` →
   atomically `currentConversationId=X`, `currentMessages=[]` (already empty).
3. Clear-effect: `prevId=null`, `currId=X` → `shouldClear=false` → no clear
   (preserves streaming messages). `loadedConvIdRef.current=null` (reset).
   `prevConversationIdRef.current=X`.
4. Load-effect: `loadedConvIdRef.current=null !== X` → don't skip;
   `currentMessages.length === 0` → skip.
5. ✓ chat-store preserves `[user_msg, assistant_msg_streaming]`.

### Scenario 4: page reload on ?id=X

1. Initial mount: `currentConversationId=null`, `currentMessages=[]`,
   `loadedConvIdRef.current=undefined`.
2. Sidebar's `useEffect` calls `fetchConversations()`.
3. `fetchConversations` sees `?id=X`, `currentConversationId !== X` → enters branch.
   - Controller, `myRequestId=1`, `store.selectConversation(X, {loading:true})`
     → `currentConversationId=X`, `currentMessages=[]`.
   - `clearMessages()`, `await getMessages(X)`.
4. Clear-effect (initial mount): `prevId=undefined` → skip, set `prevId=X`,
   `reconcilePersisted(X)`.
5. Load-effect (initial mount): `loadedConvIdRef.current=undefined !== X` →
   don't skip; `currentMessages.length === 0` → skip.
6. `getMessages(X)` resolves: `setCurrentMessages(X_msgs)`.
7. Load-effect: `loadedConvIdRef.current=undefined !== X` → don't skip;
   `currentMessages.length > 0` → load. `loadedConvIdRef.current=X`.
   ✓ X's messages loaded.

## Files edited

- `src/stores/conversation-store.ts` — atomic `setCurrentConversationId` clear;
  new `selectConversation(id, opts?)` store action.
- `src/hooks/use-conversations.ts` — `selectRequestIdRef` guard;
  `selectConversation` + `fetchConversations` rewritten to use the atomic
  store action + request-id supersession checks.
- `src/components/chat/chat-container.tsx` — removed `lastLoadedMsgCountRef`;
  replaced `lastLoadedConvRef` with `loadedConvIdRef`; clear-effect resets
  `loadedConvIdRef.current = null` on every actual id change; load-effect
  skips when already loaded OR when `currentMessages` is empty (fetch
  pending).

## Verification

- `bunx tsc --noEmit --skipLibCheck` — ZERO errors in any of the 3 edited
  files. All remaining `tsc` errors are pre-existing (`examples/`,
  `skills/`, `section-*.tsx` legacy components — none touched).
- `bun run lint` — still broken in the repo itself (circular-structure
  error in the flat-config plugin — pre-existing, unrelated, documented in
  the REAL-HOPX-SDK worklog entry).
- Dev server (`tail dev.log`): `GET /chat 200` after the edits; no new
  compile errors or runtime exceptions.

## Notes for downstream

- The reload-mid-generation restore feature (where `reconcilePersisted`
  keeps the in-flight assistant message so a refresh mid-stream restores
  it) has a pre-existing conflict with the load-effect: on re-mount, the
  load-effect fires and calls `clearMessages()` + loads DB messages,
  wiping the restored streamed messages. This is NOT a regression from
  this fix (the original code had the same conflict) but is worth noting
  for a future iteration. A proper fix would set
  `loadedConvIdRef.current = currId` on initial mount when
  `reconcilePersisted` kept the streamed messages, so the load-effect
  skips the first time.
- The `selectConversation` store action's no-op guard
  (`if (state.currentConversationId === id && opts?.loading === undefined)
  return state;`) ensures that calling `selectConversation` with the same
  id and no opts is a no-op (avoids spurious re-renders). When `loading`
  is explicitly passed, the guard is bypassed so the loading flag can flip
  even on a same-id call (this shouldn't happen in practice but is safe).
- The `selectRequestIdRef` is shared between `selectConversation` and
  `fetchConversations` so a rapid `selectConversation(B)` can supersede an
  in-flight `fetchConversations`-driven fetch (and vice versa). This is
  intentional — both paths compete for the same store slot.

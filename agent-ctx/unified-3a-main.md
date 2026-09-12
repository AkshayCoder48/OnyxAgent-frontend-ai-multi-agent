# unified-3a — Scheduled-tasks BROWSER side (chat-link registry, mirror sync, server-message merge, UI)

Task ID: unified-3a
Agent: general-purpose subagent (Z.ai Code)
Full work log: /home/z/my-project/worklog.md → "Task ID: unified-3a" section.

## Files CREATED
- `src/lib/scheduler/chat-context.ts` — shared browser-side chat-context assembly (systemPrompt + title + ChatTurnMessage[]) used by BOTH the AI tool and the TaskFormDialog; DEFAULT_CHAT_TASK_INSTRUCTIONS.
- `src/lib/scheduler/chat-sync.ts` — link registry (`onyx-chat-links` localStorage), mirrorChatToServer (sync_chat, 30s throttle + force), pullServerMessages (pull_chat → dedupe by id → Dexie + live global store when viewed & not executing; markers `onyx-chat-smsg:<chatId>`).
- `src/components/chat/server-chat-sync.tsx` — invisible component in the dashboard layout: 45s pull loop, mirror on view-change (2s settle) + on linked-execution finish (hub registry watch, forced).

## Files MODIFIED
- `src/lib/scheduler/client.ts` — syncChat/pullChat wrappers + ServerChatMessageView/PullChatUpdateView types (key resolved at call time, never stored).
- `src/lib/services/index.ts` — conversationService.ensureConversation + appendServerMessages (bulkPut with preserved server ids + tool_calls rows + conversation bookkeeping) + ServerMessageRowInput.
- `src/lib/tools/scheduled_tasks.ts` — now imports the shared chat-context; create registers addLinkedChat; update re-registers links (list-capture of the old chatId, removal only when no other task holds it).
- `src/components/scheduled/task-form-dialog.tsx` — "Run in chat" Select (default = most recent conversation on create; preselect on edit), instructions optional with a chat, submit includes chatId + chatContext, link register/unregister, forced mirror after update.
- `src/components/scheduled/task-card.tsx` — statusOf exported; header row links to `/chat?id=<chatId>` (keyboard-accessible) + "💬 title" chip (fallback t("linkedChat")).
- `src/components/scheduled/scheduled-tasks-view.tsx` — batch conversation titles → card chips; tasks prop → dialog.
- `src/components/chat/conversation-sidebar.tsx` — Scheduled Tasks section (header row → /scheduled-tasks + up to 4 task rows + "N more →"), ONE shared 30s poller, collapsed-rail emerald pulse dot; sits above RunningExecutionsSection.
- `src/app/[locale]/(dashboard)/layout.tsx` — mounts ServerChatSync.
- `messages/en.json` + `messages/pl.json` — scheduled.linkedChat + scheduled.moreTasks.

## Verification
- `npx tsc --noEmit` → 0 errors. `bunx eslint` on all changed files → exit 0; conversation-sidebar has 6 warnings byte-identical to the HEAD baseline (pre-existing).
- curl `/scheduled-tasks` → 200, `/chat` → 200; dev.log clean (no compile errors). agent-browser: scheduled-tasks management view renders; screenshot in screenshots/unified-3a-scheduled-tasks.png.
- 16/16 bun smoke assertions on the mapping functions (throwaway, deleted).

## Known issue (NOT this task's files)
/chat sidebar crashes in `<RunningExecutionsSection>` (unified-1's file: `useRunningExecutions` selector returns a fresh array per getSnapshot → React 19 store loop, "getServerSnapshot should be cached"). Proven pre-existing by disabling ServerChatSync. Fixing that selector unblocks visual QA of the sidebar task rows.

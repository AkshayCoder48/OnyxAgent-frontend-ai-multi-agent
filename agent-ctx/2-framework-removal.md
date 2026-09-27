# Task 2 — framework-removal (subagent-framework-removal)

Task: Remove ALL AI framework selection from the app — Onyx AI Framework only.

## Files changed (6)

1. `src/hooks/use-chat.ts`
   - Deleted `DEFAULT_SYSTEM_PROMPT` (only referenced by the presets map) and the entire `FRAMEWORK_PROMPTS` map (default / onyx_ai / pydantic_ai / langchain / crewai / openai_assistants).
   - Added single constant `ONYX_AI_SYSTEM_PROMPT` = the exact former `onyx_ai` preset text, with a comment noting it is THE framework prompt (Onyx AI — the only framework).
   - `buildTurnOptions`: base prompt is now ALWAYS `ONYX_AI_SYSTEM_PROMPT` unless the user's custom system-prompt override is enabled — no `settings.ai_framework` lookup, no fallback chain.

2. `src/lib/scheduler/chat-context.ts`
   - Mirrored the same change: deleted `DEFAULT_SYSTEM_PROMPT` + `FRAMEWORK_PROMPTS`, added `ONYX_AI_SYSTEM_PROMPT`.
   - `resolveChatSystemPrompt` now ignores any stored `ai_framework` value and resolves user-override → Onyx AI prompt → + web-research directive (same as live chat).

3. `src/app/[locale]/(dashboard)/settings/config/page.tsx`
   - Removed the "AI framework" `SectionCard` block that rendered `<AIFrameworkSection />`.
   - Deleted the entire `AIFrameworkSection` component (framework radio list: Default Assistant / Onyx AI / LangChain / OpenAI Assistants / CrewAI).
   - No import cleanup needed — `AlertTriangle`, `Loader2`, `useAuth`, `toast`, `cn` all verified still used elsewhere in the file.

4. `src/components/chat/chat-empty-state.tsx`
   - Removed the `frameworkLabel` state + the effect fetching `settingsService.getAIFramework(...)`.
   - Footer now renders static `<span>Powered by Onyx AI Framework</span>` (markup/classes otherwise identical).
   - Dropped now-unused imports: `useEffect, useState` (react) and `settingsService`.

5. `src/lib/services/index.ts`
   - `getAIFramework` / `setAIFramework` KEPT but marked `@deprecated` ("Framework selection removed — the app always uses Onyx AI. Kept only so legacy stored values normalize to onyx_ai."). `getAIFramework` always returns `"onyx_ai"`; `setAIFramework` is a no-op that resolves. Legacy `pydantic_ai` → `onyx_ai` normalization note preserved in comments.
   - `UserSettings.ai_framework` field marked `@deprecated`; `get()` now returns the constant `"onyx_ai"` (legacy stored values normalize to it).
   - After the UI removals, grep confirmed NO remaining callers of get/setAIFramework outside services itself.

6. `src/types/models.ts`
   - `UserSettings.ai_framework` doc comment updated to `@deprecated` (app always uses Onyx AI; legacy values normalize to "onyx_ai").

## Framework references found but intentionally LEFT (not selection logic)

- `src/components/genui/ComparisonTable.tsx` — generic data-driven GenUI table; "Framework"/"LangGraph" appear only in comments explaining accepted data shapes. No preset list.
- `src/lib/agent/onyx-md.ts` (lines ~426-428, ~604-632) — documentation EXAMPLES of the generic `comparison_table` GenUI block (sample data like LangGraph/CrewAI/ADK columns). Not framework selection.
- `src/lib/agent/runtime.ts:5` — descriptive comment ("now superseded by Onyx AI, OnyxAgent's native agent framework"). `runtime.ts:1922` — "language- or framework-specific role" (web-dev specialist roles, unrelated).
- `src/lib/tools/workspace_analysis.ts:101` — "Detect project type, languages, frameworks" (analyzing the USER's code projects, unrelated).
- `src/lib/mcp/client.ts:20` — descriptive "LangChain-style servers" comment.
- `messages/en.json` / `pl.json` `"stat_frameworks"` — unused i18n key (no usage in src/), not user-visible; left untouched.
- Onboarding components + `dev/components/page.tsx` — verified: no framework selection UI present.

## Verification

- `bun run lint`: 0 errors, 32 warnings — ALL pre-existing in untouched files; zero warnings in changed files.
- `bunx tsc --noEmit`: clean (no output).
- Dev server 3100 (was down; restarted): `GET /` → 307, `GET /chat` → 200, `GET /settings/config` → 200, no compile errors in `dev-3100.log`.
- Untouched (per instructions): worked-panel, message-item, tool-call-card, chat-input, thinking-reasoning, streaming text files.
- Not committed (main agent handles commits).

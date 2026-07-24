# Task: REMOVE-API-ROUTES
## Agent: API-Routes-Remover (Z.ai Code)

### Task
Remove all 69 backend-proxy API routes (proxies to a deleted FastAPI backend) and replace with a single stateless CORS streaming proxy route for AI provider calls.

### Work Log

#### Step 1 — Deleted entire `src/app/api/` directory
Ran `rm -rf /home/z/my-project/src/app/api` (per task spec). Confirmed 69 proxy route.ts files were removed. Listed every file before deletion for the audit trail (see "Files Deleted" below).

#### Step 2 — Created `/home/z/my-project/src/app/api/chat-proxy/route.ts`
A stateless streaming CORS proxy for OpenAI-compatible AI providers. Fixes the "failed to fetch" CORS errors when the browser calls AI providers directly.

Design constraints honored:
- `export const runtime = "nodejs"`
- `export const dynamic = "force-dynamic"`
- `export const maxDuration = 300` (5 min for streaming)
- NO database, NO auth, NO logging of request bodies
- User's API key passed through from client (encrypted at rest on client side)
- Stateless — every request self-contained

Implementation details:
- **POST handler**:
  - Reads `x-target-url` header
  - Validates URL with `new URL()` + protocol check (must be `http:` or `https:`)
  - Reads request body as text (never inspected/logged)
  - Builds forward headers: `content-type: application/json` (forced), `authorization` (passed through), and any `x-oai-*` / `anthropic-*` headers
  - Sets `accept: text/event-stream,application/json;q=0.9` if not already set
  - `fetch(targetUrl, { method: "POST", headers, body, duplex: "half" })` (with `@ts-expect-error` for `duplex` since it's undici-only, not in DOM lib)
  - On `!ok || !upstream.body`: returns upstream status with upstream `content-type`, no-store cache, plus passthrough of `x-ratelimit-*`, `x-model`, `x-provider` headers (so clients can back off)
  - On success: streams `upstream.body` directly with no TransformStream/buffering/transformation; headers include `content-type` (from upstream, default `text/event-stream`), `cache-control: no-cache`, `connection: keep-alive`, `access-control-allow-origin: *`, plus passthrough rate-limit/model metadata headers
- **OPTIONS handler**: returns 204 with CORS headers (`access-control-allow-origin: *`, `access-control-allow-methods: POST, OPTIONS`, `access-control-allow-headers: Content-Type, Authorization, x-target-url, x-oai-*, anthropic-*`, `access-control-max-age: 86400`)
- **Error handling**:
  - `AbortError` → 499 JSON
  - Network errors (fetch throws) → 502 JSON with error message
  - Body read errors → 400 JSON
  - Invalid `x-target-url` → 400 JSON
- Uses `NextResponse` from `next/server` for JSON errors; native `Response` for streaming success (so we can pass the upstream `ReadableStream` directly as the body)
- TypeScript-verified with `bunx tsc --noEmit` — clean compile, no errors

#### Step 3 — Skipped `/api/auth/route.ts` (per task instructions)
Read `src/middleware.ts` to check if it references any API routes.

Findings:
- `src/middleware.ts` is `next-intl` middleware only — handles locale routing (`localePrefix: "as-needed"`, `localeDetection: false`)
- The matcher **explicitly EXCLUDES** `/api` from i18n processing: `"/((?!api|_next|_vercel|static|icon$|apple-icon$|opengraph-image$|twitter-image$|manifest|robots$|sitemap$|.*\\..*).*)" `
- Middleware does NOT call any API routes, does NOT validate auth state, does NOT reference `/api/auth/me` or similar
- Therefore: no auth callback route is needed. The task spec says "If it does [reference API routes], you may need to edit middleware" — it doesn't, so we skipped this step.
- Another agent (per task spec) handles middleware; we left `src/middleware.ts` untouched.

### Files Deleted (69 proxy route.ts files)

```
src/app/api/agent-settings/env-vars/[name]/route.ts
src/app/api/agent-settings/env-vars/route.ts
src/app/api/agent-settings/route.ts
src/app/api/agent-settings/sandbox-keys/route.ts
src/app/api/agent-settings/system-prompt/route.ts
src/app/api/ai-providers/[provider_id]/route.ts
src/app/api/ai-providers/[provider_id]/test/route.ts
src/app/api/ai-providers/route.ts
src/app/api/auth/login/route.ts
src/app/api/auth/logout/route.ts
src/app/api/auth/magic-link/request/route.ts
src/app/api/auth/magic-link/verify/route.ts
src/app/api/auth/me/route.ts
src/app/api/auth/oauth-callback/route.ts
src/app/api/auth/password-reset/confirm/route.ts
src/app/api/auth/password-reset/request/route.ts
src/app/api/auth/refresh/route.ts
src/app/api/auth/register/route.ts
src/app/api/conversations/[id]/messages/[messageId]/rate/route.ts   (dir literal: "essageId]")
src/app/api/conversations/[id]/messages/route.ts
src/app/api/conversations/[id]/route.ts
src/app/api/conversations/[id]/shares/[shareId]/route.ts
src/app/api/conversations/[id]/shares/route.ts
src/app/api/conversations/export/route.ts
src/app/api/conversations/route.ts
src/app/api/conversations/shared-with-me/route.ts
src/app/api/conversations/tool-stats/route.ts
src/app/api/custom-tools/[tool_id]/route.ts
src/app/api/custom-tools/catalog/route.ts
src/app/api/custom-tools/route.ts
src/app/api/files/[id]/route.ts
src/app/api/files/upload/route.ts
src/app/api/health/route.ts
src/app/api/mcp-servers/[server_id]/route.ts
src/app/api/mcp-servers/route.ts
src/app/api/me/slash-commands/[id]/route.ts
src/app/api/me/slash-commands/builtin/route.ts
src/app/api/me/slash-commands/custom/route.ts
src/app/api/me/slash-commands/route.ts
src/app/api/skills/[skill_name]/route.ts
src/app/api/skills/catalog/route.ts
src/app/api/skills/install/[skill_name]/route.ts
src/app/api/skills/installed/route.ts
src/app/api/skills/upload/route.ts
src/app/api/users/avatar/[userId]/route.ts
src/app/api/users/me/avatar/route.ts
src/app/api/users/me/route.ts
src/app/api/v1/agent/models/route.ts
src/app/api/v1/rag/collections/[name]/documents/[documentId]/route.ts
src/app/api/v1/rag/collections/[name]/documents/route.ts
src/app/api/v1/rag/collections/[name]/info/route.ts
src/app/api/v1/rag/collections/[name]/ingest/route.ts
src/app/api/v1/rag/collections/[name]/route.ts
src/app/api/v1/rag/collections/route.ts
src/app/api/v1/rag/documents/[docId]/download/route.ts
src/app/api/v1/rag/documents/[docId]/route.ts
src/app/api/v1/rag/documents/route.ts
src/app/api/v1/rag/search/route.ts
src/app/api/v1/rag/supported-formats/route.ts
src/app/api/v1/rag/sync/[syncId]/route.ts
src/app/api/v1/rag/sync/connectors/route.ts
src/app/api/v1/rag/sync/local/route.ts
src/app/api/v1/rag/sync/sources/[sourceId]/route.ts
src/app/api/v1/rag/sync/sources/[sourceId]/trigger/route.ts
src/app/api/v1/rag/sync/sources/route.ts
src/app/api/workspace/files/download-folder/route.ts
src/app/api/workspace/files/download/route.ts
src/app/api/workspace/files/route.ts
src/app/api/workspace/stats/route.ts
```

**Total deleted: 69 route files** (matching the task spec).

### Files Created (1)

```
src/app/api/chat-proxy/route.ts   (stateless CORS streaming proxy, ~210 lines)
```

### Files Untouched
- `src/middleware.ts` — does NOT reference any API routes (only `next-intl` locale handling); per task spec, another agent handles middleware changes.
- All files outside `src/app/api/` — per task constraints.

### Stage Summary
- All 69 FastAPI proxy routes removed.
- Single replacement: `/api/chat-proxy` — stateless, no DB, no auth, streams AI provider responses, fixes CORS.
- Client API key passes through from request body / `authorization` header (encrypted at rest on client).
- TypeScript compiles cleanly (`bunx tsc --noEmit` — no errors).
- ESLint config has a pre-existing circular-structure issue (not caused by this task; same error before/after).
- Did NOT create `/api/auth/route.ts` — `src/middleware.ts` does not reference any API routes (explicitly excludes `/api` from its matcher), so no auth callback route is needed.
- `src/middleware.ts` left untouched (per task constraints).

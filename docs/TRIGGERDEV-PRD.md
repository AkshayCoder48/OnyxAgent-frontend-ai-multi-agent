# Trigger.dev v4 Integration — PRD Implementation Map

Status: **implemented** (this document maps every PRD requirement to the code that
satisfies it). The app dispatches background work DIRECTLY to the operator's own
Trigger.dev Cloud project (BYO cloud key + BYOK model keys), executes it on a
deployed durable worker (`trigger-worker/`), and syncs progress back through run
metadata — no callbacks to the app except the durable-cron tick.

## Architecture (PRD §2)

```
Frontend (Next.js client)                Your Backend (Next.js API routes)
  useBackgroundTasks() ──POST /api/tasks/trigger──▶ TaskRun (SQLite, token hashed)
        ▲                                            │ dispatchCloudRun()
        │ poll /api/tasks/status (2-4s)              ▼
  TanStack Query ◀── run metadata + output ── api.trigger.dev/api/v1/tasks/agent-run/trigger
                                                            │
                                                    Trigger.dev Cloud (durable)
                                                    agent-run task (maxDuration 1h)
                                                            │ E2B SDK (BYOK key)
                                                            ▼
                                                    E2B sandbox (up to 2h window)
                                                    headless agent runner
```

## §3.1 BYOK Management — ✅ implemented (pre-existing, hardened)

- Secure storage: provider keys are AES-GCM sealed in the browser vault
  (`src/lib/crypto/vault.ts`), decrypted in memory at turn-build time; the
  Trigger.dev cloud key is AES-256-GCM sealed server-side in
  `TaskCloudConfig.encryptedKey` (`src/lib/tasks/trigger-cloud.ts`).
- Context payload pass-through: `dispatchCloudRun()` decrypts the triggering
  client's key pool and passes it IN THE RUN PAYLOAD (`credentials.keyPool`) —
  never worker env vars.
- Key volatility: the worker image carries NO user keys; every run injects them
  dynamically (`CloudAgentRunPayload.credentials`).
- **BYOK policy (user directive 2026-10-31): "I want users to use their own
  credentials not mine."** Every background `agent_run` calls the LLM through
  the user's own pinned gateway (`config.chatUrl`) with the user's key pool —
  enforced in ONE place, `src/lib/tasks/run-credentials.ts` (unit-tested), and
  mirrored by a worker-side gate in `agent-run.ts`. The app's keyless LLM
  bridge (`/api/tasks/llm` → z-ai-web-dev-sdk, the operator's credentials)
  was **removed**; the task token is never an LLM bearer. Runs without user
  credentials fail fast with an actionable "add your provider" message.

## §3.2 Durable Normal Chat Agent — ✅ implemented

- Task offloading: every background prompt is a durable cloud task
  (`trigger-worker/src/tasks/agent-run.ts`, `agent_run` type chat handoffs via
  `dispatchDetachedCloudTurn` / pagehide beacons).
- Resilience: **exponential backoff with full jitter** on every upstream LLM
  failure (401/429/5xx/drop) with key-pool rotation — `backoffDelayMs()` in
  agent-run.ts (the `retry.fetch()` discipline). Sandbox creation retries ×3
  with the same backoff. Task-level retries: ×2.
- Persistence: progress chunks stream into run metadata and are drained by the
  status sync into `TaskRun.chunks`/`TaskArtifact` rows incrementally — history
  survives even if the frontend never reconnects.

## §3.3 Autonomous Agentic Workflows + HITL — ✅ implemented

- Execution loops: the E2B sandbox agent runner executes Plan → Execute →
  Self-correct loops (round-tracked in metadata: `progress.round/totalRounds`).
- State checkpointing: every state transition flushes to run METADATA (atomic
  `metadata.set("onyx", …)`); Trigger.dev v4 resumes the exact execution after
  worker restarts/redeploys, and the waitpoint suspension below is durable by
  construction.
- **Human-in-the-Loop (needsApproval)**: `maybeSuspendForApproval()` in
  agent-run.ts mints a **Trigger.dev waitpoint token** (`wait.createToken`,
  7-day ceiling), publishes it through run metadata (`onyx.approval`), and
  SUSPENDS the run (`wait.forToken`) — parked on the cloud with no worker slot
  and no timeout. The app's status sync mirrors `approval` into
  `TaskRun.progress`, the UI renders the **PAUSED banner with Approve / Deny**
  (`src/components/chat/background-tasks-strip.tsx`), and
  `POST /api/tasks/approval` delivers the decision via
  `POST /api/v1/waitpoints/tokens/:id/complete` → the run resumes (approve) or
  settles as `cancelled` (deny). Gating triggers:
  - `config.requireApproval: true` — settable via the `background_task` tool's
    `require_approval` arg (any task type);
  - destructive terminal commands auto-gate (`DESTRUCTIVE_PATTERN` — rm -rf,
    drop table, git push --force, curl|sh, npm publish, shutdown…).

## §3.4 Scheduled & Recurring Tasks — ✅ implemented

- **Durable crons per user profile**: every `TaskSchedule` row is mirrored as
  an IMPERATIVE Trigger.dev schedule (`POST /api/v1/schedules`,
  `deduplicationKey: onyx-sched-<rowId>`, the row's cron + timezone) on
  create/update/delete in `src/app/api/tasks/schedules/**`. The cloud fires the
  deployed `scheduled-sweep` task (`trigger-worker/src/tasks/scheduled-sweep.ts`)
  at exactly the user's cron times — independent of any browser/server warmth.
- The sweep task ticks the app (`POST /api/tasks/schedules/tick`, bearer =
  sealed worker token in `TaskCloudConfig.encryptedWorkerToken`), which claims
  + dispatches due rows with FRESH BYOK credentials (the app is the credential
  broker — keys are never frozen into schedule payloads): the schedule row
  pins the user's own gateway (`config.chatUrl`) and carries the provider key
  AES-256-GCM sealed (`TaskSchedule.encryptedApiKey`), unsealed ONLY into the
  in-memory keyring at fire time. agent_run schedules without a pinned
  gateway are rejected at creation — scheduled work never runs on the app's
  own model (the keyless bridge was removed).
- Timeout freedom: scheduled runs execute on the cloud like any other run —
  up to `TASK_MAX_DURATION_MS` (2h), no HTTP boundary.
- Fallbacks (unchanged): in-process 60s sweep loop + throttled sweep-on-read.

## §3.5 Realtime Reconnection & UI Sync — ✅ implemented (pull-based realtime)

- Live progress: chunk ring updates land in ≤4s through the status poll
  (`useBackgroundTasks` — 4s while live) — text/tool_call/tool_result chunks
  render streaming-style in the run detail view.
- Hydration on re-entry: reload adoption is fully implemented — localStorage
  handoff pointers (`onyx-turn-cloud-handoff:<convId>`) + `taskId` resolution
  reconstruct the in-flight bubble on return; the background-task lander
  auto-lands finished runs into their conversation.
- Deviation note: `@trigger.dev/react` live WebSocket hooks are intentionally
  NOT used — the app is multi-operator BYO-cloud-key (each user connects their
  own project), which conflicts with a single project-scoped realtime client.
  The pull protocol provides the same UX at 2-4s latency; upgrading to
  `@trigger.dev/react` is a roadmap item for single-operator deployments.

## §4 Non-Functional Requirements — ✅ implemented

| Requirement | Implementation |
|---|---|
| Concurrency controls | `agent-run` task runs in queue `agent-runs` with `concurrency: { perKey: 2 }`; the app passes `concurrencyKey: userId` on every trigger — one user can never exhaust the operator's allocation. |
| Data privacy | BYOK keys travel encrypted at rest (vault + server seal), decrypted only in memory for the dispatch payload; the worker image carries no secrets; logs mask every `tr_…` key; task tokens are stored as sha256 only. |
| Timeout limits | `TASK_MAX_DURATION_MS` raised 30min → 2h; agent-run `maxDuration` 35min → 1h; E2B sandbox window follows the run window (tier-capped accounts fall back to 30min). |
| Observability | Trigger.dev Cloud's native OpenTelemetry tracing + run metadata (`onyx` blob) expose every phase, tool call, and failure; the dashboard links are surfaced in Settings → Cloud (`cloudDashboardBase`). |

## §5.1 Front-End Task State Mapping — ✅ implemented

| Cloud state | UI (`background-tasks-strip.tsx`) |
|---|---|
| QUEUED | Amber pill + "Agent is waiting for cloud allocation…" |
| EXECUTING | Pulse dot + live stage/round narration + streaming chunk view |
| **PAUSED (HITL)** | **High-priority amber banner: "Approval required — execution is paused in the cloud" + Approve/Deny action buttons** |
| COMPLETED | "sync to chat" action + artifact downloads |
| FAILED / CANCELLED | Red pill + error excerpt; denial shows "Denied by human approval." |

## Key env vars

| Var | Purpose |
|---|---|
| `APP_URL` | Public origin — the durable-cron tick target + worker-deploy default (passed to the worker deploy automatically). NOT an LLM endpoint: the keyless bridge fallback was removed with the BYOK policy (user directive 2026-10-31). |
| `TRIGGER_CLOUD_KEY` | Optional operator key (Settings → Cloud connect is the primary path). |
| `E2B_TEMPLATE_ID` | The browser-ready sandbox template (see `scripts/build-browser-sandbox-template.sh`). |
| `TASKS_CLOUD_MASTER_KEY` | AES master key for the server-side seal (defaults to a generated machine key). |

## Files of interest

- Worker: `trigger-worker/src/tasks/agent-run.ts` (HITL gate, backoff, queue),
  `trigger-worker/src/tasks/scheduled-sweep.ts` (durable cron),
  `trigger-worker/src/e2b-driver.ts` (2h sandbox window + retry).
- App: `src/lib/tasks/trigger-cloud.ts` (waitpoint/schedule/concurrencyKey/
  worker-token REST), `src/app/api/tasks/approval/route.ts` (HITL decision),
  `src/app/api/tasks/schedules/tick/route.ts` (cloud cron heartbeat),
  `src/components/chat/background-tasks-strip.tsx` (PAUSED banner).
- Removed with this migration: the legacy E2B-detached lane, OnyxBase-KV
  scheduler, local driver, pull-worker protocol, and self-host v3 stack files
  (~4,000 lines of dead code).

# Background Task Execution Framework

Implementation of the Background Task Execution Framework PRD for OnyxAgent —
multi-step long-running tasks, cron scheduling, and asynchronous agent worker
loops inside E2B sandboxes, orchestrated by one of three execution modes:
the app's built-in **local orchestrator** (zero-config default),
**Trigger.dev Cloud** (connect an api.trigger.dev key in Settings → Cloud
Tasks — no self-hosting), or a **self-hosted Trigger.dev v3 worker**
(durable execution you operate), all without abandoning the client-first,
backendless principle.

## Topology (PRD §2.2)

```
┌────────────────────────────────────────────────────────────────────────┐
│                          BROWSER CLIENT (UI)                           │
│  [React Views] <---> [Zustand/TanStack Query] <---> [Dexie v7 / OPFS]  │
└───────────────────────────┬────────────────────────────────────────────┘
                            │  POST /api/tasks/trigger (serialized state
                            │  + task token + key pool — FR-1.1/1.2/1.3)
                            v
            [Next.js API routes /api/tasks/*  (SQLite via Prisma)]
                            │
            ┌───────────────┴────────────────────────┐
            │ local orchestrator (default)           │ Trigger.dev worker
            │ in-process driver + 60s scheduler      │ (deploy/trigger-dev +
            │                                        │  trigger-worker/, pull-
            │                                        │  based claim/report)
            └───────────────┬────────────────────────┘
                            │ E2B SDK (fresh task sandbox, ≤30 min — §4.2)
                            v
            ┌────────────────────────────────────────┐
            │ E2B SANDBOX                            │
            │  · .onyxagent_files.json manifest      │
            │  · headless runner v2 (tool loop,      │
            │    key-pool rotation on 429)           │
            │  · long terminal commands              │
            └───────────────┬────────────────────────┘
                            │ report: progress chunks + artifacts
                            v
            task_artifacts (SQLite) ──▶ browser polls /api/tasks/status
                              (chunked blocks, FR-3.2) ──▶ Dexie/OPFS
                              sync-back with conflict check (§4.1)
```

## Three orchestration modes

Resolved in priority order (see `src/lib/tasks/orchestration-mode.ts`):
self-hosted env config wins over a connected cloud key; otherwise a cloud
key wins; otherwise local.

| | Local (default) | Trigger.dev Cloud | Self-hosted Trigger.dev |
|---|---|---|---|
| Config | none — works out of the box | Settings → **Cloud Tasks**: paste a `tr_trigger_…`/`tr_pat_…` key (verified live, stored AES-256-GCM; `TRIGGER_CLOUD_KEY` env also works) | `TRIGGER_DEV_URL` + `TRIGGER_DEV_TOKEN` (+ `WORKER_TOKEN`) on the app; worker deployed per `deploy/trigger-dev/` |
| Driver | in-process (`src/lib/tasks/local-driver.ts`), claims via atomic Prisma lock; sweep-on-read re-adopts stale locks | `trigger-worker/src/tasks/agent-run.ts` deployed to cloud — plus the app **kicks** it directly per run via `POST api.trigger.dev/api/v1/runs` (`src/lib/tasks/trigger-cloud.ts`) | same worker, deployed on your own Trigger.dev v3 |
| Dispatch | `startLocalRun` in-process | instant cloud kick on trigger + `poll-claims` cron backstop | `poll-claims` cron (≤1 min latency) |
| Schedules | app's 60s loop fires due `TaskSchedule` rows | worker's `sweep-schedules` cron fires them (app loop only arms) | same |
| Durability | sandbox runner survives everything (nohup + file protocol); serverless process death is recovered on next status poll | same sandbox persistence + cloud retry/replay + **cloud self-heal** (stale rows settled from cloud run state on status polls) | same sandbox persistence + Trigger.dev retry/replay |
| Extras | — | minted `WORKER_TOKEN` shown in the setup checklist; cloud cancel propagation; `TaskRun.externalRunId` → dashboard links; per-run `cloudRunId` on `/api/tasks/status` | — |
| Best for | dev / single-instance hobby deploys | production without operating anything | production / air-gapped / custom |

Mode switches are config-only — no code changes. The app never pushes to a
self-hosted worker; workers **pull** claims
(`POST /api/tasks/worker {action:"claim"}`). In CLOUD mode the app
additionally **pushes the kick** through the trigger.dev REST API (the only
push path, and it targets trigger.dev's own cloud — not your infra).

## Key flows

- **Trigger (FR-1.1/1.2/1.3)** — the client serializes the conversation slice
  (last 30 text-only messages) + the OPFS workspace manifest (bounded: 200
  files / 6 MB / 8 MB payload), mints a task token (sha256-hashed server-side),
  and builds a rotational key pool from the user's providers
  (`onyx:key-rotation` round-robin). `POST /api/tasks/trigger` persists the
  run (no secrets on disk — keys go to the in-memory keyring only, §4.2) and
  dispatches.
- **Execute (FR-2.2 / FR-4.1)** — the driver creates a dedicated E2B sandbox
  (≤30 min), mounts the files, writes + verifies `.onyxagent_files.json`,
  and launches the stdlib-Python headless runner (v2 — supports the key pool,
  rotates on 429/401) or the terminal command wrapper.
- **Monitor (FR-3.1/3.2)** — the runner persists `agent_status.json` +
  `chat_history.json` every round; the driver translates new entries into
  chunked polling blocks (`round`/`text`/`tool_call`/`tool_result`) that the
  client's TanStack Query hooks render progressively.
- **Finalize (FR-2.3 / FR-4.2)** — new/changed sandbox files (vs the mount
  manifest) + the final message are registered as artifacts; the client
  syncs them back to Dexie/OPFS **only when no newer local changes exist**
  (state-conflict prevention, §4.1) — otherwise they stay as pending
  attachment payloads for manual extraction.
- **Schedules (FR-2.1)** — the Settings → Schedules pane maps user input to
  5-field cron (+`@` shorthands) with live validation and next-run preview
  (`src/lib/tasks/protocol.ts` — `validateCron`/`nextCronRun`, timezone-aware
  via two-pass Intl offset resolution).

## Surfaces

| Layer | Files |
|---|---|
| Contract | `src/lib/tasks/protocol.ts` (isomorphic) |
| Server lib | `src/lib/tasks/{prisma,run-store,keyring,cron-scheduler,manifest,runner-config,local-driver,llm-bridge,orchestration-mode,trigger-cloud}.ts` |
| API routes | `src/app/api/tasks/{trigger,status,cancel,sync,llm,schedules,schedules/[id],artifact/[id],worker,cloud}/route.ts` |
| Client lib | `src/lib/tasks/{client,serialize,key-pool}.ts` + `src/hooks/use-background-tasks.ts` (Dexie v7 mirror: `background_tasks`) |
| UI | `src/components/settings/section-schedules.tsx` (pane), `src/components/settings/section-trigger-cloud.tsx` (Cloud Tasks pane), `src/components/chat/background-tasks-strip.tsx` (live strip) |
| Tools | `src/lib/tools/background_task.ts` (create/status/list/cancel), `run_terminal` `background:true` (FR-3.3) |
| Worker | `trigger-worker/` (pull-based durable driver; deployable to cloud or self-hosted) |
| Deploy | `deploy/trigger-dev/` (self-hosted Trigger.dev v3 compose) |

## Environment variables

| Var | Side | Purpose |
|---|---|---|
| `TRIGGER_DEV_URL` + `TRIGGER_DEV_TOKEN` | app | both set → self-hosted worker mode (local firing disabled; takes priority over a cloud key) |
| `TRIGGER_CLOUD_KEY` | app | trigger.dev Cloud key — activates cloud mode without the UI (Settings → Cloud Tasks stores the same thing, encrypted) |
| `TRIGGER_CLOUD_TASK_SLUG` | app | task id the app kicks in cloud mode (default `agent-run`) |
| `TRIGGER_CLOUD_API_URL` | app | api.trigger.dev override (enterprise clouds) |
| `TASKS_CLOUD_MASTER_KEY` | app | AES-256-GCM master key for the sealed cloud config (hex 64 / base64 32B; default: generated `db/cloud-config.key`) |
| `WORKER_TOKEN` | app + worker | shared secret for claim/report/sweep — or minted automatically when a cloud key is connected |
| `APP_URL` | app + worker | app origin (cloud kicks + scheduled-run bridge URL) |
| `E2B_API_KEY` | app + worker | sandbox creation (app side also accepts the client vault key / `USE_SERVER_ENV`) |
| `TASK_LLM_URL` / `TASK_LLM_TOKEN` / `TASK_KEY_POOL` | worker | LLM bridge + provider pool for sandbox runners |

The app's **keyless LLM bridge** (`POST /api/tasks/llm`, z-ai-web-dev-sdk
server-side) means background tasks work with zero provider keys by default —
the runner's `chat_url` points at the bridge and the task token is the
bearer credential.

## PRD traceability

| Requirement | Implementation |
|---|---|
| FR-1.1 state serialization | `src/lib/tasks/serialize.ts` → `TaskPayload` (conversation slice + OPFS manifest, budget-capped) |
| FR-1.2 verified trigger endpoint | `POST /api/tasks/trigger` — task-token auth (client-minted, sha256-stored), vault-side key handling, atomic run creation |
| FR-1.3 key rotation | `src/lib/tasks/key-pool.ts` (round-robin index) + runner v2 `api_key_pool` (429/401 rotation) + `TASK_KEY_POOL` (worker) |
| FR-2.1 schedules UI pane | Settings overlay → Schedules (`section-schedules.tsx`) → `TaskSchedule` rows (Prisma) |
| FR-2.2 sandbox init + headless pipeline | `local-driver.ts` phases / `agent-run` task phases → `agent_start`-style launch (runner v2) |
| FR-2.3 artifact write-back | `TaskArtifact` rows → client extraction (`syncRunToConversation`, OPFS + Dexie) or pending attachment payloads |
| FR-3.1 status polling router | `GET /api/tasks/status?runId&cursor` + `useBackgroundTask(s)` hooks (TanStack Query, adaptive 3–4s/15s) |
| FR-3.2 streaming fallback | chunked polling blocks (`TaskStatusChunk` round/text/tool_call/tool_result) mapped to chat-store-style parts |
| FR-3.3 un-throttled run_terminal | `run_terminal {background:true}` → `terminal_command` task (≤30 min sandbox lifecycle) |
| FR-4.1 manifest snapshot | `.onyxagent_files.json` written + verified (`manifest.ts`, `mountReport`) |
| FR-4.2 workspace sync-back | artifact diff vs manifest at finalize → client OPFS/Dexie sync at phase closure |
| §4.1 atomic resumption | local: phase checkpoints + stale-lock adoption (sweep-on-read); worker: `step.run()` replay + claim staleness fence |
| §4.1 state-conflict prevention | `clientSyncState` (pending/synced/conflicted) + client-side `created_at > started_at` check before any write-back |
| §4.2 sandbox lifecycles | hard `TASK_MAX_DURATION_MS` 30-min window + deadline kill + stall guard |
| §4.2 credential sandboxing | keys only in the in-memory keyring + sandbox `run.json` (chmod 600); Prisma stores hashes; nothing in logs |

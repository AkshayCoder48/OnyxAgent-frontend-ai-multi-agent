# Background Task Execution Framework

Multi-step long-running tasks, cron scheduling, and asynchronous agent loops
inside E2B sandboxes — executed **directly on your Trigger.dev Cloud project**.

There is exactly one execution mode: **cloud** — no alternative orchestration
modes exist. Without a connected cloud key the app has no background
execution; the trigger route answers with actionable guidance instead.

## How it works

1. **Connect** a trigger.dev Cloud key in **Settings → Cloud**. The app
   verifies it live (`GET /api/v1/whoami`), stores it AES-256-GCM encrypted,
   and resolves your cloud project. `TRIGGER_CLOUD_KEY` (env) activates the
   same mode headlessly.
2. **Deploy** — the app deploys `trigger-worker/` (the `agent-run` +
   `health` tasks) to your cloud project automatically when needed;
   serverless deployments simply ride the persistent cloud deployment.
3. **Dispatch** — every run is triggered directly:
   `POST api.trigger.dev/api/v1/tasks/agent-run/trigger` with the full
   payload (run spec + per-run E2B key + resolved LLM credentials), clamped
   to a REST-safe size. No queue, no callbacks into the app.
4. **Monitor** — progress streams back via run metadata (an `onyx` blob with
   a chunk ring); the app syncs it into its `TaskRun` rows and the browser
   polls `/api/tasks/status`. Terminal results settle from the run output
   into `TaskArtifact` rows, then sync back to Dexie/OPFS with conflict
   checks.
5. **Schedules** — fire from the app's own scheduler (`cron-scheduler.ts`);
   each due `TaskSchedule` row dispatches like any other run.

## Surfaces

| Layer | Files |
|---|---|
| Contract | `src/lib/tasks/protocol.ts` (isomorphic; `CloudRunMetadata` / `CloudRunOutput` / `CloudAgentRunPayload`) |
| Server lib | `src/lib/tasks/{prisma,run-store,keyring,cron-scheduler,manifest,runner-config,llm-bridge,orchestration-mode,trigger-cloud,cloud-config-store}.ts` |
| API routes | `src/app/api/tasks/{trigger,status,cancel,sync,llm,schedules,schedules/[id],artifact/[id],cloud}/route.ts` |
| Client lib | `src/lib/tasks/{client,serialize,key-pool}.ts` + `src/hooks/use-background-tasks.ts` (Dexie v7 mirror) |
| UI | `src/components/settings/section-schedules.tsx`, `src/components/settings/section-trigger-cloud.tsx`, `src/components/chat/background-tasks-strip.tsx` |
| Tools | `src/lib/tools/background_task.ts` (create/status/list/cancel), `run_terminal` `background:true` |
| Worker | `trigger-worker/` — see its README |

## Environment variables

| Var | Purpose |
|---|---|
| `TRIGGER_CLOUD_KEY` | optional headless activation — the same key the UI stores encrypted |
| `TRIGGER_CLOUD_TASK_SLUG` | task id the app triggers (default `agent-run`) |
| `TRIGGER_CLOUD_API_URL` | api.trigger.dev override (enterprise clouds) |
| `TASKS_CLOUD_MASTER_KEY` | AES-256-GCM master key for the sealed cloud config (default: generated `db/cloud-config.key`) |
| `APP_URL` | public app origin — the keyless LLM-bridge fallback URL for sandbox runners |
| `E2B_API_KEY` | sandbox creation when the client vault has no key (a per-run key may ride in the run payload) |

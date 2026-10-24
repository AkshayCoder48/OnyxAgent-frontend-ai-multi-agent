# OnyxAgent Trigger.dev Worker

The **durable execution driver** for OnyxAgent's Background Task Execution
Framework (PRD). Deployed against a self-hosted Trigger.dev v3 instance
(see `../deploy/trigger-dev/`) or trigger.dev Cloud, it claims queued
background-task runs from the app and executes them inside E2B sandboxes —
every phase wrapped in `step.run()` for atomic resumption (PRD §4.1).

## Architecture (pull-based)

```
Browser (Dexie/OPFS) ── POST /api/tasks/trigger ──▶ app (SQLite TaskRun)
                                                         │ queued
        ┌── poll-claims (cron * * * * *) ◀────────────────┘
        │           claim via POST /api/tasks/worker {action:"claim"}
        ▼
   agent-run (this worker, step.run phases)
        │ E2B SDK
        ▼
   E2B sandbox (≤30 min) ── headless runner v2 / terminal command
        │ POST /api/tasks/worker {action:"report"} — progress, chunks, artifacts
        ▼
   app task_artifacts ──▶ browser polls /api/tasks/status → Dexie/OPFS sync-back
```

The app **never calls the worker** — workers pull. This keeps the app
client-first and avoids any push-API coupling: swap the entire orchestration
layer without touching the app.

## Tasks

| Task id | Cadence | Purpose |
|---|---|---|
| `poll-claims` | cron `* * * * *` | Claim up to 3 queued runs; dispatch each to `agent-run` |
| `sweep-schedules` | cron `* * * * *` | Ask the app to fire due `TaskSchedule` rows (FR-2.1/2.2) |
| `agent-run` | per run | Durable driver: claim ack → create-sandbox → mount → verify → start → monitor → collect-artifacts → finish |

## Setup

```bash
# Node 20+ / bun
bun install
cp .env.example .env   # fill in the values
bun run deploy         # uses TRIGGER_DEPLOYMENT_URL + TRIGGER_ACCESS_TOKEN
```

Local dev against a running self-hosted instance:

```bash
bun run dev
```

## Environment

| Var | Required | Purpose |
|---|---|---|
| `TRIGGER_DEPLOYMENT_URL` | yes | Self-hosted instance origin (e.g. `https://trigger.example.com`) |
| `TRIGGER_ACCESS_TOKEN` | yes | Access token created on the instance |
| `APP_URL` | yes | The OnyxAgent app origin the worker drives |
| `WORKER_TOKEN` | yes | Shared secret — must match the app's `WORKER_TOKEN` env |
| `E2B_API_KEY` | yes | Worker creates task sandboxes directly |
| `TASK_LLM_URL` | no | OpenAI-compatible URL the sandbox runner calls (default `${APP_URL}/api/tasks/llm`) |
| `TASK_LLM_TOKEN` | no | Bearer token for the LLM URL (bridge token minted app-side) |
| `TASK_KEY_POOL` | no | Comma-separated provider keys rotated on 429/401 (FR-1.3) |

## App-side mode switch

Set these on the app to delegate execution to this worker:

```
TRIGGER_DEV_URL=https://trigger.example.com   # informational
TRIGGER_DEV_TOKEN=...                          # informational
WORKER_TOKEN=<same value as here>
```

When `TRIGGER_DEV_URL` + `TRIGGER_DEV_TOKEN` are both set the app stops
firing schedules locally (its 60s loop only ARMS `nextRunAt`) and leaves
queued runs for `poll-claims`. Unset them to fall back to the app's built-in
local orchestrator (zero-config mode).

## Troubleshooting

- **claim returns empty runs** — the app is not in Trigger.dev mode (check
  `TRIGGER_DEV_URL`/`TRIGGER_DEV_TOKEN`), or nothing is queued.
- **`503 worker mode disabled`** — the app has no `WORKER_TOKEN` env set.
- **`401` on claim** — `WORKER_TOKEN` mismatch between app and worker.
- **E2B quota errors** — the 30-min task sandbox was killed; check the E2B
  dashboard, and note runs fail gracefully with `execution window exceeded`.

## Provenance notes

- `src/protocol.ts` mirrors `src/lib/tasks/protocol.ts` (app) — keep in sync.
- `src/runner-source.ts` mirrors `HEADLESS_RUNNER_PY` from
  `src/lib/e2b/headless-agent.ts` (runner v2) — keep in sync.

# OnyxAgent Trigger.dev Worker

The **durable execution driver** for OnyxAgent's Background Task Execution
Framework (PRD). Deployed against trigger.dev **Cloud** (the zero-ops
option — see *Cloud mode* below) or a self-hosted Trigger.dev v3 instance
(see `../deploy/trigger-dev/`), it claims queued background-task runs from
the app and executes them inside E2B sandboxes — every phase wrapped in
`step.run()` for atomic resumption (PRD §4.1).

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
| `TRIGGER_DEPLOYMENT_URL` | self-hosted | Self-hosted instance origin (e.g. `https://trigger.example.com`) — omit for trigger.dev Cloud |
| `TRIGGER_ACCESS_TOKEN` | yes | Access token created on the instance (or cloud.trigger.dev for `npx trigger.dev@latest deploy`) |
| `APP_URL` | yes | The OnyxAgent app origin the worker drives (must be publicly reachable) |
| `WORKER_TOKEN` | yes | Shared secret — must match the app's `WORKER_TOKEN` env, or the token the app minted when connecting a cloud key (Settings → Cloud Tasks shows it) |
| `E2B_API_KEY` | yes | Worker creates task sandboxes directly |
| `TASK_LLM_URL` | no | OpenAI-compatible URL the sandbox runner calls (default `${APP_URL}/api/tasks/llm`) |
| `TASK_LLM_TOKEN` | no | Bearer token for the LLM URL (bridge token minted app-side) |
| `TASK_KEY_POOL` | no | Comma-separated provider keys rotated on 429/401 (FR-1.3) |

## App-side mode switch — three modes

The app resolves its orchestration mode in this priority order:

**1. Self-hosted** — set both env vars on the app:

```
TRIGGER_DEV_URL=https://trigger.example.com   # informational
TRIGGER_DEV_TOKEN=...                          # informational
WORKER_TOKEN=<same value as here>
```

**2. Trigger.dev Cloud** — no env vars needed. In the app, open
**Settings → Cloud Tasks**, paste a trigger.dev key (`tr_trigger_…`
environment key or `tr_pat_…` personal access token) and connect. The app:

- verifies the key live against `https://api.trigger.dev`, stores it
  AES-256-GCM encrypted in its database (never re-displayed),
- **mints a `WORKER_TOKEN` for you** (shown in the setup checklist with a
  copy button) when the env var is absent — set THAT value on the cloud
  project env above,
- kicks every user-triggered background run straight to the deployed
  `agent-run` task via `POST /api/v1/runs` (zero queue latency), with
  `poll-claims` as the backstop dispatcher,
- self-heals stuck runs by checking cloud run state on status polls,
  and cancels the backing cloud run when you cancel locally.

Deploy this worker to the cloud with:

```bash
cd trigger-worker
npx trigger.dev@latest deploy   # or: bun run deploy after `bun install`
```

Headless deployments can skip the UI entirely: `TRIGGER_CLOUD_KEY` (plus the
optional `TRIGGER_CLOUD_TASK_SLUG`, default `agent-run`) activates cloud mode
from the environment.

**3. Local (default)** — no configuration: the app's in-process driver owns
execution and its 60s loop fires schedules itself.

In modes 1 and 2 the app stops firing schedules locally (the loop only ARMS
`nextRunAt`; `sweep-schedules` here is the firing authority) and queued runs
are left for `poll-claims`.

## Troubleshooting

- **claim returns empty runs** — the app is not in a worker mode (env vars
  unset and no cloud key connected), or nothing is queued.
- **`503 worker mode disabled`** — the app has no `WORKER_TOKEN` env set AND
  no minted token from a cloud connection.
- **`401` on claim** — `WORKER_TOKEN` mismatch between app and worker (when
  the app minted one, copy it from Settings → Cloud Tasks).
- **`413`/payload too large on cloud kicks** — the run's serialized payload
  exceeded the trigger.dev Cloud limit; the app releases the run back to
  queued and surfaces the upstream error.
- **E2B quota errors** — the 30-min task sandbox was killed; check the E2B
  dashboard, and note runs fail gracefully with `execution window exceeded`.

## Provenance notes

- `src/protocol.ts` mirrors `src/lib/tasks/protocol.ts` (app) — keep in sync.
- `src/runner-source.ts` mirrors `HEADLESS_RUNNER_PY` from
  `src/lib/e2b/headless-agent.ts` (runner v2) — keep in sync.

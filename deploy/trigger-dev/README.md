# Self-hosted Trigger.dev v3 — bring-up guide

The orchestration tier of OnyxAgent's Background Task Execution Framework
(PRD §2.1). Docker is required on the host (this cannot run inside the
OnyxAgent sandbox — it is a deployment artifact for a small VPS / Render /
hobby instance).

## 1. Bring the stack up

```bash
cd deploy/trigger-dev
# generate real secrets first (openssl rand -base64 32) and edit the compose
docker compose up -d
docker compose logs -f trigger-web   # wait for the healthcheck to pass
```

The dashboard is now on `http://<host>:3000`.

## 2. Create the project + token

1. Open `http://<host>:3000`, create an account (magic-link login needs
   `SMTP_HOST` configured — for a private hobby instance use the seeded
   dev-login path documented in the self-hosting guide).
2. Create a project named **`onyxagent-background-tasks`** (must match
   `trigger-worker/trigger.config.ts`).
3. Generate an **access token** (Project → Settings → API keys).

## 3. Deploy the worker

```bash
cd trigger-worker
bun install
cp .env.example .env
#   TRIGGER_DEPLOYMENT_URL=http://<host>:3000
#   TRIGGER_ACCESS_TOKEN=<the token from step 2>
#   APP_URL=https://<your-onyxagent-origin>
#   WORKER_TOKEN=<long random string>
#   E2B_API_KEY=...
bun run deploy
```

## 4. Switch the app to worker mode

Set on the OnyxAgent app:

```
TRIGGER_DEV_URL=http://<host>:3000    # informational — marks triggerdev mode
TRIGGER_DEV_TOKEN=<the token>          # informational
WORKER_TOKEN=<same value as worker>    # authenticates worker claim/report/sweep
```

With both `TRIGGER_DEV_URL` and `TRIGGER_DEV_TOKEN` set, the app's local
orchestrator stops firing (runs stay `queued`) and its schedule loop only
arms `nextRunAt` — the worker's `poll-claims` + `sweep-schedules` cron tasks
become the execution authority.

## 5. Verify

- Send a background task from the app (background strip or the
  `background_task` tool): within a minute `poll-claims` claims it and the
  status poll shows live `round/stage` progress from the worker.
- Create a schedule due in the next minute: `sweep-schedules` fires it.
- The app's `GET /api/tasks/status` reflects worker-reported chunks.

## Security notes

- Never commit secrets — all values above are placeholders.
- `WORKER_TOKEN` is a shared secret between exactly two parties (app +
  worker); rotate by changing both sides together.
- Keep the instance on a private network or behind an authenticating proxy
  unless you intend public sign-ups.
- Task credentials (provider keys) live only in the app's in-memory keyring
  and the sandbox `run.json` (chmod 600, inside the user's own E2B sandbox) —
  never in Postgres, never in worker logs (PRD §4.2).

## Reference

- Self-hosting guide: https://trigger.dev/docs/self-hosting
- Docker image reference: https://trigger.dev/docs/self-hosting/reference/docker-image
- The compose file here mirrors the documented minimal topology (postgres +
  redis + web + worker); pin image digests for production.

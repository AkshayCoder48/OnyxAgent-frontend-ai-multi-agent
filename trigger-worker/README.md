# OnyxAgent Cloud Worker

The OnyxAgent worker for Trigger.dev Cloud. It is deployed **automatically by
the app**: connect your trigger.dev Cloud key in **Settings → Cloud** and the
app verifies it, resolves your project, and ships this worker for you — zero
setup, nothing to configure.

## Tasks

| Task id | Purpose |
|---|---|
| `agent-run` | Durable E2B-sandbox agent execution — chat agent runs, sub-agent chains, scheduled business tasks, terminal commands. Progress streams via run metadata; results land in the run output. |
| `health` | Liveness probe the app triggers to confirm the deployment is live. |

## Manual deploy (only needed when this worker changes)

```bash
cd trigger-worker
bun install
TRIGGER_PROJECT_REF=<project externalRef> npx trigger.dev@latest deploy --env prod --plain
```

Export `TRIGGER_ACCESS_TOKEN=<your tr_…_sk_ key>` (the same secret key you
connect in Settings → Cloud) to authenticate. The project ref in
`trigger.config.ts` defaults to `proj_hrhpqztgulssacmpehmg` and is overridable
via `TRIGGER_PROJECT_REF`.

## Local development

```bash
npx trigger.dev@latest dev
```

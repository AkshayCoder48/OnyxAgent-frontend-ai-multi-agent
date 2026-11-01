# OnyxAgent — Vercel Deploy Template

Spin up your own OnyxAgent in about five minutes. The one-click button below clones the repository into your GitHub account, creates a Vercel project wired to it, prompts you for **every documented environment variable** (all of them optional), builds, and deploys. You only fill in values where you want server-side fallbacks — the app is BYOK-first, so each user's provider keys normally live in their browser vault, not in these variables.

## One-click deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FAkshayCoder48%2FOnyxAgent-frontend-ai-multi-agent&env=E2B_API_KEY%2CE2B_TEMPLATE_ID%2CDATABASE_URL%2CAPP_URL%2CNEXT_PUBLIC_APP_URL%2CTAVILY_API_KEY%2CDDG_PROXY_BASE%2CDDG_RELAY_TOKEN%2CDDG_FORWARD_CLIENT_IP%3Dtrue%2CTRIGGER_CLOUD_KEY%2CTRIGGER_CLOUD_TASK_SLUG%2CTRIGGER_CLOUD_API_URL%2CTASKS_CLOUD_MASTER_KEY%2CTRIGGER_PROJECT_REF%2CTRIGGER_ACCESS_TOKEN&envDescription=All%20optional%20%E2%80%94%20OnyxAgent%20is%20BYOK-first%20%28add%20keys%20later%20in%20Settings%29.%20Pair%20DDG_PROXY_BASE%20with%20DDG_RELAY_TOKEN%20after%20running%20scripts%2Fddg-relay.mjs%20on%20any%20non-Vercel%20box%3B%20see%20DEPLOY.md.&envLink=https%3A%2F%2Fgithub.com%2FAkshayCoder48%2FOnyxAgent-frontend-ai-multi-agent%2Fblob%2Fmain%2FDEPLOY.md&project-name=onyxagent&repository-name=onyxagent&demo-title=OnyxAgent&demo-description=Frontend-only%20AI%20multi-agent%20chat%20%E2%80%94%2050%2B%20tools%2C%20subagent%20orchestration%2C%20streaming%2C%20sandboxed%20execution%2C%20BYOK.&demo-url=https%3A%2F%2Fonyx-agent-frontend-ai-multi-agent-wine.vercel.app&demo-image=https%3A%2F%2Fraw.githubusercontent.com%2FAkshayCoder48%2FOnyxAgent-frontend-ai-multi-agent%2Fmain%2Fscreenshots%2Factive-idx-fix-final-desktop.png)

Raw URL, if you prefer copy-paste:

```text
https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FAkshayCoder48%2FOnyxAgent-frontend-ai-multi-agent&env=E2B_API_KEY%2CE2B_TEMPLATE_ID%2CDATABASE_URL%2CAPP_URL%2CNEXT_PUBLIC_APP_URL%2CTAVILY_API_KEY%2CDDG_PROXY_BASE%2CDDG_RELAY_TOKEN%2CDDG_FORWARD_CLIENT_IP%3Dtrue%2CTRIGGER_CLOUD_KEY%2CTRIGGER_CLOUD_TASK_SLUG%2CTRIGGER_CLOUD_API_URL%2CTASKS_CLOUD_MASTER_KEY%2CTRIGGER_PROJECT_REF%2CTRIGGER_ACCESS_TOKEN&envDescription=All%20optional%20%E2%80%94%20OnyxAgent%20is%20BYOK-first%20%28add%20keys%20later%20in%20Settings%29.%20Pair%20DDG_PROXY_BASE%20with%20DDG_RELAY_TOKEN%20after%20running%20scripts%2Fddg-relay.mjs%20on%20any%20non-Vercel%20box%3B%20see%20DEPLOY.md.&envLink=https%3A%2F%2Fgithub.com%2FAkshayCoder48%2FOnyxAgent-frontend-ai-multi-agent%2Fblob%2Fmain%2FDEPLOY.md&project-name=onyxagent&repository-name=onyxagent&demo-title=OnyxAgent&demo-description=Frontend-only%20AI%20multi-agent%20chat%20%E2%80%94%2050%2B%20tools%2C%20subagent%20orchestration%2C%20streaming%2C%20sandboxed%20execution%2C%20BYOK.&demo-url=https%3A%2F%2Fonyx-agent-frontend-ai-multi-agent-wine.vercel.app&demo-image=https%3A%2F%2Fraw.githubusercontent.com%2FAkshayCoder48%2FOnyxAgent-frontend-ai-multi-agent%2Fmain%2Fscreenshots%2Factive-idx-fix-final-desktop.png
```

## Environment variables — the full preset

Every key below is created by the deploy flow (the button's `env` list carries them all). None are required: the app boots and chats with an empty set, and users attach their own model keys in **Settings** after deploying.

| Variable | Needed? | Prefilled | Purpose |
|---|---|---|---|
| `E2B_API_KEY` | optional | — | Server-side fallback sandbox key; users normally bring their own in Settings |
| `E2B_TEMPLATE_ID` | optional | — | Durable sandbox browser template id — build once with `bash scripts/build-browser-sandbox-template.sh` for ~seconds browser boots |
| `DATABASE_URL` | optional | — | SQLite URL; defaults to `file:./db/custom.db` (ephemeral on serverless — fine for the default setup) |
| `APP_URL` | recommended | — | Public origin of **your** deployment; used by the schedule tick (`/api/tasks/schedules/tick`) and the Trigger.dev worker |
| `NEXT_PUBLIC_APP_URL` | recommended | — | Canonical public origin for Pollinations OAuth redirect URIs |
| `TAVILY_API_KEY` | optional | — | Server-side fallback for the `web_fetch` tool |
| `DDG_PROXY_BASE` | optional | — | Route DuckDuckGo engine calls through your non-Vercel relay — the one mechanism that lifts the WAF block (see below) |
| `DDG_RELAY_TOKEN` | optional | — | Shared secret; must match the token your relay runs with |
| `DDG_FORWARD_CLIENT_IP` | optional | `true` | Forward each visitor's public IP on DDG calls (`X-Forwarded-For` / `X-Real-IP` / `Forwarded`); set `false` for privacy-sensitive deployments |
| `TRIGGER_CLOUD_KEY` | optional | — | Trigger.dev Cloud key for background agent runs |
| `TRIGGER_CLOUD_TASK_SLUG` | optional | — | Task slug; code defaults to `agent-run` |
| `TRIGGER_CLOUD_API_URL` | optional | — | Trigger.dev API origin; code defaults to `https://api.trigger.dev` |
| `TASKS_CLOUD_MASTER_KEY` | optional | — | AES master key sealing the cloud key + worker token at rest (auto-generated in `db/cloud-config.key` when unset) |
| `TRIGGER_PROJECT_REF` | optional | — | Auto worker deploy (Settings → Cloud → Deploy fills this itself) |
| `TRIGGER_ACCESS_TOKEN` | optional | — | Auto worker deploy token (same flow) |

## After the first deploy

1. In Vercel → your project → **Settings → Environment Variables**, set `APP_URL` and `NEXT_PUBLIC_APP_URL` to your final URL (for example `https://onyxagent-xxxx.vercel.app`) and redeploy once. These two make background task ticks and the Pollinations OAuth callback point at the right origin.
2. Open `/chat`, open **Settings**, and add the provider keys you personally use (OpenAI-compatible, Anthropic, Gemini, Pollinations, ...). They stay in the browser vault — nothing is required on the server.
3. Optional: set `E2B_API_KEY` (Settings → Sandboxes also accepts a per-user key) if you want the sandbox code-execution tools without BYOK.

## Search egress — why `provider` may say `miklium`, and how to make it say `ddg`

DuckDuckGo's anti-bot WAF blocks **Vercel's entire egress range** — not just one region. Verified live on 2026-11-01 with the identical in-house handshake (browser-grade headers, fresh `vqd` token):

| Function region | DDG answer |
|---|---|
| `iad1` (default) | blocked — WAF anomaly page |
| `sin1` | blocked |
| `hkg1` | blocked |
| `fra1` | blocked |
| plain non-Vercel cloud VM | 90+ results, HTTP 200 |

No region choice, npm package, or header trick escapes it: the block is on the egress IP itself. When DDG is blocked, the rescue engine (Miklium) answers so image/video search keeps working, and the `provider` field honestly reports who served the rows.

To get genuine `provider: ddg` results, run the one-file relay on any always-on machine that is not Vercel (a home box, a Tailscale exit node, or a cheap VPS — live-verified: a plain cloud-VM IP passes; the block targets Vercel's hammered ranges):

```bash
# on the relay box (Node 18+, zero dependencies)
PORT=8787 DDG_RELAY_TOKEN=<random-string> node scripts/ddg-relay.mjs
```

Then in Vercel → Settings → Environment Variables:

```text
DDG_PROXY_BASE  = http(s)://<relay-host>:8787
DDG_RELAY_TOKEN = <same random-string>
```

Redeploy, and every DDG call (token page, `i.js`, `v.js`) leaves from your relay's IP. The relay only proxies those three allowlisted paths — it is not an open proxy — and passes upstream statuses through untouched so the app's soft-block detection keeps working. Result thumbnails still load directly in each visitor's browser. Full details: header of `scripts/ddg-relay.mjs` and the search-egress section of `.env.example`.

## Function region

`vercel.json` pins functions to `sin1` (Singapore — the lowest-latency Vercel region for the maintainer). Change the `regions` array to your preference and redeploy; pick the region closest to your users.

## Verify your deployment

```bash
curl "https://<your-app>.vercel.app/api/ddg-search?q=test&type=image&limit=3"
```

- `"provider": "ddg"` — DuckDuckGo answered from your egress (or through your relay)
- `"provider": "miklium"` — DDG is blocked for that egress; the rescue engine served real results anyway
- a `"note"` saying engines are busy — every engine hard-failed; retry shortly

## Manual alternative (Vercel CLI)

```bash
git clone https://github.com/AkshayCoder48/OnyxAgent-frontend-ai-multi-agent
cd OnyxAgent-frontend-ai-multi-agent
bun install            # or npm install
cp .env.example .env   # fill any optional values
npx vercel             # link, then: npx vercel --prod
```

The same environment-variable table applies; the dashboard's Settings → Environment Variables is the equivalent of the button's prompt.

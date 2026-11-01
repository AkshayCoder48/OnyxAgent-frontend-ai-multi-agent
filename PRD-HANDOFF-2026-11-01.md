# PRD — Browser Tool Stability + Full Handoff
**Date:** 2026-11-01 · **Branch:** `main` · **Status:** code shipped, one E2E rerun pending

> **New chat? Read this file top to bottom, then run §6. Never commit or print any value from §7.**

---

## 1. Mission

The `use_browser` tool (CloakBrowser inside E2B) hung with an infinitely
growing timer (2 min → 5 min → 15 min) and died with
`browser_error — Page.goto: Target page, context or browser has been closed`
on real navigations. This PRD records the full root-cause analysis, the fix
that shipped, the live evidence, how to verify, and every credential slot
needed to resume work in a fresh chat.

## 2. Root causes (all confirmed in code + reproduced live)

| # | Cause | Where | Effect |
|---|-------|-------|--------|
| 1 | **Double-driver race**: the client's reconnect path re-ran boot while a live driver still owned the sandbox; boot.sh's pid-file guard was keyed on an already-exited pid; the 2nd driver's orphan-reaper (`pgrep -f user-data-dir=…` + SIGKILL) killed the 1st driver's Chromium **mid-goto** | `browser-session.ts` `sendBrowserCommand` → `ensureBrowserDriver`; `browser-driver.ts` `_clear_stale_profile_locks` | The exact `Page.goto: Target page, context or browser has been closed` error |
| 2 | **15-min in-loop install**: `playwright install --with-deps chromium` (timeout=900 s) ran INSIDE a command handler while the client clock ticked | old `boot_browser()` | The 2→5→15 min escalation |
| 3 | **No per-command watchdog**: sync Playwright is thread-affine; a stuck call blocked the loop forever; the only deadline was the client giving up (and its blind reboot then caused #1) | driver `main()` | Infinite pending |
| 4 | **pgrep liveness**: a wedged-but-alive driver looked healthy; a CPU-starved-but-fine one looked dead — both fed the double-boot | `driverAlive()` | Spurious redeploys |
| 5 | **Missing system libs on the default template**: uid 1000, no apt layer → `libnspr4.so: cannot open shared object file` for BOTH engines; nothing installed them outside the forbidden in-loop install | default E2B template | Cold start impossible on lean templates |

## 3. What shipped (this branch)

**`src/lib/e2b/browser-driver.ts`** (v `2026.11.01` — auto-redeploys stale drivers)
- **Single-instance `flock`** on `.driver.lock`: exactly one driver per sandbox, ever; a second instance exits instantly.
- **Per-command watchdog** (`_command_watchdog`): action-aware deadline (75 s normal / 420 s heavy, both env-tunable). A stuck sync call is unblocked by killing the **browser process** (never the driver); the loop replies a structured `timeout` error and the next command reboots the browser. **Every command settles.**
- **One in-driver self-heal retry**: a mid-action `Target closed` family error resets + reboots on the persistent profile and replays the action once — seconds, no client round-trip, no second driver.
- **No in-loop installs** — the 15-min stall is gone; a missing binary is an honest `BootFailure`.
- **Heartbeat** (`.heartbeat`, 1 s) replaces pgrep as the liveness signal.
- Nav ceiling env-configurable (`ONYX_NAV_TIMEOUT_MS`, default 30 s).

**`src/lib/e2b/browser-session.ts`**
- **Cooperative single-owner swap** (`stopDriverAndBrowser`): kill driver → wait for exit → reap Chromium → clear markers → THEN boot.
- **Heartbeat liveness** (`driverAlive`): fresh stamp + process + `.ready`.
- **Grace window on the ORIGINAL command id** when the driver is alive: re-reads its result file instead of re-sending (no double navigation/submit).
- boot.sh: **real flock**, never boots over a live driver, **lib probe** (`ldd | grep "not found"`), and root/sudo/non-root ladders that install the Chromium lib set (`libnspr4 libnss3 libatk… ` — debian 12 names) inside the detached, narrated boot window.
- All ceilings env-configurable: `ONYX_BROWSER_FIRST_ACTION_MS` (360 s), `ONYX_BROWSER_BOOT_FAST_MS` (120 s), `ONYX_BROWSER_BOOT_COLD_MS` (600 s), `ONYX_BROWSER_ACTION_MS` (90 s), `ONYX_BROWSER_HEAVY_MS` (480 s), `ONYX_BROWSER_GRACE_MS` (30 s).

**`src/lib/tools/use_browser.ts`** — single source of truth for the operation-aware ceiling (`browserActionTimeoutMs`).

**`src/lib/tool-display-names.ts` + `tool-call-card.tsx`** — plain UI display names (UI-only; execution names untouched): umbrella/management names → curated phrases, and **any unknown name — a user-created custom tool — renders humanized** (`weather_fetch` → "Weather Fetch"). No more raw `custom_tools`/`manage_custom_tool` in the card header.

**Tests** — `browser-driver.test.ts`: 15 structural pins incl. the new no-infinite-pending suite (flock ordering, watchdog target, no in-loop install argv, one-retry bound, heartbeat wiring, env ceilings).

## 4. Live E2E evidence (real E2B sandbox, user's key)

| Probe | Result |
|-------|--------|
| Cold boot (fresh sandbox, no browser runtime) | pip ladder + 120 MiB binaries + sudo lib install + preboot → **READY**, fully narrated in boot.log (~6 min first time, one-time) |
| Warm boot (runtime cached) | **READY in ~30 s** (was 6–10 silent min) |
| Pre-fix failure reproduced | navigate failed **fast + honestly** (1.6 s, `browser_startup_failed: libnspr4.so`) instead of hanging 15 min — then boot.sh's lib ladder fixed it on the next boot |
| Watchdog / double-boot / nav-speed probes | scripted and ready — **run §6 to finish the evidence table** (the final navigate-speed run was cut off by a session timeout, not by the product) |

## 5. Architecture (unchanged contract)

```
use_browser (single AI-facing tool, 24 actions)
  → BrowserSessionManager (client)  cmd.json → res-<id>.json file protocol
    → boot.sh (detached: pip ladder, binaries, system libs, flock, preboot)
      → driver.py in-sandbox: CloakBrowser launch_persistent_context(humanize=True)
        persistent profile, live cast, watchdog, single-instance flock
```
Optional speed-up: build `e2b-template/` (`e2b template build -c e2b-template/Dockerfile -n onyx-cloakbrowser`) and set `E2B_TEMPLATE_ID` → every sandbox starts browser-ready (seconds).

## 6. How to verify (new chat)

```bash
npm install
npx vitest run src/lib/e2b/browser-driver.test.ts   # 15 structural pins

# Live probes (E2B_API_KEY comes from §7 — env var only, never inline in code):
E2B_API_KEY=<from your settings> node scripts/e2b-browser-e2e.mjs boot          # cold/warm boot + sandbox id
E2B_API_KEY=<…> node scripts/e2b-browser-e2e.mjs fast <sandboxId>               # navigate × 2 + read — must settle in seconds
E2B_API_KEY=<…> node scripts/e2b-browser-e2e.mjs stuck <sandboxId>              # while(true){} → watchdog settles ≤ ~75 s, driver survives, next navigate self-heals
E2B_API_KEY=<…> node scripts/e2b-browser-e2e.mjs double <sandboxId>             # second driver exits instantly (flock), browser unaffected
E2B_API_KEY=<…> node scripts/e2b-browser-e2e.mjs log <sandboxId>                # driver.log tail
```
Acceptance: every probe settles ≤ ~2 min; no `Target page, context or browser has been closed`; driver count always 1.

## 7. Credentials map — **names only, values NEVER go in files or chat logs**

| Credential | Purpose | Where the new chat gets it | Rules |
|------------|---------|---------------------------|-------|
| `E2B_API_KEY` | Sandbox + browser tool (all `e2b-*` scripts, `/api/sandbox`) | User pastes it in chat for testing, or it lives in the app: Settings → Config → E2B Sandbox; local dev: repo-root `.env` (gitignored ✅) | **Never commit, never echo in full, never hardcode.** The key shared in chat on 2026-11-01 was test-only — rotate it in the E2B dashboard if it ever lands in any log |
| Kilo anonymous gateway | Test LLM provider — **no key** | `https://ai-gateway.kilo.ai/api/v1`, model `kilo-auto/free` or any `:free` id; OpenAI-compatible; 200 req/h per IP | Requests route through `ai-gateway.kilo.ai` (expected; the real provider stays hidden behind the gateway) |
| App LLM keys (BYOK providers) | Chat/agent LLM | Encrypted in the app DB (`settingsService.getDecryptedEnvVars`) — nothing to store in the repo | Never export to files |
| `DATABASE_URL` (Prisma) | App DB | `.env` (gitignored ✅) | Never commit |
| `E2B_TEMPLATE_ID` | Optional custom template name (not secret) | Set only after building `e2b-template/` | Plain string |
| `CLOAKBROWSER_LICENSE_KEY` | Optional CloakBrowser Pro (free tier needs none) | Sandbox env var | Never commit |

**Iron rule for every future session:** credentials are referenced by env-var
name in code, docs and commits. A key seen in chat is already half-public —
treat it as ephemeral and rotate.

## 8. Remaining roadmap (priority order)

1. **Finish the E2E evidence table** (§6 `fast` / `stuck` / `double`) — the harness run was interrupted once; the product code is already pushed.
2. **Kilo LLM end-to-end**: run a mini agent loop against the anonymous gateway (`kilo-auto/free`) that calls `use_browser` navigate/read through the session manager — proves the model→tool→sandbox chain with a free LLM.
3. **Build the `onyx-cloakbrowser` template** and set `E2B_TEMPLATE_ID` → cold boot drops from ~6 min to seconds.
4. **Streaming auto-scroll fix** (queued user ask): the fox-app chat sticks to the bottom during streaming — follow only when the user is already at the bottom (`components/chat` message list scroll logic).
5. Monitor first real-world `use_browser` sessions for any new `browser_error` shapes; the watchdog/self-heal telemetry lands in `driver.log`.

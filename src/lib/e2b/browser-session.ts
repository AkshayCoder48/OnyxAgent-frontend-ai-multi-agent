"use client";

/**
 * Browser session manager (client side) — boots the sandbox-side browser
 * driver (CloakBrowser, humanize=True, persistent profile) over the
 * existing E2B infrastructure and shuttles commands to it through the
 * file protocol:
 *
 *   write /home/user/.onyx/browser/driver.py   (the Python driver source)
 *   write /home/user/.onyx/browser/boot.sh     (installer + launcher)
 *   nohup bash boot.sh &                       (DETACHED: pip install + daemon)
 *   poll .boot-failed / .ready with short commands until up
 *   cmd.json → res-<id>.json round-trip per action
 *
 * WHY THE BOOT IS DETACHED: the pip install of the runtime needs minutes,
 * but the /api/sandbox route runs as a serverless function (Netlify) that
 * is hard-killed after seconds. A blocking install through exec_stream
 * dies mid-flight, the SSE stream closes WITHOUT a result event, and the
 * failure surfaced as a confusing "browser_startup_failed — Failed to
 * install the browser runtime in the sandbox" with no detail. The
 * sandbox VM itself keeps running for hours regardless of any HTTP
 * request — so boot.sh runs there under nohup (the same proven pattern
 * the driver daemon uses) and the client only POLLS with short-lived
 * commands until the boot reports ready or failed.
 *
 * RECONNECTION (PRD §28): a dead driver (crash / sandbox hiccup) is
 * detected on command timeout — the manager re-boots it (the persistent
 * profile under ~/.onyx/browser/profile keeps cookies + localStorage, so
 * the restored session survives where possible) and replays the action
 * ONCE before reporting failure.
 *
 * The AI-facing surface stays the single `use_browser` tool; this module
 * is the BrowserSessionManager + BrowserActionExecutor plumbing.
 */

import { BROWSER_DRIVER_PY_SOURCE, BROWSER_DRIVER_VERSION } from "./browser-driver";

// ---------------------------------------------------------------------------
// Paths (must match browser-driver.ts).
// ---------------------------------------------------------------------------

const BR_DIR = "/home/user/.onyx/browser";
const DRIVER_PATH = `${BR_DIR}/driver.py`;
const READY_PATH = `${BR_DIR}/.ready`;
const VERSION_PATH = `${BR_DIR}/.version`;
const CMD_PATH = `${BR_DIR}/cmd.json`;
const HEARTBEAT_PATH = `${BR_DIR}/.heartbeat`;
const PROFILE_DIR = `${BR_DIR}/profile`;
// driver.log (the daemon's own log) is written by boot.sh's redirect — no
// client-side reference needed anymore.
const BOOT_SH_PATH = `${BR_DIR}/boot.sh`;
const BOOT_LOG_PATH = `${BR_DIR}/boot.log`;
const INSTALL_LOG_PATH = `${BR_DIR}/boot-install.log`;
const BOOT_FAIL_PATH = `${BR_DIR}/.boot-failed`;

/** Build-time configurable ceilings (PRD §9 — every wait in this file is
 * tunable). Next.js inlines these process.env reads at build time for the
 * client bundle; self-hosters set them in the build/deploy environment. */
function envInt(name: string, dflt: number): number {
  const v = typeof process !== "undefined" ? process.env?.[name] : undefined;
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/** First action ceiling — with the boot-time PREBOOT (see BOOT_SH_SOURCE)
 *  the browser is already up when the driver reports READY, so this is a
 *  safety net, not the expected path. */
const FIRST_BOOT_TIMEOUT_MS = envInt("ONYX_BROWSER_FIRST_ACTION_MS", 6 * 60_000);
/** Detached-boot polling ceiling when the runtime must be installed first
 *  (cold pip install + ~200 MB binary pre-fetch legitimately takes minutes
 *  on a slow sandbox network; each poll is a short request, the install
 *  itself runs in the sandbox). */
const BOOT_POLL_TIMEOUT_MS = envInt("ONYX_BROWSER_BOOT_COLD_MS", 10 * 60_000);
/** Polling ceiling when the runtime is ALREADY importable (the
 *  onyx-cloakbrowser template, or a warm sandbox that installed it
 *  earlier) — the driver starts in seconds and the preboot browser launch
 *  in a few more; anything past this window means the sandbox is wedged. */
const FAST_BOOT_POLL_TIMEOUT_MS = envInt("ONYX_BROWSER_BOOT_FAST_MS", 2 * 60_000);
/** Usual per-action ceiling. The DRIVER's own watchdog (CMD_DEADLINE_S,
 *  default 75s) always settles a stuck action before this expires, so a
 *  timeout here means transport trouble, not a hung page. */
const DEFAULT_ACTION_TIMEOUT_MS = envInt("ONYX_BROWSER_ACTION_MS", 90_000);
/** Heavy-operation ceiling (screenshot / download / recording assembly). */
const HEAVY_ACTION_TIMEOUT_MS = envInt("ONYX_BROWSER_HEAVY_MS", 8 * 60_000);
/** Grace window for a live driver's watchdog result to land after the
 * client-side action ceiling expires (never reboot over a live driver). */
const LIVE_DRIVER_GRACE_MS = envInt("ONYX_BROWSER_GRACE_MS", 30_000);
/** Consecutive failed polls before declaring the sandbox unreachable. A
 *  dead/paused/out-of-quota sandbox used to spin the FULL boot window with
 *  every poll silently swallowed (`.catch(() => null)`) and then time out
 *  with the diagnostic-free "No boot output was captured" — the exact
 *  browser_startup_failed the users hit after 6-10 silent minutes. */
const MAX_CONSECUTIVE_POLL_FAILURES = 6;

/** Minimal client surface this manager needs (E2BClient implements it). */
export interface BrowserSandboxClient {
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string>;
  runCommandStream(
    command: string,
    opts?: { cwd?: string; timeout?: number; envs?: Record<string, string> },
  ): AsyncIterable<{ type: string; data?: string; exit_code?: number }>;
}

export interface BrowserCommandResult {
  success?: boolean;
  action?: string;
  error?: { type: string; message: string; recoverable?: boolean };
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Sandbox exec helper (collects the stream).
// ---------------------------------------------------------------------------

async function execInSandbox(
  client: BrowserSandboxClient,
  command: string,
  timeoutSec: number,
): Promise<{ ok: boolean; output: string; error: string }> {
  let out = "";
  let err = "";
  let exit = 0;
  try {
    for await (const chunk of client.runCommandStream(command, { timeout: timeoutSec })) {
      if (chunk.type === "stdout" && chunk.data) out += chunk.data;
      else if (chunk.type === "stderr" && chunk.data) err += chunk.data;
      else if (chunk.type === "result") exit = chunk.exit_code ?? 0;
    }
  } catch (e) {
    return { ok: false, output: out, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: exit === 0, output: out, error: err };
}

// ---------------------------------------------------------------------------
// Driver boot (serialized — concurrent tool calls must not double-boot).
// ---------------------------------------------------------------------------

let bootPromise: Promise<{ ok: true } | { ok: false; error: string }> | null = null;

/** True once a first browser action has completed (binary already fetched). */
let firstActionDone = false;

export function browserFirstActionDone(): boolean {
  return firstActionDone;
}

async function driverAlive(client: BrowserSandboxClient): Promise<boolean> {
  // HEARTBEAT LIVENESS (the double-boot fix): bare pgrep reported a
  // wedged-but-alive driver as healthy while a CPU-starved-but-fine one
  // looked dead — both sent the client into the wrong branch. The driver
  // stamps .heartbeat every second; fresh stamp + live process + .ready is
  // the only combination counted as alive.
  const r = await execInSandbox(
    client,
    `hb=$(stat -c %Y ${HEARTBEAT_PATH} 2>/dev/null || echo 0); now=$(date +%s); test -f ${READY_PATH} && test $((now - hb)) -lt 60 && pgrep -f "[d]river.py" >/dev/null && echo READY || echo NO`,
    30,
  );
  return r.ok && r.output.trim() === "READY";
}

/**
 * COOPERATIVE SINGLE-OWNER SHUTDOWN (the 'Page.goto: Target page, context or
 * browser has been closed' fix): kill the driver FIRST, WAIT for it to be
 * gone, THEN reap its Chromium, THEN clear the markers — only then may a
 * new boot start. The old path launched boot.sh while a live driver still
 * owned the sandbox: boot.sh rm -f'd the LIVE driver's .ready and started a
 * second driver whose orphan-reaper SIGKILLed the first one's browser
 * mid-navigation. Between the pkill and the Chromium reap the flock inside
 * driver.py is the backstop: a second driver simply exits.
 */
async function stopDriverAndBrowser(
  client: BrowserSandboxClient,
  waitSec = 25,
): Promise<void> {
  await execInSandbox(client, `pkill -f "[d]river.py" 2>/dev/null; sleep 1; true`, 20).catch(
    () => null,
  );
  const deadline = Date.now() + waitSec * 1000;
  while (Date.now() < deadline) {
    const r = await execInSandbox(
      client,
      `pgrep -f "[d]river.py" >/dev/null 2>&1 && echo UP || echo GONE`,
      15,
    ).catch(() => null);
    if (r && r.output.trim() === "GONE") break;
    await new Promise((res) => setTimeout(res, 1000));
  }
  await execInSandbox(
    client,
    `pkill -9 -f "user-data-dir=${PROFILE_DIR}" 2>/dev/null; rm -f ${READY_PATH} ${VERSION_PATH} ${HEARTBEAT_PATH}; true`,
    20,
  ).catch(() => null);
}

/**
 * True when the RUNNING driver's version stamp matches this build's
 * BROWSER_DRIVER_PY_SOURCE. A live driver with an old/missing stamp runs
 * stale code — per-command errors never kill the daemon (the active_idx
 * UnboundLocalError kept "recoverable"-failing every action forever), so
 * the caller must kill + redeploy it instead of reusing it.
 */
async function driverUpToDate(client: BrowserSandboxClient): Promise<boolean> {
  const r = await execInSandbox(client, `cat ${VERSION_PATH} 2>/dev/null`, 15);
  return r.ok && r.output.trim() === BROWSER_DRIVER_VERSION;
}

// ---------------------------------------------------------------------------
// Detached boot script (runs INSIDE the sandbox under nohup).
// ---------------------------------------------------------------------------

/**
 * boot.sh — the sandbox-side installer + daemon launcher. Runs detached
 * (`nohup bash boot.sh > boot.log 2>&1 &`) so it survives the HTTP request
 * that spawned it and any serverless function timeout behind that request.
 *
 * Contract with the polling client (see ensureBrowserDriver):
 *   .boot-failed  — FATAL: written with the pip log tail when the runtime
 *                   could not be installed; the client surfaces it verbatim.
 *   .ready        — SUCCESS: written by driver.py when its command loop is
 *                   up (the driver itself is launched by this script).
 *   boot.log      — human-readable progress lines the client narrates live.
 *
 * Install ladder (first success wins). CRITICAL: pip and the import probe
 * MUST target the SAME interpreter — on the E2B code-interpreter template
 * a bare `pip` can install into a different Python than `python3` (the
 * kernel venv vs the system interpreter), so the install "succeeded" while
 * `python3 -c "import cloakbrowser"` failed on every ladder attempt (the
 * recurring browser_startup_failed). `python3 -m pip` is therefore the
 * PRIMARY resolver — bare pip is only a last resort. No `| tail` on the
 * pip calls — a pipe would mask pip's exit code; success is verified with
 * the import probe instead, and probe failures log the actual ImportError
 * so boot-install.log always says WHY.
 */
const BOOT_SH_SOURCE = `#!/bin/bash
# Onyx sandbox browser boot — DETACHED installer + daemon launcher.
cd "$(dirname "$0")" || exit 1

log() { echo "[boot \$(date +%H:%M:%S)] \$*"; }

# Resolve the interpreter FIRST — every pip call AND the probe use it.
PY="python3"
command -v python3 >/dev/null 2>&1 || PY="python3.12"
command -v "\$PY" >/dev/null 2>&1 || PY="python"
log "interpreter: \$PY (\$(\$PY -V 2>&1)) at \$(command -v \$PY)"

# pip MODULE of THAT interpreter (never a bare pip binary first — it can
# target a different site-packages than \$PY reads).
if ! "\$PY" -m pip --version >/dev/null 2>&1; then
  log "\$PY -m pip unavailable — falling back to pip3/pip"
  PIP="pip3"
  command -v pip3 >/dev/null 2>&1 || PIP="pip"
else
  PIP="\$PY -m pip"
fi

# One boot at a time — a REAL flock (the old pid-file guard keyed on a pid
# that had already exited when boot.sh finished, so a retried client could
# double-boot: boot.sh rm -f'd the LIVE driver's .ready and launched a
# second driver, whose orphan-reaper SIGKILLed the first driver's Chromium
# mid-navigation — the live 'Page.goto: Target page, context or browser has
# been closed' incident).
exec 9>.boot-lock
if ! flock -n 9; then
  log "another boot is already running — exiting"
  exit 0
fi
# And never boot over a LIVE driver: when driver.py is running AND
# heartbeating, this sandbox already owns a healthy browser session — touch
# nothing (the old path deleted .ready out from under it).
hb=$(stat -c %Y .heartbeat 2>/dev/null || echo 0)
now=$(date +%s)
if pgrep -f "[d]river.py" >/dev/null 2>&1 && [ \$((now - hb)) -lt 60 ]; then
  log "a live driver already owns this sandbox (heartbeat fresh) — exiting without touching it"
  exit 0
fi

log "checking the browser runtime…"
fresh_install=0
if "\$PY" -c "import cloakbrowser, playwright" >/dev/null 2>&1; then
  log "browser runtime already installed"
else
  fresh_install=1
  log "installing the browser runtime (first run — can take a few minutes)…"
  ok=0
  for flags in "" "--break-system-packages" "--user --break-system-packages" "--user"; do
    log "\$PIP install \${flags:-default}: cloakbrowser==0.6.1 playwright"
    if \$PIP install --quiet --no-input \$flags "cloakbrowser==0.6.1" playwright >> boot-install.log 2>&1; then
      log "pip exited 0 (\${flags:-default}) — verifying the import…"
      if "\$PY" -c "import cloakbrowser, playwright" >>boot-install.log 2>&1; then
        ok=1
        log "browser runtime installed and importable"
        break
      else
        log "import probe FAILED after a successful pip run — interpreter mismatch (see boot-install.log)"
      fi
    else
      log "pip run failed (\${flags:-default}) — trying the next variant"
    fi
  done
  if [ "\$ok" != "1" ]; then
    {
      echo "pip could not install cloakbrowser==0.6.1 + playwright into \$PY (\$(command -v \$PY), \$(\$PY -V 2>&1))."
      echo "---- probe error ----"
      "\$PY" -c "import cloakbrowser, playwright" 2>&1 | tail -n 8
      echo "---- last 40 lines of boot-install.log ----"
      tail -n 40 boot-install.log 2>/dev/null
    } > .boot-failed
    log "FATAL: browser runtime install failed (details in .boot-failed)"
    exit 1
  fi
fi

# BINARY + SYSTEM-LIB PRE-FETCH (browser_startup_failed fix): after a FRESH
# install the ~200 MB browser binaries are still missing — fetch them HERE
# (inside the detached, narrated boot window) instead of letting the first
# use_browser action pay the download behind its own action timeout. The
# SYSTEM LIBS get the same treatment: a lean base template ships neither
# libnspr4/libnss3/… for the stealth Chromium nor apt layer — the live
# 'cloakbrowser launch failed: libnspr4.so: cannot open shared object file'
# incident. An ldd probe re-runs the lib install whenever a cached binary
# still misses libraries (fresh sandbox on a warm volume, partial install).
# Best-effort: a failed pre-fetch degrades to the honest BootFailure.
CB_BIN=\$(ls /home/user/.cloakbrowser/chromium-*/chrome 2>/dev/null | head -n 1)
need_libs=0
if [ -n "\$CB_BIN" ] && ldd "\$CB_BIN" 2>/dev/null | grep -q "not found"; then
  need_libs=1
  log "cached stealth Chromium is missing system libraries — installing them…"
fi
if [ "\$fresh_install" = "1" ] || [ "\$need_libs" = "1" ]; then
  log "pre-fetching the browser binaries + system libraries (~200 MB — the slow part of a cold boot)…"
  # Chromium's shared-library set (both engines need it; debian 12 names).
  BROWSER_LIBS="libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libatspi2.0-0 libdbus-1-3 libexpat1 libglib2.0-0 libpango-1.0-0 libcairo2 fonts-liberation"
  if [ "\$(id -u)" = "0" ]; then
    if "\$PY" -m playwright install --with-deps chromium >> boot-install.log 2>&1; then
      log "chromium + system libraries installed (root) — the stealth Chromium will launch"
    else
      log "playwright --with-deps failed — trying the binary-only install"
      "\$PY" -m playwright install chromium >> boot-install.log 2>&1 || log "playwright chromium pre-fetch failed"
    fi
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    # USER SANDBOX with passwordless sudo (the default E2B template): install
    # the lib set through sudo — the live cold-boot failure was exactly this
    # ('libnspr4.so: cannot open shared object file', uid 1000, no root).
    log "installing browser system libraries via sudo…"
    sudo apt-get update -qq >> boot-install.log 2>&1 || true
    if sudo apt-get install -y -qq \$BROWSER_LIBS >> boot-install.log 2>&1; then
      log "browser system libraries installed (sudo) — the stealth Chromium will launch"
    else
      log "sudo lib install failed — the driver will report an honest launch error (build the onyx-cloakbrowser template)"
    fi
    "\$PY" -m playwright install chromium >> boot-install.log 2>&1 || log "playwright chromium pre-fetch failed"
  else
    # No root AND no sudo: binaries only — the driver reports the honest
    # launch error with the template hint instead of hanging.
    "\$PY" -m playwright install chromium >> boot-install.log 2>&1 || log "playwright chromium pre-fetch failed (no root/sudo — system libs unavailable)"
  fi
  if "\$PY" -m cloakbrowser install >> boot-install.log 2>&1; then
    log "stealth Chromium binary cached — the browser will launch instantly"
  else
    log "cloakbrowser binary pre-fetch failed — the driver will report an honest launch error"
  fi
  # Re-probe: report the honest end state of the lib install.
  if [ -n "\$CB_BIN" ] && ldd "\$CB_BIN" 2>/dev/null | grep -q "not found"; then
    log "WARNING: system libraries are STILL missing after the pre-fetch — see boot-install.log"
  fi
fi

# PREBOOT MARKER: driver.py boots the BROWSER (the expensive part) before
# it writes .ready, so "boot done" means "browser USABLE": the first
# action no longer hides a ~200 MB download behind its own timeout, and a
# boot failure surfaces in the boot poll instead of an action timeout.
: > .preboot

log "starting the browser driver…"
rm -f .ready
nohup "\$PY" driver.py > driver.log 2>&1 &
log "driver launched (pid \$!) — it will preboot the browser before reporting ready"
`;

/** One short-lived sandbox command that answers the whole boot state:
 *  the failure marker (+ its contents), READY, or the latest progress line
 *  (boot.sh AND the driver's preboot lines both append to boot.log). */
const BOOT_POLL_CMD = [
  `if [ -f ${BOOT_FAIL_PATH} ]; then echo "BOOT_FAILED"`,
  `sed -n '1,60p' ${BOOT_FAIL_PATH}`,
  `elif test -f ${READY_PATH} && pgrep -f "[d]river.py" >/dev/null 2>&1; then echo "READY"`,
  `else tail -n 1 ${BOOT_LOG_PATH} 2>/dev/null; true; fi`,
].join("; ");

/** Detects whether the browser runtime is already importable in the
 *  sandbox (onyx-cloakbrowser template, or a warm sandbox that installed
 *  it earlier) so the poll window matches reality: template-warm boots in
 *  seconds, cold installs legitimately need minutes. One short command;
 *  ANY probe failure assumes the slow path (safe default). */
const RUNTIME_PROBE_CMD = [
  `PY=python3; command -v python3 >/dev/null 2>&1 || PY=python3.12`,
  `command -v "\$PY" >/dev/null 2>&1 || PY=python`,
  `"\$PY" -c "import cloakbrowser, playwright" >/dev/null 2>&1 && echo RUNTIME_PRESENT || echo RUNTIME_MISSING`,
].join("; ");

/**
 * Install + boot the browser driver in the sandbox. Idempotent + cached:
 * a live driver CURRENT on version is left alone; a live STALE driver (old
 * code) is killed + redeployed so fixes actually reach running sandboxes;
 * a failed boot drops the cache so the next call retries. `onProgress`
 * receives human narration for the tool UI.
 */
export async function ensureBrowserDriver(
  client: BrowserSandboxClient,
  onProgress?: (line: string) => void,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!bootPromise) {
    bootPromise = (async () => {
      try {
        if (await driverAlive(client)) {
          if (await driverUpToDate(client)) return { ok: true };
          // Stale driver CODE is running in this sandbox. COOPERATIVE
          // SINGLE-OWNER SWAP: kill it, WAIT for the exit, reap its Chromium,
          // clear the markers — then deploy. (The old in-place pkill+sleep
          // raced the live driver: it could still be mid-goto when the new
          // boot's orphan-reaper SIGKILLed its browser.) The persistent
          // profile (cookies/localStorage) survives the swap.
          onProgress?.("Updating the sandbox browser driver…");
          await stopDriverAndBrowser(client, 25);
        } else {
          // Not alive — clear any stale stamps from a dead run so the
          // version check after boot compares against fresh state.
          await execInSandbox(client, `rm -f ${VERSION_PATH}`, 15);
        }
        onProgress?.("Preparing the sandbox browser runtime…");
        await execInSandbox(
          client,
          `mkdir -p ${BR_DIR}/shots ${BR_DIR}/profile /home/user/downloads`,
          20,
        );
        await client.writeFile(DRIVER_PATH, BROWSER_DRIVER_PY_SOURCE);
        await client.writeFile(BOOT_SH_PATH, BOOT_SH_SOURCE);
        // Clear the last boot's markers so the polls below read fresh state.
        await execInSandbox(
          client,
          `rm -f ${READY_PATH} ${BOOT_FAIL_PATH} ${BOOT_LOG_PATH}`,
          15,
        );

        // PRE-FLIGHT RUNTIME PROBE (browser_startup_failed fix): pick a
        // poll window that matches reality instead of a fixed 6 minutes for
        // everyone. A template-warm sandbox (onyx-cloakbrowser) or a sandbox
        // that already installed the runtime boots in seconds → tight
        // ceiling, wedged sandboxes fail fast. A cold install legitimately
        // needs minutes (pip ladder + ~200 MB binary pre-fetch) → honest
        // ceiling + honest narration.
        const probe = await execInSandbox(client, RUNTIME_PROBE_CMD, 30).catch(() => null);
        const runtimePresent = (probe?.output ?? "").includes("RUNTIME_PRESENT");
        const pollCeilingMs = runtimePresent ? FAST_BOOT_POLL_TIMEOUT_MS : BOOT_POLL_TIMEOUT_MS;
        onProgress?.(
          runtimePresent
            ? "Browser runtime found in the sandbox — starting the browser driver…"
            : "No browser runtime in this sandbox — installing cloakbrowser + playwright and pre-fetching the stealth Chromium binary (first run only, up to ~10 minutes)…",
        );

        // DETACHED BOOT (the fix for browser_startup_failed on serverless):
        // launch boot.sh under nohup INSIDE the sandbox — the sandbox VM
        // outlives any HTTP request, so the minutes-long pip install can
        // actually finish. The client only polls (short requests) below.
        const launched = await execInSandbox(
          client,
          `cd ${BR_DIR} && nohup bash boot.sh > ${BOOT_LOG_PATH} 2>&1 & echo booting`,
          20,
        );
        if (!launched.output.includes("booting")) {
          return {
            ok: false,
            error: `Could not launch the sandbox browser boot: ${(launched.error || launched.output).slice(-200)}`,
          };
        }

        const deadline = Date.now() + pollCeilingMs;
        let lastProgress = "";
        let consecutivePollFailures = 0;
        let lastPollError = "";
        while (Date.now() < deadline) {
          const poll = await execInSandbox(client, BOOT_POLL_CMD, 30).catch((e) => {
            lastPollError = e instanceof Error ? e.message : String(e);
            return null;
          });
          if (poll === null) {
            // SANDBOX-UNREACHABLE FAST-FAIL (the "No boot output was
            // captured" fix): a dead/paused/out-of-quota sandbox used to
            // swallow every poll for the FULL window and then time out with
            // zero diagnostic value. Consecutive failures mean the sandbox
            // itself (not the boot) is the problem — say so and stop early.
            consecutivePollFailures += 1;
            if (consecutivePollFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
              return {
                ok: false,
                error: `The sandbox stopped responding while the browser was booting (${MAX_CONSECUTIVE_POLL_FAILURES} consecutive poll failures${lastPollError ? ` — last error: ${lastPollError.slice(-200)}` : ""}). It may be paused, out of quota, or the E2B connection dropped. Retry the action; if it persists, restart the sandbox session.`,
              };
            }
            await new Promise((r) => setTimeout(r, 1500));
            continue;
          }
          consecutivePollFailures = 0;
          const out = poll.output.trim();
          if (out.startsWith("BOOT_FAILED")) {
            const detail = out.slice("BOOT_FAILED".length).trim();
            return {
              ok: false,
              error: `Failed to install the browser runtime in the sandbox: ${detail.slice(-400) || "the installer exited without detail (boot-install.log in ~/.onyx/browser has the full log)."}`,
            };
          }
          if (out === "READY") return { ok: true };
          // Narrate live progress (e.g. "[boot 12:03:11] pip install …")
          // so a cold install shows real movement instead of a spinner.
          if (out && out !== lastProgress) {
            lastProgress = out;
            onProgress?.(out);
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
        const [bootLog, installLog] = await Promise.all([
          client.readFile(BOOT_LOG_PATH).catch(() => ""),
          client.readFile(INSTALL_LOG_PATH).catch(() => ""),
        ]);
        const tail = `${bootLog ? ` Boot log: ${bootLog.slice(-300)}` : ""}${installLog ? ` Install log: ${installLog.slice(-300)}` : ""}`;
        return {
          ok: false,
          error: `The sandbox browser runtime did not finish booting within ${Math.round(pollCeilingMs / 60_000)} minutes.${tail || " No boot output was captured."} Tip: build the custom sandbox template (see e2b-template/README.md — “e2b template build -c e2b-template/Dockerfile -n onyx-cloakbrowser”) and set E2B_TEMPLATE_ID so every sandbox starts browser-ready and boots in seconds instead of installing at runtime.`,
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    })();
    const result = await bootPromise;
    if (!result.ok) bootPromise = null; // transient failure → retry next call
    return result;
  }
  return bootPromise;
}

// ---------------------------------------------------------------------------
// Command round-trip (serialized queue — one action at a time, matching
// the driver's single-threaded loop).
// ---------------------------------------------------------------------------

let queueTail: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queueTail.then(task, task);
  queueTail = run.catch(() => undefined);
  return run;
}

async function readResFile(
  client: BrowserSandboxClient,
  id: string,
  timeoutMs: number,
): Promise<BrowserCommandResult | null> {
  const resPath = `${BR_DIR}/res-${id}.json`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await client.readFile(resPath);
      if (raw && raw.trim()) {
        const parsed = JSON.parse(raw) as BrowserCommandResult;
        // Best-effort cleanup so the dir doesn't accumulate result files.
        void execInSandbox(client, `rm -f ${resPath}`, 15).catch(() => undefined);
        return parsed;
      }
    } catch {
      // not there yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function sendCommandOnce(
  client: BrowserSandboxClient,
  cmd: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ id: string; result: BrowserCommandResult | null }> {
  // Monotonic + random: two commands in the same millisecond (retry + new
  // call) must never collide on the same res-<id>.json.
  const id =
    "c" +
    (++cmdSeq).toString(36) +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 6);
  await client.writeFile(CMD_PATH, JSON.stringify({ id, ...cmd }));
  return { id, result: await readResFile(client, id, timeoutMs) };
}

let cmdSeq = 0;

/**
 * Execute one browser action with automatic reconnection: on a timed-out
 * command the driver's liveness is checked; a dead driver is re-booted
 * (persistent profile keeps the session state) and the action replays ONCE.
 */
export async function sendBrowserCommand(
  client: BrowserSandboxClient,
  cmd: Record<string, unknown>,
  opts?: { timeoutMs?: number; onProgress?: (line: string) => void },
): Promise<BrowserCommandResult> {
  const timeoutMs =
    opts?.timeoutMs ??
    (firstActionDone ? DEFAULT_ACTION_TIMEOUT_MS : FIRST_BOOT_TIMEOUT_MS);
  return enqueue(async () => {
    const booted = await ensureBrowserDriver(client, opts?.onProgress);
    if (!booted.ok) {
      return {
        success: false,
        error: { type: "browser_startup_failed", message: booted.error, recoverable: true },
      } satisfies BrowserCommandResult;
    }
    let sent = await sendCommandOnce(client, cmd, timeoutMs);
    if (sent.result) {
      firstActionDone = true;
      return sent.result;
    }
    // Timed out — check the DRIVER, not just the transport: a LIVE driver
    // (fresh heartbeat) carries its own per-command watchdog that ALWAYS
    // writes the result file (a stuck sync call gets unblocked by killing
    // the browser process). Never blind-reboot over it — the old reboot is
    // exactly what spawned the second driver that SIGKILLed the live
    // browser mid-goto ('Target page, context or browser has been closed').
    opts?.onProgress?.("The browser is taking longer than expected — checking the session…");
    const alive = await driverAlive(client).catch(() => false);
    if (alive) {
      // GRACE WINDOW on the ORIGINAL command id — re-READ its result file,
      // never re-send it (a second write would execute the action twice:
      // double navigation, double submit). The driver's watchdog settles
      // the in-flight action and writes this very file.
      const grace = await readResFile(client, sent.id, LIVE_DRIVER_GRACE_MS);
      if (grace) {
        firstActionDone = true;
        return grace;
      }
      return {
        success: false,
        error: {
          type: "timeout",
          message: `Browser action "${String(cmd.action)}" did not settle within ${Math.round(
            (timeoutMs + LIVE_DRIVER_GRACE_MS) / 1000,
          )}s (the driver is alive and its watchdog is armed). Retry the action — a retry reuses the warm session.`,
          recoverable: true,
        },
      } satisfies BrowserCommandResult;
    }
    // Driver really is dead — cooperative reboot + ONE replay (safe here:
    // the original command never completed).
    opts?.onProgress?.("The browser driver stopped responding — restarting it…");
    bootPromise = null; // force the re-boot path
    const reboot = await ensureBrowserDriver(client, opts?.onProgress);
    if (!reboot.ok) {
      return {
        success: false,
        error: {
          type: "browser_disconnected",
          message: `The browser session was lost and could not be restored: ${reboot.error}`,
          recoverable: true,
        },
      } satisfies BrowserCommandResult;
    }
    const replay = await sendCommandOnce(client, cmd, DEFAULT_ACTION_TIMEOUT_MS);
    if (replay.result) {
      firstActionDone = true;
      return replay.result;
    }
    return {
      success: false,
      error: {
        type: "timeout",
        message: `Browser action "${String(cmd.action)}" timed out after ${Math.round(timeoutMs / 1000)}s.`,
        recoverable: true,
      },
    } satisfies BrowserCommandResult;
  });
}

/** Operation-aware action ceiling (PRD §9): heavy operations get the long
 * budget, everything else the default (or the first-action budget while
 * the binary is still being fetched). Exported for the tool layer so the
 * schema and the ceiling stay in one place. */
const HEAVY_OPS = new Set(["screen_record", "screenshot", "download"]);

export function browserActionTimeoutMs(action: string): number {
  return HEAVY_OPS.has(action)
    ? HEAVY_ACTION_TIMEOUT_MS
    : firstActionDone
      ? DEFAULT_ACTION_TIMEOUT_MS
      : FIRST_BOOT_TIMEOUT_MS;
}

/** Reset the cached boot (sandbox rotation / new session). */
export function resetBrowserSessionCache(): void {
  bootPromise = null;
}

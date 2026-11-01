"use client";

/**
 * Browser session manager (client side) — REIMPLEMENTATION (2026-11-01 PRD).
 *
 * Boots the sandbox-side browser driver (CloakBrowser, humanize=True,
 * persistent profile) over the existing E2B infrastructure and shuttles
 * commands to it through the file protocol:
 *
 *   write /home/user/.onyx/browser/driver.py   (the Python driver source)
 *   write /home/user/.onyx/browser/boot.sh     (installer + launcher)
 *   nohup bash boot.sh &                       (DETACHED: pip install + daemon)
 *   poll .boot-failed / .ready with short commands until up
 *   cmd.json → res-<id>.json round-trip per action
 *
 * ── WHAT THIS REWRITE FIXES (the "runs forever, no output" incident) ──────
 *
 *  1. NO INFINITE HTTP WAITS. Every sandbox interaction here runs through
 *     withTimeout(): the E2B client's fetch()-based methods carry NO
 *     AbortSignal of their own, so a single stalled round-trip (serverless
 *     cold start, proxy stall, E2B API hiccup) used to leave the tool call
 *     hanging FOREVER — the deadline checks only ran BETWEEN polls. Now a
 *     stalled call is abandoned after BROWSER_TIMEOUTS.httpCallMs and the
 *     poll loop keeps progressing. The orphaned promise is left to be
 *     reaped by the runtime; control ALWAYS returns.
 *
 *  2. PER-CLIENT SESSION STATE. The old module cached ONE global boot
 *     promise and ONE global command queue — two conversations in
 *     "separate" mode fought over them (cross-session interference), and
 *     one wedged command blocked every later browser call globally. State
 *     now lives in a WeakMap keyed by the sandbox client: isolated
 *     boot/queue/first-action per agent session.
 *
 *  3. ZERO-STARTUP-DELAY PREPARE. The server kicks the detached
 *     browser install AT SANDBOX CREATION (see /api/sandbox
 *     createAndCacheSandbox); the client additionally calls
 *     prepareBrowserInBackground() after sandbox creation/rotation. The
 *     CloakBrowser download therefore runs WHILE the user chats — the
 *     first use_browser call finds a ready browser instead of paying the
 *     whole install behind its own timeout.
 *
 *  4. GUARANTEED STRUCTURED OUTPUT. sendBrowserCommand NEVER returns null
 *     and NEVER rejects: boot failure, timeout, cancellation, sandbox
 *     death and driver crashes all resolve to a structured result with a
 *     readable `output` line. The agent always receives an answer.
 *
 *  5. CANCELLATION. An AbortSignal (the agent tool context's) stops the
 *     poll loop and resolves with a cancelled result.
 *
 * RECONNECTION: a dead driver (crash / sandbox hiccup) is detected on
 * command timeout — the manager re-boots it (the persistent profile under
 * ~/.onyx/browser/profile keeps cookies + localStorage) and replays the
 * action ONCE before reporting failure. The sandbox-side watchdog (see
 * browser-driver.ts) guarantees the driver itself always answers.
 *
 * The AI-facing surface stays the single `use_browser` tool; this module
 * is the BrowserSessionManager + BrowserActionExecutor plumbing.
 */

import {
  BROWSER_DRIVER_PY_SOURCE,
  BROWSER_DRIVER_VERSION,
  BROWSER_BOOT_SH_SOURCE,
  BROWSER_SANDBOX_PATHS,
  buildDetachedSpawnCommand,
} from "./browser-driver";

const BR_DIR = BROWSER_SANDBOX_PATHS.dir;
const DRIVER_PATH = BROWSER_SANDBOX_PATHS.driver;
const READY_PATH = BROWSER_SANDBOX_PATHS.ready;
const VERSION_PATH = BROWSER_SANDBOX_PATHS.version;
const CMD_PATH = BROWSER_SANDBOX_PATHS.cmd;
const BOOT_SH_PATH = BROWSER_SANDBOX_PATHS.bootSh;
const BOOT_LOG_PATH = BROWSER_SANDBOX_PATHS.bootLog;
const INSTALL_LOG_PATH = BROWSER_SANDBOX_PATHS.installLog;
const BOOT_FAIL_PATH = BROWSER_SANDBOX_PATHS.bootFailed;

// ---------------------------------------------------------------------------
// Timeout configuration (PRD §6: configurable, never hardcode scattered
// limits). Exported for tests; treat as read-only in app code.
// ---------------------------------------------------------------------------

export const BROWSER_TIMEOUTS = {
  /** Ceiling for ONE sandbox HTTP round-trip (exec poll / file read /
   *  write). A stalled call is abandoned after this — the loop keeps
   *  progressing instead of hanging the tool call forever. */
  httpCallMs: 25_000,
  /** Boot-poll ceiling when the runtime is ALREADY importable (the
   *  onyx-cloakbrowser template, or a warm sandbox that installed it
   *  earlier) — the driver starts in seconds; anything past this window
   *  means the sandbox is wedged. */
  bootPollFastMs: 2 * 60_000,
  /** Boot-poll ceiling for a cold install (pip ladder + ~200 MB binary
   *  pre-fetch legitimately takes minutes on a slow sandbox network;
   *  each poll is a short request, the install itself runs in the
   *  sandbox). With the creation-time prepare kick this window is usually
   *  already elapsed before the first tool call ever arrives. */
  bootPollColdMs: 10 * 60_000,
  /** Default per-action ceiling (client side). Driver-side budgets are
   *  smaller so the DRIVER answers first with the better error. */
  actionDefaultMs: 105_000,
  /** Consecutive failed polls before declaring the sandbox unreachable. */
  maxConsecutivePollFailures: 6,
  /** Delay between boot polls. */
  bootPollIntervalMs: 1_500,
  /** Delay between result-file polls. */
  resultPollIntervalMs: 500,
} as const;

/**
 * @internal — TEST HOOK. When a key is set here it overrides
 * BROWSER_TIMEOUTS for every timing read in this module, so tests can
 * shrink deadlines to milliseconds and verify the no-infinite-wait
 * guarantees quickly. App code never touches it.
 */
export const __browserTimeoutsOverride: Partial<
  Record<keyof typeof BROWSER_TIMEOUTS | "streamDeadline", number>
> = {};

const t_ = <K extends keyof typeof BROWSER_TIMEOUTS>(k: K): number =>
  (__browserTimeoutsOverride[k] ?? BROWSER_TIMEOUTS[k]);

// ---------------------------------------------------------------------------
// Timeout helper — the heart of the "no infinite waits" guarantee.
// ---------------------------------------------------------------------------

class DeadlineReached extends Error {
  constructor(label: string, ms: number) {
    super(`${label} did not complete within ${Math.round(ms / 1000)}s`);
    this.name = "DeadlineReached";
  }
}

/** True when `output` contains `line` as a STANDALONE line. The sandbox
 * exec transport streams through a PTY whose chunking (and any historical
 * duplication artifact — see the exec_stream ANSI-stripper fix, 2026-11-01)
 * must never break an exact-match probe: the browser boot's READY/NO and
 * version-stamp checks match LINE-wise instead of on the whole output. */
function hasStandaloneLine(output: string, line: string): boolean {
  const re = new RegExp(`^\\s*${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
  return re.test(output);
}

/**
 * Race a promise against a hard timer. The underlying work is NOT
 * abortable through the E2B client interface (its fetch calls accept no
 * signal), so the orphaned promise is simply left behind — what matters
 * is that CONTROL returns to the caller so the tool call keeps
 * progressing toward a structured result.
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineReached(label, ms)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Wait, but wake early when the signal aborts. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(t);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Client surface + result contract
// ---------------------------------------------------------------------------

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
  /** ALWAYS present in results from sendBrowserCommand — a human-readable
   *  one-line summary the chat UI renders directly (PRD §5: never an
   *  empty successful response). */
  output?: string;
  url?: string;
  title?: string;
  error?: { type: string; message: string; recoverable?: boolean };
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Sandbox exec helper (collects the stream; EVERY call deadline-bounded).
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
    const stream = client.runCommandStream(command, { timeout: timeoutSec });
    // Bound the WHOLE stream consumption — a fetch that never yields a
    // result event (hung serverless connection) must not hang us forever.
    // The floor keeps legitimate silent commands (up to their own E2B
    // timeout) alive; the test hook shrinks it for fast verification.
    const deadlineMs =
      (__browserTimeoutsOverride.streamDeadline ?? 0) ||
      Math.max(t_("httpCallMs"), timeoutSec * 1000 + 5_000);
    const chunks = await withTimeout(
      (async () => {
        const parts: Array<{ type: string; data?: string; exit_code?: number }> = [];
        for await (const c of stream) parts.push(c);
        return parts;
      })(),
      deadlineMs,
      "sandbox command stream",
    );
    for (const chunk of chunks) {
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
// Per-client session state (PRD §9: isolated browser sessions per agent).
// ---------------------------------------------------------------------------

interface BrowserSessionState {
  /** In-flight (or cached-successful) driver boot for THIS sandbox. */
  bootPromise: Promise<{ ok: true } | { ok: false; error: string }> | null;
  /** Background prepare already kicked for this client. */
  prepared: boolean;
  /** True once a browser action completed against this sandbox (the
   *  runtime + binaries are warm). */
  firstActionDone: boolean;
  /** Serialized command queue — one action at a time, matching the
   *  driver's single-threaded loop. Per-client, so one chat can never
   *  block another. */
  queueTail: Promise<unknown>;
}

const sessionsHolder: { map: WeakMap<object, BrowserSessionState> } = { map: new WeakMap() };

function sessionOf(client: BrowserSandboxClient): BrowserSessionState {
  let s = sessionsHolder.map.get(client);
  if (!s) {
    s = { bootPromise: null, prepared: false, firstActionDone: false, queueTail: Promise.resolve() };
    sessionsHolder.map.set(client, s);
  }
  return s;
}

function enqueue<T>(state: BrowserSessionState, task: () => Promise<T>): Promise<T> {
  const run = state.queueTail.then(task, task);
  state.queueTail = run.catch(() => undefined);
  return run;
}

// ---------------------------------------------------------------------------
// Driver liveness / version checks (each bounded by withTimeout).
// ---------------------------------------------------------------------------

async function driverAlive(client: BrowserSandboxClient): Promise<boolean> {
  try {
    const r = await withTimeout(
      execInSandbox(
        client,
        `test -f ${READY_PATH} && pgrep -f "[d]river.py" >/dev/null && echo READY || echo NO`,
        30,
      ),
      t_("httpCallMs") + 35_000,
      "driver liveness probe",
    );
    // LINE-wise match — the whole-output `=== "READY"` broke on any PTY
    // artifact (a duplicated frame made it "READY\r\nREADY", and a LIVE
    // driver read as dead → every call re-booted from scratch).
    return r.ok && hasStandaloneLine(r.output, "READY");
  } catch {
    return false;
  }
}

/**
 * True when the RUNNING driver's version stamp matches this build's
 * BROWSER_DRIVER_PY_SOURCE. A live driver with an old/missing stamp runs
 * stale code — per-command errors never kill the daemon, so the caller
 * must kill + redeploy it instead of reusing it.
 */
async function driverUpToDate(client: BrowserSandboxClient): Promise<boolean> {
  try {
    const r = await withTimeout(
      execInSandbox(client, `cat ${VERSION_PATH} 2>/dev/null`, 15),
      t_("httpCallMs") + 20_000,
      "driver version probe",
    );
    // LINE-wise match (same PTY-artifact hardening as driverAlive): a
    // duplicated frame must never make a CURRENT driver read as stale —
    // that triggered an unnecessary kill + redeploy + full re-boot.
    return r.ok && hasStandaloneLine(r.output, BROWSER_DRIVER_VERSION);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Boot poll commands (same contract as boot.sh: BOOT_FAILED | READY | progress).
// ---------------------------------------------------------------------------

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

/** True while boot.sh is STILL RUNNING in this sandbox (the .boot-lock
 * holder is alive — e.g. the creation-time prepare kick or an earlier
 * rotation kick). While held, redeploying files or clearing markers would
 * orphan the running boot's log (fd → deleted inode, progress lines
 * vanish) and the second boot.sh would exit on the lock anyway — so the
 * caller skips straight to polling. A lock whose holder is DEAD (finished
 * or killed boot) reads BOOT_FREE. */
const BOOT_LOCK_PROBE_CMD = [
  `if [ -f ${BR_DIR}/.boot-lock ] && [ -s ${BR_DIR}/.boot-lock ]`,
  `&& kill -0 "$(cat ${BR_DIR}/.boot-lock 2>/dev/null)" 2>/dev/null; then echo BOOT_LOCKED`,
  `else echo BOOT_FREE; fi`,
].join(" ");

/**
 * Install + boot the browser driver in the sandbox. Idempotent + cached
 * PER CLIENT: a live driver CURRENT on version is left alone; a live
 * STALE driver (old code) is killed + redeployed so fixes actually reach
 * running sandboxes; a failed boot drops the cache so the next call
 * retries. `onProgress` receives human narration for the tool UI.
 */
export async function ensureBrowserDriver(
  client: BrowserSandboxClient,
  onProgress?: (line: string) => void,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const state = sessionOf(client);
  if (!state.bootPromise) {
    state.bootPromise = (async () => {
      try {
        if (await driverAlive(client)) {
          if (await driverUpToDate(client)) return { ok: true };
          // Stale driver CODE is running in this sandbox. Kill it so the
          // redeploy below installs the current source — the persistent
          // profile (cookies/localStorage) survives the swap.
          onProgress?.("Updating the sandbox browser driver…");
          await execInSandbox(
            client,
            `pkill -f "[d]river.py"; sleep 1; rm -f ${READY_PATH} ${VERSION_PATH}`,
            20,
          ).catch(() => undefined);
        } else {
          // Not alive — clear any stale stamps from a dead run so the
          // version check after boot compares against fresh state.
          await execInSandbox(client, `rm -f ${VERSION_PATH}`, 15).catch(() => undefined);
        }
        onProgress?.("Preparing the sandbox browser runtime…");
        await withTimeout(
          execInSandbox(
            client,
            `mkdir -p ${BR_DIR}/shots ${BR_DIR}/profile /home/user/downloads`,
            20,
          ),
          t_("httpCallMs"),
          "workspace dir setup",
        );

        // IN-FLIGHT BOOT GUARD: a boot.sh that is STILL RUNNING (kicked at
        // sandbox creation or by an earlier rotation) owns this sandbox's
        // install. Redeploying files / clearing markers now would orphan its
        // log (fd → deleted inode — the poll would narrate nothing for the
        // rest of the window) and the second boot.sh would exit on the lock
        // anyway. When locked, skip the redeploy + kick entirely and poll
        // the RUNNING boot.
        const lockProbe = await withTimeout(
          execInSandbox(client, BOOT_LOCK_PROBE_CMD, 15),
          t_("httpCallMs") + 20_000,
          "boot lock probe",
        ).catch(() => null);
        const bootAlreadyRunning = (lockProbe?.output ?? "").includes("BOOT_LOCKED");

        if (!bootAlreadyRunning) {
          await withTimeout(client.writeFile(DRIVER_PATH, BROWSER_DRIVER_PY_SOURCE), t_("httpCallMs"), "driver deploy");
          await withTimeout(client.writeFile(BOOT_SH_PATH, BROWSER_BOOT_SH_SOURCE), t_("httpCallMs"), "boot script deploy");
          // Clear the last boot's markers so the polls below read fresh state.
          await execInSandbox(
            client,
            `rm -f ${READY_PATH} ${BOOT_FAIL_PATH} ${BOOT_LOG_PATH}`,
            15,
          ).catch(() => undefined);
        } else {
          onProgress?.("A browser setup is already running in this sandbox — waiting for it to finish…");
        }

        // PRE-FLIGHT RUNTIME PROBE: pick a poll window that matches
        // reality instead of a fixed ceiling for everyone. A template-warm
        // sandbox (onyx-cloakbrowser) boots in seconds → tight ceiling,
        // wedged sandboxes fail fast. A cold install legitimately needs
        // minutes (pip ladder + ~200 MB binary pre-fetch) → honest ceiling
        // + honest narration.
        const probe = await withTimeout(
          execInSandbox(client, RUNTIME_PROBE_CMD, 30),
          t_("httpCallMs") + 35_000,
          "runtime probe",
        ).catch(() => null);
        const runtimePresent = (probe?.output ?? "").includes("RUNTIME_PRESENT");
        const pollCeilingMs = runtimePresent
          ? t_("bootPollFastMs")
          : t_("bootPollColdMs");
        onProgress?.(
          runtimePresent
            ? "Browser runtime found in the sandbox — starting the browser driver…"
            : "No browser runtime in this sandbox yet — installing cloakbrowser + playwright and pre-fetching the stealth Chromium binary (first run only, up to ~10 minutes)…",
        );

        // DETACHED BOOT (the use_browser-runs-forever fix): boot.sh MUST be
        // spawned via the Popen(start_new_session) launcher — the plain
        // `nohup … &` kick used here before is KILLED by E2B's post-command
        // cleanup the moment the kick command returns, so .ready never
        // appeared and the boot poll spun to its ceiling (see
        // buildDetachedSpawnCommand's probe table). The sandbox VM outlives
        // any HTTP request; the client only polls (short requests) below.
        if (!bootAlreadyRunning) {
          const launched = await withTimeout(
            execInSandbox(
              client,
              buildDetachedSpawnCommand({
                cwd: BR_DIR,
                argv: ["bash", "boot.sh"],
                logPath: BOOT_LOG_PATH,
              }) + " && echo booting",
              20,
            ),
            t_("httpCallMs"),
            "boot launch",
          );
          if (!launched.output.includes("booting")) {
            return {
              ok: false,
              error: `Could not launch the sandbox browser boot: ${(launched.error || launched.output).slice(-200)}`,
            };
          }
        }

        const deadline = Date.now() + pollCeilingMs;
        let lastProgress = "";
        let consecutivePollFailures = 0;
        let lastPollError = "";
        while (Date.now() < deadline) {
          let poll: Awaited<ReturnType<typeof execInSandbox>> | null = null;
          try {
            poll = await withTimeout(
              execInSandbox(client, BOOT_POLL_CMD, 30),
              t_("httpCallMs") + 35_000,
              "boot poll",
            );
          } catch (e) {
            lastPollError = e instanceof Error ? e.message : String(e);
            poll = null;
          }
          // A poll that FAILED (execInSandbox returns ok:false — a stream
          // deadline, an E2B error — or threw) counts toward the cap: a
          // dead/paused/out-of-quota sandbox used to swallow every poll
          // for the FULL window and then time out with zero diagnostic
          // value. Consecutive failures mean the sandbox itself (not the
          // boot) is the problem — say so and stop early.
          if (poll === null || !poll.ok) {
            if (poll !== null) lastPollError = (poll.error || poll.output || lastPollError).slice(-200);
            consecutivePollFailures += 1;
            if (consecutivePollFailures >= t_("maxConsecutivePollFailures")) {
              return {
                ok: false,
                error: `The sandbox stopped responding while the browser was booting (${t_("maxConsecutivePollFailures")} consecutive poll failures${lastPollError ? ` — last error: ${lastPollError.slice(-200)}` : ""}). It may be paused, out of quota, or the E2B connection dropped. Retry the action; if it persists, restart the sandbox session.`,
              };
            }
            await new Promise((r) => setTimeout(r, t_("bootPollIntervalMs")));
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
          // LINE-wise READY match — the strict `out === "READY"` never matched
          // once the PTY transport duplicated a frame ("READY\r\nREADY"),
          // which is exactly the multi-minute "didn't finish booting" hang.
          if (hasStandaloneLine(out, "READY")) return { ok: true };
          // Narrate live progress (e.g. "[boot 12:03:11] pip install …")
          // so a cold install shows real movement instead of a spinner.
          if (out && out !== lastProgress) {
            lastProgress = out;
            onProgress?.(out);
          }
          await new Promise((r) => setTimeout(r, t_("bootPollIntervalMs")));
        }
        const [bootLog, installLog] = await Promise.all([
          withTimeout(client.readFile(BOOT_LOG_PATH), t_("httpCallMs"), "boot log read").catch(() => ""),
          withTimeout(client.readFile(INSTALL_LOG_PATH), t_("httpCallMs"), "install log read").catch(() => ""),
        ]);
        const tail = `${bootLog ? ` Boot log: ${bootLog.slice(-300)}` : ""}${installLog ? ` Install log: ${installLog.slice(-300)}` : ""}`;
        return {
          ok: false,
          error: `The sandbox browser runtime did not finish booting within ${Math.round(pollCeilingMs / 60_000)} minutes.${tail || " No boot output was captured."} Tip: build the custom sandbox template (bash scripts/build-browser-sandbox-template.sh, then set E2B_TEMPLATE_ID=onyx-cloakbrowser) so every sandbox starts browser-ready and boots in seconds instead of installing at runtime.`,
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    })();
    const result = await state.bootPromise;
    if (!result.ok) state.bootPromise = null; // transient failure → retry next call
    return result;
  }
  return state.bootPromise;
}

// ---------------------------------------------------------------------------
// Background prepare — the zero-startup-delay kick (PRD §3).
// ---------------------------------------------------------------------------

/**
 * Kick the browser boot WITHOUT waiting for it. Called at sandbox creation
 * and after sandbox rotation (see sandbox-rotation.ts) so the CloakBrowser
 * runtime install + binary download run in the background WHILE the user
 * chats; the first use_browser call then typically finds a READY driver.
 * Fire-and-forget: every failure is swallowed (the awaited
 * ensureBrowserDriver path inside the tool reports real errors).
 */
export function prepareBrowserInBackground(
  client: BrowserSandboxClient,
  onProgress?: (line: string) => void,
): void {
  const state = sessionOf(client);
  if (state.prepared) return;
  state.prepared = true;
  void ensureBrowserDriver(client, onProgress ?? (() => {}))
    .then((r) => {
      if (r.ok) console.log("[browser] background prepare complete — browser ready before first use");
      else console.log("[browser] background prepare did not complete:", r.error.slice(0, 200));
    })
    .catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Command round-trip (serialized per client; every step deadline-bounded).
// ---------------------------------------------------------------------------

async function readResFile(
  client: BrowserSandboxClient,
  id: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<BrowserCommandResult | null> {
  const resPath = `${BR_DIR}/res-${id}.json`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) return null;
    try {
      const raw = await withTimeout(client.readFile(resPath), t_("httpCallMs"), "result read");
      if (raw && raw.trim()) {
        const parsed = JSON.parse(raw) as BrowserCommandResult;
        // Best-effort cleanup so the dir doesn't accumulate result files.
        void execInSandbox(client, `rm -f ${resPath}`, 15).catch(() => undefined);
        return parsed;
      }
    } catch {
      // not there yet (or the read stalled past httpCallMs) — keep polling
      // while the deadline allows; progress is guaranteed either way.
    }
    await abortableDelay(t_("resultPollIntervalMs"), signal);
  }
  return null;
}

async function sendCommandOnce(
  client: BrowserSandboxClient,
  cmd: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<BrowserCommandResult | null> {
  const id = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await withTimeout(client.writeFile(CMD_PATH, JSON.stringify({ id, ...cmd })), t_("httpCallMs"), "command write");
  return readResFile(client, id, timeoutMs, signal);
}

/**
 * Execute one browser action with automatic reconnection: on a timed-out
 * command the driver's liveness is checked; a dead driver is re-booted
 * (persistent profile keeps the session state) and the action replays ONCE.
 *
 * GUARANTEED RESULT (PRD §7): this function NEVER rejects and NEVER returns
 * null — every path (success, driver error, timeout, cancellation, boot
 * failure, sandbox death) resolves to a structured BrowserCommandResult
 * carrying a readable `output` line. The agent is never left waiting for
 * an answer that never arrives.
 */
export async function sendBrowserCommand(
  client: BrowserSandboxClient,
  cmd: Record<string, unknown>,
  opts?: {
    timeoutMs?: number;
    onProgress?: (line: string) => void;
    /** Cancellation — the agent tool context's abort signal. Aborting
     *  resolves immediately with a structured cancelled result. */
    signal?: AbortSignal;
  },
): Promise<BrowserCommandResult> {
  const state = sessionOf(client);
  const timeoutMs = opts?.timeoutMs ?? t_("actionDefaultMs");
  const signal = opts?.signal;
  if (signal?.aborted) {
    return {
      success: false,
      action: String(cmd.action ?? ""),
      error: { type: "cancelled", message: "The browser action was cancelled before it started.", recoverable: true },
      output: "Browser action cancelled.",
    };
  }
  return enqueue(state, async () => {
    if (signal?.aborted) {
      return cancelledResult(cmd);
    }
    const booted = await ensureBrowserDriver(client, opts?.onProgress);
    if (!booted.ok) {
      return {
        success: false,
        action: String(cmd.action ?? ""),
        error: { type: "browser_startup_failed", message: booted.error, recoverable: true },
        output: `Browser failed to start: ${booted.error.slice(0, 300)}`,
      } satisfies BrowserCommandResult;
    }
    if (signal?.aborted) {
      return cancelledResult(cmd);
    }
    let result = await sendCommandOnce(client, cmd, timeoutMs, signal);
    if (result) {
      state.firstActionDone = true;
      return ensureOutput(result, cmd);
    }
    if (signal?.aborted) {
      return cancelledResult(cmd);
    }
    // Timed out — is the driver still alive? (Reconnection path.)
    opts?.onProgress?.("The browser driver stopped responding — reconnecting…");
    const alive = await driverAlive(client).catch(() => false);
    state.bootPromise = null; // force a re-boot path
    if (!alive) {
      const reboot = await ensureBrowserDriver(client, opts?.onProgress);
      if (!reboot.ok) {
        return {
          success: false,
          action: String(cmd.action ?? ""),
          error: {
            type: "browser_disconnected",
            message: `The browser session was lost and could not be restored: ${reboot.error}`,
            recoverable: true,
          },
          output: `Browser session lost: ${reboot.error.slice(0, 300)}`,
        } satisfies BrowserCommandResult;
      }
    }
    result = await sendCommandOnce(client, cmd, Math.min(timeoutMs, t_("actionDefaultMs")), signal);
    if (result) {
      state.firstActionDone = true;
      return ensureOutput(result, cmd);
    }
    if (signal?.aborted) {
      return cancelledResult(cmd);
    }
    return {
      success: false,
      action: String(cmd.action ?? ""),
      error: {
        type: "timeout",
        message: `Browser action "${String(cmd.action)}" timed out after ${Math.round(timeoutMs / 1000)}s.`,
        recoverable: true,
      },
      output: `Browser action "${String(cmd.action)}" timed out after ${Math.round(timeoutMs / 1000)}s — the driver or sandbox stopped responding.`,
    } satisfies BrowserCommandResult;
  });
}

function cancelledResult(cmd: Record<string, unknown>): BrowserCommandResult {
  return {
    success: false,
    action: String(cmd.action ?? ""),
    error: { type: "cancelled", message: "The browser action was cancelled.", recoverable: true },
    output: "Browser action cancelled.",
  };
}

/** Guarantee the PRD §5 output contract: a non-empty readable `output`. */
function ensureOutput(result: BrowserCommandResult, cmd: Record<string, unknown>): BrowserCommandResult {
  if (typeof result.output === "string" && result.output.trim()) return result;
  const action = String(result.action ?? cmd.action ?? "browser");
  if (result.success === false && result.error) {
    return { ...result, output: `${result.error.type}: ${result.error.message.slice(0, 300)}` };
  }
  const url = typeof result.url === "string" ? result.url : "";
  const title = typeof result.title === "string" ? result.title : "";
  const text = typeof result.text === "string" && result.text ? `${result.text.length} chars of text` : "";
  const count = typeof result.count === "number" ? `${result.count} items` : "";
  const fallback =
    text ||
    (typeof result.elements === "object" && Array.isArray(result.elements) ? `${result.elements.length} elements` : "") ||
    count ||
    (title || url ? `on ${title || url}` : "") ||
    `${action} completed.`;
  return { ...result, output: `${action}: ${fallback}` };
}

/** Reset ALL cached session state (sandbox rotation / new session /
 *  logout). Each client's next browser command re-boots cleanly. WeakMap
 *  entries can't be enumerated, so the map is swapped wholesale. */
export function resetBrowserSessionCache(): void {
  sessionsHolder.map = new WeakMap();
}

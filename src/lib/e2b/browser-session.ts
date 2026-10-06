"use client";

/**
 * Browser session manager (client side) — boots the sandbox-side browser
 * driver (CloakBrowser, humanize=True, persistent profile) over the
 * existing E2B infrastructure and shuttles commands to it through the
 * file protocol:
 *
 *   write /home/user/.onyx/browser/driver.py   (the Python driver source)
 *   pip install cloakbrowser playwright         (runtime + fallback)
 *   nohup python3 driver.py                     (detached daemon)
 *   cmd.json → res-<id>.json round-trip per action
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

import { BROWSER_DRIVER_PY_SOURCE } from "./browser-driver";

// ---------------------------------------------------------------------------
// Paths (must match browser-driver.ts).
// ---------------------------------------------------------------------------

const BR_DIR = "/home/user/.onyx/browser";
const DRIVER_PATH = `${BR_DIR}/driver.py`;
const READY_PATH = `${BR_DIR}/.ready`;
const CMD_PATH = `${BR_DIR}/cmd.json`;
const LOG_PATH = `${BR_DIR}/driver.log`;

/** First boot downloads the browser binary (~200 MB) — generous ceiling. */
const FIRST_BOOT_TIMEOUT_MS = 6 * 60_000;
/** pip install ceiling (cached wheels make repeats fast). */
const INSTALL_TIMEOUT_S = 280;
/** Usual per-action ceiling. */
const DEFAULT_ACTION_TIMEOUT_MS = 90_000;

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
  const r = await execInSandbox(
    client,
    `test -f ${READY_PATH} && pgrep -f "[d]river.py" >/dev/null && echo READY || echo NO`,
    30,
  );
  return r.ok && r.output.trim() === "READY";
}

/**
 * Install + boot the browser driver in the sandbox. Idempotent + cached:
 * a live driver is left alone; a failed boot drops the cache so the next
 * call retries. `onProgress` receives human narration for the tool UI.
 */
export async function ensureBrowserDriver(
  client: BrowserSandboxClient,
  onProgress?: (line: string) => void,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!bootPromise) {
    bootPromise = (async () => {
      try {
        if (await driverAlive(client)) return { ok: true };
        onProgress?.("Preparing the sandbox browser runtime…");
        await execInSandbox(
          client,
          `mkdir -p ${BR_DIR}/shots ${BR_DIR}/profile /home/user/downloads`,
          20,
        );
        await client.writeFile(DRIVER_PATH, BROWSER_DRIVER_PY_SOURCE);
        await execInSandbox(client, `rm -f ${READY_PATH}`, 15);
        // Runtime deps: cloakbrowser (primary, humanize=True) + playwright
        // (the standard-Chromium fallback). Both pip packages are small;
        // the browser BINARY downloads on first launch inside the driver.
        // NOTE: no pipes on the pip calls — `| tail` would mask pip's exit
        // code; success is verified with an import probe instead.
        const pkgsOk = () =>
          execInSandbox(
            client,
            `python3 -c "import cloakbrowser, playwright" >/dev/null 2>&1 && echo YES || echo NO`,
            30,
          ).then((r) => r.output.trim() === "YES");
        onProgress?.("Installing the browser runtime (first run only)…");
        if (!(await pkgsOk())) {
          let inst = await execInSandbox(
            client,
            `pip install --quiet cloakbrowser playwright`,
            INSTALL_TIMEOUT_S,
          );
          if (!inst.ok || !(await pkgsOk())) {
            // Externally-managed environments need --break-system-packages.
            inst = await execInSandbox(
              client,
              `pip install --quiet --break-system-packages cloakbrowser playwright`,
              INSTALL_TIMEOUT_S,
            );
          }
          if (!(await pkgsOk())) {
            return {
              ok: false,
              error: `Failed to install the browser runtime in the sandbox: ${(inst.error || inst.output).slice(-300)}`,
            };
          }
        }
        onProgress?.("Starting the browser…");
        await execInSandbox(
          client,
          `cd ${BR_DIR} && nohup python3 driver.py > driver.log 2>&1 & echo started`,
          20,
        );
        // Poll for the .ready marker (the daemon loop, not the browser boot).
        const deadline = Date.now() + 45_000;
        while (Date.now() < deadline) {
          if (await driverAlive(client)) return { ok: true };
          await new Promise((r) => setTimeout(r, 800));
        }
        const log = await client.readFile(LOG_PATH).catch(() => "");
        return {
          ok: false,
          error: `The sandbox browser driver did not start in time.${log ? ` Driver log: ${log.slice(-300)}` : ""}`,
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
): Promise<BrowserCommandResult | null> {
  const id = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await client.writeFile(CMD_PATH, JSON.stringify({ id, ...cmd }));
  return readResFile(client, id, timeoutMs);
}

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
    let result = await sendCommandOnce(client, cmd, timeoutMs);
    if (result) {
      firstActionDone = true;
      return result;
    }
    // Timed out — is the driver still alive? (PRD §28 reconnection.)
    opts?.onProgress?.("The browser driver stopped responding — reconnecting…");
    const alive = await driverAlive(client).catch(() => false);
    bootPromise = null; // force a re-boot path
    if (!alive) {
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
    }
    result = await sendCommandOnce(client, cmd, DEFAULT_ACTION_TIMEOUT_MS);
    if (result) {
      firstActionDone = true;
      return result;
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

/** Reset the cached boot (sandbox rotation / new session). */
export function resetBrowserSessionCache(): void {
  bootPromise = null;
}

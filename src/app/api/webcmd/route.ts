/**
 * WEBCMD BRIDGE — server-side executor for the webcmd agent-browser CLI
 * (https://github.com/agentrhq/webcmd).
 *
 * OnyxAgent's primary browser surface (`use_browser`) executes CloakBrowser
 * inside the user's E2B sandbox. webcmd is the complementary LOCAL engine:
 * a self-learning browser daemon (CloakBrowser stealth Chromium, headed)
 * running on THIS host, with persistent cookie profiles, explicit sessions,
 * Playwright-style `browser run` programs and per-site sitemap memory.
 *
 * Because webcmd's Chromium is deliberately HEADED (stealth automation —
 * it strips `--headless`), this sandbox needs a virtual display. This route
 * owns the full host-side supervision chain:
 *
 *   Xvfb :99  →  webcmd daemon (port 9777, DISPLAY aware)  →  CLI spawn
 *
 * Every request re-verifies the chain cheaply (unix-socket probe, daemon
 * status + /proc/<pid>/environ DISPLAY check) and repairs it before
 * shelling out, so a machine restart or a reaped Xvfb self-heals.
 *
 * Contract:
 *   POST { args: string[], stdin?: string, timeoutMs?: number }
 *   →   { ok: boolean, stdout: string, stderr: string, exitCode: number,
 *         parsed?: unknown, repaired?: string[] }
 *
 * Security: the CLI is invoked with an ARGUMENT WHITELIST (only session /
 * browser / profile / doctor / daemon-status / site-memory subcommands) —
 * arbitrary host command execution is impossible through this route. The
 * one free-form surface, `browser run` program text, travels via stdin and
 * executes inside webcmd's sandboxed Playwright runner, not the host shell.
 */
import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Browser programs can legitimately run minutes; Hobby ceiling is 300.
export const maxDuration = 300;

// ---------------------------------------------------------------------------
// Host facts (resolved once per server process).
// ---------------------------------------------------------------------------

const HOME = process.env.HOME || "/home/z";
const WEBCMD_BIN =
  process.env.WEBCMD_BIN ||
  ["/home/z/.npm-global/bin/webcmd", "/usr/local/bin/webcmd", "/usr/bin/webcmd"].find((p) =>
    fs.existsSync(p),
  ) ||
  "webcmd";
const XVFB_BIN = "/usr/bin/Xvfb";
const X11_SOCKET = "/tmp/.X11-unix/X99";
const DISPLAY = ":99";

/** Repair actions taken for a request (surfaced to the tool → model). */
let repaired: string[] = [];

// ---------------------------------------------------------------------------
// Supervision chain.
// ---------------------------------------------------------------------------

/** True when a live X server answers on the X99 unix socket. */
function x11Alive(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(X11_SOCKET);
    let settled = false;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(v);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    setTimeout(() => done(false), 800);
  });
}

/** Detached spawn that survives the request lifecycle (double-fork style). */
function spawnDetached(command: string, args: string[]) {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, DISPLAY, HOME },
  });
  child.unref();
  return child;
}

/** Ensure the Xvfb virtual display is up (headed CloakBrowser needs it). */
async function ensureXvfb(): Promise<void> {
  if (await x11Alive()) return;
  try {
    fs.rmSync(X11_SOCKET, { force: true });
  } catch {
    // stale socket removal is best-effort
  }
  spawnDetached(XVFB_BIN, [DISPLAY, "-screen", "0", "1920x1080x24", "-nolisten", "tcp"]);
  // Wait briefly for the socket to answer (typical start <300ms).
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (await x11Alive()) {
      repaired.push("xvfb-started");
      return;
    }
  }
}

/** Child-process helper: collect output, kill on deadline. */
function run(
  command: string,
  args: string[],
  opts: { timeoutMs: number; stdin?: string; env?: NodeJS.ProcessEnv },
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number; timedOut?: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: `${stderr}${err.message}`, exitCode: -1 });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: !timedOut && code === 0, stdout, stderr, exitCode: code ?? -1, timedOut });
    });
    if (opts.stdin !== undefined) {
      child.stdin?.write(opts.stdin);
    }
    child.stdin?.end();
  });
}

const webcmdEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  DISPLAY,
  HOME,
  WEBCMD_NO_UPDATE_CHECK: "1",
});

/** Daemon PID via `webcmd daemon status` text ("Daemon: running (PID 1847)"). */
async function daemonPid(): Promise<number | null> {
  const r = await run(WEBCMD_BIN, ["daemon", "status"], { timeoutMs: 15_000, env: webcmdEnv() });
  if (!/running/i.test(r.stdout)) return null;
  const m = r.stdout.match(/PID\s+(\d+)/);
  return m ? Number(m[1]) : null;
}

/** True when the daemon process carries DISPLAY in its environment. */
function daemonHasDisplay(pid: number): boolean {
  try {
    const envBlob = fs.readFileSync(`/proc/${pid}/environ`).toString();
    return envBlob.split("\0").some((e) => e.startsWith("DISPLAY="));
  } catch {
    return false;
  }
}

/** Ensure the webcmd daemon is running AND display-aware. */
async function ensureDaemon(): Promise<void> {
  const pid = await daemonPid();
  if (pid && daemonHasDisplay(pid)) return;
  await run(WEBCMD_BIN, ["daemon", "restart"], { timeoutMs: 30_000, env: webcmdEnv() });
  repaired.push("daemon-restarted");
  await new Promise((r) => setTimeout(r, 1500));
}

// ---------------------------------------------------------------------------
// Argument whitelist — the ONLY CLI surfaces this route will execute.
// ---------------------------------------------------------------------------

const ALLOWED_ROOTS = new Set(["session", "browser", "profile", "doctor", "daemon", "site"]);
/** Daemon subcommand policy: status/restart keep the chain alive; `stop` is
 *  a self-DoS and stays host-private. */
const DAEMON_ALLOWED = new Set(["status", "restart"]);
/** Site memory is read-knowledge: inspect stored sitemap memory + notes. */
const SITE_ALLOWED = new Set(["memory", "note", "endpoint", "field-map"]);
const BLOCKED_FLAGS = new Set(["--config", "--profile-dir", "--adapter"]);

function validateArgs(args: unknown): { ok: true; args: string[] } | { ok: false; error: string } {
  if (!Array.isArray(args) || args.length === 0) {
    return { ok: false, error: "args must be a non-empty string array" };
  }
  if (args.length > 24) {
    return { ok: false, error: "too many arguments (max 24)" };
  }
  const strings: string[] = [];
  for (const a of args) {
    if (typeof a !== "string" || a.length === 0 || a.length > 8192) {
      return { ok: false, error: "each argument must be a non-empty string (max 8192 chars)" };
    }
    if (BLOCKED_FLAGS.has(a)) {
      return { ok: false, error: `blocked flag: ${a}` };
    }
    strings.push(a);
  }
  // webcmd's GLOBAL FLAGS precede the subcommand (`webcmd --session <id>
  // browser run …`). Peel them off before root-command validation.
  let i = 0;
  while (i < strings.length && strings[i].startsWith("--")) {
    const flag = strings[i];
    if (flag === "--session" || flag === "--profile") {
      const value = strings[i + 1];
      if (!value || value.startsWith("--")) {
        return { ok: false, error: `${flag} requires a value` };
      }
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)) {
        return { ok: false, error: `invalid ${flag} value: ${value.slice(0, 40)}` };
      }
      i += 2;
    } else if (flag === "-f" || flag === "--format" || flag === "--json" || flag.startsWith("--timeout")) {
      i += flag === "--timeout" ? 2 : 1;
    } else {
      return { ok: false, error: `global flag not allowed: ${flag}` };
    }
  }
  const [root, second] = strings.slice(i);
  if (!root || !ALLOWED_ROOTS.has(root)) {
    return { ok: false, error: `command not allowed: ${root ?? "(none)"}` };
  }
  if (root === "daemon" && second && !DAEMON_ALLOWED.has(second)) {
    return { ok: false, error: `daemon ${second} not allowed (status/restart only)` };
  }
  if (root === "site" && second && !SITE_ALLOWED.has(second)) {
    return { ok: false, error: `site ${second} not allowed (read-only memory surfaces)` };
  }
  return { ok: true, args: strings };
}

// ---------------------------------------------------------------------------
// Route handler.
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  repaired = [];
  let body: { args?: unknown; stdin?: unknown; timeoutMs?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const validated = validateArgs(body.args);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }
  const stdin = typeof body.stdin === "string" ? body.stdin.slice(0, 512_000) : undefined;
  const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 60_000, 5_000), 280_000);

  // Repair the supervision chain BEFORE shelling out.
  try {
    await ensureXvfb();
    await ensureDaemon();
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: `host supervision failed: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 500 },
    );
  }

  const result = await run(WEBCMD_BIN, validated.args, { timeoutMs, stdin, env: webcmdEnv() });

  // webcmd prints rich JSON on stdout for browser/session commands —
  // surface it pre-parsed when possible so the tool result stays compact.
  let parsed: unknown;
  const trimmed = result.stdout.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = undefined;
    }
  }

  return NextResponse.json({
    ok: result.ok,
    stdout: result.stdout.slice(0, 200_000),
    stderr: result.stderr.slice(0, 20_000),
    exitCode: result.exitCode,
    timedOut: result.timedOut ?? false,
    parsed,
    ...(repaired.length ? { repaired } : {}),
  });
}

"use client";

import { registerTool } from "./registry";
import { codeSandboxForCtx } from "@/lib/e2b/sandbox-rotation";
import { bumpWorkspaceVersion, getWorkspaceFsVersion } from "./workspace-snapshot";
import { WEB_SESSION_DRIVER_SOURCE } from "./web-session-driver";
import type { E2BClient } from "@/lib/e2b/client";

/**
 * OnyxCode web sessions (OnyxCode PRD §6 — `start_web_session`) — a real
 * headless Chromium (Playwright) running INSIDE the E2B sandbox, driven
 * over a small file protocol:
 *
 *   /home/user/.onyx/websession/driver.mjs   — long-running driver (Node)
 *   /home/user/.onyx/websession/cmd.json     — {id, action, …} request
 *   /home/user/.onyx/websession/res-<id>.json — driver's reply
 *   /home/user/.onyx/websession/shots/*.png  — screenshots
 *
 * `start_web_session` installs Playwright once per sandbox, boots the
 * driver, and navigates to the start URL. `manage_web_session` performs
 * the interaction actions (navigate / click / type / screenshot / extract /
 * title / content / status / close). Everything runs sandbox-side, so it
 * works for the agent's own previews (http://localhost:PORT inside the
 * sandbox) AND public URLs.
 *
 * The DRIVER SOURCE lives in web-session-driver.ts and is shared verbatim
 * with the background runner (bg-agent-script.ts) so the SAME tools run
 * NATIVELY inside the sandbox on background turns — no browser tab needed.
 */

const NO_KEY_ERROR =
  "Web sessions require an E2B Sandbox API key. Add one in Settings → Config → E2B Sandbox.";

const WS_DIR = "/home/user/.onyx/websession";
const INSTALL_TIMEOUT_S = 280;

/* ------------------------------------------------------------------ */
/* File-protocol helpers                                               */
/* ------------------------------------------------------------------ */

function toB64(s: string): string {
  // Browser-safe UTF-8 → base64.
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

async function sendCommand(
  client: E2BClient,
  cmd: Record<string, unknown>,
  opts?: { timeoutMs?: number },
): Promise<Record<string, unknown>> {
  const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const payload = JSON.stringify({ id, ...cmd });
  await client.exec(`echo '${toB64(payload)}' | base64 -d > ${WS_DIR}/cmd.json`, { timeout: 15 });
  const timeoutMs = opts?.timeoutMs ?? 45_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await client.exec(`cat ${WS_DIR}/res-${id}.json 2>/dev/null || echo __PENDING__`, {
      timeout: 15,
    });
    if (r.stdout.trim() && r.stdout.trim() !== "__PENDING__") {
      try {
        return JSON.parse(r.stdout.trim()) as Record<string, unknown>;
      } catch {
        return { ok: false, error: "Driver returned an unreadable result." };
      }
    }
    await new Promise((res) => setTimeout(res, 1200));
  }
  return { ok: false, error: "Web session command timed out." };
}

/** Exported for the browser_eval / diagnostics tools (code_diagnostics.ts)
 *  — they drive the SAME single driver + file protocol so the AI's page
 *  state (navigation, console capture) is shared across all Code tools. */
export const webSession = { WS_DIR, ensureDriver, sendCommand, markPageLoaded, pageFsVersion };

/* ------------------------------------------------------------------ */
/* Page-freshness gate (the "AI can't see errors" fix)                  */
/* ------------------------------------------------------------------ */

/** Workspace fsVersion observed the LAST time the web-session page was
 *  (re)loaded by any path. The headless page does NOT reliably self-update
 *  when the agent writes more project files (HMR dies with every dev-server
 *  restart; big multi-file rewrites defeat fast-refresh), so a page that
 *  predates the latest writes keeps showing the OLD app — typically the
 *  scaffold's placeholder — and its console/network captures show NOTHING.
 *  Comparing this marker against getWorkspaceFsVersion() lets the
 *  diagnostics path force a reload before reading the page (see
 *  ensurePageOnTarget in code_diagnostics.ts), so the AI always inspects
 *  the REAL app and sees its actual runtime errors. */
let pageLoadedAtFsVersion = 0;

/** Record that the web-session page was just (re)loaded — call after every
 *  successful navigation (fresh page ⇒ current with the latest writes). */
function markPageLoaded(): void {
  pageLoadedAtFsVersion = getWorkspaceFsVersion();
}

/** The fsVersion the page was last loaded at (0 = never navigated). */
function pageFsVersion(): number {
  return pageLoadedAtFsVersion;
}

/** Install Playwright + boot the driver (idempotent — once per sandbox).
 *
 *  DRIVER LIVENESS (the "manage web session is not working" fix): a stale
 *  `.ready` marker is NOT proof the driver is alive — the process dies on
 *  sandbox pause/restore, OOM kills and driver crashes, and every command
 *  then timed out with "Web session command timed out." ALIVE now requires
 *  BOTH the marker AND a running `node driver.mjs` process (the `[d]river`
 *  bracket pattern keeps pgrep from matching its own shell command). A dead
 *  driver is RESTARTED on the spot — and because Playwright is already
 *  installed, a restart skips the multi-minute npm+Chromium install. */
async function ensureDriver(
  client: E2BClient,
  onProgress?: (line: string) => void,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const readyCmd = `test -f ${WS_DIR}/.ready && pgrep -f "[d]river.mjs" >/dev/null && echo READY || echo NO`;
  const alive = await client.exec(readyCmd, { timeout: 15 });
  if (alive.stdout.trim() === "READY") return { ok: true };

  onProgress?.("Preparing the web-session driver (first run installs headless Chromium)…");
  await client.exec(`mkdir -p ${WS_DIR}`, { timeout: 15 });
  // Always (re)write the driver source — a restored/recreated sandbox may
  // have lost the file, and rewriting an identical file is harmless.
  await client.batchWrite([{ path: `${WS_DIR}/driver.mjs`, content: WEB_SESSION_DRIVER_SOURCE }]);
  await client.exec(`rm -f ${WS_DIR}/.ready ${WS_DIR}/res-*.json`, { timeout: 15 });

  // Install playwright only when it is genuinely absent (fresh sandbox). A
  // restart-after-crash reuses the existing node_modules — no minutes-long
  // reinstall between web-session actions.
  const installed = await client.exec(
    `test -d ${WS_DIR}/node_modules/playwright && echo YES || echo NO`,
    { timeout: 15 },
  );
  if (installed.stdout.trim() !== "YES") {
    let installErr = "";
    let ok = false;
    for await (const chunk of client.runCommandStream(
      `npm init -y >/dev/null 2>&1; npm install --no-audit --no-fund --loglevel=error playwright && npx playwright install chromium --with-deps`,
      { cwd: WS_DIR, timeout: INSTALL_TIMEOUT_S },
    )) {
      if ((chunk.type === "stdout" || chunk.type === "stderr") && chunk.data) {
        const line = chunk.data.trim().split("\n").pop();
        if (line) onProgress?.(line);
        if (chunk.type === "stderr") installErr += chunk.data;
      } else if (chunk.type === "result") {
        ok = (chunk.exit_code ?? 0) === 0;
      }
    }
    if (!ok) {
      return {
        ok: false,
        error: `Failed to install Playwright/Chromium in the sandbox: ${installErr.slice(-300) || "npm install failed"}`,
      };
    }
  } else {
    onProgress?.("Restarting the web-session driver…");
  }

  // Boot the driver as a detached background process.
  await client.startServer(`cd ${WS_DIR} && node driver.mjs`, { cwd: "/home/user" });
  // Wait for the .ready marker.
  const start = Date.now();
  while (Date.now() - start < 15_000) {
    const r = await client.exec(readyCmd, { timeout: 15 });
    if (r.stdout.trim() === "READY") return { ok: true };
    await new Promise((res) => setTimeout(res, 800));
  }
  // Surface the driver's own log tail — "did not start in time" alone is
  // not actionable.
  const log = await client.exec(`tail -c 400 ${WS_DIR}/driver.log 2>/dev/null`, { timeout: 15 });
  const tail = log.stdout.trim();
  return {
    ok: false,
    error:
      "The web-session driver did not start in time." +
      (tail ? ` Driver log: ${tail.slice(0, 250)}` : ""),
  };
}

/* ------------------------------------------------------------------ */
/* Tool: start_web_session                                             */
/* ------------------------------------------------------------------ */

registerTool(
  "start_web_session",
  "Start a headless Chromium (Playwright) web session INSIDE the sandbox for testing and interacting with web pages — including the agent's own live previews (use http://localhost:PORT, e.g. http://localhost:3000, to test apps you just started with start_preview). Installs Chromium on first use (can take a couple of minutes; consider skip-wait). Returns a session id; drive it with manage_web_session (navigate, click, type, screenshot, extract…).",
  {
    type: "object",
    properties: {
      url: {
        type: "string",
        description:
          "URL to open first (public https:// URL, or http://localhost:PORT to test a preview running in the sandbox).",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const url = String(args.url ?? "");
    if (!url) return { ok: false, error: "url is required." };
    // THIS chat's own sandbox — the web session tests the app preview that
    // runs in the same per-chat filesystem (one chat = one app).
    const sbx = await codeSandboxForCtx(ctx);
    if (!sbx) return { ok: false, error: NO_KEY_ERROR };
    const client = sbx.client;
    const progress = (line: string) => ctx.onToolOutput?.("", line, "stdout");

    const booted = await ensureDriver(client, progress);
    if (!booted.ok) return { ok: false, error: booted.error };

    const nav = await sendCommand(client, { action: "navigate", url }, { timeoutMs: 60_000 });
    bumpWorkspaceVersion();
    if (!nav.ok) return { ok: false, error: String(nav.error ?? "Navigation failed.") };
    markPageLoaded();
    return {
      kind: "web_session",
      ok: true,
      action: "start",
      sessionId: "ws_default",
      url: nav.url ?? url,
      title: nav.title ?? null,
      status: typeof nav.status === "number" ? nav.status : null,
      message:
        "Web session ready. Drive it with manage_web_session actions: navigate, click, type, press, screenshot, extract, title, content, status, close.",
    };
  },
  false,
  "code",
);

/* ------------------------------------------------------------------ */
/* Tool: manage_web_session                                            */
/* ------------------------------------------------------------------ */

registerTool(
  "manage_web_session",
  "Drive an active OnyxCode web session (headless Chromium in the sandbox, started by start_web_session). Actions: `navigate` (url), `click` (selector), `type` (selector, text), `press` (key), `screenshot` (returns the image), `extract` (visible text, optional selector), `title`, `content` (HTML), `eval` (run JavaScript in the page — see browser_eval), `els` (interactive-element inventory with selectors + a11y info), `console` (captured console errors/warnings + page errors, deduplicated), `network` (failed 4xx/5xx + failed requests), `status`, `close`. Selectors are CSS. Use http://localhost:PORT to interact with your own previews.",
  {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "navigate",
          "click",
          "type",
          "press",
          "screenshot",
          "extract",
          "title",
          "content",
          "eval",
          "els",
          "console",
          "network",
          "status",
          "close",
        ],
        description: "The interaction to perform.",
      },
      url: { type: "string", description: "For navigate." },
      selector: { type: "string", description: "CSS selector (click/type/press/extract)." },
      text: { type: "string", description: "Text to type (type action)." },
      key: { type: "string", description: "Key to press (press action), e.g. Enter." },
      fullPage: { type: "boolean", description: "Screenshot the full page (optional)." },
      code: { type: "string", description: "JavaScript to evaluate (eval action)." },
      limit: { type: "number", description: "Max entries (console/network) or elements (els)." },
      clear: { type: "boolean", description: "Clear the captured console/network log after reading." },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const action = String(args.action ?? "");
    const sbx = await codeSandboxForCtx(ctx);
    if (!sbx) return { ok: false, error: NO_KEY_ERROR };
    const client = sbx.client;

    const booted = await ensureDriver(client);
    if (!booted.ok) return { ok: false, error: booted.error };

    const cmd: Record<string, unknown> = { action };
    if (args.url !== undefined) cmd.url = String(args.url);
    if (args.selector !== undefined) cmd.selector = String(args.selector);
    if (args.text !== undefined) cmd.text = String(args.text);
    if (args.key !== undefined) cmd.key = String(args.key);
    if (args.fullPage !== undefined) cmd.fullPage = !!args.fullPage;
    if (args.code !== undefined) cmd.code = String(args.code);
    if (args.limit !== undefined) cmd.limit = Number(args.limit) || 0;
    if (args.clear !== undefined) cmd.clear = !!args.clear;

    const result = await sendCommand(client, cmd, { timeoutMs: 60_000 });
    // A successful navigate loaded a FRESH page — record its fsVersion so
    // the diagnostics freshness gate knows the page is current.
    if (action === "navigate" && result.ok !== false) markPageLoaded();
    return { kind: "web_session", ok: result.ok !== false, action, ...result };
  },
  false,
  "code",
);

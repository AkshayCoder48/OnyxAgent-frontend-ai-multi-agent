"use client";

// webcmd — LOCAL stealth agent-browser (agentrhq/webcmd) on the host side.
//
// OnyxAgent ships two browser engines with different homes:
//
//   use_browser  → CloakBrowser INSIDE the user's E2B sandbox (cloud, needs
//                  an E2B API key) — the default interactive surface.
//   webcmd       → CloakBrowser on THIS host via the webcmd daemon: no E2B
//                  key required, persistent cookie PROFILES across turns,
//                  explicit SESSIONS (independent browser windows), Playwright-
//                  style `browser run` programs, accessibility snapshots, and
//                  a self-learning per-site memory (observed pages, states,
//                  actions, pitfalls) that makes repeat visits cheaper.
//
// The tool shuttles validated CLI invocations through /api/webcmd, which
// supervises the whole host chain (Xvfb :99 → webcmd daemon → CLI) and
// enforces an argument whitelist. Sessions auto-attach per conversation:
// the first browser action transparently creates one and it is reused for
// the whole conversation (cookies/localStorage persist within the session's
// profile), so the model never has to juggle session ids by hand.

import { registerTool } from "./registry";

const ENDPOINT = "/api/webcmd";

// ---------------------------------------------------------------------------
// Per-conversation session memory (module scope — the registry is a
// client-side singleton for the app lifetime).
// ---------------------------------------------------------------------------

const sessions = new Map<string, string>();

function convKey(ctx: { conversationId?: string; userId: string }): string {
  return ctx.conversationId ?? `user:${ctx.userId}`;
}

/** Human-safe session name: short, lowercase, dashed. */
function sessionName(): string {
  const rand = Math.random().toString(36).slice(2, 6);
  return `onyx-${Date.now().toString(36).slice(-5)}-${rand}`;
}

// ---------------------------------------------------------------------------
// Route transport.
// ---------------------------------------------------------------------------

interface WebcmdRouteResult {
  ok?: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  timedOut?: boolean;
  parsed?: unknown;
  repaired?: string[];
  error?: string;
}

async function webcmd(
  args: string[],
  opts: { stdin?: string; timeoutMs?: number } = {},
): Promise<WebcmdRouteResult> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      args,
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, stderr: `route ${res.status}: ${text.slice(0, 500)}` };
  }
  return res.json();
}

/** Extract a session id from `session create` output (JSON or plain text). */
function extractSessionId(r: WebcmdRouteResult): string | null {
  const p = r.parsed as { id?: string } | undefined;
  if (p && typeof p.id === "string") return p.id;
  const m = (r.stdout ?? "").match(/^\s*id:\s*(\S+)/m);
  return m ? m[1] : null;
}

async function ensureSession(
  ctx: { conversationId?: string; userId: string },
): Promise<{ session: string } | { error: string }> {
  const key = convKey(ctx);
  const existing = sessions.get(key);
  if (existing) return { session: existing };
  const r = await webcmd(["session", "create", sessionName(), "-f", "json"], { timeoutMs: 30_000 });
  const id = extractSessionId(r);
  if (!id) {
    return {
      error: `Could not create a webcmd session: ${(r.stderr || r.stdout || "").slice(0, 300)}`,
    };
  }
  sessions.set(key, id);
  return { session: id };
}

/** Session ids can die (explicit close / daemon reset) — recreate + retry once. */
function looksLikeDeadSession(r: WebcmdRouteResult): boolean {
  const hay = `${(r.stderr ?? "").toLowerCase()} ${(r.stdout ?? "").toLowerCase()}`;
  return /session.*(not found|unknown|closed|invalid|no longer)|(not found|unknown|closed|invalid|no longer).*session/.test(
    hay,
  );
}

const ACTIONS = ["run", "snapshot", "tabs", "session", "status", "memory"] as const;

const DESCRIPTION = `Drive a REAL stealth browser (CloakBrowser via webcmd) running locally on the server — persistent logged-in sessions, full interactivity, and self-learning site memory. No sandbox key required.

WHEN TO USE:
- Sites that need LOGIN or cookies kept across steps (the session + profile persist between calls).
- Anti-bot walls, Cloudflare, JS-heavy SPAs — the browser is a real headed Chromium with stealth fingerprints.
- Repeated visits to the same sites: webcmd quietly learns their pages/states/actions (sitemap memory) so later tasks are faster.
- Interactive reading/extraction that web_fetch cannot do (click, type, scroll, wait).

For simply READING static pages (articles, docs) prefer web_fetch — it is faster and cheaper.

ACTIONS:
- "run" (code) — execute a Playwright-style async JS program in the page. \`page\` is the live Playwright Page. Example: \`await page.goto("https://example.com"); return { title: await page.title() };\` — ALWAYS end with a return statement returning a JSON-serializable value (keep it small). The session persists across runs: navigate in one call, click/extract in the next.
- "snapshot" () — structured accessibility-tree snapshot of the current page (links/inputs with refs — great for planning clicks).
- "tabs" () — list open tabs in the session.
- "session" (operation: create|list|close) — manage browser sessions explicitly (usually unnecessary; one is auto-created per conversation).
- "status" () — health of the local browser chain (daemon, display, binary).
- "memory" (site, memoryOperation: show|list) — inspect webcmd's learned sitemap memory for a site (pages, states, actions, pitfalls, notes).

Playwright API available in "run": page.goto, page.click(selector), page.fill(selector, text), page.press, page.waitForTimeout, page.locator(...).textContent(), page.evaluate(fn), page.screenshot({path}) into ~/screenshots, page.title(), page.url(), and more. Prefer returning extracted DATA (title, text, hrefs, rows) over screenshots when possible.`;

interface WebcmdArgs {
  action: string;
  code?: string;
  session?: string;
  timeoutMs?: number;
  operation?: string;
  name?: string;
  site?: string;
  memoryOperation?: string;
}

registerTool(
  "webcmd",
  DESCRIPTION,
  {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [...ACTIONS],
        description: "The webcmd operation to perform.",
      },
      code: {
        type: "string",
        description:
          'JS program for action "run" (Playwright Page in `page`). Must end with a return of a JSON-serializable value.',
      },
      session: {
        type: "string",
        description: "Explicit webcmd session id (default: the conversation's auto-managed session).",
      },
      operation: {
        type: "string",
        enum: ["create", "list", "close"],
        description: 'Sub-operation for action "session".',
      },
      name: { type: "string", description: 'Name for session create (default: auto).' },
      site: {
        type: "string",
        description: 'Site key for action "memory" (e.g. "hn", "reddit").',
      },
      memoryOperation: {
        type: "string",
        enum: ["show", "list"],
        description: 'Memory sub-operation for action "memory" (default "show").',
      },
      timeoutMs: {
        type: "number",
        description: 'Run budget in ms for action "run" (default 90000, max 240000).',
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async (args: Record<string, unknown>, ctx) => {
    const a = args as WebcmdArgs;
    const action = String(a.action ?? "");
    if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) {
      return { error: `Unknown action: ${action}` };
    }

    // ---- status -----------------------------------------------------------
    if (action === "status") {
      const r = await webcmd(["doctor"], { timeoutMs: 45_000 });
      const lines = (r.stdout ?? "")
        .split("\n")
        .filter((l) => /^\[(OK|FAIL)\]/.test(l.trim()) || /Daemon:|Runtime:|Browser binary:|Connectivity:/.test(l))
        .join("\n");
      const sid = sessions.get(convKey(ctx));
      return {
        kind: "webcmd",
        action,
        ok: r.ok && !/\[FAIL\]/.test(r.stdout ?? ""),
        health: lines || r.stdout?.slice(0, 800) || r.stderr?.slice(0, 300),
        ...(sid ? { session: sid } : {}),
      };
    }

    // ---- session management ------------------------------------------------
    if (action === "session") {
      const op = a.operation ?? "list";
      if (op === "create") {
        const r = await webcmd(["session", "create", a.name || sessionName(), "-f", "json"], {
          timeoutMs: 30_000,
        });
        const id = extractSessionId(r);
        if (!id) {
          return { kind: "webcmd", action, error: (r.stderr || r.stdout || "create failed").slice(0, 400) };
        }
        sessions.set(convKey(ctx), id);
        return { kind: "webcmd", action, ok: true, session: id, note: "Session created and attached to this conversation." };
      }
      if (op === "list") {
        const r = await webcmd(["session", "list", "-f", "json"], { timeoutMs: 30_000 });
        return { kind: "webcmd", action, ok: r.ok, sessions: r.parsed ?? r.stdout?.slice(0, 4000) };
      }
      if (op === "close") {
        const sid = a.session || sessions.get(convKey(ctx));
        if (!sid) return { kind: "webcmd", action, error: "No session to close." };
        const r = await webcmd(["session", "close", sid], { timeoutMs: 30_000 });
        // Drop any map entry pointing at the closed session.
        for (const [k, v] of sessions) if (v === sid) sessions.delete(k);
        return { kind: "webcmd", action, ok: r.ok, closed: sid, detail: r.parsed ?? r.stdout?.slice(0, 500) };
      }
      return { error: `Unknown session operation: ${op}` };
    }

    // ---- memory ------------------------------------------------------------
    if (action === "memory") {
      if (!a.site) return { error: "site is required for action 'memory' (e.g. 'hn', 'reddit')." };
      const memOp = a.memoryOperation ?? "show";
      const r = await webcmd(["site", "memory", memOp, a.site, "-f", "json"], { timeoutMs: 30_000 });
      return {
        kind: "webcmd",
        action,
        ok: r.ok,
        site: a.site,
        memory: r.parsed ?? r.stdout?.slice(0, 12_000) ?? r.stderr?.slice(0, 400),
      };
    }

    // ---- browser actions (run / snapshot / tabs) ---------------------------
    let sid = a.session || sessions.get(convKey(ctx)) || null;
    if (!sid) {
      const ensured = await ensureSession(ctx);
      if ("error" in ensured) return { kind: "webcmd", action, error: ensured.error };
      sid = ensured.session;
    }

    const execBrowser = async (session: string): Promise<WebcmdRouteResult> => {
      if (action === "run") {
        const budget = Math.min(Math.max(Number(a.timeoutMs) || 90_000, 20_000), 240_000);
        return webcmd(
          ["--session", session, "browser", "run", "--stdin", "--timeout", String(budget)],
          { stdin: a.code, timeoutMs: Math.min(budget + 40_000, 280_000) },
        );
      }
      if (action === "snapshot") {
        return webcmd(["--session", session, "browser", "snapshot"], { timeoutMs: 90_000 });
      }
      return webcmd(["--session", session, "browser", "tabs"], { timeoutMs: 45_000 });
    };

    if (action === "run" && (!a.code || !a.code.trim())) {
      return { error: "code is required for action 'run' (Playwright-style JS, ending with a return)." };
    }

    let r = await execBrowser(sid);

    // Dead session? (daemon restart / explicit close wipes session state)
    // Recreate once, bind a page to it, and retry transparently.
    if (!r.ok && looksLikeDeadSession(r)) {
      const fresh = await webcmd(["session", "create", sessionName(), "-f", "json"], {
        timeoutMs: 30_000,
      });
      const id = extractSessionId(fresh);
      if (id) {
        sessions.set(convKey(ctx), id);
        sid = id;
        if (action !== "run") {
          // snapshot/tabs need a live page — run a no-op program that
          // opens one in the fresh session first.
          await webcmd(
            ["--session", sid, "browser", "run", "--stdin", "--timeout", "30000"],
            { stdin: "return true;", timeoutMs: 60_000 },
          );
        }
        r = await execBrowser(sid);
      }
    }

    const parsed = r.parsed as Record<string, unknown> | undefined;
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      return {
        kind: "webcmd",
        action,
        session: sid,
        error: (parsed.error as { message?: string; code?: string })?.message ?? JSON.stringify(parsed.error).slice(0, 600),
      };
    }

    return {
      kind: "webcmd",
      action,
      session: sid,
      ok: r.ok,
      ...(parsed ?? (r.stdout ? { raw: r.stdout.slice(0, 12_000) } : {})),
      ...(r.stderr ? { stderr: r.stderr.slice(0, 800) } : {}),
      ...(r.timedOut ? { timedOut: true } : {}),
      ...(r.repaired?.length ? { repaired: r.repaired } : {}),
    };
  },
  false,
  "web",
);

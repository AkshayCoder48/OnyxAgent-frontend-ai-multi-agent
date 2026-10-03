"use client";

/**
 * OnyxCode diagnostics + browser-eval tools (OnyxCode PRD §5–§37) — ALL
 * category "code", so the request-scoped exposure (request-scoping.ts)
 * keeps every one of them out of normal OnyxAgent turns.
 *
 *   browser_eval      — execute real JavaScript against the RUNNING preview
 *                       (the headless Chromium web-session driver) and get
 *                       back the serialized result (§5–§9)
 *   inspect_elements  — the interactive-element inventory of the running
 *                       preview: tag/selector/text/role/box, the data behind
 *                       element tagging (§11–§14)
 *   run_lint          — detect + run the project's lint setup (§23)
 *   run_typecheck     — tsc --noEmit / the project's typecheck script (§24)
 *   run_build         — detect the package manager + run the build (§25)
 *   run_tests         — detect the test framework (Playwright / Vitest /
 *                       Jest / Cypress / test script) and run it (§20–§22)
 *   run_diagnostics   — the "check everything" orchestrator: runs the
 *                       APPLICABLE checks and reports each honestly (§31)
 *
 * Everything executes in the E2B sandbox against /home/user/projects/<app>
 * (the same workspace create_app/start_preview write to) and streams real
 * output live via ctx.onToolOutput. Nothing is fabricated — a skipped check
 * says it was skipped and why.
 */

import { registerTool, type ToolContext } from "./registry";
import { type E2BClient } from "@/lib/e2b/client";
import { codeSandboxForCtx } from "@/lib/e2b/sandbox-rotation";
import { bumpWorkspaceVersion, getWorkspaceFsVersion } from "./workspace-snapshot";
import { webSession } from "./code_web_session";
import { findPreviewSession, usePreviewSessionStore } from "@/stores/preview-session-store";
import { cacheBustedUrl } from "@/lib/code/preview-ops";
import { getLastSandboxWriteAt } from "@/lib/code/workspace-activity";

const NO_KEY_ERROR =
  "This tool requires an E2B Sandbox API key. Add one in Settings → Config → E2B Sandbox.";

const PROJECTS_ROOT = "/home/user/projects";

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/** The minimal package.json surface the detectors read (loose by design —
 *  unknown keys are ignored, missing keys are undefined). */
interface PackageJson {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
}

interface ProjectProbe {
  root: string;
  appName: string;
  pkg: PackageJson;
  pm: "bun" | "pnpm" | "yarn" | "npm";
}

/** Sanitize a user/model-supplied app name into a safe path segment. */
function safeAppName(name: string): string | null {
  const n = (name ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!n || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(n) || n.includes("..")) return null;
  return n;
}

/**
 * Resolve the project root + package.json + package manager for this chat's
 * app. Preference: an explicit `project` name → the chat's preview session
 * (ONE CODE CHAT = ONE APP) → the only project in the workspace.
 */
async function probeProject(
  ctx: ToolContext,
  client: E2BClient,
  projectName?: string,
): Promise<ProjectProbe | { error: string }> {
  let appName: string | null = null;

  if (projectName) {
    const safe = safeAppName(projectName);
    if (!safe) return { error: `Invalid project name: ${projectName}` };
    appName = safe;
  } else {
    const session = findPreviewSession(
      usePreviewSessionStore.getState().sessions,
      ctx.conversationId ?? null,
    );
    if (session?.name) {
      appName = session.name;
    }
  }

  if (!appName) {
    const ls = await client.exec(`ls -1 ${PROJECTS_ROOT} 2>/dev/null`, { timeout: 15 });
    const dirs = ls.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (dirs.length === 0) {
      return { error: "No projects found in the workspace — create an app first (create_app)." };
    }
    if (dirs.length > 1) {
      return {
        error: `Multiple projects found (${dirs.join(", ")}) — pass the 'project' parameter.`,
      };
    }
    appName = dirs[0]!;
  }

  const root = `${PROJECTS_ROOT}/${appName}`;
  const pkgRaw = await client.exec(`cat ${root}/package.json 2>/dev/null`, { timeout: 15 });
  let pkg: PackageJson = {};
  if (pkgRaw.exit_code === 0 && pkgRaw.stdout.trim()) {
    try {
      pkg = JSON.parse(pkgRaw.stdout);
    } catch {
      pkg = {};
    }
  }

  // Package manager detection from the lockfile (§25 — never hardcode npm).
  const locks = await client.exec(
    `cd ${root} && for f in bun.lockb bun.lock pnpm-lock.yaml yarn.lock package-lock.json; do test -f "$f" && echo "$f" && break; done`,
    { timeout: 15 },
  );
  const lock = locks.stdout.trim();
  const pm: ProjectProbe["pm"] = lock.startsWith("bun")
    ? "bun"
    : lock.startsWith("pnpm")
      ? "pnpm"
      : lock.startsWith("yarn")
        ? "yarn"
        : "npm";

  return { root, appName, pkg, pm };
}

/** Run one command in the project root, streaming output live. */
async function runProjectCommand(
  client: E2BClient,
  root: string,
  command: string,
  opts: {
    timeout?: number;
    onLine?: (line: string, stream: "stdout" | "stderr") => void;
    envs?: Record<string, string>;
  } = {},
): Promise<{ command: string; exit_code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  for await (const chunk of client.runCommandStream(command, {
    cwd: root,
    timeout: opts.timeout ?? 240,
    ...(opts.envs && Object.keys(opts.envs).length > 0 ? { envs: opts.envs } : {}),
  })) {
    if (chunk.type === "stdout" && chunk.data) {
      stdout += chunk.data;
      if (opts.onLine) {
        for (const l of chunk.data.split("\n")) if (l.trim()) opts.onLine(l, "stdout");
      }
    } else if (chunk.type === "stderr" && chunk.data) {
      stderr += chunk.data;
      if (opts.onLine) {
        for (const l of chunk.data.split("\n")) if (l.trim()) opts.onLine(l, "stderr");
      }
    } else if (chunk.type === "result") {
      exitCode = chunk.exit_code ?? 0;
    }
  }
  return {
    command,
    exit_code: exitCode ?? -1,
    stdout: stdout.length > 60_000 ? stdout.slice(0, 60_000) + "\n… (truncated)" : stdout,
    stderr: stderr.length > 30_000 ? stderr.slice(0, 30_000) + "\n… (truncated)" : stderr,
  };
}

/** First line / first 70 chars of the evaluated code — for live progress. */
function codePreview(code: string): string {
  const first = code.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return first.length > 70 ? first.slice(0, 70) + "…" : first;
}

/**
 * Ensure the web-session driver is up AND (for preview targets) that the
 * page is sitting on this chat's running preview. Returns the local URL the
 * driver navigated to, or an honest error.
 */
async function ensurePageOnTarget(
  client: E2BClient,
  ctx: ToolContext,
  opts: {
    target?: string;
    url?: string;
    onProgress?: (line: string) => void;
  },
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const { ensureDriver, sendCommand } = webSession;
  const booted = await ensureDriver(client, opts.onProgress);
  if (!booted.ok) return { ok: false, error: booted.error };

  // Resolve the target URL.
  let targetUrl: string | null = null;
  if (opts.url) {
    targetUrl = opts.url;
  } else if (opts.target !== "current_page") {
    const session = findPreviewSession(
      usePreviewSessionStore.getState().sessions,
      ctx.conversationId ?? null,
    );
    if (!session || session.status !== "running" || !session.port) {
      return {
        ok: false,
        error:
          "No preview is running for this chat. Start one first (start_preview), or pass target: 'current_page' to evaluate against whatever page the web session is on, or pass an explicit url.",
      };
    }
    // The driver runs INSIDE the same sandbox as the dev server — the
    // sandbox-local URL is the honest, direct target.
    targetUrl = `http://localhost:${session.port}`;
  }

  if (targetUrl) {
    const status = await sendCommand(client, { action: "status" }, { timeoutMs: 20_000 });
    const current = typeof status.url === "string" ? status.url : null;
    const onTarget = !!current && current.startsWith(targetUrl);
    // PAGE-FRESHNESS GATE (the "AI can't see errors" fix): a page whose URL
    // already matches the target is NOT proof it shows the current app — if
    // project files were written after it loaded, the headless page may
    // still render the OLD build (HMR dies with every dev-server restart;
    // wholesale page rewrites defeat fast-refresh), so its console/network
    // captures would miss the real app's errors (e.g.
    // "__webpack_modules__[moduleId] is not a function" chunk crashes).
    //
    // TWO staleness signals, because the in-memory fsVersion pair resets on
    // every web-app reload while the driver's page survives across turns:
    //   (a) fsVersion  — writes since the page loaded, THIS session;
    //   (b) wall-clock — the PERSISTED last-write stamp vs the page's
    //       persisted load stamp: catches a page loaded during a PREVIOUS
    //       turn before this turn's writes (the "stale tab" that kept
    //       evaluating the scaffold page while the real app was built).
    const lastWrite = getLastSandboxWriteAt();
    const pageLoaded = webSession.pageLoadedAt();
    const stale =
      onTarget &&
      (getWorkspaceFsVersion() > webSession.pageFsVersion() ||
        (lastWrite > 0 && pageLoaded > 0 && lastWrite > pageLoaded) ||
        pageLoaded === 0);
    if (!onTarget) {
      opts.onProgress?.(`TARGET ${targetUrl}`);
      // Cache-busted so no layer (driver browser cache included) can answer
      // with a stale snapshot of an earlier build.
      const nav = await sendCommand(
        client,
        { action: "navigate", url: cacheBustedUrl(targetUrl) },
        { timeoutMs: 60_000 },
      );
      if (nav.ok === false) {
        return {
          ok: false,
          error: `Navigation to ${targetUrl} failed — ${String(nav.error ?? "")}`,
        };
      }
      webSession.markPageLoaded();
    } else if (stale) {
      opts.onProgress?.(
        `Reloading ${current} — the project files or the dev server changed since this page was loaded (stale-page guard so you see the REAL app, not the old build).`,
      );
      // Re-goto the CURRENT url (preserves the AI's sub-page position) —
      // page.goto on the same URL forces a full reload, cache-busted so the
      // reload can never be answered from any cache.
      const nav = await sendCommand(
        client,
        { action: "navigate", url: cacheBustedUrl(current!) },
        { timeoutMs: 60_000 },
      );
      if (nav.ok === false) {
        return {
          ok: false,
          error: `Reloading ${current} failed — ${String(nav.error ?? "")}`,
        };
      }
      webSession.markPageLoaded();
    } else {
      opts.onProgress?.(`TARGET ${targetUrl} (already loaded, fresh)`);
    }
  }

  return { ok: true, url: targetUrl ?? "current page" };
}

/** Env-var injection (mirrors run_terminal): real values into the sandbox. */
function envsFor(ctx: ToolContext): Record<string, string> | undefined {
  return ctx.envVars && Object.keys(ctx.envVars).length > 0 ? ctx.envVars : undefined;
}

/* ------------------------------------------------------------------ */
/* Tool: browser_eval (PRD §5–§10)                                     */
/* ------------------------------------------------------------------ */

registerTool(
  "browser_eval",
  `Execute JavaScript inside the LIVE application preview and get back the REAL result — DOM queries, element inspection, computed styles, form values, app state, localStorage, layout measurements. This runs in the actual running app (the chat's preview), never a mock.

Examples:
- document.querySelectorAll("button").length
- [...document.querySelectorAll("input")].map(x => ({ name: x.name, type: x.type, value: x.value }))
- getComputedStyle(document.querySelector(".btn")).backgroundColor
- JSON.stringify(Object.keys(localStorage))

Returns a serialized result: primitives, objects, arrays and DOM-derived info come back as plain data; DOM elements return { tag, id, classes, text, box }; Promises are awaited; circular/non-serializable values degrade gracefully instead of crashing. Detected console errors/warnings from the page ride along in the result, and network failures (4xx/5xx) are captured too.`,
  {
    type: "object",
    properties: {
      code: {
        type: "string",
        description:
          'JavaScript expression or statements to evaluate in the page. Examples: \'document.querySelectorAll("button").length\', \'{ x: window.innerWidth, y: window.innerHeight }\'.',
      },
      target: {
        type: "string",
        enum: ["current_preview", "current_page"],
        description:
          "current_preview (default): the running app preview for this chat. current_page: whatever page the web session is currently on.",
      },
      url: {
        type: "string",
        description: "Optional explicit URL (http://localhost:PORT or a public https URL) instead of the preview target.",
      },
    },
    required: ["code"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const code = String(args.code ?? "");
    if (!code.trim()) return { error: "'code' is required." };
    const target = String(args.target ?? "current_preview");

    const sbx = await codeSandboxForCtx(ctx);
    if (!sbx) return { error: NO_KEY_ERROR };
    const client = sbx.client;

    const progress = (line: string) => ctx.onToolOutput?.("", line, "stdout");
    const page = await ensurePageOnTarget(client, ctx, {
      target,
      url: args.url ? String(args.url) : undefined,
      onProgress: progress,
    });
    if (!page.ok) return { error: page.error };

    progress(`EXECUTING ${codePreview(code)}`);
    const result = await webSession.sendCommand(
      client,
      { action: "eval", code },
      { timeoutMs: 60_000 },
    );

    // Ride-along diagnostics (§27–§28): recent console + network failures.
    const consoleRes = await webSession.sendCommand(
      client,
      { action: "console", limit: 5 },
      { timeoutMs: 20_000 },
    );
    const networkRes = await webSession.sendCommand(
      client,
      { action: "network", limit: 5 },
      { timeoutMs: 20_000 },
    );

    const ok = result.ok !== false;
    const value = result.value;
    let summary: string;
    if (!ok) {
      summary = String(result.error ?? "evaluation failed");
    } else if (Array.isArray(value)) {
      summary = `${value.length} item${value.length === 1 ? "" : "s"} returned`;
    } else if (value && typeof value === "object") {
      summary = "object returned";
    } else {
      summary = `result: ${String(value)}`.slice(0, 200);
    }
    progress(ok ? `RESULT ${summary}` : `ERROR ${summary}`);

    // Keep the model-visible payload bounded but useful.
    const payload = JSON.stringify(value);
    const bounded =
      payload && payload.length > 24_000
        ? `${payload.slice(0, 24_000)}… (truncated)`
        : payload;

    return {
      kind: "browser_eval",
      ok,
      url: page.url,
      ...(ok
        ? { result: bounded === undefined ? null : safeJsonParse(bounded) }
        : { error: summary }),
      console: Array.isArray(consoleRes.entries) ? consoleRes.entries : [],
      network: Array.isArray(networkRes.entries) ? networkRes.entries : [],
    };
  },
  false,
  "code",
);

/** Parse truncated JSON back to data; fall back to the raw string. */
function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/* ------------------------------------------------------------------ */
/* Tool: inspect_elements (PRD §11–§14)                                */
/* ------------------------------------------------------------------ */

registerTool(
  "inspect_elements",
  `Get the interactive-element inventory of the running app preview: every visible button, link, input, select, textarea and ARIA-role control with a stable CSS selector, tag, id, classes, text, role, name and bounding box. This is how you reference a specific element in the UI before interacting with it (manage_web_session click/type take these selectors) or when discussing a specific element the user pointed at. Runs against the chat's live preview by default.`,
  {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Max elements to return (default 60, max 200).",
      },
      target: {
        type: "string",
        enum: ["current_preview", "current_page"],
        description: "current_preview (default) or the page the web session is on.",
      },
    },
    additionalProperties: false,
  },
  async (args, ctx) => {
    const sbx = await codeSandboxForCtx(ctx);
    if (!sbx) return { error: NO_KEY_ERROR };
    const client = sbx.client;

    const progress = (line: string) => ctx.onToolOutput?.("", line, "stdout");
    const page = await ensurePageOnTarget(client, ctx, {
      target: String(args.target ?? "current_preview"),
      onProgress: progress,
    });
    if (!page.ok) return { error: page.error };

    const limit = Math.max(1, Math.min(200, Number(args.limit) || 60));
    const result = await webSession.sendCommand(
      client,
      { action: "els", limit },
      { timeoutMs: 45_000 },
    );
    const elements = Array.isArray(result.elements) ? result.elements : [];
    progress(`FOUND ${elements.length} interactive elements`);
    return {
      kind: "elements",
      ok: result.ok !== false,
      url: page.url,
      count: elements.length,
      elements,
    };
  },
  false,
  "code",
);

/* ------------------------------------------------------------------ */
/* Tool: run_lint (PRD §23)                                            */
/* ------------------------------------------------------------------ */

async function detectLintCommand(
  client: E2BClient,
  probe: ProjectProbe,
): Promise<string | null> {
  if (probe.pkg?.scripts?.lint) return `${probe.pm} run lint`;
  const cfg = await client.exec(
    `cd ${probe.root} && for f in eslint.config.js eslint.config.mjs eslint.config.cjs eslint.config.ts .eslintrc .eslintrc.json .eslintrc.js .eslintrc.cjs biome.json biome.jsonc oxlint.json .oxlintrc.json; do test -f "$f" && echo "$f" && break; done`,
    { timeout: 15 },
  );
  const found = cfg.stdout.trim();
  if (found.startsWith("eslint.config") || found.startsWith(".eslintrc")) return "npx eslint .";
  if (found.startsWith("biome")) return "npx biome check .";
  if (found.startsWith("oxlint") || found.startsWith(".oxlintrc")) return "npx oxlint .";
  const devDeps = probe.pkg?.devDependencies ?? {};
  if (devDeps.eslint) return "npx eslint .";
  if (devDeps.biome) return "npx biome check .";
  if (devDeps.oxlint) return "npx oxlint .";
  return null;
}

registerTool(
  "run_lint",
  "Run the project's linter and return the real diagnostics. Detects the existing setup first — a `lint` script, or ESLint / Biome / oxlint config — and runs the right command (never forces a specific tool). Use the reported errors/warnings to fix the source files.",
  {
    type: "object",
    properties: {
      project: { type: "string", description: "App name (optional — defaults to this chat's app)." },
    },
    additionalProperties: false,
  },
  async (args, ctx) => {
    const sbx = await codeSandboxForCtx(ctx);
    if (!sbx) return { error: NO_KEY_ERROR };
    const client = sbx.client;

    const probed = await probeProject(ctx, client, args.project as string | undefined);
    if ("error" in probed) return { error: probed.error };
    const { root } = probed;

    const command = await detectLintCommand(client, probed);
    if (!command) {
      return {
        kind: "lint",
        status: "skipped",
        reason: "No lint setup detected (no lint script, no ESLint/Biome/oxlint config).",
      };
    }

    ctx.onToolOutput?.("", `LINT ${command}`, "stdout");
    const run = await runProjectCommand(client, root, command, {
      timeout: 300,
      onLine: (l, s) => ctx.onToolOutput?.("", l, s),
      envs: envsFor(ctx),
    });
    bumpWorkspaceVersion();
    const status = run.exit_code === 0 ? "passed" : "failed";
    ctx.onToolOutput?.("", `LINT ${status} (exit ${run.exit_code})`, "stdout");
    return {
      kind: "lint",
      status,
      command: run.command,
      exit_code: run.exit_code,
      stdout: run.stdout,
      stderr: run.stderr,
    };
  },
  false,
  "code",
);

/* ------------------------------------------------------------------ */
/* Tool: run_typecheck (PRD §24)                                       */
/* ------------------------------------------------------------------ */

registerTool(
  "run_typecheck",
  "Run TypeScript type checking on the project and return the REAL diagnostics (file, line, message). Runs the project's `typecheck` script when present, else `tsc --noEmit`. Non-TypeScript projects report an honest skip.",
  {
    type: "object",
    properties: {
      project: { type: "string", description: "App name (optional — defaults to this chat's app)." },
    },
    additionalProperties: false,
  },
  async (args, ctx) => {
    const sbx = await codeSandboxForCtx(ctx);
    if (!sbx) return { error: NO_KEY_ERROR };
    const client = sbx.client;

    const probed = await probeProject(ctx, client, args.project as string | undefined);
    if ("error" in probed) return { error: probed.error };
    const { root, pkg } = probed;

    const hasTs = await client.exec(`test -f ${root}/tsconfig.json && echo YES || echo NO`, {
      timeout: 15,
    });
    const devDeps = pkg?.devDependencies ?? {};
    const isTs = hasTs.stdout.trim() === "YES" || Boolean(devDeps.typescript);

    let command: string | null = null;
    if (pkg?.scripts?.typecheck) {
      command = `${probed.pm} run typecheck`;
    } else if (isTs) {
      command = "npx tsc --noEmit";
    }
    if (!command) {
      return {
        kind: "typecheck",
        status: "skipped",
        reason: "Not a TypeScript project (no tsconfig.json / typescript dependency).",
      };
    }

    ctx.onToolOutput?.("", `TYPECHECK ${command}`, "stdout");
    const run = await runProjectCommand(client, root, command, {
      timeout: 360,
      onLine: (l, s) => ctx.onToolOutput?.("", l, s),
      envs: envsFor(ctx),
    });
    const status = run.exit_code === 0 ? "passed" : "failed";
    ctx.onToolOutput?.("", `TYPECHECK ${status} (exit ${run.exit_code})`, "stdout");
    return {
      kind: "typecheck",
      status,
      command: run.command,
      exit_code: run.exit_code,
      stdout: run.stdout,
      stderr: run.stderr,
    };
  },
  false,
  "code",
);

/* ------------------------------------------------------------------ */
/* Tool: run_build (PRD §25)                                           */
/* ------------------------------------------------------------------ */

registerTool(
  "run_build",
  "Build the project and report real success/failure with the full build log. Detects the package manager from the lockfile (bun / pnpm / yarn / npm) and runs the project's `build` script. Use this to verify the app actually compiles before calling it done.",
  {
    type: "object",
    properties: {
      project: { type: "string", description: "App name (optional — defaults to this chat's app)." },
    },
    additionalProperties: false,
  },
  async (args, ctx) => {
    const sbx = await codeSandboxForCtx(ctx);
    if (!sbx) return { error: NO_KEY_ERROR };
    const client = sbx.client;

    const probed = await probeProject(ctx, client, args.project as string | undefined);
    if ("error" in probed) return { error: probed.error };
    const { root, pkg, pm } = probed;

    if (!pkg?.scripts?.build) {
      return {
        kind: "build",
        status: "skipped",
        reason: "No build script in package.json.",
      };
    }
    const command = `${pm} run build`;
    ctx.onToolOutput?.("", `BUILD ${command}`, "stdout");
    const run = await runProjectCommand(client, root, command, {
      timeout: 480,
      onLine: (l, s) => ctx.onToolOutput?.("", l, s),
      envs: envsFor(ctx),
    });
    const status = run.exit_code === 0 ? "passed" : "failed";
    ctx.onToolOutput?.("", `BUILD ${status} (exit ${run.exit_code})`, "stdout");
    return {
      kind: "build",
      status,
      command: run.command,
      exit_code: run.exit_code,
      stdout: run.stdout,
      stderr: run.stderr,
    };
  },
  false,
  "code",
);

/* ------------------------------------------------------------------ */
/* Tool: run_tests (PRD §20–§22)                                       */
/* ------------------------------------------------------------------ */

async function detectTestCommand(
  client: E2BClient,
  probe: ProjectProbe,
): Promise<string | null> {
  const cfg = await client.exec(
    `cd ${probe.root} && for f in playwright.config.ts playwright.config.js playwright.config.mjs playwright.config.cts vitest.config.ts vitest.config.js vitest.config.mts jest.config.js jest.config.ts jest.config.cjs jest.config.mjs jest.config.json cypress.config.ts cypress.config.js; do test -f "$f" && echo "$f" && break; done`,
    { timeout: 15 },
  );
  const found = cfg.stdout.trim();
  if (found.startsWith("playwright")) return "npx playwright test";
  if (found.startsWith("vitest")) return "npx vitest run";
  if (found.startsWith("jest")) return "npx jest";
  if (found.startsWith("cypress")) return "npx cypress run";

  const devDeps = probe.pkg?.devDependencies ?? {};
  if (devDeps.playwright || devDeps["@playwright/test"]) return "npx playwright test";
  if (devDeps.vitest) return "npx vitest run";
  if (devDeps.jest) return "npx jest";

  const testScript = probe.pkg?.scripts?.test;
  if (testScript && !/^(echo|exit)/.test(testScript)) return `${probe.pm} run test`;
  return null;
}

registerTool(
  "run_tests",
  "Run the project's test suite. Detects the EXISTING framework first — Playwright, Vitest, Jest, Cypress (by config file or devDependency), or the package `test` script — and runs the right command. Never forces a framework the project doesn't use. E2E tests run against the app inside the sandbox.",
  {
    type: "object",
    properties: {
      project: { type: "string", description: "App name (optional — defaults to this chat's app)." },
      file: {
        type: "string",
        description: "Optional: run only this test file (path relative to the project root).",
      },
    },
    additionalProperties: false,
  },
  async (args, ctx) => {
    const sbx = await codeSandboxForCtx(ctx);
    if (!sbx) return { error: NO_KEY_ERROR };
    const client = sbx.client;

    const probed = await probeProject(ctx, client, args.project as string | undefined);
    if ("error" in probed) return { error: probed.error };
    const { root } = probed;

    let command = await detectTestCommand(client, probed);
    if (!command) {
      return {
        kind: "tests",
        status: "skipped",
        reason:
          "No test setup detected (no Playwright/Vitest/Jest/Cypress config or dependency, no test script).",
      };
    }
    const file = String(args.file ?? "").trim();
    if (file && command.startsWith("npx ")) {
      const safe = file.replace(/[^\w./-]/g, "");
      command = `${command} ${safe}`;
    }

    ctx.onToolOutput?.("", `TESTS ${command}`, "stdout");
    const run = await runProjectCommand(client, root, command, {
      timeout: 480,
      onLine: (l, s) => ctx.onToolOutput?.("", l, s),
      envs: envsFor(ctx),
    });
    const status = run.exit_code === 0 ? "passed" : "failed";
    ctx.onToolOutput?.("", `TESTS ${status} (exit ${run.exit_code})`, "stdout");
    return {
      kind: "tests",
      status,
      command: run.command,
      exit_code: run.exit_code,
      stdout: run.stdout,
      stderr: run.stderr,
    };
  },
  false,
  "code",
);

/* ------------------------------------------------------------------ */
/* Tool: run_diagnostics (PRD §26–§32) — "check everything"            */
/* ------------------------------------------------------------------ */

interface CheckResult {
  name: string;
  status: "passed" | "failed" | "skipped";
  summary: string;
  detail?: string;
}

registerTool(
  "run_diagnostics",
  `Run a comprehensive health check on this chat's app and report every result honestly. Applicable checks are detected per project — never run blindly:

1. Type checking (TypeScript projects)
2. Lint (ESLint/Biome/oxlint when configured)
3. Unit/E2E tests (when a framework/test script exists — pass includeTests to include)
4. Build (pass includeBuild — slower)
5. Preview health (is the dev server actually serving)
6. Browser console errors (when the web-session driver is already installed)
7. Network failures (4xx/5xx + failed requests, same condition)

Each check reports passed / failed / skipped with a summary. Use this after significant changes to verify your work end-to-end instead of assuming it works.`,
  {
    type: "object",
    properties: {
      project: { type: "string", description: "App name (optional — defaults to this chat's app)." },
      includeTests: {
        type: "boolean",
        description: "Also run the test suite when one is detected (default false — tests are expensive).",
      },
      includeBuild: {
        type: "boolean",
        description: "Also run the production build (default false — slow).",
      },
    },
    additionalProperties: false,
  },
  async (args, ctx) => {
    const sbx = await codeSandboxForCtx(ctx);
    if (!sbx) return { error: NO_KEY_ERROR };
    const client = sbx.client;
    const progress = (line: string) => ctx.onToolOutput?.("", line, "stdout");

    const probed = await probeProject(ctx, client, args.project as string | undefined);
    if ("error" in probed) return { error: probed.error };
    const { root, pkg, pm, appName } = probed;
    const envs = envsFor(ctx);

    const checks: CheckResult[] = [];
    const totalStart = Date.now();

    // ── 1. Typecheck ───────────────────────────────────────────────────
    const hasTs = await client.exec(`test -f ${root}/tsconfig.json && echo YES || echo NO`, {
      timeout: 15,
    });
    const devDeps = pkg?.devDependencies ?? {};
    if (pkg?.scripts?.typecheck || hasTs.stdout.trim() === "YES" || devDeps.typescript) {
      progress("STEP 1 — Type checking");
      const cmd = pkg?.scripts?.typecheck ? `${pm} run typecheck` : "npx tsc --noEmit";
      const run = await runProjectCommand(client, root, cmd, {
        timeout: 360,
        onLine: (l, s) => ctx.onToolOutput?.("", l, s),
        envs,
      });
      checks.push({
        name: "Typecheck",
        status: run.exit_code === 0 ? "passed" : "failed",
        summary:
          run.exit_code === 0
            ? "No type errors"
            : `${run.stdout.split("\n").filter((l) => l.includes("error TS")).length || "Some"} type errors`,
        detail: run.stdout.slice(0, 4_000) || run.stderr.slice(0, 4_000),
      });
    } else {
      checks.push({ name: "Typecheck", status: "skipped", summary: "Not a TypeScript project" });
    }

    // ── 2. Lint ────────────────────────────────────────────────────────
    const lintCommand = await detectLintCommand(client, probed);
    if (lintCommand) {
      progress("STEP 2 — Lint");
      const run = await runProjectCommand(client, root, lintCommand, {
        timeout: 300,
        onLine: (l, s) => ctx.onToolOutput?.("", l, s),
        envs,
      });
      const problems = (run.stdout + run.stderr).split("\n").filter((l) => /\b(error|warning)\b/i.test(l)).length;
      checks.push({
        name: "Lint",
        status: run.exit_code === 0 ? "passed" : "failed",
        summary: run.exit_code === 0 ? "Clean" : `${problems || "Some"} problems`,
        detail: (run.stdout + run.stderr).slice(0, 4_000),
      });
    } else {
      checks.push({ name: "Lint", status: "skipped", summary: "No lint setup detected" });
    }

    // ── 3. Tests (opt-in) ──────────────────────────────────────────────
    if (args.includeTests) {
      const testCommand = await detectTestCommand(client, probed);
      if (testCommand) {
        progress("STEP 3 — Tests");
        const run = await runProjectCommand(client, root, testCommand, {
          timeout: 480,
          onLine: (l, s) => ctx.onToolOutput?.("", l, s),
          envs,
        });
        const m = (run.stdout + run.stderr).match(/(\d+)\s+passed/);
        checks.push({
          name: "Tests",
          status: run.exit_code === 0 ? "passed" : "failed",
          summary: m ? `${m[1]} tests passed` : run.exit_code === 0 ? "Passed" : "Failed",
          detail: (run.stdout + run.stderr).slice(0, 4_000),
        });
      } else {
        checks.push({ name: "Tests", status: "skipped", summary: "No test setup detected" });
      }
    } else {
      checks.push({ name: "Tests", status: "skipped", summary: "Not requested (includeTests)" });
    }

    // ── 4. Build (opt-in) ──────────────────────────────────────────────
    if (args.includeBuild) {
      if (pkg?.scripts?.build) {
        progress("STEP 4 — Build");
        const run = await runProjectCommand(client, root, `${pm} run build`, {
          timeout: 480,
          onLine: (l, s) => ctx.onToolOutput?.("", l, s),
          envs,
        });
        checks.push({
          name: "Build",
          status: run.exit_code === 0 ? "passed" : "failed",
          summary: run.exit_code === 0 ? "Build succeeded" : "Build failed",
          detail: (run.stderr || run.stdout).slice(0, 4_000),
        });
      } else {
        checks.push({ name: "Build", status: "skipped", summary: "No build script" });
      }
    } else {
      checks.push({ name: "Build", status: "skipped", summary: "Not requested (includeBuild)" });
    }

    // ── 5. Preview health ──────────────────────────────────────────────
    const session = findPreviewSession(
      usePreviewSessionStore.getState().sessions,
      ctx.conversationId ?? null,
    );
    if (session && session.status === "running" && session.port) {
      progress("STEP 5 — Preview health");
      const probe = await client.exec(
        `curl -s -o /dev/null -w "%{http_code}" --max-time 10 http://localhost:${session.port} || echo ERR`,
        { timeout: 20 },
      );
      const code = probe.stdout.trim();
      const healthy = code.startsWith("2") || code.startsWith("3");
      checks.push({
        name: "Preview",
        status: healthy ? "passed" : "failed",
        summary: healthy
          ? `Serving (HTTP ${code}) on port ${session.port}`
          : `Not serving (HTTP ${code || "unreachable"}) on port ${session.port}`,
      });
    } else {
      checks.push({
        name: "Preview",
        status: "skipped",
        summary: session ? `Preview is ${session.status}` : "No preview session for this chat",
      });
    }

    // ── 6 + 7. Browser console + network (only if the driver is ready) ──
    const driverReady = await client.exec(
      `test -f ${webSession.WS_DIR}/.ready && echo READY || echo NO`,
      { timeout: 15 },
    );
    if (driverReady.stdout.trim() === "READY") {
      progress("STEP 6 — Browser console + network");
      const page = await ensurePageOnTarget(client, ctx, { onProgress: progress });
      if (page.ok) {
        const consoleRes = await webSession.sendCommand(
          client,
          { action: "console", limit: 20, clear: true },
          { timeoutMs: 20_000 },
        );
        const networkRes = await webSession.sendCommand(
          client,
          { action: "network", limit: 20, clear: true },
          { timeoutMs: 20_000 },
        );
        const entries = Array.isArray(consoleRes.entries) ? consoleRes.entries : [];
        checks.push({
          name: "Browser console",
          status: entries.length === 0 ? "passed" : "failed",
          summary:
            entries.length === 0
              ? "No console errors/warnings"
              : `${entries.length} console errors/warnings`,
          detail: JSON.stringify(entries.slice(0, 10), null, 1).slice(0, 3_000),
        });
        const netEntries = Array.isArray(networkRes.entries) ? networkRes.entries : [];
        checks.push({
          name: "Network",
          status: netEntries.length === 0 ? "passed" : "failed",
          summary:
            netEntries.length === 0
              ? "No failed requests"
              : `${netEntries.length} failed requests (4xx/5xx/network)`,
          detail: JSON.stringify(netEntries.slice(0, 10), null, 1).slice(0, 3_000),
        });
      } else {
        checks.push({ name: "Browser console", status: "skipped", summary: page.error });
        checks.push({ name: "Network", status: "skipped", summary: page.error });
      }
    } else {
      checks.push({
        name: "Browser console",
        status: "skipped",
        summary: "Web-session driver not installed (start_web_session installs it on first use)",
      });
      checks.push({
        name: "Network",
        status: "skipped",
        summary: "Web-session driver not installed",
      });
    }

    bumpWorkspaceVersion();
    const failed = checks.filter((c) => c.status === "failed").length;
    const passed = checks.filter((c) => c.status === "passed").length;
    const skipped = checks.filter((c) => c.status === "skipped").length;
    progress(
      `DIAGNOSTICS ${failed === 0 ? "ALL HEALTHY" : `${failed} FAILING`} — ${passed} passed, ${failed} failed, ${skipped} skipped (${Math.round((Date.now() - totalStart) / 1000)}s)`,
    );

    return {
      kind: "diagnostics",
      ok: failed === 0,
      project: appName,
      root,
      checks,
      summary: { passed, failed, skipped },
    };
  },
  false,
  "code",
);

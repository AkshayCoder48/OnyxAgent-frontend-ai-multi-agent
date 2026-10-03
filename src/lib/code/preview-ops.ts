"use client";

/**
 * OnyxCode preview operations (OnyxCode PRD §4.3/§6 + Runtime PRD §2-8) — the
 * client-side engine behind `start_preview` / `manage_preview`, the Preview
 * panel's Start/Stop buttons, AND the per-chat preview lifecycle
 * (auto-start on entering a code chat, stop on leaving it — PRD §5-6/§73-76).
 * Shared so the agent's tools and the UI act on the exact same sandbox
 * processes and session records.
 *
 * ONE CODE CHAT = ONE APP: every preview is scoped by conversationId, its
 * session record keyed deterministically as pv-<conversationId>, and starts
 * are mutually exclusive per conversation (never double-start — concurrent
 * callers await the SAME in-flight start).
 *
 * Flow (start):
 *   1. resolve the E2B client — THIS chat's OWN sandbox ("separate" mode,
 *      one chat = one app = its own filesystem; the same sandbox the
 *      authoring tools wrote the project into),
 *   2. kill the conversation's previous dev server (restart hygiene),
 *   3. run the scaffold's install command (foreground, streamed progress),
 *   4. start the dev server as a DETACHED background command (start_server),
 *   5. resolve the public URL (get_host → https://{sandboxId}-{port}.e2b.dev),
 *   6. poll the URL until it responds (or timeout) — "running" is only ever
 *      recorded after the URL actually serves (PRD §7/§122),
 *   7. upsert the conversation's single PreviewSession record
 *      (localStorage-persisted → survives refresh).
 */

import { getE2BClient } from "@/lib/e2b/client";
import { getEffectiveE2BKey } from "@/lib/e2b/env-key";
import { useAuthStore } from "@/stores";
import {
  findPreviewSession,
  previewSessionIdFor,
  usePreviewSessionStore,
  type PreviewSession,
  type PreviewSessionStatus,
} from "@/stores/preview-session-store";
import { getScaffold, projectDir, type CodeScaffold } from "@/lib/code/scaffolds";
import { notifySandboxWrite } from "@/lib/code/workspace-activity";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Shared "no sandbox key" message (the agent tools + the UI restart path). */
export const NO_KEY_ERROR =
  "Previews require an E2B Sandbox API key. Add one in Settings → Config → E2B Sandbox.";

/**
 * Detect what kind of project lives at projects/<appName> by probing the
 * sandbox — used when start_preview is called without an explicit framework
 * (and no session history). Serving, say, a Next.js project with a static
 * file server (or a Node/Express app without its deps) renders a broken or
 * placeholder page instead of the real app the agent built, so we look at
 * the project files themselves.
 */
export async function detectScaffold(
  client: ReturnType<typeof getE2BClient>,
  appName: string,
): Promise<CodeScaffold> {
  const read = (rel: string) =>
    client.readFile(`${projectDir(appName)}/${rel}`).catch(() => null);

  const pkgRaw = await read("package.json");
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.next) return getScaffold("nextjs")!;
      if (deps.vite || deps["@vitejs/plugin-react"]) return getScaffold("vite-react")!;
      // OnyxCode supports only React+Vite / Next.js / static — an express
      // or python project falls through to the static scaffold rules.
    } catch {
      /* unparseable package.json — fall through */
    }
  }
  const indexHtml = await read("index.html");
  if (indexHtml) return getScaffold("static")!;
  return getScaffold("static")!;
}

export interface StartPreviewOptions {
  apiKey: string;
  appName: string;
  scaffold: CodeScaffold;
  /** Defaults to the scaffold's port. */
  port?: number;
  conversationId?: string;
  /** Progress lines streamed to the tool card / UI. */
  onProgress?: (line: string) => void;
}

export interface StartPreviewResult {
  ok: boolean;
  session?: PreviewSession;
  error?: string;
  /** True when an ALREADY-RUNNING healthy dev server was reused instead of
   *  killing + rebooting it (the anti-restart-churn path). */
  reused?: boolean;
  /** True when a dev server WAS running but was rebooted (it was stale —
   *  older than the newest project files — or the served page was a stale
   *  snapshot). Open tabs should be refreshed after a restart. */
  restarted?: boolean;
  /** True when the serving page is still the create_app PLACEHOLDER — the
   *  honest "the agent hasn't built the real app yet" flag surfaced by the
   *  start_preview tool so the model never mistakes it for the real app. */
  servingScaffoldPlaceholder?: boolean;
}

/** The full dev-server probe: is it up, answering, and — critically — was it
 * booted AFTER the newest project file was written?
 *
 * THE STALE-SERVER BUG this guards against: a dev server that booted while
 * the project still contained the create_app scaffold placeholder can keep
 * serving that STALE compiled output forever — HMR/websocket file-watching
 * is unreliable through the sandbox (Next.js dev even regenerates a wiped
 * `.next` from its in-memory module graph), so "process up + HTTP 200" is
 * NOT proof the served page matches the files on disk. The fix compares the
 * OLDEST matching server process's elapsed time (`ps -o etimes=`) against
 * the newest project source mtime (excluding node_modules/.next): if any
 * file changed AFTER the server booted, the server is stale and MUST be
 * restarted, or the preview keeps showing the scaffold page.
 */
async function probeDevServer(
  client: ReturnType<typeof getE2BClient>,
  appName: string,
  port: number,
): Promise<{ up: boolean; httpOk: boolean; stale: boolean; detail?: string }> {
  const safeMarker = `projects/${appName}`.replace(/-/g, "[-]");
  const probe = await client.exec(
    // All-in-one: PID list (oldest elapsed), newest source mtime, local HTTP.
    // Every field degrades independently — a missing ps/procps field never
    // breaks the rest of the probe.
    `PIDS=$(pgrep -f "${safeMarker}" 2>/dev/null | tr '\n' ' '); ` +
      `if [ -z "$PIDS" ]; then echo "NO_SERVER"; else ` +
      `OLDEST=$(ps -o etimes= -p $PIDS 2>/dev/null | tr -d ' ' | grep -E '^[0-9]+$' | sort -rn | head -n 1); ` +
      `NEWEST=$(find "/home/user/projects/${appName}" -path '*/node_modules' -prune -o -path '*/.next' -prune -o -path '*/.git' -prune -o -type f -printf '%T@\\n' 2>/dev/null | sort -rn | head -n 1 | cut -d. -f1); ` +
      `NOW=$(date +%s); ` +
      `CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://localhost:${port}" 2>/dev/null); ` +
      `echo "UP oldest=\${OLDEST:-?} newest=\${NEWEST:-0} now=\$NOW code=\${CODE:-ERR}"; fi`,
    { timeout: 25 },
  );
  const out = probe.stdout.trim();
  if (!out || out.startsWith("NO_SERVER") || !out.startsWith("UP")) {
    return { up: false, httpOk: false, stale: false, detail: out || "no server process" };
  }
  const fields = Object.fromEntries(
    out
      .split(/\s+/)
      .slice(1)
      .map((tok) => {
        const eq = tok.indexOf("=");
        return eq > 0 ? [tok.slice(0, eq), tok.slice(eq + 1)] : [tok, ""];
      }),
  );
  const code = String(fields.code ?? "ERR");
  const httpOk = code.startsWith("2") || code.startsWith("3");
  const elapsed = Number(fields.oldest);
  const newest = Number(fields.newest ?? 0);
  const now = Number(fields.now ?? 0);
  // Stale when a project file is NEWER than the server's boot (file changed
  // `elapsed` seconds ago at most, i.e. now-newest < elapsed). Unknown
  // elapsed/newest degrades to "not stale" (conservative reuse).
  const stale =
    Number.isFinite(elapsed) &&
    elapsed > 0 &&
    Number.isFinite(newest) &&
    newest > 0 &&
    Number.isFinite(now) &&
    now > 0 &&
    now - newest < elapsed;
  return { up: true, httpOk, stale, detail: out };
}

/* ------------------------------------------------------------------ */
/* Scaffold-placeholder detection (the "preview shows the scaffold      */
/* instead of the built app" honesty check)                              */
/* ------------------------------------------------------------------ */

/** Markers that identify the create_app PLACEHOLDER page (scaffolds.ts):
 * the "<AppName> is live." hero and the "Scaffolded by OnyxCode"
 * metadata/footer. When the SERVED page contains one but the project's
 * entry files on disk NO LONGER do, the server/proxy is serving a stale
 * snapshot of the scaffold — never the real app. */
const SCAFFOLD_MARKER_RE = /is live\.|Scaffolded by OnyxCode/i;

/** Does the page served at the (cache-busted) URL still render the create_app
 * placeholder? Returns null when it can't be determined (CORS-opaque hosts,
 * client-rendered SPAs whose raw HTML has no markers, network failure) —
 * callers treat null as "unknown, don't fail on it". */
async function servingScaffoldPlaceholder(url: string): Promise<boolean | null> {
  try {
    const r = await fetch(cacheBustedUrl(url), { cache: "no-store" });
    if (!r.ok) return null;
    const html = await r.text();
    if (!html || html.length < 200) return null;
    return SCAFFOLD_MARKER_RE.test(html);
  } catch {
    return null;
  }
}

/** Do the project's ENTRY files on disk still contain the scaffold markers?
 * (True = the agent hasn't replaced the placeholder yet — a scaffold-served
 * preview is then CORRECT. False = the real app is on disk.) */
async function diskStillHasScaffold(
  client: ReturnType<typeof getE2BClient>,
  appName: string,
): Promise<boolean> {
  const dir = projectDir(appName);
  const probe = await client.exec(
    `grep -l -e 'is live\\.' -e 'Scaffolded by OnyxCode' "${dir}/app/page.tsx" "${dir}/app/layout.tsx" "${dir}/index.html" "${dir}/src/App.jsx" 2>/dev/null | head -n 1`,
    { timeout: 15 },
  );
  return probe.stdout.trim().length > 0;
}

/** Append a unique cache-buster query so NO caching layer (browser cache,
 * iframe cache, E2B edge proxy) can answer with a stale snapshot. Unknown
 * query params are ignored by every supported scaffold (Next/Vite/static). */
export function cacheBustedUrl(url: string, token?: string): string {
  if (!url) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}_onyx=${encodeURIComponent(token ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`)}`;
}

/**
 * Is the URL actually SERVING? E2B's public port proxy answers every
 * request — a CLOSED port returns HTTP 502 {"…port is not open"} WITH
 * `access-control-allow-origin: *`, so a normal CORS fetch can read the
 * status: 2xx = serving, anything else = not (yet). The opaque no-cors
 * fallback only runs when the host sends no CORS headers at all (custom
 * preview hosts) — there, any network-level response counts as serving.
 * Every probe is CACHE-BUSTED: a proxy that serves a cached snapshot would
 * otherwise answer 200 for a page that no longer exists.
 */
export async function isUrlServing(url: string): Promise<boolean> {
  const probeUrl = cacheBustedUrl(url);
  try {
    const r = await fetch(probeUrl, { cache: "no-store" });
    return r.ok;
  } catch {
    try {
      await fetch(probeUrl, { mode: "no-cors", cache: "no-store" });
      return true;
    } catch {
      return false;
    }
  }
}

/** Poll a public preview URL until it actually serves (status-aware). */
export async function checkPreviewUrl(
  url: string,
  opts?: { timeoutMs?: number; onProgress?: (line: string) => void },
): Promise<boolean> {
  const timeoutMs = opts?.timeoutMs ?? 90_000;
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    attempt++;
    if (await isUrlServing(url)) {
      opts?.onProgress?.(`Preview URL is serving (attempt ${attempt}).`);
      return true;
    }
    if (attempt === 1) {
      opts?.onProgress?.("Waiting for the dev server to boot…");
    } else if (attempt % 5 === 0) {
      opts?.onProgress?.(`Still waiting for ${url} … (${Math.round((Date.now() - start) / 1000)}s)`);
    }
    await sleep(2_000);
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Start mutual-exclusion (Runtime PRD §6/§75 — never double-start)     */
/* ------------------------------------------------------------------ */

/** One in-flight start per conversation (awaited by every concurrent caller). */
const inflightStarts = new Map<string, Promise<StartPreviewResult>>();
/** Listeners notified whenever a start begins/ends (the Preview panel's
 *  "starting…" state subscribes here — including tool-driven starts). */
const startListeners = new Set<() => void>();

function notifyStartsChanged(): void {
  for (const listener of startListeners) listener();
}

/** Subscribe to start-in-flight changes. Returns an unsubscribe function. */
export function subscribePreviewStarts(listener: () => void): () => void {
  startListeners.add(listener);
  return () => {
    startListeners.delete(listener);
  };
}

/** Is a start already in flight for this conversation? */
export function isPreviewStartInFlight(conversationId: string): boolean {
  return inflightStarts.has(conversationId);
}

/** The in-flight start promise for a conversation, if any (the leave-the-
 *  workspace stop path awaits it so a mid-boot server is stopped once it
 *  lands instead of leaking). */
export function getInflightPreviewStart(
  conversationId: string,
): Promise<StartPreviewResult> | null {
  return inflightStarts.get(conversationId) ?? null;
}

/**
 * ONE start per conversation at a time: if a start is already in flight,
 * callers await ITS result instead of kicking off a second dev server.
 * Everything that starts a preview (the agent's start_preview tool, the
 * panel's Start button, the auto-start on entering a code chat) funnels
 * through here.
 */
export function startPreviewExclusive(
  conversationId: string | null | undefined,
  start: () => Promise<StartPreviewResult>,
): Promise<StartPreviewResult> {
  if (!conversationId) return start();
  const existing = inflightStarts.get(conversationId);
  if (existing) return existing;
  const run = start().finally(() => {
    inflightStarts.delete(conversationId);
    notifyStartsChanged();
  });
  inflightStarts.set(conversationId, run);
  notifyStartsChanged();
  return run;
}

export async function startPreview(opts: StartPreviewOptions): Promise<StartPreviewResult> {
  const { apiKey, appName, scaffold } = opts;
  const port = opts.port ?? scaffold.port;
  const progress = opts.onProgress;
  const conversationId = opts.conversationId ?? null;

  if (!scaffold.serverCommand) {
    return {
      ok: false,
      error: `The ${scaffold.label} scaffold has no preview server (CLI tools are run with run_terminal instead).`,
    };
  }

  try {
    // THIS chat's OWN sandbox — the dev server must boot in the same
    // isolated filesystem create_app / create_file_chunk wrote the project
    // into (one chat = one app). Without a conversationId this degenerates
    // to the legacy shared slot (defensive — warn loudly).
    if (!conversationId) {
      console.warn(
        "[preview] startPreview called without a conversationId — falling back to the shared sandbox",
      );
    }
    const client = getE2BClient(apiKey, conversationId, "separate");
    const cwd = scaffold.cwd(appName);

    // 0. SANDBOX SANITY — the project directory must exist in THIS sandbox.
    // (Sandboxes can be replaced mid-session — rotation, eviction, dead-
    // sandbox recovery — in which case files written earlier live in the
    // OLD sandbox. A doomed `cd` would start a server that dies instantly;
    // fail honestly so the agent re-creates the files here first.)
    const dirCheck = await client.exec(`test -d ${cwd} && echo EXISTS || echo MISSING`, {
      timeout: 15,
    });
    if (!dirCheck.stdout.includes("EXISTS")) {
      return {
        ok: false,
        error:
          `Project directory ${cwd} was not found in the current sandbox ` +
          "(the sandbox may have been replaced — files written earlier may live in a previous one). " +
          "Re-create the project files first (create_app or create_file_chunk), then start the preview again.",
      };
    }

    // 0.7. REUSE A HEALTHY, FRESH SERVER (the anti-restart-churn fix): if a
    // dev server for THIS app is already running, answering on the port, AND
    // was booted AFTER the newest project file was written, KEEP it.
    // Restarting unconditionally broke every already-open preview tab (the
    // old page kept chunk references from the previous webpack build and
    // crashed with "__webpack_modules__[moduleId] is not a function"), but
    // reusing a STALE server kept serving the scaffold placeholder forever —
    // so reuse now ALSO requires the server to be newer than every source
    // file (probeDevServer's mtime check). On reuse we only bump bootEpoch
    // (the panel remounts its iframe → shows the CURRENT app) and re-verify
    // the public URL — after confirming the served page is not the scaffold
    // placeholder while the real app is on disk (the stale-snapshot guard).
    const probe = await probeDevServer(client, appName, port);
    if (probe.up && probe.httpOk) {
      if (probe.stale) {
        progress?.(
          "The running dev server predates the newest project files (it would keep serving the OLD build) — restarting it…",
        );
      } else {
        progress?.("A dev server for this app is already running and healthy — reusing it (no restart, open tabs keep working).");
        const hostInfo = await client.getHostUrl(port);
        const live = await checkPreviewUrl(hostInfo.url, {
          timeoutMs: 30_000,
          onProgress: (line) => progress?.(line),
        });
        if (live) {
          // STALE-SNAPSHOT GUARD: if the URL serves the scaffold placeholder
          // while the project on disk no longer contains it, the preview is
          // pinned to a stale snapshot — restart once instead of recording a
          // lying "running".
          const servingScaffold = await servingScaffoldPlaceholder(hostInfo.url);
          if (servingScaffold === true) {
            const diskScaffold = await diskStillHasScaffold(client, appName);
            if (!diskScaffold) {
              progress?.(
                "The preview URL is serving the scaffold placeholder but the real app is on disk — restarting the dev server to shake the stale snapshot…",
              );
            } else {
              const session = await recordSession(conversationId, {
                appName,
                scaffold,
                port,
                url: hostInfo.url,
                sandboxId: hostInfo.sandboxId,
                command: `cd ${cwd} && ${scaffold.serverCommand!(appName, port)}`,
              });
              return { ok: true, session, reused: true, servingScaffoldPlaceholder: true };
            }
          } else {
            const session = await recordSession(conversationId, {
              appName,
              scaffold,
              port,
              url: hostInfo.url,
              sandboxId: hostInfo.sandboxId,
              command: `cd ${cwd} && ${scaffold.serverCommand!(appName, port)}`,
            });
            return { ok: true, session, reused: true };
          }
        }
        // Public URL not answering although localhost does (proxy hiccup)
        // — fall through to the full restart path, which re-exposes the port.
        progress?.("The public URL did not answer — restarting the dev server.");
      }
    }

    // ── FULL (RE)START PATH ────────────────────────────────────────────
    // At most one forced retry: a first boot that still serves the scaffold
    // placeholder (stale proxy snapshot / zombie server) gets ONE more
    // chance with a clean kill; a second failure is reported HONESTLY so the
    // agent stops flailing and can tell the user what is actually wrong.
    let lastError: string | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const boot = await bootPreviewServer({
        client,
        appName,
        scaffold,
        port,
        cwd,
        conversationId,
        onProgress: progress,
      });
      if (boot.ok) {
        return {
          ok: true,
          session: boot.session,
          restarted: attempt > 1 || probe.up,
          ...(boot.servingScaffoldPlaceholder ? { servingScaffoldPlaceholder: true } : {}),
        };
      }
      lastError = boot.error;
      // Retry only when the failure looks like a stale snapshot/served-build
      // problem (a missing directory or failed install will not heal itself).
      if (!boot.retryable) break;
      progress?.(`Attempt ${attempt} failed (${lastError}) — retrying once with a clean kill…`);
    }
    const session = findPreviewSession(usePreviewSessionStore.getState().sessions, conversationId);
    if (session) {
      usePreviewSessionStore.getState().markStatus(session.id, "error", lastError ?? undefined);
    }
    return { ok: false, error: lastError ?? "Failed to start the preview." };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/** Persist the conversation's single preview record (running). */
async function recordSession(
  conversationId: string | null,
  info: {
    appName: string;
    scaffold: CodeScaffold;
    port: number;
    url: string;
    sandboxId?: string;
    command: string;
  },
): Promise<PreviewSession> {
  const session: PreviewSession = {
    id: conversationId
      ? previewSessionIdFor(conversationId)
      : `pv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name: info.appName,
    framework: info.scaffold.key,
    frameworkLabel: info.scaffold.label,
    url: info.url,
    port: info.port,
    sandboxId: info.sandboxId ?? "",
    status: "running",
    command: info.command,
    createdAt: Date.now(),
    bootEpoch: Date.now(),
    ...(conversationId ? { conversationId } : {}),
  };
  usePreviewSessionStore.getState().upsert(session);
  // A completed start (fresh boot OR healthy reuse) invalidates every page
  // loaded from a PREVIOUS build generation — chunk ids change on reboot,
  // so stale pages crash with "__webpack_modules__[moduleId] is not a
  // function" on their next lazy chunk load. Publishing on the workspace
  // write bus (a) persists the wall-clock write stamp so browser_eval's
  // cross-turn stale-page gate fires, and (b) reloads the preview panel's
  // iframe once writes settle.
  notifySandboxWrite();
  return session;
}

/** Boot the dev server from scratch: clean kill → install → start → verify
 * (BOTH sandbox-localhost AND the public URL) → scaffold honesty check. */
async function bootPreviewServer(opts: {
  client: ReturnType<typeof getE2BClient>;
  appName: string;
  scaffold: CodeScaffold;
  port: number;
  cwd: string;
  conversationId: string | null;
  onProgress?: (line: string) => void;
}): Promise<
  | { ok: true; session: PreviewSession; servingScaffoldPlaceholder?: boolean }
  | { ok: false; error: string; retryable: boolean }
> {
  const { client, appName, scaffold, port, cwd, conversationId, onProgress: progress } = opts;

  if (!scaffold.serverCommand) {
    return {
      ok: false,
      retryable: false,
      error: `The ${scaffold.label} scaffold has no preview server.`,
    };
  }

  // 1. RESTART HYGIENE: kill every trace of the previous server — by PORT
  // first (the actual listener; next-server workers rewrite their process
  // titles so path-marker kills MISS them and they keep squatting on the
  // port serving the OLD build), then by project-path marker, then by this
  // scaffold's framework process names (safe: one sandbox = one chat = one
  // app), and wait for the port to actually be FREE before rebooting so the
  // fresh server can never hit EADDRINUSE against a zombie.
  try {
    await killPreviewProcesses(client, appName, port, scaffold.key);
  } catch {
    /* best-effort */
  }

  // 2. Install dependencies (foreground, streamed).
  if (scaffold.installCommand) {
    progress?.(`Installing dependencies (${scaffold.installCommand})…`);
    let installOk = true;
    let installErr = "";
    let tail = "";
    for await (const chunk of client.runCommandStream(scaffold.installCommand, {
      cwd,
      timeout: 280,
    })) {
      if ((chunk.type === "stdout" || chunk.type === "stderr") && chunk.data) {
        tail = (tail + chunk.data).slice(-800);
        if (chunk.type === "stderr") installErr += chunk.data;
        progress?.(chunk.data.trim().split("\n").pop() ?? "");
      } else if (chunk.type === "result") {
        installOk = (chunk.exit_code ?? 0) === 0;
      }
    }
    if (!installOk) {
      return {
        ok: false,
        retryable: false,
        error: `Dependency install failed (exit ${installOk ? 0 : 1}): ${installErr.slice(-400) || tail.slice(-400)}`,
      };
    }
    progress?.("Dependencies installed.");
  }

  // 3. Start the dev server (detached background command).
  const serverCmd = scaffold.serverCommand(appName, port);
  // The `cd <dir> &&` prefix puts the project path in the process's
  // command line so Stop can pkill by it.
  const wrappedCmd = `cd ${cwd} && ${serverCmd}`;
  progress?.(`Starting dev server: ${serverCmd}`);
  const started = await client.startServer(wrappedCmd, { cwd: "/home/user" });
  if (!started.started) {
    return { ok: false, retryable: true, error: "The sandbox refused to start the dev server." };
  }

  // 4. Resolve the public URL — and SANDBOX-CHECK it: startServer and
  // getHostUrl are separate server calls; if they resolve DIFFERENT
  // sandboxes (server-cache divergence), the URL would embed some OTHER
  // (stale) sandbox's app while our dev server boots alone here. That is
  // exactly the "preview shows the scaffold in the sidebar but the real app
  // in a new tab" / "proxy pinned to a stale snapshot" class of bugs —
  // fail honestly instead of recording a lying "running".
  const hostInfo = await client.getHostUrl(port);
  if (
    started.sandboxId &&
    hostInfo.sandboxId &&
    started.sandboxId !== hostInfo.sandboxId
  ) {
    return {
      ok: false,
      retryable: false,
      error:
        `Preview sandbox mismatch: the dev server started in sandbox ${started.sandboxId} ` +
        `but the public URL points at sandbox ${hostInfo.sandboxId} (a stale sandbox record). ` +
        "Retry the start in a moment — if it persists, stop the preview and start it again.",
    };
  }
  progress?.(`Public preview URL: ${hostInfo.url}`);

  // 5. Wait until BOTH endpoints actually serve — the sandbox-local port
  // (proof OUR dev server owns the port) and the public URL. "running" is
  // only recorded after both answer; a public URL that answers while
  // localhost is dead means the URL is pinned to a stale snapshot.
  const localLive = waitLocalServing(client, port, 90_000, (line) => progress?.(line));
  const publicLive = checkPreviewUrl(hostInfo.url, {
    timeoutMs: 90_000,
    onProgress: (line) => progress?.(line),
  });
  const [localOk, publicOk] = await Promise.all([localLive, publicLive]);

  if (!localOk && publicOk) {
    return {
      ok: false,
      retryable: false,
      error:
        `The public preview URL (${hostInfo.url}) answered, but the dev server is NOT listening ` +
        `on localhost:${port} in this chat's sandbox — the URL is serving a stale snapshot from a ` +
        "different/older sandbox, not this app. Stop the preview and start it again; if it persists the " +
        "E2B sandbox may need to be rotated (ask the user to restart it from Settings).",
    };
  }
  if (!localOk || !publicOk) {
    return {
      ok: false,
      retryable: true,
      error:
        "The server started but did not respond in time — it may still be booting; try start_preview again or refresh the preview panel.",
    };
  }

  // 6. SCAFFOLD HONESTY CHECK: never record "running" while the URL serves
  // the create_app placeholder and the real app is on disk. (Null = unknown
  // — e.g. client-rendered Vite shells — treated as fine.)
  let servingScaffold = false;
  const placeholder = await servingScaffoldPlaceholder(hostInfo.url);
  if (placeholder === true) {
    const diskScaffold = await diskStillHasScaffold(client, appName);
    if (!diskScaffold) {
      servingScaffold = true;
      return {
        ok: false,
        retryable: true,
        error:
          `The preview at ${hostInfo.url} is still serving the scaffold placeholder, not the built app ` +
          "(stale build/snapshot). A clean restart will be attempted.",
      };
    }
    // The placeholder IS the current on-disk app (the agent hasn't replaced
    // it yet) — honest "running" with a flag the tool surfaces to the agent.
    const session = await recordSession(conversationId, {
      appName,
      scaffold,
      port,
      url: hostInfo.url,
      sandboxId: hostInfo.sandboxId,
      command: wrappedCmd,
    });
    return { ok: true, session, servingScaffoldPlaceholder: true };
  }

  const session = await recordSession(conversationId, {
    appName,
    scaffold,
    port,
    url: hostInfo.url,
    sandboxId: hostInfo.sandboxId,
    command: wrappedCmd,
  });
  return { ok: true, session };
}

/** Poll localhost:PORT inside the sandbox until it answers 2xx/3xx. */
async function waitLocalServing(
  client: ReturnType<typeof getE2BClient>,
  port: number,
  timeoutMs: number,
  onProgress?: (line: string) => void,
): Promise<boolean> {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    attempt++;
    try {
      const r = await client.exec(
        `curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://localhost:${port} 2>/dev/null || echo ERR`,
        { timeout: 15 },
      );
      const code = r.stdout.trim();
      if (code.startsWith("2") || code.startsWith("3")) return true;
    } catch {
      /* sandbox hiccup — keep polling */
    }
    if (attempt === 1) onProgress?.("Waiting for the dev server to boot (sandbox-local check)…");
    await sleep(3_000);
  }
  return false;
}

/**
 * Restart THE CHAT's app from its persisted session record (Runtime PRD
 * §6/§75 — the auto-start on entering a code chat, and the panel's Start
 * button): resolve the E2B key + scaffold from the record (probing the
 * project files when the framework is unknown), then run the normal start
 * path — mutually exclusive per conversation, so a manual Start while an
 * auto-start is mid-flight simply awaits it. On failure the record flips to
 * an honest "error" state (PRD §122) and is KEPT so retry/auto-start still
 * work.
 */
export async function restartPreviewForConversation(
  conversationId: string,
  opts?: { onProgress?: (line: string) => void },
): Promise<StartPreviewResult> {
  const session = findPreviewSession(usePreviewSessionStore.getState().sessions, conversationId);
  if (!session) {
    return {
      ok: false,
      error: "No app project is recorded for this chat yet — ask OnyxCode to create one first.",
    };
  }
  const result = await startPreviewExclusive(conversationId, () =>
    startPreviewFromSession(session, conversationId, opts),
  );
  if (!result.ok) {
    usePreviewSessionStore
      .getState()
      .markStatus(session.id, "error", result.error ?? "Failed to start the preview.");
  }
  return result;
}

/** Resolve key + scaffold for a persisted session, then startPreview. */
async function startPreviewFromSession(
  session: PreviewSession,
  conversationId: string,
  opts?: { onProgress?: (line: string) => void },
): Promise<StartPreviewResult> {
  const userId = useAuthStore.getState().user?.id;
  const apiKey = userId ? await getEffectiveE2BKey(userId) : null;
  if (!apiKey) {
    return { ok: false, error: NO_KEY_ERROR };
  }
  // Prefer the framework recorded on the session; fall back to probing the
  // project files (covers legacy records with unknown frameworks) — in
  // THIS chat's own sandbox, where the project lives.
  let scaffold = getScaffold(session.framework);
  if (!scaffold) {
    const client = getE2BClient(apiKey, conversationId, "separate");
    scaffold = await detectScaffold(client, session.name);
  }
  return startPreview({
    apiKey,
    appName: session.name,
    scaffold,
    port: session.port || scaffold.port,
    conversationId,
    onProgress: opts?.onProgress,
  });
}

/** Per-scaffold process-name patterns for the LAST-RESORT kill layer —
 * safe because one sandbox = one chat = one app (a framework's processes in
 * THIS sandbox can only belong to this chat's preview). The patterns use the
 * BRACKET-TRICK (`[ ]`, `[-]`, `[.]`) so pkill's own command line — which
 * contains the pattern literally — can never match itself. */
const FRAMEWORK_KILL_PATTERNS: Record<string, string> = {
  nextjs: `next[ ]dev|next[-]server`,
  "vite-react": `v[i]te`,
  static: `http[.]server`,
};

/**
 * Kill a preview's dev server in the sandbox — LAYERED, PORT FIRST:
 *
 *   1. PORT kill (fuser/lsof/ss): the actual LISTENER. This is the layer
 *      that catches `next-server` workers — Next.js rewrites their process
 *      titles (no project path in the cmdline), so the path-marker pkill
 *      MISS them and they keep squatting on the port serving the OLD build
 *      (the zombie that regenerates a stale `.next` forever).
 *   2. Project-path marker pkill (the shell/npm wrappers).
 *   3. Framework process patterns (last resort, per-sandbox-safe).
 *   4. Wait until the port is actually FREE (up to 12s) so the fresh
 *      server can never hit EADDRINUSE against a dying zombie.
 */
async function killPreviewProcesses(
  client: ReturnType<typeof getE2BClient>,
  appName: string,
  port: number,
  frameworkKey?: string,
): Promise<void> {
  // BRACKET-TRICK: the literal marker would match this stop command's OWN
  // command line (pkill kills its own shell) — `[-]` keeps the regex
  // matching the real server process ("projects/my-app") but not the
  // pattern string itself ("projects/my[-]-app").
  const safeMarker = `projects/${appName}`.replace(/-/g, "[-]");
  const frameworkPattern = frameworkKey ? FRAMEWORK_KILL_PATTERNS[frameworkKey] : null;
  const command = [
    // 1. Kill whatever LISTENS on the port (the precise kill).
    `fuser -k ${port}/tcp 2>/dev/null || true`,
    `lsof -t -i:${port} 2>/dev/null | xargs -r kill -9 2>/dev/null || true`,
    // 2. Kill anything whose command line references the project dir.
    `pkill -9 -f "${safeMarker}" 2>/dev/null || true`,
    // 3. Framework process names (one sandbox = one app — cannot hit
    //    another chat's server).
    frameworkPattern ? `pkill -9 -f "${frameworkPattern}" 2>/dev/null || true` : `true`,
    // 4. Force-close any listener still hanging on (best-effort).
    `ss -Kltn "sport = :${port}" 2>/dev/null || true`,
    // 5. Wait for the port to be genuinely free (a zombie that ignores
    //    SIGKILL for a moment must not poison the next boot).
    `for i in 1 2 3 4 5 6; do ` +
      `curl -s -o /dev/null --max-time 2 "http://localhost:${port}" 2>/dev/null && sleep 2 || exit 0; ` +
      `done`,
  ].join("; ");
  await client.exec(command, { timeout: 30 });
}

/**
 * Stop a preview session's dev server. Kills by the project-path marker in
 * the command line and by port (fuser/ss when available) — then marks the
 * record stopped regardless (the sandbox rotation reaps anything left over
 * eventually). The record itself is KEPT (status "stopped", url cleared) —
 * it is the chat's app-project marker, so re-entering the chat can
 * auto-start it again (Runtime PRD §5-6/§73-75).
 */
export async function stopPreviewSession(
  session: Pick<PreviewSession, "id" | "name" | "port" | "framework" | "conversationId">,
  apiKey?: string,
): Promise<boolean> {
  const store = usePreviewSessionStore.getState();
  let key = apiKey ?? null;
  if (!key) {
    const userId = useAuthStore.getState().user?.id;
    key = userId ? await getEffectiveE2BKey(userId) : null;
  }
  if (!key) {
    // No sandbox access — still mark stopped locally so the UI stays honest.
    store.markStatus(session.id, "stopped");
    return false;
  }
  try {
    // Kill the dev server in the sandbox it actually runs in: the chat's
    // OWN sandbox when the record carries a conversationId (one chat = one
    // app), else the legacy shared workspace (pre-isolation records).
    const client = getE2BClient(
      key,
      session.conversationId ?? null,
      session.conversationId ? "separate" : "shared",
    );
    await killPreviewProcesses(client, session.name, session.port, session.framework);
    store.markStatus(session.id, "stopped");
    return true;
  } catch {
    store.markStatus(session.id, "stopped");
    return false;
  }
}

/**
 * Honest liveness check (Runtime PRD §7/§122): ping the session's public
 * URL and sync the record to what the network actually says — a dead URL
 * flips the record to "stopped" (dropping the stale URL) so the panel can
 * never embed a dead page; a URL that responds again upgrades a timed-out
 * "error" boot back to "running". A record the user STOPPED is never
 * resurrected by a poll (the Stop button wins).
 */
export async function refreshPreviewSessionLiveness(
  session: Pick<PreviewSession, "id" | "url" | "status">,
): Promise<PreviewSessionStatus> {
  const store = usePreviewSessionStore.getState();
  const current = store.sessions.find((s) => s.id === session.id);
  if (!current) return session.status;
  if (!current.url) {
    if (current.status !== "stopped") store.markStatus(current.id, "stopped");
    return "stopped";
  }
  const serving = await isUrlServing(current.url);
  const fresh = usePreviewSessionStore.getState().sessions.find((s) => s.id === session.id);
  if (!fresh) return session.status;
  if (serving) {
    if (fresh.status === "error") {
      usePreviewSessionStore.getState().markStatus(fresh.id, "running");
      return "running";
    }
    return fresh.status;
  }
  if (fresh.status !== "stopped") {
    usePreviewSessionStore.getState().markStatus(fresh.id, "stopped");
  }
  return "stopped";
}

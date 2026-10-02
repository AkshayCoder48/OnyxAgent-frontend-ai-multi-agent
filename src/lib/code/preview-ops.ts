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
}

/**
 * Is a dev server for THIS app already running and answering on the port?
 * Two probes in one exec (both must pass):
 *   1. a process whose command line references the project dir exists
 *      (the bracket trick keeps pgrep from matching its own shell), and
 *   2. `curl http://localhost:PORT` answers 2xx/3xx inside the sandbox.
 *
 * This is the gate for the REUSE path in startPreview: killing and rebooting
 * a healthy dev server breaks EVERY already-open preview tab (pages hold
 * chunk references from the previous webpack build — the classic
 * "__webpack_modules__[moduleId] is not a function" stale-chunk crash) and
 * costs a full reinstall + reboot cycle for nothing. A healthy server keeps
 * serving; only its bootEpoch is bumped so the panel iframe remounts.
 */
async function isDevServerHealthy(
  client: ReturnType<typeof getE2BClient>,
  appName: string,
  port: number,
): Promise<boolean> {
  const safeMarker = `projects/${appName}`.replace(/-/g, "[-]");
  const probe = await client.exec(
    `pgrep -f "${safeMarker}" >/dev/null 2>&1 && curl -s -o /dev/null -w "%{http_code}" --max-time 12 http://localhost:${port} 2>/dev/null || echo ERR`,
    { timeout: 25 },
  );
  const code = probe.stdout.trim();
  return code.startsWith("2") || code.startsWith("3");
}

/**
 * Is the URL actually SERVING? E2B's public port proxy answers every
 * request — a CLOSED port returns HTTP 502 {"…port is not open"} WITH
 * `access-control-allow-origin: *`, so a normal CORS fetch can read the
 * status: 2xx = serving, anything else = not (yet). The opaque no-cors
 * fallback only runs when the host sends no CORS headers at all (custom
 * preview hosts) — there, any network-level response counts as serving.
 */
export async function isUrlServing(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { cache: "no-store" });
    return r.ok;
  } catch {
    try {
      await fetch(url, { mode: "no-cors", cache: "no-store" });
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

    // 0.7. REUSE A HEALTHY SERVER (the anti-restart-churn fix): if a dev
    // server for THIS app is already running and answering on the port,
    // KEEP it. Restarting unconditionally broke every already-open preview
    // tab — the old page kept chunk references from the previous webpack
    // build and crashed with "__webpack_modules__[moduleId] is not a
    // function" as soon as the new build served different module ids — and
    // re-ran the whole install+boot cycle needlessly. On reuse we only bump
    // bootEpoch (the panel remounts its iframe → shows the CURRENT app) and
    // re-verify the public URL.
    if (await isDevServerHealthy(client, appName, port)) {
      progress?.("A dev server for this app is already running and healthy — reusing it (no restart, open tabs keep working).");
      const hostInfo = await client.getHostUrl(port);
      const live = await checkPreviewUrl(hostInfo.url, {
        timeoutMs: 30_000,
        onProgress: (line) => progress?.(line),
      });
      if (live) {
        const serverCmd = scaffold.serverCommand!(appName, port);
        const session: PreviewSession = {
          id: conversationId
            ? previewSessionIdFor(conversationId)
            : `pv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          name: appName,
          framework: scaffold.key,
          frameworkLabel: scaffold.label,
          url: hostInfo.url,
          port,
          sandboxId: hostInfo.sandboxId,
          status: "running",
          command: `cd ${cwd} && ${serverCmd}`,
          createdAt: Date.now(),
          bootEpoch: Date.now(),
          ...(conversationId ? { conversationId } : {}),
        };
        usePreviewSessionStore.getState().upsert(session);
        return { ok: true, session, reused: true };
      }
      // Public URL not answering although localhost does (proxy hiccup) —
      // fall through to the full restart path, which re-exposes the port.
      progress?.("The public URL did not answer — restarting the dev server.");
    }

    // 0.5. RESTART HYGIENE (one app per chat): if this conversation already
    // has a preview record, kill its old dev server (project marker + port)
    // BEFORE booting the new one — a half-dead process squatting on the port
    // would make the fresh server fail to bind (or serve stale output).
    // Best-effort: a failed kill must never block the start.
    if (conversationId) {
      const prev = findPreviewSession(usePreviewSessionStore.getState().sessions, conversationId);
      if (prev) {
        progress?.(`Stopping the previous preview for ${prev.name}…`);
        try {
          await killPreviewProcesses(client, prev.name, port);
        } catch {
          /* best-effort */
        }
      }
    }

    // 1. Install dependencies (foreground, streamed).
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
          error: `Dependency install failed (exit ${installOk ? 0 : 1}): ${installErr.slice(-400) || tail.slice(-400)}`,
        };
      }
      progress?.("Dependencies installed.");
    }

    // 2. Start the dev server (detached background command).
    const serverCmd = scaffold.serverCommand(appName, port);
    // The `cd <dir> &&` prefix puts the project path in the process's
    // command line so Stop can pkill by it.
    const wrappedCmd = `cd ${cwd} && ${serverCmd}`;
    progress?.(`Starting dev server: ${serverCmd}`);
    const started = await client.startServer(wrappedCmd, { cwd: "/home/user" });
    if (!started.started) {
      return { ok: false, error: "The sandbox refused to start the dev server." };
    }

    // 3. Resolve the public URL.
    const hostInfo = await client.getHostUrl(port);
    progress?.(`Public preview URL: ${hostInfo.url}`);

    // 4. Wait until it actually serves — "running" is only recorded after
    // the URL responds (honest status, PRD §7/§122).
    const live = await checkPreviewUrl(hostInfo.url, {
      timeoutMs: 90_000,
      onProgress: (line) => progress?.(line),
    });

    // 5. Record the session — the DETERMINISTIC pv-<conversationId> id, so
    //    the chat keeps exactly one record and every start re-uses/upgrades
    //    it in place (the store's upsert adopts any legacy record for the
    //    conversation). Survives refresh.
    const session: PreviewSession = {
      id: conversationId
        ? previewSessionIdFor(conversationId)
        : `pv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name: appName,
      framework: scaffold.key,
      frameworkLabel: scaffold.label,
      url: hostInfo.url,
      port,
      sandboxId: hostInfo.sandboxId ?? started.sandboxId,
      status: live ? "running" : "error",
      command: wrappedCmd,
      error: live ? undefined : "The server started but the public URL did not respond in time — it may still be booting; refresh the preview panel.",
      createdAt: Date.now(),
      bootEpoch: Date.now(),
      ...(conversationId ? { conversationId } : {}),
    };
    usePreviewSessionStore.getState().upsert(session);
    return { ok: true, session };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
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

/**
 * Kill a preview's dev server in the sandbox: by the project-path marker in
 * the process's command line and by port (fuser/ss when available).
 */
async function killPreviewProcesses(
  client: ReturnType<typeof getE2BClient>,
  appName: string,
  port: number,
): Promise<void> {
  // BRACKET-TRICK: the literal marker would match this stop command's OWN
  // command line (pkill kills its own shell) — `[-]` keeps the regex
  // matching the real server process ("projects/my-app") but not the
  // pattern string itself ("projects/my[-]app").
  const safeMarker = `projects/${appName}`.replace(/-/g, "[-]");
  const command = [
    // 1. Kill anything whose command line references the project dir.
    `pkill -f "${safeMarker}" || true`,
    // 2. Kill whatever still listens on the port (fuser or ss).
    `fuser -k ${port}/tcp 2>/dev/null || true`,
    `ss -Kltn "sport = :${port}" 2>/dev/null || true`,
  ].join("; ");
  await client.exec(command, { timeout: 20 });
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
  session: Pick<PreviewSession, "id" | "name" | "port" | "conversationId">,
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
    await killPreviewProcesses(client, session.name, session.port);
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

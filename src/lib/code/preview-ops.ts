"use client";

/**
 * OnyxCode preview operations (OnyxCode PRD §4.3/§6) — the client-side
 * engine behind `start_preview` / `manage_preview` AND the Preview tab's
 * Stop button. Shared so the agent's tools and the UI act on the exact
 * same sandbox processes and session records.
 *
 * Flow (start):
 *   1. resolve the E2B client (shared sandbox),
 *   2. run the scaffold's install command (foreground, streamed progress),
 *   3. start the dev server as a DETACHED background command (start_server),
 *   4. resolve the public URL (get_host → https://{sandboxId}-{port}.e2b.dev),
 *   5. poll the URL until it responds (or timeout),
 *   6. upsert a PreviewSession record (localStorage-persisted → survives
 *      refresh) — the Preview tab renders from these records.
 */

import { getE2BClient } from "@/lib/e2b/client";
import { getEffectiveE2BKey } from "@/lib/e2b/env-key";
import { useAuthStore } from "@/stores";
import {
  usePreviewSessionStore,
  type PreviewSession,
} from "@/stores/preview-session-store";
import type { CodeScaffold } from "@/lib/code/scaffolds";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

export async function startPreview(opts: StartPreviewOptions): Promise<StartPreviewResult> {
  const { apiKey, appName, scaffold } = opts;
  const port = opts.port ?? scaffold.port;
  const progress = opts.onProgress;

  if (!scaffold.serverCommand) {
    return {
      ok: false,
      error: `The ${scaffold.label} scaffold has no preview server (CLI tools are run with run_terminal instead).`,
    };
  }

  try {
    const client = getE2BClient(apiKey, null, "shared");
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
          "Re-create the project files first (create_app or create_file), then start the preview again.",
      };
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

    // 4. Wait until it actually serves.
    const live = await checkPreviewUrl(hostInfo.url, {
      timeoutMs: 90_000,
      onProgress: (line) => progress?.(line),
    });

    // 5. Record the session (survives refresh).
    const session: PreviewSession = {
      id: `pv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name: appName,
      framework: scaffold.key,
      frameworkLabel: scaffold.label,
      url: hostInfo.url,
      port,
      sandboxId: hostInfo.sandboxId ?? started.sandboxId,
      status: live ? "running" : "error",
      command: wrappedCmd,
      error: live ? undefined : "The server started but the public URL did not respond in time — it may still be booting; refresh the Preview tab.",
      createdAt: Date.now(),
      ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
    };
    usePreviewSessionStore.getState().upsert(session);
    return { ok: true, session };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/**
 * Stop a preview session's dev server. Kills by pid (if known), by the
 * project-path marker in the command line, and by port (fuser/ss when
 * available) — then marks the record stopped regardless (the sandbox
 * rotation reaps anything left over eventually).
 */
export async function stopPreviewSession(
  session: Pick<PreviewSession, "id" | "name" | "port" | "url">,
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
    const client = getE2BClient(key, null, "shared");
    // BRACKET-TRICK: the literal marker would match this stop command's OWN
    // command line (pkill kills its own shell) — `[-]` keeps the regex
    // matching the real server process ("projects/my-app") but not the
    // pattern string itself ("projects/my[-]app").
    const safeMarker = `projects/${session.name}`.replace(/-/g, "[-]");
    const command = [
      // 1. Kill anything whose command line references the project dir.
      `pkill -f "${safeMarker}" || true`,
      // 2. Kill whatever still listens on the port (fuser or ss).
      `fuser -k ${session.port}/tcp 2>/dev/null || true`,
      `ss -Kltn "sport = :${session.port}" 2>/dev/null || true`,
    ].join("; ");
    await client.exec(command, { timeout: 20 });
    store.markStatus(session.id, "stopped");
    return true;
  } catch {
    store.markStatus(session.id, "stopped");
    return false;
  }
}

/** Light liveness check for an existing session URL (used by the panel). */
export async function refreshPreviewSessionLiveness(
  session: PreviewSession,
): Promise<"running" | "stopped" | "error"> {
  try {
    await fetch(session.url, { mode: "no-cors", cache: "no-store" });
    return session.status === "stopped" ? session.status : "running";
  } catch {
    return "stopped";
  }
}

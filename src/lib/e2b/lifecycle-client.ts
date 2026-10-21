"use client";

/**
 * E2B sandbox lifecycle client — pause/resume persistency (E2B docs:
 * https://docs.e2b.dev/sandbox/persistence).
 *
 * Pausing a sandbox freezes its FULL state — the filesystem AND the RAM
 * (running processes, variables, open connections) — with no automatic
 * deletion until it is explicitly killed. Any later Sandbox.connect
 * auto-resumes it in place, exactly where it froze.
 *
 * The app uses this two ways:
 *   1. AUTO-PAUSE ON EXIT: when the app is closed/navigated away from
 *      (pagehide), every known workspace sandbox is paused (sendBeacon —
 *      survives the unload). The sandbox stops burning its 1h runtime
 *      window immediately instead of idling to the timeout, and its state
 *      persists indefinitely. The next app open auto-resumes it
 *      (getSandbox → Sandbox.connect).
 *   2. MANUAL CONTROLS: Settings → E2B exposes pause / resume / status
 *      through the same /api/sandbox actions.
 */

import { useEffect } from "react";

/** Module cache for the pagehide beacon: (decrypted key, known sandbox ids).
 *  Refreshed on mount + on visibility regain (the key decrypt is async and
 *  cannot run during unload — it must be pre-warmed). */
let cachedKey: string | null = null;
let cachedSandboxIds: string[] = [];

/** E2B localStorage slot prefix — every workspace sandbox id the browser
 *  knows lives at `e2b-sandbox-id:<apiKey>[:<conversationId>]`. */
const SANDBOX_ID_PREFIX = "e2b-sandbox-id:";

/** All sandbox ids the browser currently knows about (localStorage scan +
 *  the in-module cache). Deduped. */
export function knownSandboxIds(): string[] {
  const ids = new Set<string>(cachedSandboxIds);
  if (typeof window !== "undefined") {
    try {
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k && k.startsWith(SANDBOX_ID_PREFIX)) {
          const v = window.localStorage.getItem(k);
          if (v) ids.add(v);
        }
      }
    } catch {
      // private mode / quota — the module cache still helps
    }
  }
  return [...ids];
}

/** Refresh the module cache (called on mount + visibility regain). */
async function refreshLifecycleCache(): Promise<void> {
  try {
    const [{ settingsService }, { useAuthStore }] = await Promise.all([
      import("@/lib/services"),
      import("@/stores"),
    ]);
    const userId = useAuthStore.getState().user?.id;
    if (!userId) return;
    const key = await settingsService.getDecryptedSandboxKey(userId);
    if (key) cachedKey = key;
    cachedSandboxIds = knownSandboxIds();
  } catch {
    // best-effort — auto-pause simply skips when the key is unavailable
    // (the E2B 1h timeout pause remains the fallback).
  }
}

/** Pause one sandbox through the API (manual control + tests). */
export async function pauseSandbox(apiKey: string, sandboxId: string): Promise<{
  ok: boolean;
  paused?: boolean;
  reason?: string;
  detail?: string;
  error?: string;
}> {
  const res = await fetch("/api/sandbox", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey, action: "pause", args: { sandboxId } }),
  });
  return (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as {
    ok: boolean;
    paused?: boolean;
    reason?: string;
    detail?: string;
    error?: string;
  };
}

/** Resume one sandbox (Sandbox.connect auto-resume). */
export async function resumeSandbox(apiKey: string, sandboxId: string): Promise<{
  ok: boolean;
  resumed?: boolean;
  error?: string;
}> {
  const res = await fetch("/api/sandbox", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey, action: "resume", args: { sandboxId } }),
  });
  return (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as {
    ok: boolean;
    resumed?: boolean;
    error?: string;
  };
}

export interface LifecycleSandbox {
  sandboxId: string;
  state: string;
  startedAt: string;
  ageMs: number;
  scope: string | null;
  conversationId: string | null;
}

/** List the account's sandboxes with lifecycle state (Settings UI). */
export async function fetchLifecycleStatus(apiKey: string): Promise<LifecycleSandbox[]> {
  const res = await fetch("/api/sandbox", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey, action: "lifecycle_status" }),
  });
  const data = (await res.json().catch(() => ({}))) as { sandboxes?: LifecycleSandbox[] };
  return data.sandboxes ?? [];
}

/**
 * Pause every known workspace sandbox on pagehide — the E2B persistency
 * save. Runs ONCE per document lifetime; idempotent.
 *
 * sendBeacon carries the pause POST through the unload (a normal fetch
 * would be cancelled); the JSON body parses fine because the route reads
 * the raw body with req.json() regardless of content-type.
 */
export function installSandboxAutoPause(): () => void {
  if (typeof window === "undefined") return () => {};

  const onPageHide = () => {
    try {
      if (!cachedKey) return; // key not pre-warmed — skip (timeout pause still applies)
      for (const sandboxId of knownSandboxIds()) {
        const body = JSON.stringify({
          apiKey: cachedKey,
          action: "pause",
          args: { sandboxId },
        });
        // Blob with a non-JSON type avoids a preflight the beacon can't do.
        try {
          navigator.sendBeacon("/api/sandbox", new Blob([body], { type: "text/plain" }));
        } catch {
          // best-effort — the E2B 1h timeout pause is the fallback
        }
      }
    } catch {
      // never break the unload path
    }
  };

  window.addEventListener("pagehide", onPageHide);
  return () => window.removeEventListener("pagehide", onPageHide);
}

/** KEEPALIVE CADENCE — resets every known sandbox's E2B timeout window
 *  while the app is open. Without it the 1h Hobby-plan window expires on
 *  ACTIVE sessions too, E2B auto-pauses the sandbox (onTimeout: "pause"),
 *  and the user's next `ls -la` pays a full auto-resume (tens of seconds)
 *  before the first byte — the "basic commands take minutes" report. Only
 *  fires while the document is VISIBLE (a hidden tab must not hold sandboxes
 *  awake); paused-at-timeout remains the closed-app behavior. */
const KEEPALIVE_INTERVAL_MS = 4 * 60 * 1000;

async function keepaliveKnownSandboxes(): Promise<void> {
  if (!cachedKey) return;
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
  for (const sandboxId of knownSandboxIds()) {
    try {
      // Fire-and-forget POST — the server connect + setTimeout resets the
      // E2B 1h window (see the keepalive action). Errors are silently
      // ignored: a dead sandbox heals on its next real use.
      await fetch("/api/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: cachedKey,
          action: "keepalive",
          sandboxId,
        }),
      });
    } catch {
      // best-effort
    }
  }
}

/**
 * SandboxLifecycleSync — mount ONCE (app providers). Pre-warms the
 * lifecycle caches while visible, installs the pagehide auto-pause, and
 * runs the keepalive loop that keeps interactive sandboxes from pausing.
 */
export function SandboxLifecycleSync(): null {
  useEffect(() => {
    void refreshLifecycleCache();
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      void refreshLifecycleCache();
    };
    document.addEventListener("visibilitychange", refresh);
    const uninstall = installSandboxAutoPause();
    window.addEventListener("storage", refresh);
    // KEEPALIVE LOOP (visible sessions only — see keepaliveKnownSandboxes).
    const keepaliveTimer = setInterval(() => {
      void keepaliveKnownSandboxes();
    }, KEEPALIVE_INTERVAL_MS);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("storage", refresh);
      clearInterval(keepaliveTimer);
      uninstall();
    };
  }, []);
  return null;
}

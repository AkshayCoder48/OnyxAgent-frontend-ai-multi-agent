"use client";

/**
 * ACTIVE DETACHED-RUN FLAGS (localStorage) — the synchronous, unload-safe
 * marker of which sandboxes currently host a live headless-agent run.
 *
 * WHY localStorage (not Dexie): the pagehide auto-pause handler in
 * `lifecycle-client.ts` runs during document unload where async IndexedDB
 * reads are unreliable. It scans these flags synchronously and SKIPS pausing
 * any sandbox with an active run — pausing would freeze the detached agent
 * mid-loop, defeating the entire "close the app, come back to finished
 * work" architecture. The server-side `pause` action carries a second,
 * independent guard (pgrep for the runner process).
 *
 * Written by `detached-run.ts` (start → set, settle → clear).
 */

const FLAG_PREFIX = "onyx-detached-active:";

/** Mark a sandbox as hosting a live detached run. */
export function markDetachedActive(sandboxId: string): void {
  if (typeof window === "undefined" || !sandboxId) return;
  try {
    window.localStorage.setItem(FLAG_PREFIX + sandboxId, String(Date.now()));
  } catch {
    // private mode / quota — the server-side pause guard still protects
  }
}

/** Clear the active-run flag (run settled / stopped / failed). */
export function clearDetachedActive(sandboxId: string): void {
  if (typeof window === "undefined" || !sandboxId) return;
  try {
    window.localStorage.removeItem(FLAG_PREFIX + sandboxId);
  } catch {
    // ignore
  }
}

/** All sandbox ids that currently host a live detached run (sync scan). */
export function detachedActiveIds(): Set<string> {
  const ids = new Set<string>();
  if (typeof window === "undefined") return ids;
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(FLAG_PREFIX)) {
        ids.add(k.slice(FLAG_PREFIX.length));
      }
    }
  } catch {
    // private mode — empty set (server-side guard still applies)
  }
  return ids;
}

/** Whether ONE sandbox has a live detached run. */
export function isDetachedActive(sandboxId: string): boolean {
  if (typeof window === "undefined" || !sandboxId) return false;
  try {
    return window.localStorage.getItem(FLAG_PREFIX + sandboxId) !== null;
  } catch {
    return false;
  }
}

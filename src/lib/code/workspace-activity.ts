"use client";

/**
 * Workspace write-activity bus (OnyxCode preview freshness).
 *
 * WHY THIS EXISTS: the live preview iframe and the agent's headless
 * web-session page load ONCE and then rely on the dev server's HMR
 * websocket to stay current. That websocket does NOT survive the E2B
 * public port proxy, so pages go stale the moment the agent writes more
 * files — the preview sidebar kept showing the scaffold's placeholder
 * landing page forever while the real app was already on the server
 * (fresh loads in a new tab showed the real app).
 *
 * `bumpWorkspaceVersion("files")` (workspace-snapshot.ts) — called by
 * EVERY file-mutating tool handler (create_file_chunk / edit_file /
 * create_app / run_terminal / workspace_sync / …) — now also publishes
 * here. Consumers:
 *
 *   - PreviewPanel: reload the embedded iframe once writes settle, so the
 *     sidebar always shows the CURRENT app (never a stale scaffold page).
 *   - code_diagnostics (ensurePageOnTarget): re-navigate the headless
 *     browser when the workspace changed since the page was loaded, so
 *     the AI sees the REAL app and its console errors — not a stale
 *     placeholder ("ai can't see errors" fix).
 *
 * Deliberately dependency-free (no imports) — it sits at the bottom of
 * the import graph so both the tools layer and the code/preview layer
 * can use it without cycles.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/** localStorage key for the persisted last-write wall-clock stamp. The
 * in-memory fsVersion counter (workspace-snapshot) resets on every web-app
 * reload, so a second, RELATIVE-time signal is needed: consumers compare
 * this stamp against the headless page's persisted LOAD stamp to detect a
 * page that predates the latest writes ACROSS reloads/turns (the driver
 * process inside the sandbox keeps its page alive indefinitely — without
 * this, browser_eval happily evaluated a scaffold page from a previous
 * turn: the "AI can't see errors / stale tab" bug). */
const LAST_WRITE_KEY = "onyx:workspace:lastWriteAt";

function readLastWriteAt(): number {
  if (typeof window === "undefined") return 0;
  try {
    return Number(window.localStorage.getItem(LAST_WRITE_KEY)) || 0;
  } catch {
    return 0;
  }
}

/** The wall-clock time of the last sandbox file write (0 when never/unknown).
 * Survives web-app reloads — unlike the in-memory fsVersion counter. */
export function getLastSandboxWriteAt(): number {
  return readLastWriteAt();
}

/** Record a sandbox write NOW (persisted). Exposed for non-file events that
 * still invalidate loaded pages — e.g. a dev-server RESTART changes every
 * chunk id, so pages loaded before the restart are dead even though no file
 * changed (the "__webpack_modules__[moduleId]" crash class). */
export function markSandboxWriteAt(now = Date.now()): void {
  if (typeof window === "undefined") return;
  try {
    // Monotonic: never move the stamp backwards (clock jitter safety).
    const prev = readLastWriteAt();
    if (now < prev) return;
    window.localStorage.setItem(LAST_WRITE_KEY, String(now));
  } catch {
    /* storage unavailable — the in-memory bus below still fires */
  }
}

/**
 * Notify subscribers that sandbox workspace FILES changed (a
 * file-mutating tool completed). Called from bumpWorkspaceVersion
 * (scope "files") — never for local-only state (memories, subagents…).
 * Also persists the write stamp (see getLastSandboxWriteAt).
 */
export function notifySandboxWrite(): void {
  markSandboxWriteAt(Date.now());
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* a broken subscriber must never break the writer */
    }
  }
}

/** Subscribe to sandbox file writes. Returns an unsubscribe function. */
export function subscribeSandboxWrites(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

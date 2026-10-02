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

/**
 * Notify subscribers that sandbox workspace FILES changed (a
 * file-mutating tool completed). Called from bumpWorkspaceVersion
 * (scope "files") — never for local-only state (memories, subagents…).
 */
export function notifySandboxWrite(): void {
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

"use client";

import { useEffect, useRef } from "react";

import {
  getInflightPreviewStart,
  isUrlServing,
  restartPreviewForConversation,
  stopPreviewSession,
} from "@/lib/code/preview-ops";
import { findPreviewSession, usePreviewSessionStore } from "@/stores/preview-session-store";

/**
 * Best-effort stop of a conversation's preview (Runtime PRD §5/§74): kill
 * the dev server and mark the record stopped. A start still in flight (the
 * user left mid-boot) is awaited and stopped once it lands — no zombie
 * servers left behind. The shared E2B sandbox itself is NEVER destroyed.
 */
async function stopConversationPreview(conversationId: string): Promise<void> {
  const inflight = getInflightPreviewStart(conversationId);
  if (inflight) {
    try {
      const result = await inflight;
      if (result.session) await stopPreviewSession(result.session);
    } catch {
      /* best-effort */
    }
    return;
  }
  const session = findPreviewSession(usePreviewSessionStore.getState().sessions, conversationId);
  if (session && session.status !== "stopped") {
    await stopPreviewSession(session);
  }
}

/**
 * Per-chat preview lifecycle (Runtime PRD §5-8/§73-76) — "One Code Chat =
 * One App Preview Project":
 *
 *   STOP ON LEAVE (§5/§74): when the user LEAVES the Code workspace (the
 *   ChatWorkspace for mode "code" unmounts — exactly the /code layout
 *   unmount signal) or SWITCHES to another code chat, the outgoing
 *   conversation's preview dev server is stopped (fire-and-forget, never
 *   blocking navigation; the shared E2B sandbox itself stays). Panel
 *   toggles and tab hides never unmount this hook, so they never stop
 *   anything.
 *
 *   AUTO-START ON RETURN (§6/§75): entering a code chat whose app project
 *   has a persisted (stopped) session record silently restarts the preview
 *   from the persisted project name/framework — the files survive in the
 *   sandbox. Idempotent: a start already in flight for the conversation is
 *   awaited, never doubled. On failure the record flips to an honest
 *   "error" (PRD §122) and the panel offers a manual Start button.
 *
 *   HONEST STATUS (§7): a record that claims "running" but whose URL no
 *   longer responds (recycled sandbox, killed process) is flipped to
 *   "stopped" and restarted — a dead URL is never presented as live.
 *
 * @param active   true only while the workspace is in Code Mode.
 * @param conversationId  the ACTIVE conversation (null = fresh chat state).
 */
export function useCodePreviewLifecycle(active: boolean, conversationId: string | null): void {
  // The conversation THIS effect run is responsible for stopping on cleanup.
  const stopOnCleanupRef = useRef<string | null>(null);
  // A stop scheduled by a just-fired cleanup, cancellable by an immediate
  // re-mount for the SAME conversation (React StrictMode's dev
  // mount → unmount → remount dance must not stop a fresh auto-start).
  const pendingStopRef = useRef<{ conversationId: string; cancel: () => void } | null>(null);

  useEffect(() => {
    if (!active || !conversationId) return;

    // Re-mounting for the same conversation cancels the pending stop the
    // synthetic unmount scheduled; a re-run for a DIFFERENT conversation
    // leaves it alone (that is a real switch — the old chat must stop).
    if (pendingStopRef.current?.conversationId === conversationId) {
      pendingStopRef.current.cancel();
      pendingStopRef.current = null;
    }
    stopOnCleanupRef.current = conversationId;

    // ── AUTO-START (silent, fire-and-forget — never blocks the workspace) ──
    let cancelled = false;
    void (async () => {
      const session = findPreviewSession(
        usePreviewSessionStore.getState().sessions,
        conversationId,
      );
      if (!session) return; // the chat has no app project yet — nothing to do
      if (session.status === "stopped") {
        await restartPreviewForConversation(conversationId);
        return;
      }
      if (session.status === "error") {
        // The last start failed — show the honest error + manual Start in
        // the panel; never auto-retry a failing boot on every visit.
        return;
      }
      // status === "running": verify the URL still serves (a recycled
      // sandbox leaves a dead URL behind) — restart honestly if not.
      if (!session.url) {
        usePreviewSessionStore.getState().markStatus(session.id, "stopped");
        if (!cancelled) await restartPreviewForConversation(conversationId);
        return;
      }
      const serving = await isUrlServing(session.url);
      if (cancelled) return;
      if (!serving) {
        usePreviewSessionStore.getState().markStatus(session.id, "stopped");
        await restartPreviewForConversation(conversationId);
      }
    })();

    // ── STOP ON LEAVE / SWITCH (deferred + cancellable, fire-and-forget) ──
    return () => {
      cancelled = true;
      const id = stopOnCleanupRef.current;
      stopOnCleanupRef.current = null;
      if (!id) return;
      // Defer the actual stop by a short tick so an immediate re-mount for
      // the SAME conversation (StrictMode dev) can cancel it; real
      // navigation away keeps this hook unmounted, so the stop fires.
      const timer = window.setTimeout(() => {
        pendingStopRef.current = null;
        void stopConversationPreview(id);
      }, 250);
      pendingStopRef.current = { conversationId: id, cancel: () => window.clearTimeout(timer) };
    };
  }, [active, conversationId]);
}

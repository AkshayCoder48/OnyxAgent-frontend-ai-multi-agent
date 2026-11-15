#!/usr/bin/env python3
"""use-chat.ts — replace the cloud orphan-adoption effect with the E2B
detached-run reattach (anchor-based splice with asserts)."""
import pathlib

P = pathlib.Path("/home/z/my-project/OnyxAgent-frontend-ai-multi-agent/src/hooks/use-chat.ts")
t = P.read_text()

START = "  // ── ORPHANED-TURN SETTLE / CLOUD ADOPTION (reload / re-entry) ───────────"
END = """  // Prune spent handoff snapshots (drops the provider key from memory as
  // soon as the turn it belonged to is no longer running).
  useEffect(() => {
    if (!isProcessing) pruneFinishedTurnHandoffs();
  }, [isProcessing]);
"""

i = t.find(START)
assert i != -1, "start anchor not found"
j = t.find(END, i)
assert j != -1, "end anchor not found"
j += len(END)

NEW = """  // ── ORPHANED-TURN SETTLE / DETACHED-RUN REATTACH (reload / re-entry) ────
  // Idempotent: if an execution is already registered for the conversation
  // we simply re-subscribe (the execSummary above). Navigating away NEVER
  // stops it.
  //
  // A browser refresh / app cut while a DETACHED (E2B sandbox) run was in
  // flight is NOT an interruption — the headless runner kept working inside
  // the sandbox (detached process, 24h window, pause-on-timeout guards).
  // On return the persisted Dexie `detached_runs` row (still running) is
  // re-adopted: the interrupted bubble becomes a live status bubble and the
  // finished work lands straight into it. Runs with no live row (the app
  // died before the dispatch completed, or the run already synced) settle
  // silently — no interruption notes in the chat (user directive).
  useEffect(() => {
    const turnId = currentConversationIdFromStore ?? conversationId ?? null;
    if (!turnId) return;
    if (executionHub.getFor(turnId)) return;
    let cancelled = false;
    void (async () => {
      // AUTH-HYDRATION WAIT: on a cold reload the persisted auth store may
      // not have rehydrated when this effect first runs — poll until the
      // store resolves (bounded), or re-adoption never happens.
      const userId = await waitForAuthUser(10_000);
      if (!userId || cancelled) return;
      if (useChatStore.getState().isStreaming) return;
      if (executionHub.getFor(turnId)) return;

      // ── 1) DETACHED-RUN REATTACH — a sandbox run is still in flight. ──
      try {
        const { getDetachedRunForConversation, adoptDetachedRun } = await import(
          "@/lib/agent/detached-run"
        );
        const row = await getDetachedRunForConversation(userId, turnId);
        if (
          row &&
          (row.status === "running" || row.status === "starting") &&
          !row.result_message_id
        ) {
          const rows = await conversationService.getMessages(turnId, userId);
          const streamingRows = rows.filter(
            (r) =>
              r.role === "assistant" &&
              (r as { is_streaming?: boolean }).is_streaming === true,
          );
          const bubble = streamingRows[streamingRows.length - 1] ?? null;
          if (bubble) {
            await writeBubbleStatus(
              bubble.id,
              "Onyx is working in the background. Wait until the task is finished to see the complete response here.",
              true,
            );
          }
          await refreshConversationRows(turnId, userId);
          await adoptDetachedRun({
            userId,
            conversationId: turnId,
            messageId: bubble?.id ?? null,
            isCancelled: () => cancelled,
            onProgress: async (st) => {
              if (!bubble) return;
              const line = st.current_tool
                ? `⏳ Working in the sandbox — running ${st.current_tool}… (round ${st.round ?? "?"}${
                    st.total_rounds ? `/${st.total_rounds}` : ""
                  })`
                : "Onyx is working in the background. Wait until the task is finished to see the complete response here.";
              await writeBubbleStatus(bubble.id, line, true);
              await refreshConversationRows(turnId, userId);
            },
          });
          await refreshConversationRows(turnId, userId);
          return;
        }
      } catch {
        // best-effort — fall through to the silent settle below
      }

      // ── 2) NO LIVE RUN — settle any interrupted streaming rows ────────
      // SILENTLY (user directive 2026-11-14 — the "This task was
      // interrupted…" commentary is gone from the product; the user just
      // continues with a new message).
      try {
        const settledIds = await conversationService.settleInterruptedMessages(turnId);
        if (settledIds.length > 0) {
          await refreshConversationRows(turnId, userId);
        }
      } catch {
        // best-effort — the rows settle on the next load instead
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentConversationIdFromStore, conversationId]);
"""

t = t[:i] + NEW + t[j:]
P.write_text(t)
print("orphan effect replaced;", len(NEW.splitlines()), "new lines")

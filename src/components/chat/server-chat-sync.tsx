"use client";

// ============================================================================
// ServerChatSync — an invisible client component mounted once in the
// dashboard layout (next to SchedulerHeartbeat). It is the browser half of
// the unified chat records (see lib/scheduler/chat-sync.ts):
//
//   · every 45s (+ on mount) it PULLS server-appended messages for every
//     linked chat (scheduled-run results, telegram replies) into Dexie and,
//     for the viewed conversation, into the live chat store — silent,
//     never throws;
//   · it MIRRORS the browser's state to the server when the viewed
//     conversation changes to a linked chat (2s settle) and when an agent
//     execution for a linked conversation finishes (the final messages must
//     reach the mirror so the next scheduled run sees them).
//
// Renders null; exposes nothing.
// ============================================================================

import { useEffect, useRef } from "react";
import { useAuth } from "@/hooks";
import { useConversationStore } from "@/stores";
import { useHubStore } from "@/lib/agent/execution-hub";
import { getLinkedChatIds, mirrorChatToServer, pullServerMessages } from "@/lib/scheduler/chat-sync";

/** How often the server-side messages are pulled while the app is open. */
const PULL_INTERVAL_MS = 45_000;
/** Settle time before mirroring a freshly-viewed conversation. */
const VIEW_SETTLE_MS = 2_000;
/** Delay after an execution finishes (Dexie + store syncs settle first). */
const FINISH_SETTLE_MS = 1_500;

export function ServerChatSync() {
  // useAuth (not the raw store) — its mount effect runs authStore.init(),
  // which rehydrates the real user + vault before the first key resolution
  // (the same cold-navigation race SchedulerHeartbeat documents).
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const viewedConversationId = useConversationStore((s) => s.currentConversationId);

  // ── Pull loop: mount + every 45s — silent, never throws. ─────────────────
  useEffect(() => {
    if (!userId) return;
    const pull = () => {
      void pullServerMessages(userId);
    };
    pull();
    const id = window.setInterval(pull, PULL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [userId]);

  // ── Mirror (a): the viewed conversation changes to a linked chat →
  //    mirror after a 2s settle. Never fires for unlinked chats. ────────────
  useEffect(() => {
    if (!userId || !viewedConversationId) return;
    if (!getLinkedChatIds().includes(viewedConversationId)) return;
    const chatId = viewedConversationId;
    const t = window.setTimeout(() => {
      void mirrorChatToServer(userId, chatId);
    }, VIEW_SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [userId, viewedConversationId]);

  // ── Mirror (b): an execution for a linked conversation transitions to a
  //    terminal state (or is unregistered) → mirror that chat after a short
  //    settle so the final messages land in the server mirror. Force: this is
  //    the one sync that must always win over the 30s throttle. ────────────
  const byExecution = useHubStore((s) => s.byExecution);
  const runningConversationsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!userId) return;
    const runningNow = new Set<string>();
    for (const e of Object.values(byExecution)) {
      if (e.status === "running" && e.conversationId) runningNow.add(e.conversationId);
    }
    // Conversations that WERE running and no longer are → the turn finished.
    const finished: string[] = [];
    for (const convId of runningConversationsRef.current) {
      if (!runningNow.has(convId)) finished.push(convId);
    }
    runningConversationsRef.current = runningNow;
    if (!finished.length) return;
    const linked = new Set(getLinkedChatIds());
    for (const convId of finished) {
      if (!linked.has(convId)) continue; // (c) never for unlinked chats
      window.setTimeout(() => {
        void mirrorChatToServer(userId, convId, { force: true });
      }, FINISH_SETTLE_MS);
    }
  }, [byExecution, userId]);

  return null;
}

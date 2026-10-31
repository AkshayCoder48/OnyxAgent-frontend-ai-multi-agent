"use client";

/**
 * AUTOMATIC TURN HANDOFF ("close and resume") — the zero-action path.
 *
 * When the app closes while a foreground turn is running, the in-browser
 * loop dies with the tab. Closing the app is NOT a cancellation request —
 * the durable lane below makes sure the work continues:
 *
 *   TRIGGER.DEV CLOUD LANE (the ONLY lane — USER DIRECTIVE: "use trigger for
 *   bg work, not E2B"): pagehide dispatches EVERY running chat turn to the
 *   operator's trigger.dev Cloud project as a durable agent_run — a tiny
 *   beacon to /api/tasks/trigger + a localStorage meta. The cloud owns the
 *   execution lifecycle from that moment; reload/close/navigate cannot touch
 *   it. On return, use-chat adopts the run: the interrupted chat bubble
 *   becomes a live background status bubble and the finished result lands IN
 *   THE CHAT BUBBLE automatically (no strips, no scary "task was interrupted"
 *   notes). When the beacon never landed, use-chat's SELF-HEAL pass
 *   re-dispatches the interrupted turn to the cloud instead of settling it.
 *   (turn-cloud-handoff.ts owns that machinery.)
 *
 * The legacy E2B-sandbox beacon lane was REMOVED (user directive) — E2B is
 * a sandbox for tools, not a background execution engine.
 *
 * The snapshot registry is pure in-memory state captured at send time and
 * consumed synchronously at pagehide.
 */

import { useEffect } from "react";
import { executionHub } from "@/lib/agent/execution-hub";
import {
  cloudHandoffActive,
  dispatchCloudAgentRunBeacon,
  prewarmCloudHandoff,
  writeChatHandoffMeta,
} from "@/lib/agent/turn-cloud-handoff";
import { useAuthStore } from "@/stores/auth-store";

// ---------------------------------------------------------------------------
// Snapshot registry (module-level; lives exactly as long as the tab)
// ---------------------------------------------------------------------------

/** Everything needed to hand a foreground turn to the durable lane — captured
 * synchronously at send time, consumed synchronously at pagehide. */
export interface TurnHandoffSnapshot {
  executionId: string;
  conversationId: string;
  userId: string;
  /** The user's prompt for the turn (upload tags included — the runner can
   *  read mirrored files from /home/user/uploads). */
  prompt: string;
  systemPrompt: string;
  chatUrl: string;
  apiKey: string;
  model: string;
  temperature: number | null;
  startedAt: number;
}

const snapshots = new Map<string, TurnHandoffSnapshot>();

/** Register the CURRENT foreground turn for a possible close-handoff.
 * Called from useChat.doSend right before the runtime starts. */
export function registerTurnHandoff(snapshot: TurnHandoffSnapshot): void {
  snapshots.set(snapshot.executionId, snapshot);
}

/** Drop snapshots whose execution is no longer running (turn finished,
 * stopped or failed — nothing to hand off anymore). Prunes the provider
 * API key from memory as soon as it is no longer needed. */
export function pruneFinishedTurnHandoffs(): void {
  for (const [execId, snap] of snapshots) {
    const status = executionHub.getSummary(execId)?.status;
    if (status !== "running") snapshots.delete(execId);
    else if (snap.conversationId !== (executionHub.getSummary(execId)?.conversationId ?? snap.conversationId)) {
      // Conversation re-keyed (new-chat creation) — refresh the pointer so
      // the handoff lands on the real conversation id.
      snapshots.set(execId, { ...snap, conversationId: executionHub.getSummary(execId)!.conversationId! });
    }
  }
}

function listSnapshots(): TurnHandoffSnapshot[] {
  return [...snapshots.values()];
}

// ---------------------------------------------------------------------------
// History seed (shared with the cloud beacon payload)
// ---------------------------------------------------------------------------

/** History BEFORE this turn's user message, excluding the system prompt
 *  (the cloud lane ships the system prompt separately in config). */
export function handoffHistory(snapshot: TurnHandoffSnapshot): Array<{
  role: "user" | "assistant";
  content: string;
}> {
  const store = executionHub.getStore(snapshot.executionId);
  const messages = store ? store.getState().messages : [];
  const conversational = messages.filter(
    (m) => (m.role === "user" || m.role === "assistant") && (m.content ?? "").trim().length > 0,
  );
  let lastUserIdx = -1;
  for (let i = conversational.length - 1; i >= 0; i--) {
    if (conversational[i]!.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  const history = lastUserIdx >= 0 ? conversational.slice(0, lastUserIdx) : conversational;
  return history.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content ?? "",
  }));
}

// ---------------------------------------------------------------------------
// E2B key pre-warm (the beacon cannot decrypt the vault during unload — the
// key is passed to the cloud runner so its sandbox tools work)
// ---------------------------------------------------------------------------

let cachedE2BKey: string | null = null;

async function prewarmE2BKey(): Promise<void> {
  try {
    const [{ settingsService }, { useAuthStore }] = await Promise.all([
      import("@/lib/services"),
      import("@/stores"),
    ]);
    const userId = useAuthStore.getState().user?.id;
    if (!userId) return;
    const key = await settingsService.getDecryptedSandboxKey(userId);
    if (key) cachedE2BKey = key;
  } catch {
    // best-effort — no key ⇒ the cloud lane still works (server env E2B key)
  }
}

/** Refresh everything the pagehide handlers need synchronously: the E2B
 *  key (for the cloud runner's sandbox tools), the cloud-mode flag and the
 *  rotational key pool. */
async function prewarmAll(): Promise<void> {
  const userId = useAuthStore.getState().user?.id;
  await Promise.all([prewarmE2BKey(), prewarmCloudHandoff(userId)]);
}

// ---------------------------------------------------------------------------
// The pagehide handler
// ---------------------------------------------------------------------------

function onWindowPageHide(): void {
  try {
    pruneFinishedTurnHandoffs();
    const running = listSnapshots();
    if (running.length === 0 && !cloudHandoffActive()) {
      return;
    }

    // ── TRIGGER.DEV CLOUD (the ONLY durability lane) ─────────────────────
    // Every running chat turn becomes its OWN durable cloud run — reload,
    // close and navigate cannot interrupt them.
    if (cloudHandoffActive()) {
      if (running.length > 0) {
        // Up to 3 newest turns per pagehide (beacon budget + sanity cap —
        // a normal app has at most one foreground turn per conversation).
        const newest = [...running].sort((a, b) => b.startedAt - a.startedAt).slice(0, 3);
        for (const snap of newest) {
          if (!snap.conversationId) continue;
          const dispatched = dispatchCloudAgentRunBeacon({
            userId: snap.userId,
            prompt: snap.prompt,
            systemPrompt: snap.systemPrompt,
            history: handoffHistory(snap),
            chatUrl: snap.chatUrl,
            apiKey: snap.apiKey,
            model: snap.model,
            temperature: snap.temperature,
            conversationId: snap.conversationId,
            title: snap.prompt.replace(/\s+/g, " ").trim().slice(0, 60) || "Cloud run",
            e2bApiKey: cachedE2BKey,
          });
          if (dispatched) writeChatHandoffMeta(snap.conversationId, dispatched, snap.prompt);
        }
        // The snapshots are spent — the cloud owns these turns now.
        snapshots.clear();
      }
      return;
    }

    // No cloud key connected: with the E2B lane removed there is no durable
    // handoff — the return path settles interrupted turns honestly (the
    // default settle note). Nothing else to do during unload.
  } catch {
    // never break the unload path
  }
}

function installTurnHandoff(): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("pagehide", onWindowPageHide);
  return () => window.removeEventListener("pagehide", onWindowPageHide);
}

// ---------------------------------------------------------------------------
// React binding — mount ONCE in providers
// ---------------------------------------------------------------------------

/** Pre-warms the E2B key + cloud mode + key pool while visible + installs
 *  the pagehide handoff. */
export function TurnHandoffController(): null {
  useEffect(() => {
    void prewarmAll();
    const onVisible = () => {
      if (document.visibilityState === "visible") void prewarmAll();
    };
    document.addEventListener("visibilitychange", onVisible);
    // Periodic refresh while visible: the cached cloud-mode flag must stay
    // FRESH at pagehide time — a tab left open for hours would otherwise
    // dispatch (or skip) beacons based on a stale connect/disconnect state.
    const prewarmTimer = setInterval(() => {
      if (document.visibilityState === "visible") void prewarmAll();
    }, 60_000);
    const uninstall = installTurnHandoff();
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(prewarmTimer);
      uninstall();
    };
  }, []);
  return null;
}

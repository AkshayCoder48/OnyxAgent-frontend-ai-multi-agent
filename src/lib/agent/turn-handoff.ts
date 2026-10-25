"use client";

/**
 * AUTOMATIC TURN HANDOFF ("close and resume" — the zero-action path).
 *
 * When the app closes while a foreground turn is running, the in-browser
 * loop dies with the tab. Closing the app is NOT a cancellation request —
 * the durable lanes below make sure the work continues:
 *
 *   1. TRIGGER.DEV CLOUD LANE (preferred, when a cloud key is connected):
 *      pagehide dispatches EVERY running turn (chat + business) to the
 *      operator's trigger.dev Cloud project as a durable agent_run — a tiny
 *      beacon to /api/tasks/trigger + a localStorage meta. The cloud owns
 *      the execution lifecycle from that moment; reload/close/navigate
 *      cannot touch it. On return, use-chat adopts the run (Dexie mirror +
 *      task token) and the background-tasks strip streams progress until
 *      syncRunToConversation lands the finished work.
 *      (turn-cloud-handoff.ts owns that machinery.)
 *
 *   2. E2B LANE (legacy fallback, no cloud key): hand the NEWEST running
 *      turn to the shared E2B sandbox's headless runner via a pagehide
 *      beacon ({action:"agent_start"}). Fragile by nature (the beacon, the
 *      sandbox discovery and the 24h window must all survive the unload) —
 *      kept only for users who never connected Trigger.dev Cloud.
 *
 * The snapshot registry is pure in-memory state captured at send time and
 * consumed synchronously at pagehide.
 */

import { useEffect } from "react";
import { nanoid } from "nanoid";
import { executionHub } from "@/lib/agent/execution-hub";
import { buildSeedMessages } from "@/lib/agent/detached-run";
import { markDetachedActive } from "@/lib/agent/detached-active";
import {
  cloudHandoffActive,
  dispatchBusinessTurnHandoffs,
  dispatchCloudAgentRunBeacon,
  prewarmCloudHandoff,
  writeChatHandoffMeta,
} from "@/lib/agent/turn-cloud-handoff";
import { useAuthStore } from "@/stores/auth-store";
import { sandboxIdStorageKey } from "@/lib/e2b/client";
import { useDetachedRunStore } from "@/stores/detached-run-store";

// ---------------------------------------------------------------------------
// Snapshot registry (module-level; lives exactly as long as the tab)
// ---------------------------------------------------------------------------

/** Everything needed to hand a foreground turn to a durable lane — captured
 *  synchronously at send time, consumed synchronously at pagehide. */
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
 *  stopped or failed — nothing to hand off anymore). Prunes the provider
 *  API key from memory as soon as it is no longer needed. */
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
// Handoff meta (localStorage — the durable "a run is out there" pointer,
// consumed by the legacy E2B lane; the cloud lane keeps its own meta in
// turn-cloud-handoff.ts)
// ---------------------------------------------------------------------------

const META_PREFIX = "onyx-turn-handoff:";

export interface TurnHandoffMeta {
  runId: string;
  conversationId: string;
  /** Seed message count — chat_history.json entries at index >= seedCount
   *  are the runner's NEW output to sync back. */
  seedCount: number;
  startedAt: number;
  model: string;
  chatUrl: string;
  /** The shared sandbox the beacon targeted (null when the slot was empty —
   *  the server resolves/creates one and a warm instance reconnects). */
  sandboxId: string | null;
  promptPreview: string;
}

/** Read the pending E2B handoff record for a conversation (null when none). */
export function readTurnHandoffMeta(conversationId: string): TurnHandoffMeta | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(META_PREFIX + conversationId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TurnHandoffMeta;
    return typeof parsed?.runId === "string" && typeof parsed?.seedCount === "number" ? parsed : null;
  } catch {
    return null;
  }
}

/** Clear the E2B handoff record (after the run synced / was stopped / lost). */
export function clearTurnHandoffMeta(conversationId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(META_PREFIX + conversationId);
  } catch {
    // ignore
  }
}

/** The note appended to the stale streaming placeholder when the turn was
 * handed to the sandbox (must contain "task was interrupted" — the settle
 * pass uses that substring as its idempotency marker). */
export const TURN_HANDOFF_NOTE =
  "This task was interrupted by the app closing — it was handed to the E2B sandbox and keeps working there. The finished result appears below when it completes; send a message anytime.";

// ---------------------------------------------------------------------------
// Seed builders (synchronous — read the execution store at pagehide)
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

/** Seed = system + history BEFORE this turn's user message + the prompt
 *  (the E2B lane's runner config consumes the full seed). The in-flight
 *  partial assistant output is dropped: the runner re-runs the whole turn
 *  from the prompt and the synced result replaces it. */
function buildHandoffSeed(snapshot: TurnHandoffSnapshot): Array<{
  role: "system" | "user" | "assistant";
  content: string;
}> {
  return buildSeedMessages(snapshot.systemPrompt, handoffHistory(snapshot), snapshot.prompt);
}

// ---------------------------------------------------------------------------
// E2B key pre-warm (the beacon cannot decrypt the vault during unload)
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
 *  key, the cloud-mode flag and the rotational key pool. */
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

    // ── LANE 1: TRIGGER.DEV CLOUD (preferred) ─────────────────────────────
    // Every running chat turn becomes its OWN durable cloud run — reload,
    // close and navigate cannot interrupt them. Business turns dispatch
    // through the same lane (dispatchBusinessTurnHandoffs).
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
      dispatchBusinessTurnHandoffs(cachedE2BKey);
      return; // cloud lane handled everything — no E2B beacon
    }

    // ── LANE 2: E2B SANDBOX (legacy, no cloud key) ────────────────────────
    if (running.length === 0 || !cachedE2BKey) return;

    // ONE runner per sandbox — hand off only the NEWEST running turn (a
    // second agent_start would overwrite run.json + collide on the history).
    const newest = running.reduce((a, b) => (b.startedAt >= a.startedAt ? b : a));
    if (!newest.conversationId) return;

    const seed = buildHandoffSeed(newest);
    const runId = `handoff_${nanoid(8)}`;
    const startedAt = Date.now();
    const config = {
      run_id: runId,
      conversation_id: newest.conversationId,
      prompt: newest.prompt,
      chat_url: newest.chatUrl,
      api_key: newest.apiKey,
      model: newest.model,
      system_prompt: newest.systemPrompt,
      seed_messages: seed,
      temperature: newest.temperature,
      max_rounds: 24,
    };

    // Shared-sandbox slot (synchronous read — the client class persists its
    // id at `e2b-sandbox-id:<apiKey>`). When empty the beacon still fires
    // (sandboxId: null) and a warm server instance resolves its cache.
    let slotId: string | null = null;
    try {
      slotId = window.localStorage.getItem(sandboxIdStorageKey(cachedE2BKey, null, "shared"));
    } catch {
      // private mode — null slot
    }

    // 1) Durable pointer for the return path (sync write).
    const meta: TurnHandoffMeta = {
      runId,
      conversationId: newest.conversationId,
      seedCount: seed.length,
      startedAt,
      model: newest.model,
      chatUrl: newest.chatUrl,
      sandboxId: slotId,
      promptPreview: newest.prompt.slice(0, 400),
    };
    try {
      window.localStorage.setItem(META_PREFIX + newest.conversationId, JSON.stringify(meta));
    } catch {
      return; // no durable pointer ⇒ a handoff would be undiscoverable — skip
    }

    // 2) Exempt the sandbox from the pagehide auto-pause (lifecycle-client
    //    scans this flag synchronously; our listener runs first — providers
    //    mounts TurnHandoffController above SandboxLifecycleSync).
    if (slotId) markDetachedActive(slotId);

    // 3) UI mirror so the strip re-attaches immediately on return (zustand
    //    persist writes localStorage synchronously).
    useDetachedRunStore.getState().setRun(newest.conversationId, {
      runId,
      sandboxId: slotId ?? "",
      status: "running",
      stage: "starting",
      startedAt,
    });

    // 4) Fire the beacon. Blob with a non-JSON type avoids a preflight the
    //    beacon cannot do; the route parses the raw body regardless.
    const body = JSON.stringify({
      apiKey: cachedE2BKey,
      action: "agent_start",
      conversationId: null,
      sandboxMode: "shared",
      sandboxId: slotId,
      args: { config: JSON.stringify(config) },
    });
    try {
      navigator.sendBeacon("/api/sandbox", new Blob([body], { type: "text/plain" }));
    } catch {
      // best-effort — the return path reports the loss honestly
    }

    // The snapshot is spent — drop it (and any others die as interrupted,
    // which is exactly what they are).
    snapshots.clear();
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
// React binding — mount ONCE in providers, ABOVE SandboxLifecycleSync
// ---------------------------------------------------------------------------

/** Pre-warms the E2B key + cloud mode + key pool while visible + installs
 *  the pagehide handoff. Mount order matters: this component's listener must
 *  be registered BEFORE SandboxLifecycleSync's auto-pause so
 *  markDetachedActive is visible to it. */
export function TurnHandoffController(): null {
  useEffect(() => {
    void prewarmAll();
    const onVisible = () => {
      if (document.visibilityState === "visible") void prewarmAll();
    };
    document.addEventListener("visibilitychange", onVisible);
    const uninstall = installTurnHandoff();
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      uninstall();
    };
  }, []);
  return null;
}

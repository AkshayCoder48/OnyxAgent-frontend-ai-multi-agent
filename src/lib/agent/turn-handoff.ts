"use client";

/**
 * AUTOMATIC TURN HANDOFF ("close and resume" — the zero-action path).
 *
 * The explicit "Sandbox runs" toggle (DetachedRunToggle) hands a WHOLE turn to
 * the sandbox headless runner before it starts. But users naturally test
 * "send a message, close the app, come back" WITHOUT toggling anything — the
 * in-browser loop then dies with the tab and the orphaned-settle path shows
 * the "task was interrupted… send a message to continue" note (the "fake
 * bait" report, 2026-10-22). This module closes that gap:
 *
 *   foreground turn running ──app closes──▶ pagehide:
 *     1. build the run config from IN-MEMORY state (provider + prompt +
 *        seed history from the execution store — all synchronous),
 *     2. persist a handoff meta record to localStorage (sync, unload-safe)
 *        + the detached-run store view (zustand persist → localStorage),
 *     3. markDetachedActive(the shared sandbox) so the pagehide auto-pause
 *        in lifecycle-client.ts skips it (our handler is registered FIRST —
 *        see providers.tsx mount order),
 *     4. sendBeacon /api/sandbox {action:"agent_start"} — the server
 *        deploys + launches the nohup runner and (since the fix) stamps a
 *        fresh 24h sandbox window.
 *
 *   app reopened ──▶ the orphaned-settle effect in use-chat.ts finds the
 *   meta: settles the stale streaming placeholder with a "moved to the
 *   sandbox" note, hydrates the Dexie run row + store view, and syncs —
 *   the DetachedRunStrip keeps polling until the finished work lands as a
 *   native assistant message (same sync path as explicit detached runs).
 *
 * WHY localStorage FOR THE META (not Dexie): pagehide cannot await
 * IndexedDB writes (same reasoning as detached-active.ts). The meta is
 * consumed once on return and rewritten per handoff — size stays tiny.
 */

import { useEffect } from "react";
import { nanoid } from "nanoid";
import { executionHub } from "@/lib/agent/execution-hub";
import { buildSeedMessages } from "@/lib/agent/detached-run";
import { markDetachedActive } from "@/lib/agent/detached-active";
import { sandboxIdStorageKey } from "@/lib/e2b/client";
import { useDetachedRunStore } from "@/stores/detached-run-store";

// ---------------------------------------------------------------------------
// Snapshot registry (module-level; lives exactly as long as the tab)
// ---------------------------------------------------------------------------

/** Everything needed to hand a foreground turn to the sandbox runner —
 *  captured synchronously at send time, consumed synchronously at pagehide. */
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
 *  Called from useChat.doSend right before the runtime starts. */
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
// Handoff meta (localStorage — the durable "a run is out there" pointer)
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

/** Read the pending handoff record for a conversation (null when none). */
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

/** Clear the handoff record (after the run synced / was stopped / lost). */
export function clearTurnHandoffMeta(conversationId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(META_PREFIX + conversationId);
  } catch {
    // ignore
  }
}

/** The note appended to the stale streaming placeholder when the turn was
 *  handed to the sandbox (must contain "task was interrupted" — the settle
 *  pass uses that substring as its idempotency marker). */
export const TURN_HANDOFF_NOTE =
  "This task was interrupted by the app closing — it was handed to the E2B sandbox and keeps working there. The finished result appears below when it completes; send a message anytime.";

// ---------------------------------------------------------------------------
// Seed builder (synchronous — reads the execution store at pagehide)
// ---------------------------------------------------------------------------

/** Seed = system + history BEFORE this turn's user message + the prompt.
 *  The in-flight partial assistant output is dropped: the runner re-runs the
 *  whole turn from the prompt and the synced result replaces it. */
function buildHandoffSeed(snapshot: TurnHandoffSnapshot): Array<{
  role: "system" | "user" | "assistant";
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
  const history = (lastUserIdx >= 0 ? conversational.slice(0, lastUserIdx) : conversational).map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content ?? "",
  }));
  return buildSeedMessages(snapshot.systemPrompt, history, snapshot.prompt);
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
    // best-effort — no key ⇒ no handoff (the honest interrupted note remains)
  }
}

// ---------------------------------------------------------------------------
// The pagehide handler
// ---------------------------------------------------------------------------

function onWindowPageHide(): void {
  try {
    pruneFinishedTurnHandoffs();
    const running = listSnapshots();
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

/** Pre-warms the E2B key while visible + installs the pagehide handoff.
 *  Mount order matters: this component's listener must be registered BEFORE
 *  SandboxLifecycleSync's auto-pause so markDetachedActive is visible to it. */
export function TurnHandoffController(): null {
  useEffect(() => {
    void prewarmE2BKey();
    const onVisible = () => {
      if (document.visibilityState === "visible") void prewarmE2BKey();
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

"use client";

// ============================================================================
// Scheduler client helper — the browser's single door to /api/scheduler/*.
//
// SECURITY MODEL (same as the cloud-workspace tools): the OnyxBase API key is
// resolved from the encrypted vault AT CALL TIME via settingsService and sent
// as the `X-OnyxBase-Key` request header. It is never stored in React state
// that renders, never logged, never persisted anywhere new — the decrypted
// value lives only inside the transient fetch call below.
// ============================================================================

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/hooks";
import type {
  SafeScheduledTask,
  ScheduledTaskRun,
} from "@/lib/scheduler/types";

/** Envelope every /api/scheduler route answers with. */
export interface SchedulerApiResponse {
  ok: boolean;
  error?: string;
  message?: string;
  task?: SafeScheduledTask;
  tasks?: SafeScheduledTask[];
  run?: ScheduledTaskRun;
  runs?: ScheduledTaskRun[];
  [key: string]: unknown;
}

/** Tick payload (POST /api/scheduler/tick). */
export interface SchedulerTickResult {
  ok: boolean;
  ticked: boolean;
  skipped?: string;
  fired: number;
  finalized: number;
  tasks: number;
  running: number;
  nextDueAt: number | null;
  lastTickAt: number | null;
  trigger: string;
  errors: string[];
}

const NOT_CONFIGURED_MESSAGE =
  "Cloud scheduling isn't configured yet. Add your OnyxBase API key in Settings → Cloud Workspace.";

// ── CONNECTION-POOL PROTECTION (the navigation-lag fix) ────────────────────
// A browser holds at most ~6 concurrent HTTP/1.1 connections per origin.
// The background pollers (sidebar convergence, server-chat pull, scheduler
// heartbeat) used to fire independently — a slow tick (up to 18s) + a slow
// list + a pull could occupy several slots for tens of seconds, and the
// router's RSC fetch for a route change (Agent ⇄ Settings) then
// QUEUED BEHIND THEM — the reported "takes 20-40s to navigate". Two guards:
//   1. SINGLE-FLIGHT: this tab runs AT MOST ONE scheduler request at a time
//      (a tiny promise chain — pollers wait their turn instead of piling
//      up connections). User-facing TOOL calls (scheduled_tasks.ts) use
//      their own fetch and bypass this queue.
//   2. HARD TIMEOUT: 25s — a hung request must not squat on a connection
//      slot forever; the callers' catch paths already treat failure as
//      "skip this cycle".
const SCHEDULER_FETCH_TIMEOUT_MS = 25_000;

let schedulerChain: Promise<unknown> = Promise.resolve();

/** Serialize one scheduler fetch per tab (background pollers only). */
function enqueueSchedulerFetch<T>(op: () => Promise<T>): Promise<T> {
  const run = schedulerChain.then(op, op);
  schedulerChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ── ZERO-TASK TICK SKIP ────────────────────────────────────────────────
// When the sidebar's last convergence saw ZERO scheduled tasks, there is
// nothing for a heartbeat to fire or finalize — skip the tick entirely
// (the memoized "list" is cheap, the tick is the expensive one). The
// sidebar updates this on every convergence; first load (null) still ticks.
let lastKnownTaskCount: number | null = null;

/** Record how many scheduled tasks the client currently knows about. */
export function noteSchedulerTasks(count: number): void {
  lastKnownTaskCount = count;
}

/** Resolve the vault key for a user (transient — caller must not persist it). */
async function resolveKey(userId: string): Promise<string | null> {
  const { settingsService } = await import("@/lib/services");
  return settingsService.getDecryptedOnyxBaseApiKey(userId);
}

async function postScheduler(
  route: string,
  key: string,
  body: Record<string, unknown>,
): Promise<SchedulerApiResponse> {
  // Single-flight + timeout — see the connection-pool protection block.
  return enqueueSchedulerFetch(async () => {
    const res = await fetch(route, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OnyxBase-Key": key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SCHEDULER_FETCH_TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => ({}))) as SchedulerApiResponse;
    if (!res.ok && data.ok !== false) {
      return { ok: false, error: "HTTP_ERROR", message: `Request failed (${res.status})` };
    }
    return data;
  });
}

// ---------------------------------------------------------------------------
// Tasks CRUD
// ---------------------------------------------------------------------------

/**
 * Call POST /api/scheduler/tasks with `{ action, ...payload }`.
 * Resolves the OnyxBase key from the encrypted vault at call time.
 */
export async function schedulerApi(
  userId: string,
  action: string,
  payload: Record<string, unknown> = {},
): Promise<SchedulerApiResponse> {
  if (!userId) {
    return { ok: false, error: "NO_USER", message: "Sign in first." };
  }
  let key: string | null = null;
  try {
    key = await resolveKey(userId);
  } catch {
    key = null;
  }
  if (!key || !key.trim()) {
    return { ok: false, error: "NOT_CONFIGURED", message: NOT_CONFIGURED_MESSAGE };
  }
  try {
    return await postScheduler("/api/scheduler/tasks", key, { action, ...payload });
  } catch (e) {
    return {
      ok: false,
      error: "NETWORK",
      message: e instanceof Error ? e.message : "Network error",
    };
  }
}

// ---------------------------------------------------------------------------
// Unified chat records (sync_chat / pull_chat) — view types + wrappers
// ---------------------------------------------------------------------------

import type { ChatTurnMessage } from "./types";

/**
 * A server-appended message (smsg record) as the browser receives it — the
 * server-side ServerChatMessage shape (chat-store.ts) with parts/toolCalls
 * type-loose because they arrive as plain JSON.
 */
export interface ServerChatMessageView {
  /** e.g. "smsg_<e2bRunId>" (scheduled-run results). */
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string | null;
  reasoning?: string | null;
  /** Browser MessagePart[] shape (JSON). */
  parts?: unknown[] | null;
  /** Browser ToolCall[] shape (JSON). */
  toolCalls?: unknown[] | null;
  createdAt: string;
  origin?: "scheduled";
}

export interface PullChatUpdateView {
  chatId: string;
  messages: ServerChatMessageView[];
  meta?: { title: string; kind: "chat" };
  /** The newest smsg marker for this chat (the next `after` cursor). */
  nextAfter?: string;
}

export interface PullChatResponse extends SchedulerApiResponse {
  updates: PullChatUpdateView[];
  /** Newest smsg marker across the response (coarse server clock). */
  serverTime: string;
}

export interface SyncChatResponse extends SchedulerApiResponse {
  durable?: boolean;
}

export interface SyncChatPayload {
  chatId: string;
  title?: string;
  systemPrompt?: string;
  messages: ChatTurnMessage[];
}

/** sync_chat: browser → KV chat mirror snapshot → { ok, durable }. */
export async function syncChat(userId: string, payload: SyncChatPayload): Promise<SyncChatResponse> {
  const res = await schedulerApi(userId, "sync_chat", payload as unknown as Record<string, unknown>);
  return res as unknown as SyncChatResponse;
}

/** pull_chat: KV server-appended messages for the given cursors. */
export async function pullChat(
  userId: string,
  updates: Array<{ chatId: string; after?: string }>,
): Promise<PullChatResponse> {
  const res = await schedulerApi(userId, "pull_chat", { updates });
  return res as unknown as PullChatResponse;
}

// ---------------------------------------------------------------------------
// Tick (heartbeat)
// ---------------------------------------------------------------------------

/** Fire-and-forget scheduler heartbeat (POST /api/scheduler/tick). */
export async function tickHeartbeat(userId: string): Promise<SchedulerTickResult | null> {
  if (!userId) return null;
  // ZERO-TASK SKIP: nothing to fire or finalize — the tick is the most
  // expensive scheduler call; with no tasks it is pure latency.
  if (lastKnownTaskCount === 0) return null;
  let key: string | null = null;
  try {
    key = await resolveKey(userId);
  } catch {
    key = null;
  }
  if (!key || !key.trim()) return null; // silent — never throws
  try {
    // Single-flight + timeout — see the connection-pool protection block.
    const res = await enqueueSchedulerFetch(() =>
      fetch("/api/scheduler/tick", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OnyxBase-Key": key as string },
        body: JSON.stringify({ trigger: "heartbeat" }),
        signal: AbortSignal.timeout(SCHEDULER_FETCH_TIMEOUT_MS),
      }),
    );
    if (!res.ok) return null;
    return (await res.json().catch(() => null)) as SchedulerTickResult | null;
  } catch {
    return null; // silent
  }
}

// ---------------------------------------------------------------------------
// useSchedulerKey — the hook wrapper for keyed views
// ---------------------------------------------------------------------------

export type SchedulerKeyState = "loading" | "ready" | "not_configured" | "no_user";

/**
 * Resolves the CURRENT user (via useAuth, which runs authStore.init() on
 * mount — critical on cold direct navigations) + whether their OnyxBase key
 * is configured. The key itself is never exposed — only its presence.
 */
export function useSchedulerKey(): {
  userId: string | null;
  state: SchedulerKeyState;
  refetch: () => void;
} {
  // useAuth (not the raw store) — its mount effect runs authStore.init(),
  // which rehydrates the real user + vault on a cold direct navigation (the
  // same auth-hydration race SectionCloudWorkspace documents).
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [state, setState] = useState<SchedulerKeyState>("loading");
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!userId) {
        if (!cancelled) setState("no_user");
        return;
      }
      let key: string | null = null;
      try {
        key = await resolveKey(userId);
      } catch {
        key = null;
      }
      if (!cancelled) {
        setState(key && key.trim() ? "ready" : "not_configured");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, nonce]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  return { userId, state, refetch };
}

// ---------------------------------------------------------------------------
// Provider snapshot — the execution config for unattended runs.
//
// Resolved CLIENT-side from the settings store (the same source use-chat
// reads: the chat store's selected provider/model + the decrypted key) and
// attached to create/update payloads. The model never sees it — this runs in
// UI/tool handlers, not in tool arguments.
// ---------------------------------------------------------------------------

import type { ProviderSnapshot } from "./types";

export async function resolveProviderSnapshot(): Promise<ProviderSnapshot | null> {
  try {
    const { aiProviderService } = await import("@/lib/services");
    const { useChatStore } = await import("@/stores/chat-store");
    const { useAuthStore } = await import("@/stores");
    const uid = useAuthStore.getState().user?.id;
    if (!uid) return null;
    // NOTE (stale "OnyxAI" ghost fix): no load-ALL fallback — rows under
    // obsolete/transient user ids must never ride an unattended run.
    const providers = await aiProviderService.list(uid, true);
    if (providers.length === 0) return null;
    const storeSelection = useChatStore.getState();
    const providerOverrideId = storeSelection.selectedProviderId ?? null;
    const selected =
      providerOverrideId != null
        ? (providers.find((p) => p.id === providerOverrideId) ?? providers[0])
        : providers[0];
    if (!selected) return null;
    const apiKey = await aiProviderService.getDecryptedApiKey(selected.id);
    const model = storeSelection.selectedModel ?? selected.models[0] ?? "";
    return {
      baseUrl: selected.base_url,
      apiKey,
      model,
      toolsEnabled: selected.tools_enabled,
      noPrefix: (selected as { no_prefix?: boolean }).no_prefix ?? false,
      disabledParams: (selected as { disabled_params?: string[] }).disabled_params ?? [],
    };
  } catch {
    return null;
  }
}

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
  TelegramStatus,
} from "@/lib/scheduler/types";

/**
 * Telegram connection status as the API actually returns it — the shared
 * `TelegramStatus` type omits `chatName` (a newer field); this view adds it
 * back without touching the server-owned types module.
 */
export interface TelegramStatusView extends TelegramStatus {
  chatName?: string | null;
}

/** Envelope every /api/scheduler route answers with. */
export interface SchedulerApiResponse {
  ok: boolean;
  error?: string;
  message?: string;
  task?: SafeScheduledTask;
  tasks?: SafeScheduledTask[];
  run?: ScheduledTaskRun;
  runs?: ScheduledTaskRun[];
  telegram?: TelegramStatusView;
  [key: string]: unknown;
}

/** Status payload for action "status". */
export interface SchedulerStatusInfo {
  tasks: number;
  tick: {
    lastTickAt: number | null;
    trigger: string;
    fired: number;
    finalized: number;
    tasks: number;
    running: number;
    nextDueAt: number | null;
  } | null;
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
  const res = await fetch(route, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-OnyxBase-Key": key },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as SchedulerApiResponse;
  if (!res.ok && data.ok !== false) {
    return { ok: false, error: "HTTP_ERROR", message: `Request failed (${res.status})` };
  }
  return data;
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
  /** e.g. "smsg_<e2bRunId>" (scheduled-run results) or webhook-chosen. */
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
  origin?: "scheduled" | "telegram";
}

export interface PullChatUpdateView {
  chatId: string;
  messages: ServerChatMessageView[];
  meta?: { title: string; kind: "chat" | "telegram" };
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
// Telegram
// ---------------------------------------------------------------------------

/** Call POST /api/scheduler/telegram with `{ action, ...payload }`. */
export async function telegramApi(
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
    return await postScheduler("/api/scheduler/telegram", key, { action, ...payload });
  } catch (e) {
    return {
      ok: false,
      error: "NETWORK",
      message: e instanceof Error ? e.message : "Network error",
    };
  }
}

/** GET /api/scheduler/telegram → connection status (token never returned). */
export async function getTelegramStatus(userId: string): Promise<SchedulerApiResponse> {
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
    const res = await fetch("/api/scheduler/telegram", {
      headers: { "X-OnyxBase-Key": key },
    });
    const data = (await res.json().catch(() => ({}))) as SchedulerApiResponse;
    if (!res.ok && data.ok !== false) {
      return { ok: false, error: "HTTP_ERROR", message: `Request failed (${res.status})` };
    }
    return data;
  } catch (e) {
    return {
      ok: false,
      error: "NETWORK",
      message: e instanceof Error ? e.message : "Network error",
    };
  }
}

// ---------------------------------------------------------------------------
// Tick (heartbeat)
// ---------------------------------------------------------------------------

/** Fire-and-forget scheduler heartbeat (POST /api/scheduler/tick). */
export async function tickHeartbeat(userId: string): Promise<SchedulerTickResult | null> {
  if (!userId) return null;
  let key: string | null = null;
  try {
    key = await resolveKey(userId);
  } catch {
    key = null;
  }
  if (!key || !key.trim()) return null; // silent — never throws
  try {
    const res = await fetch("/api/scheduler/tick", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OnyxBase-Key": key },
      body: JSON.stringify({ trigger: "heartbeat" }),
    });
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
    let providers = await aiProviderService.list(uid, true);
    if (providers.length === 0) {
      const { db } = await import("@/lib/db");
      providers = await db.ai_providers.toArray();
    }
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

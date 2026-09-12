"use client";

// ============================================================================
// Telegram CHAT client helper — the settings UI's door to the remote-chat
// actions on /api/scheduler/telegram (enable_chat / disable_chat /
// webhook_status + the extended status view).
//
// Kept SEPARATE from scheduler/client.ts (which other agents may be editing
// concurrently) but follows its exact security pattern: the OnyxBase key is
// resolved from the encrypted vault AT CALL TIME via settingsService and sent
// as the `X-OnyxBase-Key` request header — never stored in React state that
// renders, never logged, never persisted anywhere new.
// ============================================================================

import type { TelegramStatusView } from "./client";

/** Extended connection status as the API returns it after unified-3b — the
 *  remote-chat view is MASKED (no botToken / webhookSecret / provider key). */
export interface TelegramChatStatusView extends TelegramStatusView {
  /** Remote chat (webhook) mode is enabled. */
  chatEnabled?: boolean;
  /** The public webhook URL registered with Telegram (when enabled). */
  webhookUrl?: string;
  /** The model of the stored provider snapshot (when enabled). */
  providerModel?: string;
  /** Informational mirror flag (runtime source = the vault's mirror flag). */
  mirrorRuns?: boolean;
  /** When remote chat was enabled (ISO). */
  enabledAt?: string;
}

/** Masked getWebhookInfo projection returned by the webhook_status action. */
export interface TelegramWebhookStatusInfo {
  url: string;
  pendingUpdateCount: number;
  lastErrorMessage: string | null;
}

/** Envelope the remote-chat actions answer with. */
export interface TelegramChatApiResponse {
  ok: boolean;
  error?: string;
  message?: string;
  warning?: string;
  webhookUrl?: string;
  botInfo?: { name: string | null; username: string | null };
  info?: TelegramWebhookStatusInfo;
  telegram?: TelegramChatStatusView;
  [key: string]: unknown;
}

const NOT_CONFIGURED_MESSAGE =
  "Cloud scheduling isn't configured yet. Add your OnyxBase API key in Settings → Cloud Workspace.";

/** Resolve the vault key for a user (transient — caller must not persist it). */
async function resolveKey(userId: string): Promise<string | null> {
  const { settingsService } = await import("@/lib/services");
  return settingsService.getDecryptedOnyxBaseApiKey(userId);
}

/**
 * Call POST /api/scheduler/telegram with `{ action, ...payload }` — the
 * remote-chat actions (enable_chat / disable_chat / webhook_status) plus the
 * classic connection actions. The key is resolved from the encrypted vault
 * at call time and travels only in the request header.
 */
export async function telegramChatApi(
  userId: string,
  action: string,
  payload: Record<string, unknown> = {},
): Promise<TelegramChatApiResponse> {
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
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OnyxBase-Key": key },
      body: JSON.stringify({ action, ...payload }),
    });
    const data = (await res.json().catch(() => ({}))) as TelegramChatApiResponse;
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

/** GET /api/scheduler/telegram → the extended (masked) connection status. */
export async function getTelegramChatStatus(userId: string): Promise<TelegramChatApiResponse> {
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
    const data = (await res.json().catch(() => ({}))) as TelegramChatApiResponse;
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

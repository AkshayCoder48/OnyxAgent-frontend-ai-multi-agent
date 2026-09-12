/**
 * SERVER-side Telegram Bot API client (real API — api.telegram.org).
 *
 * Used by:
 *  - /api/scheduler/telegram route (connect validation, test messages)
 *  - the scheduler finalizer (post-run notifications)
 *
 * The bot token NEVER appears in model-visible context: it is resolved from
 * KV (schedule:telegram) or the encrypted browser vault, held server-side,
 * and only ever sent to api.telegram.org.
 */

const TELEGRAM_BASE = "https://api.telegram.org";

export interface TelegramBotInfo {
  id: number;
  is_bot: boolean;
  first_name: string;
  username: string;
}

export interface TelegramChatInfo {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

async function tg<T>(botToken: string, method: string, body?: Record<string, unknown>): Promise<TelegramResponse<T>> {
  try {
    const res = await fetch(`${TELEGRAM_BASE}/bot${botToken}/${method}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await res.json().catch(() => ({}))) as TelegramResponse<T>;
    return data;
  } catch (e) {
    return { ok: false, description: e instanceof Error ? e.message : "network error" };
  }
}

export async function telegramGetMe(botToken: string): Promise<TelegramBotInfo | { error: string }> {
  const r = await tg<TelegramBotInfo>(botToken, "getMe");
  if (r.ok && r.result) return r.result;
  return { error: r.description ?? `Telegram getMe failed (HTTP ${r.error_code ?? "network"})` };
}

/**
 * Discover the private chat id for the user who has messaged the bot: poll
 * getUpdates and return the newest private chat (and the sender's name).
 * The user's flow: save the token → open Telegram → send /start or any
 * message to the bot → click Discover.
 */
export async function telegramDiscoverChat(
  botToken: string,
): Promise<{ chatId: string; chatName: string } | { error: string }> {
  const r = await tg<Array<{ message?: { chat?: TelegramChatInfo; from?: { first_name?: string; username?: string }; text?: string } }>>(botToken, "getUpdates", { limit: 50 });
  if (!r.ok) return { error: r.description ?? "getUpdates failed" };
  const updates = r.result ?? [];
  let best: { chatId: string; chatName: string } | null = null;
  for (const u of updates) {
    const chat = u.message?.chat;
    if (!chat) continue;
    if (chat.type !== "private") continue; // private notifications only
    best = {
      chatId: String(chat.id),
      chatName: chat.first_name ?? chat.username ?? chat.title ?? "Telegram user",
    };
  }
  if (!best) {
    return {
      error: "No private chat found yet. Open Telegram, send /start (or any message) to your bot, then press Discover again.",
    };
  }
  return best;
}

export async function telegramSendMessage(
  botToken: string,
  chatId: string,
  text: string,
  opts?: { disableWebPagePreview?: boolean },
): Promise<{ ok: boolean; error?: string }> {
  // Telegram caps messages at 4096 chars — split long results.
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 4000) {
    chunks.push(rest.slice(0, 4000));
    rest = rest.slice(4000);
  }
  chunks.push(rest);
  for (const chunk of chunks) {
    const r = await tg<unknown>(botToken, "sendMessage", {
      chat_id: chatId,
      text: chunk,
      parse_mode: "HTML",
      disable_web_page_preview: opts?.disableWebPagePreview ?? true,
    });
    if (!r.ok) return { ok: false, error: r.description ?? "sendMessage failed" };
  }
  return { ok: true };
}

export async function telegramSendDocument(
  botToken: string,
  chatId: string,
  filename: string,
  content: string,
  caption?: string,
): Promise<{ ok: boolean; error?: string }> {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", (caption ?? "").slice(0, 1000));
  form.append(
    "document",
    new Blob([content], { type: "text/plain" }),
    filename.replace(/[^\w.\-]/g, "_") || "report.txt",
  );
  try {
    const res = await fetch(`${TELEGRAM_BASE}/bot${botToken}/sendDocument`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await res.json().catch(() => ({}))) as TelegramResponse<unknown>;
    return data.ok ? { ok: true } : { ok: false, error: data.description ?? "sendDocument failed" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "network error" };
  }
}

export async function telegramSendPhotoUrl(
  botToken: string,
  chatId: string,
  photoUrl: string,
  caption?: string,
): Promise<{ ok: boolean; error?: string }> {
  const r = await tg<unknown>(botToken, "sendPhoto", {
    chat_id: chatId,
    photo: photoUrl,
    caption: (caption ?? "").slice(0, 1000),
  });
  return r.ok ? { ok: true } : { ok: false, error: r.description ?? "sendPhoto failed" };
}

export async function telegramGetChat(
  botToken: string,
  chatId: string,
): Promise<TelegramChatInfo | { error: string }> {
  const r = await tg<TelegramChatInfo>(botToken, "getChat", { chat_id: chatId });
  if (r.ok && r.result) return r.result;
  return { error: r.description ?? "getChat failed" };
}

export async function telegramGetUpdates(
  botToken: string,
  limit = 20,
): Promise<Array<{ update_id: number; message?: { chat?: TelegramChatInfo; text?: string; date?: number } }> | { error: string }> {
  const r = await tg<Array<{ update_id: number; message?: { chat?: TelegramChatInfo; text?: string; date?: number } }>>(botToken, "getUpdates", { limit });
  if (!r.ok) return { error: r.description ?? "getUpdates failed" };
  return r.result ?? [];
}

// ---------------------------------------------------------------------------
// Webhook management (remote chat mode — unified-3b)
// ---------------------------------------------------------------------------

/** getWebhookInfo result (the fields Telegram returns). */
export interface TelegramWebhookInfo {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  ip_address?: string;
  last_error_date?: number;
  last_error_message?: string;
  last_synchronization_error_date?: number;
  max_connections?: number;
  allowed_updates?: string[];
}

/**
 * Register the webhook: Telegram POSTs every incoming message to
 * `{url}` with the `X-Telegram-Bot-Api-Secret-Token` header. Only "message"
 * updates are delivered (the webhook route ignores everything else anyway).
 * `dropPendingUpdates: true` discards updates queued before the enable
 * (fresh enable — old messages must not fire agent runs).
 */
export async function telegramSetWebhook(
  botToken: string,
  url: string,
  secretToken: string,
  opts?: { dropPendingUpdates?: boolean },
): Promise<{ ok: boolean; error?: string }> {
  const r = await tg<true>(botToken, "setWebhook", {
    url,
    secret_token: secretToken,
    allowed_updates: ["message"],
    drop_pending_updates: opts?.dropPendingUpdates === true,
  });
  return r.ok ? { ok: true } : { ok: false, error: r.description ?? "setWebhook failed" };
}

/** Remove the webhook (disable remote chat). `dropPending` also discards queued updates. */
export async function telegramDeleteWebhook(
  botToken: string,
  dropPending = false,
): Promise<{ ok: boolean; error?: string }> {
  const r = await tg<true>(botToken, "deleteWebhook", {
    drop_pending_updates: dropPending,
  });
  return r.ok ? { ok: true } : { ok: false, error: r.description ?? "deleteWebhook failed" };
}

/** Read the live webhook state (url, pending_update_count, last_error_message…). */
export async function telegramGetWebhookInfo(
  botToken: string,
): Promise<TelegramWebhookInfo | { error: string }> {
  const r = await tg<TelegramWebhookInfo>(botToken, "getWebhookInfo");
  if (r.ok && r.result) return r.result;
  return { error: r.description ?? `getWebhookInfo failed (HTTP ${r.error_code ?? "network"})` };
}

/** Looks like a Telegram bot token (123456:ABC-DEF...). */
export function looksLikeBotToken(token: string): boolean {
  return /^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(token.trim());
}

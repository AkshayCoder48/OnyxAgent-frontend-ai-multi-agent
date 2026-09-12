"use client";

/**
 * Telegram tools (browser registry — interactive turns).
 *
 * The bot token is resolved from the encrypted vault at execution time (the
 * Settings → Integrations → Telegram flow stores it there + a server-side KV
 * copy for unattended scheduled runs). The token is NEVER part of the tool
 * schema, arguments, results, or any model-visible context — same security
 * model as the OnyxBase/E2B keys.
 *
 * api.telegram.org accepts cross-origin requests, so the browser can call
 * the real Bot API directly. In BACKGROUND/scheduled runs these same tool
 * names run NATIVELY inside the E2B sandbox (see bg-agent-script.ts), where
 * the credentials are injected via run state instead.
 */

import { registerTool, type ToolContext } from "./registry";
import { getE2BClient } from "@/lib/e2b/client";
import { ensureFreshSandboxForCtx } from "@/lib/e2b/sandbox-rotation";

const TELEGRAM_BASE = "https://api.telegram.org";

interface TelegramRuntime {
  botToken: string;
  chatId: string;
}

/** Resolve the vault telegram credentials at execution time. */
async function resolveTelegram(ctx: ToolContext): Promise<TelegramRuntime | { error: string } | null> {
  try {
    const { settingsService } = await import("@/lib/services");
    const { useAuthStore } = await import("@/stores");
    const userId = ctx.userId || useAuthStore.getState().user?.id;
    if (!userId) return null;
    const botToken = await settingsService.getDecryptedTelegramBotToken(userId);
    if (!botToken || !botToken.trim()) {
      return {
        error:
          "TELEGRAM_NOT_CONNECTED: no Telegram bot is connected. Tell the user to open Settings → Integrations → Telegram and connect a bot (2-minute setup via @BotFather).",
      };
    }
    const chatId = await settingsService.getTelegramChatId(userId);
    if (!chatId) {
      return {
        error:
          "TELEGRAM_CHAT_NOT_FOUND: the bot is connected but no chat is discovered yet. The user should send /start to their bot in Telegram, then press Discover in Settings → Integrations → Telegram.",
      };
    }
    return { botToken, chatId };
  } catch {
    return null;
  }
}

async function tg<T = unknown>(
  botToken: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; result?: T; description?: string }> {
  try {
    const res = await fetch(`${TELEGRAM_BASE}/bot${botToken}/${method}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(25_000),
    });
    return (await res.json()) as { ok: boolean; result?: T; description?: string };
  } catch (e) {
    return { ok: false, description: e instanceof Error ? e.message : "network error" };
  }
}

// ---------------------------------------------------------------------------
// telegram_send_message
// ---------------------------------------------------------------------------

registerTool(
  "telegram_send_message",
  "Send a text message to the user's Telegram (their connected chat). Supports Telegram HTML (<b>, <i>, <code>). Use it to deliver reports, summaries, alerts, and results directly to the user's phone — e.g. 'send this report to my Telegram'.",
  {
    type: "object",
    properties: {
      text: { type: "string", description: "Message text (Telegram HTML allowed, max ~4000 chars per message)" },
      chat_id: { type: "string", description: "Optional override chat id — default is the user's connected chat" },
    },
    required: ["text"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const tgRt = await resolveTelegram(ctx);
    if (!tgRt || "error" in tgRt) return { error: tgRt && "error" in tgRt ? tgRt.error : "Telegram is not configured." };
    // Long messages split into 4000-char chunks.
    const text = String(args.text ?? "");
    if (!text.trim()) return { error: "text must be non-empty" };
    const chatId = String(args.chat_id || tgRt.chatId);
    const chunks: string[] = [];
    let rest = text;
    while (rest.length > 3800) {
      chunks.push(rest.slice(0, 3800));
      rest = rest.slice(3800);
    }
    chunks.push(rest);
    for (const chunk of chunks) {
      const r = await tg(tgRt.botToken, "sendMessage", {
        chat_id: chatId,
        text: chunk,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      if (!r.ok) return { error: `Telegram sendMessage failed: ${r.description ?? "unknown"}` };
    }
    return { success: true, chat_id: chatId, messages: chunks.length, length: text.length };
  },
  false,
  "telegram",
);

// ---------------------------------------------------------------------------
// telegram_send_document
// ---------------------------------------------------------------------------

registerTool(
  "telegram_send_document",
  "Send a FILE from the workspace to the user's Telegram as a document (reports, data exports, code files). Reads the file from the E2B sandbox and uploads it to Telegram.",
  {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path to send" },
      caption: { type: "string", description: "Optional caption (max 1000 chars)" },
      chat_id: { type: "string", description: "Optional override chat id" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const tgRt = await resolveTelegram(ctx);
    if (!tgRt || "error" in tgRt) return { error: tgRt && "error" in tgRt ? tgRt.error : "Telegram is not configured." };
    const e2bKey = await ensureFreshSandboxForCtx(ctx);
    if (!e2bKey) return { error: "Telegram document delivery needs an E2B sandbox key (Settings → Config → E2B Sandbox)." };
    const e2b = getE2BClient(e2bKey, null, "shared");
    const blob = await e2b.readFileBytes(String(args.path ?? ""));
    if (!blob) return { error: `File not found in the workspace: ${args.path}` };
    if (blob.size > 45 * 1024 * 1024) return { error: "File too large for Telegram (45 MB limit)" };
    const chatId = String(args.chat_id || tgRt.chatId);
    const fname = String(args.path ?? "document").split("/").pop()?.replace(/[^\w.\-]/g, "_") || "document";
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("caption", String(args.caption ?? "").slice(0, 1000));
    form.append("document", blob, fname);
    try {
      const res = await fetch(`${TELEGRAM_BASE}/bot${tgRt.botToken}/sendDocument`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
      const data = (await res.json()) as { ok: boolean; description?: string };
      if (!data.ok) return { error: `Telegram sendDocument failed: ${data.description ?? "unknown"}` };
      return { success: true, chat_id: chatId, file: fname, size: blob.size };
    } catch (e) {
      return { error: `Telegram upload failed: ${e instanceof Error ? e.message : "network error"}` };
    }
  },
  false,
  "telegram",
);

// ---------------------------------------------------------------------------
// telegram_send_photo
// ---------------------------------------------------------------------------

registerTool(
  "telegram_send_photo",
  "Send a photo to the user's Telegram — an image file from the workspace OR a public image URL. Caption optional.",
  {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative image path (alternative to url)" },
      url: { type: "string", description: "Public image URL (alternative to path)" },
      caption: { type: "string" },
      chat_id: { type: "string", description: "Optional override chat id" },
    },
    additionalProperties: false,
  },
  async (args, ctx) => {
    const tgRt = await resolveTelegram(ctx);
    if (!tgRt || "error" in tgRt) return { error: tgRt && "error" in tgRt ? tgRt.error : "Telegram is not configured." };
    const chatId = String(args.chat_id || tgRt.chatId);
    if (args.path) {
      const e2bKey = await ensureFreshSandboxForCtx(ctx);
      if (!e2bKey) return { error: "Sending a workspace image needs an E2B sandbox key." };
      const e2b = getE2BClient(e2bKey, null, "shared");
      const blob = await e2b.readFileBytes(String(args.path ?? ""));
      if (!blob) return { error: `Image not found in the workspace: ${args.path}` };
      if (blob.size > 9 * 1024 * 1024) return { error: "Photo too large for Telegram (10 MB limit)" };
      const fname = String(args.path ?? "photo.jpg").split("/").pop()?.replace(/[^\w.\-]/g, "_") || "photo.jpg";
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("caption", String(args.caption ?? "").slice(0, 1000));
      form.append("photo", blob, fname);
      try {
        const res = await fetch(`${TELEGRAM_BASE}/bot${tgRt.botToken}/sendPhoto`, {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(60_000),
        });
        const data = (await res.json()) as { ok: boolean; description?: string };
        if (!data.ok) return { error: `Telegram sendPhoto failed: ${data.description ?? "unknown"}` };
        return { success: true, chat_id: chatId, source: "file", file: fname };
      } catch (e) {
        return { error: `Telegram upload failed: ${e instanceof Error ? e.message : "network error"}` };
      }
    }
    if (args.url) {
      const r = await tg(tgRt.botToken, "sendPhoto", {
        chat_id: chatId,
        photo: String(args.url),
        caption: String(args.caption ?? "").slice(0, 1000),
      });
      if (!r.ok) return { error: `Telegram sendPhoto failed: ${r.description ?? "unknown"}` };
      return { success: true, chat_id: chatId, source: "url" };
    }
    return { error: "Provide either path (workspace image) or url (public image URL)" };
  },
  false,
  "telegram",
);

// ---------------------------------------------------------------------------
// telegram_get_updates
// ---------------------------------------------------------------------------

registerTool(
  "telegram_get_updates",
  "Fetch recent messages the user sent to the Telegram bot — read replies, commands, or questions the user sent via Telegram.",
  {
    type: "object",
    properties: { limit: { type: "number", description: "Max updates to return (default 10, max 50)" } },
    additionalProperties: false,
  },
  async (args, ctx) => {
    const tgRt = await resolveTelegram(ctx);
    if (!tgRt || "error" in tgRt) return { error: tgRt && "error" in tgRt ? tgRt.error : "Telegram is not configured." };
    const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
    const r = await tg<Array<{ message?: { chat?: { id?: number }; from?: { first_name?: string; username?: string }; text?: string; date?: number } }>>(tgRt.botToken, "getUpdates", { limit });
    if (!r.ok) {
      // Remote chat mode: Telegram refuses getUpdates while a webhook is
      // active ("can't use getUpdates while webhook is active" / 409 Conflict).
      // Degrade gracefully — updates ARE processed, just not through this tool.
      const desc = (r.description ?? "").toLowerCase();
      if (desc.includes("webhook") || desc.includes("conflict")) {
        return {
          error: "WEBHOOK_ACTIVE",
          message:
            "This bot receives messages via webhook (remote chat mode). Updates are processed automatically — this tool is unavailable while the webhook is active. Disable chat in Settings → Integrations to use it.",
        };
      }
      return { error: `Telegram getUpdates failed: ${r.description ?? "unknown"}` };
    }
    const updates = (r.result ?? []).map((u) => ({
      chat_id: u.message?.chat?.id ? String(u.message.chat.id) : null,
      from: u.message?.from?.first_name || u.message?.from?.username || "unknown",
      text: u.message?.text ?? null,
      date: u.message?.date ?? null,
    }));
    return { success: true, updates: updates.slice(0, limit) };
  },
  false,
  "telegram",
);

// ---------------------------------------------------------------------------
// telegram_get_chat
// ---------------------------------------------------------------------------

registerTool(
  "telegram_get_chat",
  "Get information about a Telegram chat by id — type (private/group/channel), name, username. Defaults to the user's connected chat.",
  {
    type: "object",
    properties: { chat_id: { type: "string", description: "Chat id to inspect — default is the connected chat" } },
    additionalProperties: false,
  },
  async (args, ctx) => {
    const tgRt = await resolveTelegram(ctx);
    if (!tgRt || "error" in tgRt) return { error: tgRt && "error" in tgRt ? tgRt.error : "Telegram is not configured." };
    const chatId = String(args.chat_id || tgRt.chatId);
    const r = await tg<{ id?: number; type?: string; title?: string; username?: string; first_name?: string }>(tgRt.botToken, "getChat", { chat_id: chatId });
    if (!r.ok) return { error: `Telegram getChat failed: ${r.description ?? "unknown"}` };
    const c = r.result ?? {};
    return { success: true, chat: { id: String(c.id ?? chatId), type: c.type ?? null, title: c.title ?? null, username: c.username ?? null, first_name: c.first_name ?? null } };
  },
  false,
  "telegram",
);

export {};

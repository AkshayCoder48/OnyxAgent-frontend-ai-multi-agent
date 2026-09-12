// ============================================================================
// Telegram integration API — real Bot API connection flow + remote chat mode.
//
// GET  /api/scheduler/telegram        → connection status (bot token MASKED)
// POST /api/scheduler/telegram        → { action: connect | discover | test |
//                                        disconnect | enable_chat |
//                                        disable_chat | webhook_status }
//   connect:       { botToken }       → validates via getMe, stores the config
//   discover:      {}                 → finds the user's private chat id via
//                                       getUpdates (user sent /start to the bot)
//   test:          {}                 → sends a test message to the stored chat
//   disconnect:    {}                 → removes the connection (+ webhook)
//   enable_chat:   { provider, mirrorRuns? }
//                                    → REMOTE CHAT: registers the webhook
//                                       (secret token), stores the provider
//                                       snapshot + chat meta; a Telegram
//                                       message then launches the full agent
//                                       runtime (see /api/telegram/webhook)
//   disable_chat:  {}                 → removes the webhook, clears the chat
//                                       fields (connection stays)
//   webhook_status:{}                 → live webhook info (masked)
//
// The bot token + webhook secret are stored ONLY in OnyxBase KV
// (schedule:telegram, the user's own account storage) and are NEVER returned
// to the client (status responses carry only botName/botUsername/chatId plus
// the masked chat-mode view). They never appear in tool schemas, prompts, or
// model-visible context.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { SchedulerKV, resolveSchedulerKey } from "@/lib/scheduler/server-kv";
import {
  looksLikeBotToken,
  telegramDeleteWebhook,
  telegramDiscoverChat,
  telegramGetMe,
  telegramGetWebhookInfo,
  telegramSendMessage,
  telegramSetWebhook,
} from "@/lib/scheduler/telegram";
import {
  SCHED_TELEGRAM_KEY,
  type ProviderSnapshot,
  type TelegramConnectionConfig,
} from "@/lib/scheduler/types";
import { writeChatMeta } from "@/lib/scheduler/chat-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function auth(req: NextRequest): { kv: SchedulerKV } | { error: NextResponse } {
  const key = resolveSchedulerKey(req.headers.get("x-onyxbase-key"));
  if (!key) {
    return {
      error: NextResponse.json(
        { ok: false, error: "NOT_CONFIGURED", message: "Add your OnyxBase API key in Settings → Cloud Workspace first." },
        { status: 503 },
      ),
    };
  }
  return { kv: new SchedulerKV(key) };
}

async function readConfig(kv: SchedulerKV): Promise<TelegramConnectionConfig | null> {
  try {
    const raw = await kv.get(SCHED_TELEGRAM_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as TelegramConnectionConfig;
  } catch {
    return null;
  }
}

async function writeConfig(kv: SchedulerKV, cfg: TelegramConnectionConfig): Promise<void> {
  await kv.set(SCHED_TELEGRAM_KEY, JSON.stringify(cfg));
}

/** Masked status view — NEVER includes botToken / webhookSecret / provider key. */
function masked(cfg: TelegramConnectionConfig | null) {
  if (!cfg) {
    return {
      connected: false,
      botName: null,
      botUsername: null,
      chatId: null,
      chatName: null,
      connectedAt: null,
      chatEnabled: false,
    };
  }
  const chatEnabled = !!(cfg.webhookSecret && cfg.webhookUrl);
  return {
    connected: !!(cfg.botToken && cfg.chatId),
    botName: cfg.botName,
    botUsername: cfg.botUsername,
    chatId: cfg.chatId,
    chatName: cfg.chatName,
    connectedAt: cfg.connectedAt,
    chatEnabled,
    ...(cfg.webhookUrl ? { webhookUrl: cfg.webhookUrl } : {}),
    ...(cfg.provider?.model ? { providerModel: cfg.provider.model } : {}),
    ...(typeof cfg.mirrorRuns === "boolean" ? { mirrorRuns: cfg.mirrorRuns } : {}),
    ...(cfg.enabledAt ? { enabledAt: cfg.enabledAt } : {}),
  };
}

/** Validate a client-supplied provider snapshot (execution config — the
 *  resolved values come from the user's own settings, but junk is rejected). */
function sanitizeProvider(raw: unknown): ProviderSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const baseUrl = typeof p.baseUrl === "string" ? p.baseUrl.trim() : "";
  const model = typeof p.model === "string" ? p.model.trim() : "";
  if (!baseUrl || !model) return null;
  return {
    baseUrl,
    apiKey: typeof p.apiKey === "string" ? p.apiKey : null,
    model,
    ...(typeof p.toolsEnabled === "boolean" ? { toolsEnabled: p.toolsEnabled } : {}),
    ...(typeof p.noPrefix === "boolean" ? { noPrefix: p.noPrefix } : {}),
    ...(Array.isArray(p.disabledParams)
      ? { disabledParams: p.disabledParams.filter((x): x is string => typeof x === "string") }
      : {}),
  };
}

/** Derive the public origin for the webhook URL. Prefers x-forwarded-host
 *  (Vercel/proxies) over request.url; proto from x-forwarded-proto (https). */
function publicOrigin(req: NextRequest): string {
  const forwardedHost = (req.headers.get("x-forwarded-host") ?? "").split(",")[0]?.trim() ?? "";
  if (forwardedHost) {
    const proto = (req.headers.get("x-forwarded-proto") ?? "").split(",")[0]?.trim() || "https";
    return `${proto}://${forwardedHost}`;
  }
  try {
    return new URL(req.url).origin;
  } catch {
    return "";
  }
}

function originLooksLocal(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host.endsWith(".local") ||
      host.endsWith(".internal")
    );
  } catch {
    return true;
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const a = auth(req);
  if ("error" in a) return a.error;
  const cfg = await readConfig(a.kv);
  return NextResponse.json({ ok: true, telegram: masked(cfg) });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const a = auth(req);
  if ("error" in a) return a.error;
  const kv = a.kv;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "BAD_REQUEST", message: "Invalid JSON body" }, { status: 400 });
  }
  const action = String(body.action ?? "");

  try {
    switch (action) {
      case "connect": {
        const botToken = String(body.botToken ?? "").trim();
        if (!looksLikeBotToken(botToken)) {
          return NextResponse.json(
            { ok: false, error: "INVALID_TOKEN", message: "That doesn't look like a Telegram bot token. Get one from @BotFather (format: 123456789:AAE…)." },
            { status: 400 },
          );
        }
        const me = await telegramGetMe(botToken);
        if ("error" in me) {
          return NextResponse.json({ ok: false, error: "TELEGRAM_REJECTED", message: `Telegram rejected the token: ${me.error}` }, { status: 400 });
        }
        const existing = await readConfig(kv);
        const sameBot = existing?.botToken === botToken;
        const cfg: TelegramConnectionConfig = {
          botToken,
          botName: me.first_name,
          botUsername: me.username,
          // Same bot → keep the discovered chat; different bot → start clean.
          chatId: sameBot ? (existing?.chatId ?? null) : null,
          chatName: sameBot ? (existing?.chatName ?? null) : null,
          connectedAt: new Date().toISOString(),
          // Same bot → keep the remote-chat state (webhook + provider + cursor).
          ...(sameBot && existing
            ? {
                ...(existing.webhookSecret ? { webhookSecret: existing.webhookSecret } : {}),
                ...(existing.webhookUrl ? { webhookUrl: existing.webhookUrl } : {}),
                ...(existing.conversationId ? { conversationId: existing.conversationId } : {}),
                ...(existing.provider !== undefined ? { provider: existing.provider } : {}),
                ...(existing.mirrorRuns !== undefined ? { mirrorRuns: existing.mirrorRuns } : {}),
                ...(existing.enabledAt ? { enabledAt: existing.enabledAt } : {}),
                ...(existing.lastUpdateId !== undefined ? { lastUpdateId: existing.lastUpdateId } : {}),
              }
            : {}),
        };
        await writeConfig(kv, cfg);
        return NextResponse.json({
          ok: true,
          telegram: masked(cfg),
          message: `Connected to @${me.username}. Now send /start to your bot in Telegram and press Discover Chat.`,
        });
      }

      case "discover": {
        const cfg = await readConfig(kv);
        if (!cfg?.botToken) {
          return NextResponse.json({ ok: false, error: "NOT_CONNECTED", message: "Connect a bot token first." }, { status: 400 });
        }
        if (cfg.webhookSecret && cfg.webhookUrl) {
          return NextResponse.json(
            {
              ok: false,
              error: "WEBHOOK_ACTIVE",
              message: "Remote chat is enabled — Telegram routes updates to the webhook, so getUpdates is unavailable. Disable chat first if you need to re-discover.",
            },
            { status: 409 },
          );
        }
        const found = await telegramDiscoverChat(cfg.botToken);
        if ("error" in found) {
          return NextResponse.json({ ok: false, error: "NO_CHAT", message: found.error }, { status: 400 });
        }
        cfg.chatId = found.chatId;
        cfg.chatName = found.chatName;
        await writeConfig(kv, cfg);
        return NextResponse.json({
          ok: true,
          telegram: masked(cfg),
          message: `Found chat with ${found.chatName} (${found.chatId}). Telegram notifications are ready.`,
        });
      }

      case "test": {
        const cfg = await readConfig(kv);
        if (!cfg?.botToken || !cfg.chatId) {
          return NextResponse.json({ ok: false, error: "NOT_CONNECTED", message: "Connect the bot + discover your chat first." }, { status: 400 });
        }
        const r = await telegramSendMessage(
          cfg.botToken,
          cfg.chatId,
          "✓ <b>OnyxAgent Telegram test</b>\nYour Telegram connection works. Scheduled-task results will arrive here.",
        );
        if (!r.ok) {
          return NextResponse.json({ ok: false, error: "SEND_FAILED", message: r.error ?? "send failed" }, { status: 400 });
        }
        return NextResponse.json({ ok: true, message: "Test message sent to your Telegram." });
      }

      case "enable_chat": {
        const cfg = await readConfig(kv);
        if (!cfg?.botToken || !cfg.chatId) {
          return NextResponse.json(
            { ok: false, error: "NOT_CONNECTED", message: "Connect the bot + discover your chat first." },
            { status: 400 },
          );
        }
        const provider = sanitizeProvider(body.provider);
        const mirrorRuns = body.mirrorRuns === true;
        const webhookSecret = randomBytes(24).toString("hex");
        const origin = publicOrigin(req);
        const webhookUrl = `${origin}/api/telegram/webhook`;
        // Fresh enable: drop anything queued before now (old messages must
        // not fire agent runs).
        const setResult = await telegramSetWebhook(cfg.botToken, webhookUrl, webhookSecret, {
          dropPendingUpdates: true,
        });
        if (!setResult.ok) {
          const message = originLooksLocal(origin)
            ? "Webhook URL is not publicly reachable — Telegram requires a public HTTPS URL. Deploy OnyxAgent (e.g. on Vercel) and enable chat from the deployed site."
            : `Telegram rejected the webhook: ${setResult.error ?? "unknown error"}`;
          return NextResponse.json({ ok: false, error: "WEBHOOK_FAILED", message }, { status: 400 });
        }
        cfg.webhookSecret = webhookSecret;
        cfg.webhookUrl = webhookUrl;
        cfg.conversationId = cfg.chatId;
        cfg.provider = provider;
        cfg.mirrorRuns = mirrorRuns;
        cfg.enabledAt = new Date().toISOString();
        delete cfg.lastUpdateId; // fresh enable — clean dedup cursor
        await writeConfig(kv, cfg);
        // The linked chat's KV meta (title/kind) — the web-app chat list and
        // the webhook's default naming read this.
        try {
          await writeChatMeta(kv, cfg.chatId, {
            title: cfg.chatName || "Telegram",
            kind: "telegram",
            createdAt: cfg.connectedAt ?? new Date().toISOString(),
          });
        } catch {
          /* best-effort — chat records work without meta */
        }
        return NextResponse.json({
          ok: true,
          webhookUrl,
          botInfo: { name: cfg.botName, username: cfg.botUsername },
          telegram: masked(cfg),
          message: provider
            ? "Remote chat enabled — send your bot a message in Telegram and it runs on the full agent runtime."
            : "Remote chat enabled without a provider — Telegram replies will warn until you re-enable chat with a model selected.",
        });
      }

      case "disable_chat": {
        const cfg = await readConfig(kv);
        if (!cfg?.botToken) {
          return NextResponse.json({ ok: false, error: "NOT_CONNECTED", message: "Connect a bot token first." }, { status: 400 });
        }
        let warning: string | undefined;
        if (cfg.webhookSecret || cfg.webhookUrl) {
          const r = await telegramDeleteWebhook(cfg.botToken, false);
          if (!r.ok) {
            warning = `Webhook removal failed on Telegram's side: ${r.error ?? "unknown"} — Telegram may keep delivering updates; they will be rejected here.`;
          }
        }
        // Clear the remote-chat fields; the connection fields stay intact.
        delete cfg.webhookSecret;
        delete cfg.webhookUrl;
        delete cfg.conversationId;
        delete cfg.provider;
        delete cfg.mirrorRuns;
        delete cfg.enabledAt;
        delete cfg.lastUpdateId;
        await writeConfig(kv, cfg);
        return NextResponse.json({
          ok: true,
          telegram: masked(cfg),
          ...(warning ? { warning } : {}),
          message: "Remote chat disabled — the bot no longer launches agent runs.",
        });
      }

      case "webhook_status": {
        const cfg = await readConfig(kv);
        if (!cfg?.botToken) {
          return NextResponse.json({ ok: false, error: "NOT_CONNECTED", message: "Connect a bot token first." }, { status: 400 });
        }
        const info = await telegramGetWebhookInfo(cfg.botToken);
        if ("error" in info) {
          return NextResponse.json({ ok: false, error: "STATUS_FAILED", message: info.error }, { status: 400 });
        }
        // Masked: url + pending count + last error only.
        return NextResponse.json({
          ok: true,
          info: {
            url: info.url ?? "",
            pendingUpdateCount: typeof info.pending_update_count === "number" ? info.pending_update_count : 0,
            lastErrorMessage: info.last_error_message ?? null,
          },
        });
      }

      case "disconnect": {
        const cfg = await readConfig(kv);
        // Remove a live webhook FIRST — otherwise Telegram would keep POSTing
        // to a route whose config (and secret) is about to vanish.
        if (cfg?.botToken && (cfg.webhookSecret || cfg.webhookUrl)) {
          await telegramDeleteWebhook(cfg.botToken, false).catch(() => {});
        }
        try {
          await kv.delete(SCHED_TELEGRAM_KEY);
        } catch {
          /* best-effort */
        }
        return NextResponse.json({ ok: true, telegram: masked(null) });
      }

      default:
        return NextResponse.json({ ok: false, error: "UNKNOWN_ACTION", message: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "ACTION_FAILED", message: e instanceof Error ? e.message : "action failed" },
      { status: 500 },
    );
  }
}

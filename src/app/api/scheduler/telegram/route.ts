// ============================================================================
// Telegram integration API — real Bot API connection flow.
//
// GET  /api/scheduler/telegram        → connection status (bot token MASKED)
// POST /api/scheduler/telegram        → { action: connect | discover | test | disconnect }
//   connect:   { botToken }           → validates via getMe, stores the config
//   discover:  {}                      → finds the user's private chat id via
//                                        getUpdates (user sent /start to the bot)
//   test:      {}                      → sends a test message to the stored chat
//   disconnect: {}                     → removes the connection
//
// The bot token is stored ONLY in OnyxBase KV (schedule:telegram, the user's
// own encrypted-at-rest account storage) and is NEVER returned to the client
// (status responses carry only botName/botUsername/chatId). It never appears
// in tool schemas, prompts, or model-visible context.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { SchedulerKV, resolveSchedulerKey } from "@/lib/scheduler/server-kv";
import {
  looksLikeBotToken,
  telegramDiscoverChat,
  telegramGetMe,
  telegramSendMessage,
} from "@/lib/scheduler/telegram";
import { SCHED_TELEGRAM_KEY } from "@/lib/scheduler/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface TelegramConfig {
  botToken: string;
  botName: string | null;
  botUsername: string | null;
  chatId: string | null;
  chatName: string | null;
  connectedAt: string | null;
}

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

async function readConfig(kv: SchedulerKV): Promise<TelegramConfig | null> {
  try {
    const raw = await kv.get(SCHED_TELEGRAM_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as TelegramConfig;
  } catch {
    return null;
  }
}

async function writeConfig(kv: SchedulerKV, cfg: TelegramConfig): Promise<void> {
  await kv.set(SCHED_TELEGRAM_KEY, JSON.stringify(cfg));
}

function masked(cfg: TelegramConfig | null) {
  if (!cfg) {
    return { connected: false, botName: null, botUsername: null, chatId: null, connectedAt: null };
  }
  return {
    connected: !!(cfg.botToken && cfg.chatId),
    botName: cfg.botName,
    botUsername: cfg.botUsername,
    chatId: cfg.chatId,
    chatName: cfg.chatName,
    connectedAt: cfg.connectedAt,
  };
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
        const cfg: TelegramConfig = {
          botToken,
          botName: me.first_name,
          botUsername: me.username,
          chatId: existing?.botToken === botToken ? (existing.chatId ?? null) : null,
          chatName: existing?.botToken === botToken ? (existing.chatName ?? null) : null,
          connectedAt: new Date().toISOString(),
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

      case "disconnect": {
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

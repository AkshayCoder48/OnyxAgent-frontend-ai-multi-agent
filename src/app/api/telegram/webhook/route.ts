// ============================================================================
// Telegram webhook — the remote-chat entry point (unified-3b, spec §17-§26).
//
// Telegram POSTs every message the user sends to the bot here (the webhook
// is registered by enable_chat with a secret token). The flow:
//
//   update.message → secret-token check → linked-chat check → update-id dedup
//   → user message appended to the KV chat (deterministic id tgmsg_<update_id>
//   — retries are idempotent) → startChatExecution — the SAME agent runtime
//   as the web app (isolated E2B sandbox + cloud workspace restore + tools),
//   with state.telegram.stream = true so the in-sandbox streamer (unified-2a)
//   streams thinking / tool progress / the final answer back into the
//   Telegram chat by editing one message. The scheduler tick then finalizes
//   the run and appends the assistant message to the same chat, so the web
//   UI shows the whole conversation.
//
// SECURITY: the request is accepted only when the X-Telegram-Bot-Api-Secret-Token
// header equals the KV config's webhookSecret (set at enable time) AND the
// message's chat id equals the linked chat id. Failures answer 401/503 in
// PLAIN TEXT with no config details. The webhookSecret never appears in any
// response, log line or message.
//
// The KV resolves through the SERVER env key (ONYXBASE_SCHEDULER_KEY) — the
// webhook is server-only, there is no browser to carry a vault key.
//
// ALWAYS answer 200 once authenticated: Telegram retries non-200 responses
// with backoff and would hammer the route. Launch failures notify the user
// through the bot itself instead.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { SchedulerKV, resolveSchedulerKey } from "@/lib/scheduler/server-kv";
import {
  SCHED_TELEGRAM_KEY,
  type ProviderSnapshot,
  type TelegramConnectionConfig,
} from "@/lib/scheduler/types";
import { startChatExecution } from "@/lib/scheduler/engine";
import { appendServerMessages, buildChatHistory, readChatMeta } from "@/lib/scheduler/chat-store";
import { telegramSendMessage } from "@/lib/scheduler/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";

/** A Telegram Update (only the fields this route reads). */
interface TelegramWebhookUpdate {
  update_id: number;
  message?: {
    message_id?: number;
    date?: number;
    text?: string;
    chat?: { id?: number; type?: string };
  };
}

/** Health probe — no config details, no secret, no KV access. */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: true, service: "onyxagent-telegram-webhook" });
}

/**
 * The default system prompt for a telegram-triggered chat execution — the
 * engine's scheduled prompt STYLE (compact, Onyx.md as the file compendium)
 * but framed as a normal assistant conversation, not an autonomous run.
 */
const TELEGRAM_CHAT_SYSTEM_PROMPT = `You are ONYX — an AI assistant with a Linux
sandbox (/home/user is your workspace) and real tools, chatting with the user
over Telegram.

## TELEGRAM REMOTE CHAT MODE

The user's message arrives from Telegram. Your progress and final answer
stream back into that Telegram chat, and the whole conversation is saved into
the linked OnyxAgent chat — the user sees it in the web app too.

RULES FOR THIS RUN:
1. Handle the user's message completely — this is the full agent runtime:
   research, code, file generation and data processing are all available.
2. No interactive browser is connected — never call ask_user. When something
   is ambiguous, make the most sensible choice, say so in your reply and
   continue; the user refines with the next message.
3. Browser-side tools (chats, memories, skills management, subagents) have
   no browser connected — they will time out. Use the sandbox-native tools
   (files, terminal, python, web_fetch, web_search, charts, datetime, …).
4. Save deliverables as FILES in the workspace (e.g. reports as .md) — the
   final workspace state syncs back to the user's persistent cloud workspace
   when the run finishes — and reference the paths in your reply.
5. Lead with the answer; attach long details as files. Telegram messages
   read best focused and self-contained.

## Available tools (sandbox-native)
- Files: analyze_workspace, list_folder, read_file, read_file_section,
  create_file, write_file, edit_file, delete_file, create_folder,
  delete_folder, move_file, verify_path, create_file_chunk, send_file,
  send_folder, search_documents
- Execution: run_python (60s), run_terminal (120s)
- Web: web_search, web_fetch, image_search, video_search
- Data/media: create_chart, preview_image, ocr_document, counterfactual,
  current_datetime
- Planning: manage_todo, show_todo
- Telegram: telegram_send_message, telegram_send_document,
  telegram_send_photo, telegram_get_updates, telegram_get_chat
(always function-calling — never "Thought:/Action:" text)

READ /home/user/Onyx.md FIRST (read_file) — it documents every tool in
detail plus the GenUI spec, execution policies, and the workspace rules
that apply to you.

## Workspace rules
- E2B is temporary; the cloud workspace is permanent. Your file changes are
  synced back automatically at the end of this run — write deliverables as
  real files.
- Files >50MB, .env/secrets, node_modules/.git/build dirs are never synced.
- Never fabricate results: if a step fails, say so in your reply.`;

async function readTelegramConfig(kv: SchedulerKV): Promise<TelegramConnectionConfig | null> {
  try {
    const raw = await kv.get(SCHED_TELEGRAM_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as TelegramConnectionConfig;
  } catch {
    return null;
  }
}

/**
 * Persist the dedup cursor AFTER a successful launch. Read-modify-write with
 * a max() guard so concurrent webhook deliveries (or a disable/enable racing
 * this write) can never regress or clobber unrelated config fields.
 * Best-effort: a failed save only means a retry re-processes the update —
 * which is safe (deterministic message ids, downstream dedup by id).
 */
async function persistUpdateCursor(kv: SchedulerKV, updateId: number): Promise<void> {
  try {
    const raw = await kv.get(SCHED_TELEGRAM_KEY);
    if (!raw) return; // config removed concurrently — nothing to mark
    const live = JSON.parse(raw) as TelegramConnectionConfig;
    if (!live || typeof live !== "object") return;
    const prev = typeof live.lastUpdateId === "number" ? live.lastUpdateId : 0;
    live.lastUpdateId = Math.max(prev, updateId);
    await kv.set(SCHED_TELEGRAM_KEY, JSON.stringify(live));
  } catch {
    /* best-effort — see the doc comment */
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── 1. Secret header — a Telegram webhook call ALWAYS carries it. A missing
  //       header is rejected outright (401, plain text, no details). ──
  const secret = req.headers.get(TELEGRAM_SECRET_HEADER) ?? "";
  if (!secret) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  // ── 2. Env-key path (server-only; no browser header on a Telegram call). ──
  const envKey = resolveSchedulerKey(null);
  if (!envKey) {
    return new NextResponse("scheduler key not configured", { status: 503 });
  }
  const kv = new SchedulerKV(envKey);

  // ── 3. Secret-token comparison vs the KV config (plain-text 401, no details):
  //       wrong secret, missing config, or chat disabled (no webhookSecret). ──
  let config: TelegramConnectionConfig | null = null;
  try {
    config = await readTelegramConfig(kv);
  } catch {
    config = null;
  }
  if (!config?.webhookSecret || secret !== config.webhookSecret) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  const botToken = config.botToken;
  const chatId = config.chatId ?? "";
  if (!botToken || !chatId) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  // ── 4. Parse the update — only update.message is handled. ──
  let update: TelegramWebhookUpdate | null = null;
  try {
    update = (await req.json()) as TelegramWebhookUpdate;
  } catch {
    update = null;
  }
  if (!update || typeof update.update_id !== "number" || !update.message) {
    // Edits, callbacks, channel posts… — acknowledged and ignored.
    return NextResponse.json({ ok: true });
  }
  const message = update.message;

  // ── 5. Security — only the linked chat; never leak the config. ──
  if (String(message.chat?.id ?? "") !== String(chatId)) {
    return NextResponse.json({ ok: true });
  }

  // ── 6. Dedup by update_id (Telegram retries + redeliveries). ──
  const lastUpdateId = typeof config.lastUpdateId === "number" ? config.lastUpdateId : 0;
  if (update.update_id <= lastUpdateId) {
    return NextResponse.json({ ok: true });
  }

  const text = typeof message.text === "string" ? message.text : "";

  // /start → one-line welcome (no agent run).
  if (text.trim() === "/start") {
    await telegramSendMessage(
      botToken,
      chatId,
      "👋 You're chatting with <b>OnyxAgent</b>. Send any text message and it runs on the full agent runtime — progress and the answer stream right here, and the conversation appears in your OnyxAgent chat list.",
    );
    await persistUpdateCursor(kv, update.update_id);
    return NextResponse.json({ ok: true });
  }

  // Non-text messages (stickers, photos, voice…) — polite refusal, no run.
  if (!text.trim()) {
    await telegramSendMessage(botToken, chatId, "I can only read text messages for now.");
    await persistUpdateCursor(kv, update.update_id);
    return NextResponse.json({ ok: true });
  }

  // Other commands (bot-style) — acknowledged silently, no run.
  if (text.startsWith("/")) {
    await persistUpdateCursor(kv, update.update_id);
    return NextResponse.json({ ok: true });
  }

  // ── The real path: append the user message → launch the chat execution.
  //    (Wrapped in try/catch — a failure still answers 200 so Telegram
  //    doesn't retry-hammer the route; the user gets a bot message instead.) ──
  try {
    // Deterministic id: a Telegram retry after a stranded cursor save
    // re-appends the SAME id — buildChatHistory + the merge poller dedupe by
    // message id, so the history never duplicates.
    await appendServerMessages(kv, chatId, [
      {
        id: `tgmsg_${update.update_id}`,
        role: "user",
        content: text,
        createdAt: new Date((message.date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
        origin: "telegram",
      },
    ]);

    const [history, meta] = await Promise.all([buildChatHistory(kv, chatId), readChatMeta(kv, chatId)]);

    // The message we just appended rides as `userMessage` — EXCLUDE it from
    // the history so state.messages never contains the turn twice.
    const messageId = `tgmsg_${update.update_id}`;
    const priorHistory = history.history.filter((h) => h.id !== messageId);

    const provider: ProviderSnapshot | null =
      config.provider && typeof config.provider.baseUrl === "string" && config.provider.baseUrl.trim()
        ? (config.provider as ProviderSnapshot)
        : null;
    if (!provider) {
      await telegramSendMessage(
        botToken,
        chatId,
        "⚠️ No AI provider configured — open Settings → Integrations → Telegram in the web app and re-enable chat with a provider selected.",
      );
      // No run launched — the cursor is NOT advanced (re-enabling with a
      // provider lets the user resend the message).
      return NextResponse.json({ ok: true });
    }

    await startChatExecution(kv, {
      chatId,
      trigger: "telegram",
      userMessage: text,
      systemPrompt: history.systemPrompt || TELEGRAM_CHAT_SYSTEM_PROMPT,
      history: priorHistory,
      provider,
      telegram: { botToken, chatId },
      name: ((meta?.title ?? "Telegram chat") || "Telegram chat").slice(0, 60),
      appOrigin: req.nextUrl.origin,
    });

    // Persist the cursor ONLY after the launch succeeded.
    await persistUpdateCursor(kv, update.update_id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    // 200 anyway — Telegram would retry and hammer the route otherwise.
    console.error("[telegram-webhook] failed to process update", update.update_id, e);
    const detail = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    await telegramSendMessage(botToken, chatId, `⚠️ OnyxAgent failed to start this run: ${detail}`).catch(() => {});
    return NextResponse.json({ ok: true });
  }
}

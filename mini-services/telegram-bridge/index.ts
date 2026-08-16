/**
 * OnyxAgent Telegram + WhatsApp Bridge
 *
 * A standalone mini-service that:
 * - Receives messages from Telegram (via Bot API)
 * - Forwards them to the OnyxAgent web app's chat API
 * - Streams the AI response back to Telegram
 * - Optionally mirrors messages to WhatsApp via Green-API
 *
 * Environment variables:
 *   TELEGRAM_BOT_TOKEN   — from @BotFather
 *   ONYX_WEB_URL          — the web app URL (default: http://localhost:3000)
 *   ONYX_PROVIDER_ID      — provider ID to use (optional, uses active)
 *   ONYX_API_KEY          — API key if the web app requires auth (optional)
 *   WHATSAPP_INSTANCE_ID  — Green-API instance ID (optional)
 *   WHATSAPP_API_TOKEN    — Green-API API token (optional)
 *   PORT                  — webhook server port (default: 3001, for webhook mode)
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=123:abc bun run dev
 *
 * Or with WhatsApp mirroring:
 *   TELEGRAM_BOT_TOKEN=123:abc \
 *   WHATSAPP_INSTANCE_ID=123456 \
 *   WHATSAPP_API_TOKEN=abcdef \
 *   bun run dev
 */

import { Bot, InlineKeyboard } from "grammy";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ONYX_WEB_URL = process.env.ONYX_WEB_URL || "http://localhost:3000";
const ONYX_API_KEY = process.env.ONYX_API_KEY || "";
const WHATSAPP_INSTANCE_ID = process.env.WHATSAPP_INSTANCE_ID;
const WHATSAPP_API_TOKEN = process.env.WHATSAPP_API_TOKEN;

if (!TELEGRAM_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN is required. Get one from @BotFather.");
  process.exit(1);
}

// Conversation tracking: Telegram chat ID → OnyxAgent conversation ID
const conversations = new Map<number, string>();

const bot = new Bot(TELEGRAM_TOKEN);

// /start command
bot.command("start", (ctx) => {
  ctx.reply(
    "🤖 *OnyxAgent Bot*\n\n" +
    "I'm connected to OnyxAgent AI. Send me a message and I'll reply!\n\n" +
    "Commands:\n" +
    "/new — Start a new conversation\n" +
    "/model — Show current model\n" +
    "/help — Show this help",
    { parse_mode: "Markdown" }
  );
});

bot.command("new", (ctx) => {
  conversations.delete(ctx.chat.id);
  ctx.reply("✅ Started a new conversation. What would you like to ask?");
});

bot.command("help", (ctx) => {
  ctx.reply(
    "🤖 *OnyxAgent Bot*\n\n" +
    "Just send me a message and I'll forward it to the AI.\n\n" +
    "Commands:\n" +
    "/new — New conversation\n" +
    "/model — Show model\n" +
    "/help — This help",
    { parse_mode: "Markdown" }
  );
});

bot.command("model", async (ctx) => {
  ctx.reply("📡 Fetching model info...");
  try {
    const res = await fetch(`${ONYX_WEB_URL}/api/chat-proxy`, {
      method: "GET",
    });
    if (res.ok) {
      ctx.reply("✅ Connected to OnyxAgent. Send a message to chat!");
    } else {
      ctx.reply("⚠️ OnyxAgent web app is running but may need configuration.");
    }
  } catch {
    ctx.reply("❌ Could not reach OnyxAgent web app. Make sure it's running.");
  }
});

// Main message handler — forward to OnyxAgent and stream response back
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) return; // Skip commands

  const chatId = ctx.chat.id;

  // Send "typing" indicator
  await ctx.replyWithChatAction("typing");

  // Get or create conversation ID
  let conversationId = conversations.get(chatId);
  const isNewConversation = !conversationId;

  try {
    // Call the OnyxAgent web app's internal chat API
    // We use the chat-proxy endpoint to get a streaming response
    const response = await fetch(`${ONYX_WEB_URL}/api/chat-proxy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(ONYX_API_KEY ? { Authorization: `Bearer ${ONYX_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        message: text,
        conversationId: conversationId || undefined,
        stream: true,
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      ctx.reply(`❌ Error: ${response.status} — ${errText.slice(0, 200)}`);
      return;
    }

    // Stream the response — collect chunks and send as a single message
    // (Telegram doesn't support true streaming, so we accumulate and send)
    let fullText = "";
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    if (reader) {
      // Send initial "thinking" message
      const thinkingMsg = await ctx.reply("🤔 Thinking...");

      let buffer = "";
      let lastUpdate = Date.now();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const dataLine = line.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          const data = dataLine.slice(6).trim();

          if (data === "[DONE]") break;

          try {
            const chunk = JSON.parse(data);
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              fullText += delta;

              // Update the message every 2 seconds to show progress
              const now = Date.now();
              if (now - lastUpdate > 2000 && fullText.length > 0) {
                lastUpdate = now;
                try {
                  await ctx.api.editMessageText(chatId, thinkingMsg.message_id, fullText.slice(0, 4000) + " ⏳");
                } catch {
                  // Message edit may fail if text hasn't changed enough
                }
                await ctx.replyWithChatAction("typing");
              }
            }
          } catch {}
        }
      }

      // Final message — replace the thinking message
      if (fullText) {
        try {
          await ctx.api.editMessageText(chatId, thinkingMsg.message_id, fullText.slice(0, 4096));
        } catch {
          // If edit fails (e.g., text too long or identical), send new message
          await ctx.reply(fullText.slice(0, 4096));
        }
      } else {
        await ctx.api.editMessageText(chatId, thinkingMsg.message_id, "⚠️ No response received.");
      }

      reader.releaseLock();
    }

    // Optionally mirror to WhatsApp
    if (WHATSAPP_INSTANCE_ID && WHATSAPP_API_TOKEN) {
      await sendWhatsAppMessage(text, "user");
      if (fullText) {
        await sendWhatsAppMessage(fullText.slice(0, 4096), "assistant");
      }
    }
  } catch (err) {
    console.error("[telegram-bridge] Error:", err);
    ctx.reply(`❌ ${err instanceof Error ? err.message : "Unknown error"}`);
  }
});

// Handle photos/documents — OCR via freeocr.ai
bot.on("message:photo", async (ctx) => {
  const photo = ctx.message.photo[ctx.message.photo.length - 1]!;
  const file = await bot.api.getFile(photo.file_id);
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;

  await ctx.reply("🔍 Running OCR on your image...");

  try {
    const ocrRes = await fetch("https://freeocr.ai/api/v1/ocr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_url: fileUrl }),
    });

    if (ocrRes.ok) {
      const data = await ocrRes.json();
      const text = data.text || "(No text detected)";
      ctx.reply(`📝 *OCR Result:*\n\n${text}`, { parse_mode: "Markdown" });
    } else {
      ctx.reply("❌ OCR failed. Try again with a clearer image.");
    }
  } catch (err) {
    ctx.reply(`❌ OCR error: ${err instanceof Error ? err.message : "Unknown"}`);
  }
});

/**
 * Send a message to WhatsApp via Green-API.
 */
async function sendWhatsAppMessage(text: string, _role: string): Promise<void> {
  if (!WHATSAPP_INSTANCE_ID || !WHATSAPP_API_TOKEN) return;
  try {
    await fetch(
      `https://api.green-api.com/waInstance${WHATSAPP_INSTANCE_ID}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId: `${WHATSAPP_INSTANCE_ID}@c.us`,
          message: text.slice(0, 4096),
        }),
      }
    );
  } catch (err) {
    console.error("[whatsapp] Failed to send:", err);
  }
}

// Start the bot
console.log("🤖 OnyxAgent Telegram Bridge starting...");
console.log(`   Web app: ${ONYX_WEB_URL}`);
console.log(`   WhatsApp: ${WHATSAPP_INSTANCE_ID ? "connected" : "disabled"}`);
console.log(`   Bot: polling for messages...`);

bot.start({
  onStart: () => console.log("✅ Bot is running! Send a message on Telegram."),
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nStopping bot...");
  bot.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  bot.stop();
  process.exit(0);
});

import { NextResponse, type NextRequest } from "next/server";
import ZAI from "z-ai-web-dev-sdk";

export const runtime = "nodejs";

const SYSTEM_PROMPT =
  "You are Terra, a warm, editorial AI assistant. Answer concisely with well-structured markdown: short intro sentence, ordered steps, a code example when relevant, and a check-list of tips. Use inline code for identifiers.";

const MAX_MESSAGES = 12;
const MAX_CHARS = 6000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 15;

const requestTimestamps: number[] = [];

interface IncomingMessage {
  role: string;
  content: unknown;
}

function sanitize(body: unknown): { messages: { role: "user" | "assistant"; content: string }[] } | { error: string } {
  const raw = (body as { messages?: unknown }).messages;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: "A non-empty messages array is required." };
  }
  const messages: { role: "user" | "assistant"; content: string }[] = [];
  for (const item of raw.slice(-MAX_MESSAGES) as IncomingMessage[]) {
    if (
      (item?.role !== "user" && item?.role !== "assistant") ||
      typeof item?.content !== "string" ||
      item.content.trim().length === 0
    ) {
      return { error: "Each message needs a role of user or assistant and non-empty content." };
    }
    if (item.content.length > MAX_CHARS) {
      return { error: "One of the messages is too long. Keep replies under 6000 characters." };
    }
    messages.push({ role: item.role, content: item.content });
  }
  if (messages.length === 0) {
    return { error: "No valid messages were provided." };
  }
  return { messages };
}

function extractText(completion: unknown): string {
  if (completion && typeof completion === "object") {
    const record = completion as { choices?: unknown; content?: unknown };
    const choice = Array.isArray(record.choices)
      ? (record.choices[0] as { message?: { content?: unknown } } | undefined)
      : undefined;
    const fromChoice = choice?.message?.content;
    if (typeof fromChoice === "string" && fromChoice.trim().length > 0) {
      return fromChoice.trim();
    }
    if (typeof record.content === "string" && record.content.trim().length > 0) {
      return record.content.trim();
    }
  }
  return "";
}

export async function POST(request: NextRequest) {
  const now = Date.now();
  while (requestTimestamps.length > 0 && now - requestTimestamps[0] > RATE_WINDOW_MS) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length >= RATE_LIMIT) {
    return NextResponse.json(
      { error: "Too many requests — take a breath and try again in a minute." },
      { status: 429 },
    );
  }
  requestTimestamps.push(now);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = sanitize(body);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const zai = await ZAI.create();
    const completion: unknown = await zai.chat.completions.create({
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...parsed.messages],
      thinking: { type: "disabled" },
    });
    const text = extractText(completion);
    if (!text) {
      return NextResponse.json(
        { error: "Terra came back empty-handed — please try again." },
        { status: 502 },
      );
    }
    return NextResponse.json({ text });
  } catch (error) {
    console.error("[/api/chat] completion failed:", error);
    return NextResponse.json(
      { error: "Terra could not complete the reply. Please try again." },
      { status: 502 },
    );
  }
}

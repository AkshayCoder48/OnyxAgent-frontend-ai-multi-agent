/**
 * AI-GENERATED STATUS PHRASES (user directive 2026-10-02, Pollinations
 * 2026-10-03):
 *
 * The "Working" / "Thinking" follow-up phrases that cycle in the live
 * status line ("Reading the context", "Connecting the details", …) used to
 * be a hard-coded list — a simulation. This route makes them REAL: on each
 * generation turn the client asks for a handful of follow-up phrases and
 * an actual LLM writes them, tailored to the user's request and the
 * agent's current activity. The result reads like the agent narrating its
 * own intermediate steps instead of cycling the same canned lines for
 * every conversation.
 *
 * UPSTREAM: the OFFICIAL Pollinations gen API — POST
 * https://gen.pollinations.ai/v1/chat/completions (OpenAI-compatible) with
 * Bearer auth (the real, authenticated gateway; the old keyless
 * text.pollinations.ai GET endpoint is retired from this app).
 *
 * KEY CHAIN (first match wins):
 *   1. The caller's connected Pollinations key — POST body `key` (BYOP —
 *      the user's own account pays; the client sends it from the encrypted
 *      settings store, NEVER logged).
 *   2. The server's POLLINATIONS_API_KEY env var (app-owner key).
 *   3. No key → a KEYLESS last-resort attempt on the free nano model (the
 *      gateway currently serves anonymous non-streaming traffic on free
 *      models; streaming is the key-required surface). A tightened anonymous
 *      tier answers 401 INSTANTLY, so the local fallback still never
 *      blocks — this keeps AI phrases alive for users who have not
 *      connected yet.
 *
 * MODELS: official publisher/model ids from the live catalogue —
 * openai/gpt-5.4-nano (fast tier) first, openai/gpt-4o-mini as the second
 * attempt. A second attempt with the alternate model rescues a malformed
 * first answer.
 *
 * Contract:
 *   POST { activity: "thinking" | "working", task?: string, tool?: string,
 *          key?: string }
 *   →   { phrases: string[], source: "ai" | "fallback" }
 *
 * Always answers 200 with usable phrases — on any upstream failure the
 * (small, generic) fallback keeps the status line moving; the client never
 * blocks on this route.
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Hobby-plan-safe ceiling (1–300): a phrase batch is a single short
// completion, but the guard costs nothing.
export const maxDuration = 60;

/** The official Pollinations gen gateway — OpenAI-compatible chat endpoint. */
const GEN_CHAT_URL = "https://gen.pollinations.ai/v1/chat/completions";
/** Primary model — the fast nano tier answers tiny JSON completions in
 *  seconds; the 4o-mini tier is the second attempt. Official publisher/model
 *  ids (the catalog migrated to publisher-prefixed names). */
const POLLINATIONS_MODELS = ["openai/gpt-5.4-nano", "openai/gpt-4o-mini"];
/** Per-attempt timeout — a phrase batch must never hold a request open. */
const UPSTREAM_TIMEOUT_MS = 15_000;
/** Max attempts (alternate model each) before the local fallback answers. */
const MAX_ATTEMPTS = 2;

/** Server-side phrase memo (60s): identical (activity, task, tool) requests
 *  — remounting status lines, multiple open clients on the same turn —
 *  share ONE upstream completion instead of paying twice. Only successful
 *  AI results are memoized (fallback batches stay fresh for a later key). */
const MEMO_TTL_MS = 60_000;
const phraseMemo = new Map<string, { at: number; phrases: string[] }>();

function memoKey(activity: string, task: string, tool: string): string {
  return `${activity}|${tool}|${task}`;
}

/** Offline/upstream-failure fallback — the minimum viable phrase set. */
const FALLBACK: Record<"thinking" | "working", string[]> = {
  thinking: [
    "Thinking it through",
    "Weighing the details",
    "Lining up the ideas",
    "Shaping the answer",
  ],
  working: [
    "Working on it",
    "Making it happen",
    "Checking it over",
    "Finishing the step",
  ],
};

const SYSTEM_PROMPT = [
  "You write the rotating status line for an AI agent chat app.",
  "Given what the agent is doing right now, write FOUR ultra-short status phrases that name the natural intermediate steps of THAT exact activity.",
  "Rules:",
  "- each phrase is 2 to 4 words, at most 30 characters, present continuous tense (\"Scanning your files\")",
  "- no pronouns (never \"I\"), no punctuation, no quotes",
  "- be concrete and specific to the user's request — never generic filler like \"Processing data\" or \"Working hard\"",
  "- phrase 1 should restate the current activity, the rest should read like plausible next steps of it",
  "Answer with STRICT JSON only, no markdown, no code fence:",
  '{"phrases":["phrase one","phrase two","phrase three","phrase four"]}',
].join("\n");

interface StatusCaptionRequest {
  activity?: unknown;
  task?: unknown;
  tool?: unknown;
  /** The caller's connected Pollinations key (BYOP). Optional — see the
   *  key chain in the header comment. Never logged, never persisted. */
  key?: unknown;
}

/** Light shape validation for a caller-supplied Pollinations key
 *  (sk_/pk_ secret keys — per the official docs). Trusted shape only; the
 *  upstream is the real authenticator. */
function sanitizeCallerKey(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim();
  if (!/^(sk|pk)_[A-Za-z0-9_-]{8,190}$/.test(key)) return null;
  return key;
}

/** Sanitize one model phrase down to a safe status-line string.
 * Capped at 34 chars: the status line reserves the width of the LONGEST
 * phrase in a batch, so one long sentence would clip every caption after
 * it on narrow screens (the "caption text cut off" fix). */
function cleanPhrase(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .replace(/["'`]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?…]+$/, "")
    .trim()
    .slice(0, 34); // status lines are short — anything longer is a sentence
  if (cleaned.length < 3) return null;
  return cleaned;
}

/** Extract the first JSON object from a model reply (tolerates stray prose
 *  and ```json fences). Returns null when nothing parseable is found. */
function extractPhrases(content: string): string[] | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(content);
  const candidates = [fenced?.[1], content];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as {
        phrases?: unknown;
      };
      if (!Array.isArray(parsed.phrases)) continue;
      const phrases = parsed.phrases
        .map(cleanPhrase)
        .filter((p): p is string => p !== null);
      if (phrases.length >= 2) return phrases.slice(0, 6);
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** One chat completion against the official gen gateway. With an apiKey
 *  the Bearer header authenticates (BYOP/app-owner); without one the request
 *  rides the gateway's anonymous tier (currently keyless-OK on free models,
 *  non-streaming). Returns the assistant text, or null on any failure (the
 *  caller's attempt loop decides what happens next). Only model + messages
 *  are sent — the gateway drops unsupported per-model parameters itself, so
 *  no temperature/max_tokens fields are risked. */
async function genChatCompletion(
  apiKey: string | null,
  model: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<string | null> {
  try {
    const res = await fetch(GEN_CHAT_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        // Required: the gateway rejects anonymous (keyless) traffic with 401
        // when no User-Agent is present (node's fetch sends none by default).
        "user-agent": "OnyxAgent/1.0 (status-caption)",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    } | null;
    const content = data?.choices?.[0]?.message?.content;
    return typeof content === "string" && content.trim() ? content : null;
  } catch {
    return null; // timeout / network — the attempt loop handles it
  }
}

export async function POST(
  request: Request,
): Promise<NextResponse> {
  let body: StatusCaptionRequest;
  try {
    body = (await request.json()) as StatusCaptionRequest;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  const activity: "thinking" | "working" =
    body.activity === "working" ? "working" : "thinking";
  // The task text is free-form user content — bounded hard, sent to the
  // model as context only, never logged.
  const task =
    typeof body.task === "string" ? body.task.slice(0, 400).trim() : "";
  const tool =
    typeof body.tool === "string" ? body.tool.slice(0, 80).trim() : "";

  const userPrompt = [
    `Activity: the agent is ${activity === "working" ? "executing the request step by step" : "thinking through the request before answering"}.`,
    tool ? `Tool it just used: ${tool}.` : "",
    task ? `The user's request: "${task}"` : "",
  ]
    .filter(Boolean)
    .join("\n");

  // Key chain: the caller's connected key → the app-owner env key → null
  // (a keyless attempt on the free nano model — see the header comment).
  const apiKey =
    sanitizeCallerKey(body.key) ?? (() => {
      const envKey = process.env.POLLINATIONS_API_KEY?.trim();
      return envKey || null;
    })();

  // Hot memo — a batch for this exact turn context was just generated.
  const key = memoKey(activity, task, tool);
  const memo = phraseMemo.get(key);
  if (memo && Date.now() - memo.at < MEMO_TTL_MS) {
    return NextResponse.json({ phrases: memo.phrases, source: "ai" });
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const model = POLLINATIONS_MODELS[attempt] ?? POLLINATIONS_MODELS[0]!;
    const content = await genChatCompletion(
      apiKey,
      model,
      SYSTEM_PROMPT,
      userPrompt,
    );
    if (!content) continue;
    const phrases = extractPhrases(content);
    if (phrases && phrases.length >= 2) {
      if (phraseMemo.size > 128) {
        // prune — stale entries only
        const cutoff = Date.now() - MEMO_TTL_MS;
        for (const [k, v] of phraseMemo) if (v.at < cutoff) phraseMemo.delete(k);
      }
      phraseMemo.set(key, { at: Date.now(), phrases });
      return NextResponse.json({ phrases, source: "ai" });
    }
  }

  return NextResponse.json({
    phrases: FALLBACK[activity],
    source: "fallback",
  });
}

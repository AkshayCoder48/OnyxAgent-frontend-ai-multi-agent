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
 * UPSTREAM: the keyless Pollinations text API
 * (https://text.pollinations.ai/{prompt}?json=true) — no SDK, no key, no
 * account. The whole prompt (system rules + turn context + the strict-JSON
 * instruction) rides in the URL like the reference python snippets; a
 * random seed keeps batches fresh. A second attempt with a different seed
 * rescues a malformed first answer.
 *
 * Contract:
 *   POST { activity: "thinking" | "working", task?: string, tool?: string }
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

/** Pollinations keyless text endpoint (the user-provided API). */
const POLLINATIONS_TEXT_URL = "https://text.pollinations.ai";
/** Primary model — the fast tier answers tiny JSON completions in seconds;
 *  the default tier is the second attempt (keyless latency varies 3-14s
 *  with the anonymous rate limiter, so the client NEVER blocks on this). */
const POLLINATIONS_MODELS = ["openai-fast", "openai"];
/** Per-attempt timeout — a phrase batch must never hold a request open. */
const UPSTREAM_TIMEOUT_MS = 15_000;
/** Max attempts (fresh seed each) before the local fallback answers. */
const MAX_ATTEMPTS = 2;

/** Server-side phrase memo (60s): identical (activity, task, tool) requests
 *  — remounting status lines, multiple open clients on the same turn —
 *  share ONE upstream completion instead of hammering the keyless tier's
 *  rate limiter. */
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

  // Pollinations keyless GET — the ENTIRE prompt rides in the URL (the
  // user-provided API shape). A fresh seed per attempt keeps batches from
  // repeating; json=true nudges the model toward JSON output.
  const prompt = `${SYSTEM_PROMPT}\n\n${userPrompt}\n\nReturn only JSON: {"phrases":["phrase one","phrase two","phrase three","phrase four"]}`;

  // Hot memo — a batch for this exact turn context was just generated.
  const key = memoKey(activity, task, tool);
  const memo = phraseMemo.get(key);
  if (memo && Date.now() - memo.at < MEMO_TTL_MS) {
    return NextResponse.json({ phrases: memo.phrases, source: "ai" });
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const model = POLLINATIONS_MODELS[attempt] ?? POLLINATIONS_MODELS[0]!;
      const seed = Math.floor(Math.random() * 1_000_000);
      const url =
        `${POLLINATIONS_TEXT_URL}/${encodeURIComponent(prompt)}` +
        `?json=true&seed=${seed}&model=${model}`;
      const res = await fetch(url, {
        method: "GET",
        headers: { accept: "text/plain" },
        cache: "no-store",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const content = (await res.text()).slice(0, 4_000);
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
    } catch {
      // try the next model/seed / fall through to the fallback below
    }
  }

  return NextResponse.json({
    phrases: FALLBACK[activity],
    source: "fallback",
  });
}

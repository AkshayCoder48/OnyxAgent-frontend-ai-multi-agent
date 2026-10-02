/**
 * AI-GENERATED STATUS PHRASES (user directive 2026-10-02):
 *
 * The "Working" / "Thinking" follow-up phrases that cycle in the live
 * status line ("Reading the context", "Connecting the details", …) used to
 * be a hard-coded list — a simulation. This route makes them REAL: on each
 * generation turn the client asks for a handful of follow-up phrases and
 * an actual LLM (z-ai-web-dev-sdk, backend-only) writes them, tailored to
 * the user's request and the agent's current activity. The result reads
 * like the agent narrating its own intermediate steps instead of cycling
 * the same canned lines for every conversation.
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
  "- each phrase is 2 to 5 words, present continuous tense (\"Scanning your files\")",
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

/** Sanitize one model phrase down to a safe status-line string. */
function cleanPhrase(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .replace(/["'`]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?…]+$/, "")
    .trim()
    .slice(0, 42); // status lines are short — anything longer is a sentence
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

  try {
    const { default: ZAI } = await import("z-ai-web-dev-sdk");
    const zai = await ZAI.create();

    const userPrompt = [
      `Activity: the agent is ${activity === "working" ? "executing the request step by step" : "thinking through the request before answering"}.`,
      tool ? `Tool it just used: ${tool}.` : "",
      task ? `The user's request: "${task}"` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const completion = await zai.chat.completions.create({
      messages: [
        { role: "assistant", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      thinking: { type: "disabled" },
    });

    const content = completion.choices[0]?.message?.content ?? "";
    const phrases = extractPhrases(content);
    if (phrases && phrases.length >= 2) {
      return NextResponse.json({ phrases, source: "ai" });
    }
  } catch {
    // fall through to the fallback below
  }

  return NextResponse.json({
    phrases: FALLBACK[activity],
    source: "fallback",
  });
}

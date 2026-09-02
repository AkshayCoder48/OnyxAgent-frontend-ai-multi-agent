"use client";

import { useMemo } from "react";
import { Check, MessageCircleQuestion, MinusCircle, HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/** Pull the question texts out of an `ask_user` tool's args (object or
 *  JSON-string). Handles the `questions` list. Returns [] when none found. */
function extractQuestions(args: unknown): string[] {
  let obj: unknown = args;
  if (typeof args === "string") {
    try {
      obj = JSON.parse(args);
    } catch {
      return [];
    }
  }
  if (obj && typeof obj === "object" && Array.isArray((obj as { questions?: unknown }).questions)) {
    return (obj as { questions: Array<{ question?: unknown }> }).questions.map((q) =>
      String(q?.question ?? ""),
    );
  }
  return [];
}

interface ParsedAnswer {
  question: string;
  answer: string;
  skipped: boolean;
}

/** Parse an ask_user RESULT into structured answers.
 *
 *  The tool returns `{ answers: [{ question, answer, skipped }] }` (as an
 *  object or a JSON string; sometimes wrapped in `{ success, output }`).
 *  Previously this raw JSON was rendered as plain text — now it parses into
 *  a Q&A transcript. Returns null when the result isn't the answers shape
 *  (e.g. it's a plain-text transcript or an error). */
export function parseAskUserResult(resultText: string): ParsedAnswer[] | null {
  if (!resultText || !resultText.trim()) return null;
  // Fast reject — the answers payload always contains "answers".
  if (!resultText.includes("answers")) return null;
  let obj: unknown = resultText;
  try {
    obj = JSON.parse(resultText);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const rec = obj as Record<string, unknown>;
  // Unwrap { success, output: {...} } ToolResult shells.
  const source =
    rec.output && typeof rec.output === "object"
      ? (rec.output as Record<string, unknown>)
      : rec;
  const answers = source.answers ?? rec.answers;
  if (!Array.isArray(answers) || answers.length === 0) return null;
  const out: ParsedAnswer[] = [];
  for (const a of answers) {
    if (!a || typeof a !== "object") continue;
    const r = a as Record<string, unknown>;
    const question = typeof r.question === "string" ? r.question : "";
    const answer = r.answer == null ? "" : String(r.answer);
    const skipped = r.skipped === true || r.skipped === "true";
    if (!question && !answer) continue;
    out.push({ question, answer, skipped });
  }
  return out.length > 0 ? out : null;
}

/** Q&A transcript — each answered question renders as a quiet card: the
 *  question in muted text, the user's answer beneath it in ink with a
 *  leading check glyph (or a "skipped" pill when the user skipped it).
 *  Skipped entries dim and collapse to a single line. */
function AnswersTranscript({ answers }: { answers: ParsedAnswer[] }) {
  return (
    <div className="space-y-1.5 py-1">
      <p className="text-foreground/55 font-mono text-[10px] tracking-wider uppercase">
        {answers.length > 1 ? "Your answers" : "Your answer"}
      </p>
      {answers.map((a, i) => (
        <div
          key={i}
          className={cn(
            "rounded-lg border border-foreground/10 bg-foreground/[0.03] px-3 py-2",
            a.skipped && "opacity-60",
          )}
        >
          <p className="text-muted-foreground flex items-start gap-1.5 text-xs leading-relaxed">
            <HelpCircle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
            <span className="break-words">{a.question || "(question)"}</span>
          </p>
          {a.skipped ? (
            <p className="text-muted-foreground/70 mt-1 inline-flex items-center gap-1.5 pl-4.5 text-[11px] italic">
              <MinusCircle className="h-3 w-3 shrink-0" aria-hidden />
              Skipped
            </p>
          ) : (
            <p className="text-foreground mt-1 flex items-start gap-1.5 pl-1 text-[13px] font-medium leading-relaxed break-words">
              <Check className="text-primary mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>{a.answer || "—"}</span>
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

/** Transcript view of an `ask_user` turn.
 *  1. Result with the structured `{answers:[...]}` payload → parsed Q&A
 *     transcript (no raw JSON ever shows).
 *  2. Plain-text result → rendered as-is (legacy providers already format
 *     "Q: …/A: …" transcripts).
 *  3. No result yet → list the questions that were asked ("Waiting for the
 *     user…"). */
export function AskUserResult({ args, resultText }: { args: unknown; resultText: string }) {
  const parsed = useMemo(() => parseAskUserResult(resultText), [resultText]);

  if (parsed) {
    return <AnswersTranscript answers={parsed} />;
  }

  if (resultText) {
    return (
      <p className="text-foreground/85 py-1 text-sm leading-relaxed break-words whitespace-pre-wrap">
        {resultText}
      </p>
    );
  }
  const questions = extractQuestions(args);
  return (
    <div className="space-y-2.5 py-1">
      <div>
        <p className="text-foreground/55 flex items-center gap-1.5 font-mono text-[10px] tracking-wider uppercase">
          <MessageCircleQuestion className="h-3 w-3" aria-hidden />
          {questions.length > 1 ? "Questions" : "Question"}
        </p>
        {questions.length > 0 ? (
          <ul className="text-foreground/85 mt-0.5 space-y-1 text-sm leading-relaxed">
            {questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground mt-0.5 text-xs italic">Waiting for the user…</p>
        )}
      </div>
      {questions.length > 0 && (
        <p className="text-muted-foreground text-xs italic">Waiting for the user…</p>
      )}
    </div>
  );
}

// ============================================================================
// JEV Decision Engine — server-side integration layer (PRD §9).
//
// Stateless proxy for POST https://jevmodel.net/v1/systemone (model
// "typesafe/jev-1.13"). Keeps the browser off cross-origin restrictions,
// validates the { state, questions } envelope (state / questions / choice /
// noul / score semantics), enforces a hard timeout, and forwards the request
// with Content-Type: application/json. Mirrors the chat-proxy style: no auth,
// no DB, no logging of payloads.
//
// Upstream contract: { code, message, data: { result: { answers } } } where
// code === 0 marks success and each answer carries a type ("choice" | "noul"
// | "score"), probabilities and a confidence. Every upstream response is
// passed through verbatim — schema validation and fallback live in the client
// adapter (src/lib/business/jev.ts), so an HTTP 200 is NOT treated as proof
// of a usable decision (PRD §9.4).
//
// NOTE ON AUTH: the official docs (https://jevmodel.net/docs) require
// `Authorization: Bearer <API_KEY>` on REST calls (the playground works
// auth-free only because it calls same-origin with a session cookie). When
// the JEV_API_KEY env var is set, its value is forwarded as that header;
// otherwise the request is sent unauthenticated and the upstream 401 is
// passed through honestly for the client adapter to fall back on.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const JEV_ENDPOINT = "https://jevmodel.net/v1/systemone";
const JEV_MODEL = "typesafe/jev-1.13";
const REQUEST_TIMEOUT_MS = 25_000;

/** Server-side API key (optional; docs require Bearer auth on REST calls). */
const JEV_API_KEY = process.env.JEV_API_KEY;

/** Max state (scenario) length forwarded upstream. */
const MAX_STATE_CHARS = 12_000;
/** Max questions per request. */
const MAX_QUESTIONS = 12;
/** Allowed score legend sizes (a usable scale needs at least two anchors). */
const SCORE_LEGEND_MIN = 2;
const SCORE_LEGEND_MAX = 10;

const QUESTION_TYPES = ["choice", "noul", "score"] as const;
type QuestionType = (typeof QUESTION_TYPES)[number];

function isQuestionType(value: unknown): value is QuestionType {
  return (
    typeof value === "string" &&
    (QUESTION_TYPES as readonly string[]).includes(value)
  );
}

interface ValidatedQuestion {
  type: QuestionType;
  instructions: string;
  /** choice: option-key → description; score: legend strings; noul: absent. */
  criteria?: Record<string, string> | string[];
}

export async function POST(request: NextRequest) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_body" } },
      { status: 400 },
    );
  }

  // ---- Validate the forwarded payload shape (state / questions) ----------
  const body = payload as { state?: unknown; questions?: unknown };

  const errors: string[] = [];
  if (typeof body.state !== "string" || !body.state.trim()) {
    errors.push("state must be a non-empty string");
  }
  if (
    !body.questions ||
    typeof body.questions !== "object" ||
    Array.isArray(body.questions)
  ) {
    errors.push("questions must be a non-empty object");
  }

  const questions = (body.questions ?? {}) as Record<string, unknown>;
  const questionKeys = Object.keys(questions);
  if (errors.length === 0 && questionKeys.length === 0) {
    errors.push("questions must be a non-empty object");
  }
  if (questionKeys.length > MAX_QUESTIONS) {
    errors.push(`questions must contain at most ${MAX_QUESTIONS} entries`);
  }

  const validated: Record<string, ValidatedQuestion> = {};
  if (errors.length === 0) {
    for (const key of questionKeys) {
      const spec = questions[key] as
        | { type?: unknown; instructions?: unknown; criteria?: unknown }
        | null;

      if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
        errors.push(`questions.${key} must be an object`);
        continue;
      }
      if (!isQuestionType(spec.type)) {
        errors.push(
          `questions.${key}.type must be one of: ${QUESTION_TYPES.join(", ")}`,
        );
        continue;
      }
      if (typeof spec.instructions !== "string" || !spec.instructions.trim()) {
        errors.push(`questions.${key}.instructions must be a non-empty string`);
        continue;
      }

      const question: ValidatedQuestion = {
        type: spec.type,
        instructions: spec.instructions,
      };

      if (spec.type === "choice") {
        const criteria = spec.criteria;
        if (
          !criteria ||
          typeof criteria !== "object" ||
          Array.isArray(criteria)
        ) {
          errors.push(
            `questions.${key}.criteria must be a non-empty object mapping option keys to description strings for type "choice"`,
          );
          continue;
        }
        const entries = Object.entries(criteria as Record<string, unknown>);
        if (
          entries.length === 0 ||
          entries.some(([, v]) => typeof v !== "string" || !v.trim())
        ) {
          errors.push(
            `questions.${key}.criteria must map option keys to non-empty description strings for type "choice"`,
          );
          continue;
        }
        question.criteria = Object.fromEntries(
          entries as [string, string][],
        );
      } else if (spec.type === "score") {
        const criteria = spec.criteria;
        if (
          !Array.isArray(criteria) ||
          criteria.length < SCORE_LEGEND_MIN ||
          criteria.length > SCORE_LEGEND_MAX ||
          criteria.some((v) => typeof v !== "string" || !v.trim())
        ) {
          errors.push(
            `questions.${key}.criteria must be an array of ${SCORE_LEGEND_MIN}-${SCORE_LEGEND_MAX} legend strings for type "score"`,
          );
          continue;
        }
        question.criteria = criteria as string[];
      }
      // type "noul" ignores criteria — nothing further to validate.

      validated[key] = question;
    }
  }

  if (errors.length > 0) {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_payload", details: errors } },
      { status: 400 },
    );
  }

  const state = (body.state as string).slice(0, MAX_STATE_CHARS);

  // ---- Call upstream -------------------------------------------------------
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (JEV_API_KEY) {
      headers.Authorization = `Bearer ${JEV_API_KEY}`;
    }

    const resp = await fetch(JEV_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: JEV_MODEL,
        state,
        questions: validated,
      }),
      signal: controller.signal,
      cache: "no-store",
    });

    const text = await resp.text();

    // Pass the upstream status + body through — the client adapter performs
    // schema validation and fallback (PRD §9.5). We never fake success here.
    return new NextResponse(
      text || '{"ok":false,"error":{"code":"empty_body"}}',
      {
        status: resp.status,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "x-jev-status": String(resp.status),
        },
      },
    );
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: aborted ? "timeout" : "network_error",
          message: aborted ? "JEV request timed out" : "JEV request failed",
        },
      },
      { status: aborted ? 504 : 502 },
    );
  } finally {
    clearTimeout(timer);
  }
}

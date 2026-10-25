"use client";

// decision — THE structured decision engine tool (JEV systemone).
//
// Takes decisions the way a careful operator would: you provide the STATE
// (the text/scenario/evidence) plus QUERIES (the decision questions), and
// the engine answers each query with a calibrated, probability-backed
// verdict — a CHOICE (which option, with per-option probabilities), a NOUL
// (a 0..1 judgment, e.g. "does this open a curiosity loop?" → 0.92), or a
// SCORE (a rating on a legend, e.g. virality 2.93 on weak→very strong).
//
// Backed by POST https://jevmodel.net/v1/systemone (model typesafe/jev-1.13)
// through the app's /api/jev-decide proxy (keeps the browser off CORS,
// enforces timeouts, attaches the JEV_API_KEY when the operator configured
// one). Never fabricates: on any upstream failure the tool returns an honest
// error and the agent falls back to its own reasoning.

import { registerTool } from "./registry";

const DECISION_ROUTE = "/api/jev-decide";
const REQUEST_TIMEOUT_MS = 30_000;

const DECISION_DESCRIPTION = `Take structured DECISIONS with a calibrated decision engine. You provide a STATE (the text / scenario / evidence / draft being decided on) plus one or more QUERIES, and each query gets a probability-backed verdict — never a coin flip.

WHEN TO USE: whenever a judgment call benefits from structured evaluation — classifying text, rating quality/virality/risk, yes-no judgments under uncertainty, choosing between options, evaluating drafts against criteria. Prefer it over ad-hoc guessing when the user asks "is this good?", "which option?", "rate this", "should we…?".

QUERY KINDS:
- "choice" — pick ONE option from the ones you define. Pass options: [{value, description}] (2–8, snake_case values + one-line descriptions of what each means). The engine returns the chosen option + per-option probabilities + confidence.
- "noul" — a 0..1 judgment ("does X hold?", "is this true?"). Just the question — no options. Returns noul (0..1) + confidence.
- "score" — rate on a scale. Pass legend: an ordered array from lowest to highest (e.g. ["weak","average","strong","very strong"], 2–8 entries). Returns a numeric score anchored to the legend (legend index 0 = the lowest) + probabilities + confidence.

RULES:
- Give each query a short snake_case id (e.g. "ship_or_wait", "virality") — answers come back keyed by it.
- Keep the STATE self-contained: paste the actual text/content being decided on (up to ~8000 chars), not a reference to it.
- Up to 8 queries per call; make them independent (they are answered in parallel).
- Report the verdicts WITH their probabilities/confidence — low-confidence answers (<0.5) should be presented as uncertain, not as fact.`;

interface DecisionQuery {
  id?: unknown;
  question?: unknown;
  kind?: unknown;
  options?: unknown;
  legend?: unknown;
}

interface DecisionAnswer {
  type?: string;
  choice?: string;
  noul?: number;
  score?: number;
  legend?: Record<string, string>;
  probabilities?: Record<string, number>;
  confidence?: number;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

registerTool(
  "decision",
  DECISION_DESCRIPTION,
  {
    type: "object",
    properties: {
      state: {
        type: "string",
        description:
          "The text/scenario/evidence to decide on — self-contained (paste the actual content, up to ~8000 chars).",
      },
      queries: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        description: "The decision queries (answered in parallel, keyed by id).",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Short snake_case key for the answer (e.g. 'ship_or_wait').",
            },
            question: { type: "string", description: "The question to answer about the state." },
            kind: {
              type: "string",
              enum: ["choice", "noul", "score"],
              description:
                "choice = pick one of the defined options; noul = a 0..1 judgment; score = rate on the legend scale.",
            },
            options: {
              type: "array",
              description: "kind=choice only: the options to pick from.",
              items: {
                type: "object",
                properties: {
                  value: { type: "string", description: "snake_case option key" },
                  description: { type: "string", description: "what this option means" },
                },
                required: ["value", "description"],
              },
            },
            legend: {
              type: "array",
              items: { type: "string" },
              description:
                "kind=score only: ordered legend, lowest → highest (e.g. ['weak','average','strong']).",
            },
          },
          required: ["id", "question", "kind"],
        },
      },
    },
    required: ["state", "queries"],
    additionalProperties: false,
  },
  async (args) => {
    // ---- Validate + normalize the queries -------------------------------
    const state = asString(args.state);
    if (!state) return { ok: false, error: "state must be a non-empty string." };
    if (!Array.isArray(args.queries) || args.queries.length === 0) {
      return { ok: false, error: "queries must be a non-empty array (1–8 queries)." };
    }
    if (args.queries.length > 8) {
      return { ok: false, error: `Too many queries (${args.queries.length}) — max 8 per call.` };
    }

    const seenIds = new Set<string>();
    const questions: Record<string, Record<string, unknown>> = {};
    const idOrder: string[] = [];

    for (const raw of args.queries as DecisionQuery[]) {
      if (!raw || typeof raw !== "object") {
        return { ok: false, error: "Each query must be an object {id, question, kind, …}." };
      }
      const id = asString(raw.id);
      const question = asString(raw.question);
      const kind = asString(raw.kind);
      if (!id) return { ok: false, error: "Every query needs a non-empty snake_case id." };
      if (!/^[a-z0-9_]+$/.test(id)) {
        return { ok: false, error: `Query id '${id}' must be snake_case ([a-z0-9_]).` };
      }
      if (seenIds.has(id)) return { ok: false, error: `Duplicate query id '${id}'.` };
      if (!question) return { ok: false, error: `Query '${id}' needs a question.` };
      if (kind !== "choice" && kind !== "noul" && kind !== "score") {
        return { ok: false, error: `Query '${id}': kind must be choice | noul | score.` };
      }

      const spec: Record<string, unknown> = {
        type: kind,
        instructions: question,
      };

      if (kind === "choice") {
        if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > 8) {
          return { ok: false, error: `Query '${id}': choice queries need 2–8 options [{value, description}].` };
        }
        const criteria: Record<string, string> = {};
        for (const opt of raw.options as Array<{ value?: unknown; description?: unknown }>) {
          const value = asString(opt?.value);
          const desc = asString(opt?.description);
          if (!value || !desc || !/^[a-z0-9_]+$/.test(value)) {
            return {
              ok: false,
              error: `Query '${id}': every option needs snake_case value + description.`,
            };
          }
          if (value in criteria) {
            return { ok: false, error: `Query '${id}': duplicate option value '${value}'.` };
          }
          criteria[value] = desc;
        }
        spec.criteria = criteria;
      } else if (kind === "score") {
        if (!Array.isArray(raw.legend) || raw.legend.length < 2 || raw.legend.length > 8) {
          return { ok: false, error: `Query '${id}': score queries need a legend of 2–8 strings.` };
        }
        const legend: string[] = [];
        for (const l of raw.legend) {
          const s = asString(l);
          if (!s) return { ok: false, error: `Query '${id}': legend entries must be strings.` };
          legend.push(s);
        }
        spec.criteria = legend;
      }

      seenIds.add(id);
      idOrder.push(id);
      questions[id] = spec;
    }

    // ---- Call the decision engine (server proxy → jevmodel.net/v1/systemone)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(DECISION_ROUTE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: state.slice(0, 12_000), questions }),
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      return {
        ok: false,
        error: aborted ? "decision engine timed out" : "decision engine unreachable",
        hint: "Fall back to your own reasoning and tell the user the decision engine was unavailable.",
      };
    } finally {
      clearTimeout(timer);
    }

    const body: unknown = await resp.json().catch(() => null);
    if (!resp.ok || !body || typeof body !== "object") {
      const message =
        body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string"
          ? (body as { message: string }).message
          : `http_${resp.status}`;
      return {
        ok: false,
        error: `decision engine rejected the request (${message})`,
        hint: "Fix the query shape if the message says so; otherwise decide yourself and mention the engine was unavailable.",
      };
    }

    const parsed = body as {
      code?: unknown;
      message?: unknown;
      data?: { result?: { answers?: Record<string, DecisionAnswer>; usage?: Record<string, unknown>; elapsedMs?: unknown } };
    };
    if (parsed.code !== 0 || !parsed.data?.result?.answers) {
      return {
        ok: false,
        error: `decision engine error: ${typeof parsed.message === "string" ? parsed.message : "unknown"}`,
        hint: "Decide yourself and tell the user the decision engine did not answer.",
      };
    }

    const answersIn = parsed.data.result.answers;
    const answers: Record<string, unknown> = {};
    for (const id of idOrder) {
      const a = answersIn[id];
      if (!a || typeof a !== "object") {
        answers[id] = { error: "no answer returned" };
        continue;
      }
      const out: Record<string, unknown> = { kind: a.type ?? null };
      if (typeof a.choice === "string") out.choice = a.choice;
      if (typeof a.noul === "number") out.probability = a.noul;
      if (typeof a.score === "number") out.score = a.score;
      if (a.legend && typeof a.legend === "object") out.legend = a.legend;
      if (a.probabilities && typeof a.probabilities === "object") out.probabilities = a.probabilities;
      if (typeof a.confidence === "number") out.confidence = a.confidence;
      answers[id] = out;
    }

    return {
      ok: true,
      answers,
      usage: parsed.data.result.usage ?? null,
      elapsedMs: parsed.data.result.elapsedMs ?? null,
    };
  },
  false,
  "reasoning",
);

// ============================================================================
// JEV Decision Engine — client adapter (PRD §9).
//
// Isolated integration module: builds systemone questions (model
// "typesafe/jev-1.13", served through the /api/jev-decide proxy →
// https://jevmodel.net/v1/systemone), validates the answers schema, maps
// labels to internal routing hints, and records every decision (including
// fallbacks) in decision_records. The chat/orchestration layer never talks
// to JEV directly (PRD §25).
// ============================================================================

import type { DecisionRecordRow } from "./types";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const JEV_ROUTE = "/api/jev-decide";

/** Intent labels the classifier is consulted with (PRD §9.3 — intent only). */
export const JEV_INTENT_LABELS = [
  "Direct Question",
  "Research",
  "Planning",
  "Content Creation",
  "Financial Analysis",
  "Operations",
  "Technical Development",
  "Review and QA",
] as const;

export type JevIntentLabel = (typeof JEV_INTENT_LABELS)[number];

export interface JevProbability {
  key: string;
  label: string;
  probability: number;
}

export interface JevClassifyResult {
  /** true only when a schema-valid classification was produced */
  ok: boolean;
  label?: string;
  confidence?: number;
  probabilities?: JevProbability[];
  /** true when JEV was unavailable/invalid and the caller must use native routing */
  fallbackUsed: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Label → routing hint mapping (application-level, PRD §9.3)
// ---------------------------------------------------------------------------

export type RoutingHint =
  | "answer_direct"
  | "research"
  | "plan"
  | "create_content"
  | "financial"
  | "operations"
  | "technical"
  | "review";

const LABEL_TO_HINT: Record<string, RoutingHint> = {
  "direct question": "answer_direct",
  direct: "answer_direct",
  research: "research",
  planning: "plan",
  "content creation": "create_content",
  "financial analysis": "financial",
  operations: "operations",
  "technical development": "technical",
  "review and qa": "review",
  "review & qa": "review",
  review: "review",
};

export function intentLabelToRoutingHint(label: string | undefined): RoutingHint | null {
  if (!label) return null;
  return LABEL_TO_HINT[label.trim().toLowerCase()] ?? null;
}

/** Low-confidence classifications are treated as no-signal (PRD §9.5). */
const MIN_CONFIDENCE = 0.5;

// ---------------------------------------------------------------------------
// systemone question building
// ---------------------------------------------------------------------------

/** Question key used for the single intent-classification question. */
const DECISION_QUESTION_KEY = "decision";

const INTENT_INSTRUCTIONS =
  "Classify the user's message intent. Choose the single best-fitting label.";

/** Short criteria descriptions for the well-known intent labels. */
const LABEL_DESCRIPTIONS: Record<string, string> = {
  "Direct Question": "a direct factual question answerable from knowledge",
  Research: "a request to search/investigate multiple sources",
  Planning: "asks to plan, sequence or schedule work",
  "Content Creation": "asks to write/produce content",
  "Financial Analysis": "financial, budget, revenue or cost analysis",
  Operations: "day-to-day operational work",
  "Technical Development": "building/debugging technical artifacts",
  "Review and QA": "review, verify or quality-check work",
};

/** Unknown labels fall back to the label itself as the criteria description. */
function labelDescription(label: string): string {
  return LABEL_DESCRIPTIONS[label] ?? label;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface JevClassifyOptions {
  input: string;
  labels: readonly string[];
  businessId?: string;
  taskId?: string;
  /** e.g. "message_intent" | "draft_type" */
  decisionType: string;
  signal?: AbortSignal;
}

/**
 * Classify text with the JEV decision engine (systemone choice question).
 * Never throws — failures are returned as { ok: false, fallbackUsed: true }
 * so the Main Agent can fall back to its native intent routing (PRD §9.5).
 * Every call is recorded in decision_records (when businessId is supplied).
 */
export async function jevClassify(opts: JevClassifyOptions): Promise<JevClassifyResult> {
  const { input, labels, businessId, taskId, decisionType, signal } = opts;

  let result: JevClassifyResult = {
    ok: false,
    fallbackUsed: true,
    error: "not_attempted",
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    if (signal) {
      signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    const resp = await fetch(JEV_ROUTE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        state: input.slice(0, 12_000),
        questions: {
          [DECISION_QUESTION_KEY]: {
            type: "choice",
            instructions: INTENT_INSTRUCTIONS,
            criteria: Object.fromEntries(
              labels.map((l) => [l, labelDescription(l)]),
            ),
          },
        },
      }),
      signal: controller.signal,
      cache: "no-store",
    }).finally(() => clearTimeout(timer));

    if (!resp.ok) {
      result = { ok: false, fallbackUsed: true, error: `http_${resp.status}` };
    } else {
      const json: unknown = await resp.json().catch(() => null);
      result = validateSystemoneClassification(json, labels);
    }
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    result = {
      ok: false,
      fallbackUsed: true,
      error: aborted ? "timeout" : "network_error",
    };
  }

  // ---- Record the decision (best-effort; never blocks the turn) ----------
  if (businessId) {
    try {
      const { decisionRecordService, businessEventService } = await import("./data");
      await decisionRecordService.append({
        business_id: businessId,
        task_id: taskId,
        decision_type: decisionType,
        input_summary: input.slice(0, 200),
        provider: "jev",
        result: result.ok ? result.label : undefined,
        confidence: result.confidence,
        fallback_used: result.fallbackUsed,
      });
      await businessEventService.append({
        business_id: businessId,
        task_id: taskId,
        event_type: "decision.completed",
        payload: {
          decision_type: decisionType,
          provider: "jev",
          ok: result.ok,
          label: result.label ?? null,
          confidence: result.confidence ?? null,
          fallback_used: result.fallbackUsed,
          error: result.error ?? null,
        },
      });
    } catch {
      // recording is best-effort — decision still returned
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Schema validation (PRD §9.4/9.5 — validate HTTP 200 bodies too)
//
// Expected systemone shape:
//   { code: 0, message: "ok",
//     data: { result: { answers: { decision: { type: "choice",
//       choice, probabilities: { <key>: number }, confidence } } } } }
// ---------------------------------------------------------------------------

function validateSystemoneClassification(
  json: unknown,
  requestedLabels: readonly string[],
): JevClassifyResult {
  if (!json || typeof json !== "object") {
    return { ok: false, fallbackUsed: true, error: "invalid_json" };
  }

  const body = json as {
    code?: unknown;
    data?: { result?: { answers?: Record<string, unknown> } } | null;
  };
  if (body.code !== 0 || !body.data?.result?.answers) {
    return { ok: false, fallbackUsed: true, error: "schema_mismatch" };
  }

  const answer = body.data.result.answers[DECISION_QUESTION_KEY];
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
    return { ok: false, fallbackUsed: true, error: "schema_mismatch" };
  }

  const { type, choice, confidence, probabilities } = answer as {
    type?: unknown;
    choice?: unknown;
    confidence?: unknown;
    probabilities?: unknown;
  };

  if (type !== "choice" || typeof choice !== "string" || !choice.trim()) {
    return { ok: false, fallbackUsed: true, error: "schema_mismatch" };
  }
  const label = choice;

  // The chosen option must be one we actually requested — unknown labels are
  // rejected (comparison is case-insensitive).
  const normalized = requestedLabels.map((l) => l.trim().toLowerCase());
  if (!normalized.includes(label.trim().toLowerCase())) {
    return { ok: false, fallbackUsed: true, error: "unknown_label" };
  }

  const conf =
    typeof confidence === "number" && Number.isFinite(confidence)
      ? confidence
      : undefined;

  if (conf !== undefined && conf < MIN_CONFIDENCE) {
    return {
      ok: false,
      fallbackUsed: true,
      error: "low_confidence",
      label,
      confidence: conf,
    };
  }

  const mapped = mapProbabilities(probabilities);

  return { ok: true, fallbackUsed: false, label, confidence: conf, probabilities: mapped };
}

/** Map a systemone probabilities object { key: number } to JevProbability[]. */
function mapProbabilities(raw: unknown): JevProbability[] | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return Object.entries(raw as Record<string, unknown>)
    .filter(([, v]) => typeof v === "number" && Number.isFinite(v))
    .map(([key, v]) => ({ key, label: key, probability: v as number }))
    .sort((a, b) => b.probability - a.probability);
}

// ---------------------------------------------------------------------------
// Convenience: intent classification for the Main Agent turn pipeline
// ---------------------------------------------------------------------------

export async function classifyMessageIntent(params: {
  businessId: string;
  message: string;
  signal?: AbortSignal;
}): Promise<{ hint: RoutingHint | null; result: JevClassifyResult }> {
  const result = await jevClassify({
    input: params.message,
    labels: JEV_INTENT_LABELS,
    businessId: params.businessId,
    decisionType: "message_intent",
    signal: params.signal,
  });
  return {
    hint: result.ok ? intentLabelToRoutingHint(result.label) : null,
    result,
  };
}

export type { DecisionRecordRow };

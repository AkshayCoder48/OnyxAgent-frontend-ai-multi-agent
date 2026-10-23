// ============================================================================
// JEV Decision Engine — client adapter (PRD §9).
//
// Isolated integration module: builds requests, calls the server route,
// validates the response schema, maps labels to internal routing hints,
// and records every decision (including fallbacks) in decision_records.
// The chat/orchestration layer never talks to JEV directly (PRD §25).
// ============================================================================

import type { DecisionRecordRow } from "./types";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const JEV_ROUTE = "/api/jev-decide";
const TOOL = "text-classifier";

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
 * Classify text with the JEV text-classifier. Never throws — failures are
 * returned as { ok: false, fallbackUsed: true } so the Main Agent can fall
 * back to its native intent routing (PRD §9.5). Every call is recorded in
 * decision_records (when businessId is supplied).
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
      body: JSON.stringify({ tool: TOOL, input: input.slice(0, 8_000), labels }),
      signal: controller.signal,
      cache: "no-store",
    }).finally(() => clearTimeout(timer));

    if (!resp.ok) {
      result = { ok: false, fallbackUsed: true, error: `http_${resp.status}` };
    } else {
      const json = (await resp.json().catch(() => null)) as
        | {
            ok?: unknown;
            tool?: unknown;
            result?: {
              kind?: unknown;
              value?: unknown;
              label?: unknown;
              confidence?: unknown;
              probabilities?: unknown;
            };
          }
        | null;

      result = validateClassification(json, labels);
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
// ---------------------------------------------------------------------------

function validateClassification(
  json: unknown,
  requestedLabels: readonly string[],
): JevClassifyResult {
  if (!json || typeof json !== "object") {
    return { ok: false, fallbackUsed: true, error: "invalid_json" };
  }
  const body = json as { ok?: unknown; result?: Record<string, unknown> };
  if (body.ok !== true || !body.result || typeof body.result !== "object") {
    return { ok: false, fallbackUsed: true, error: "schema_mismatch" };
  }
  const result = body.result;
  const kind = result.kind;
  const label = typeof result.label === "string" ? result.label : undefined;
  const confidence =
    typeof result.confidence === "number" && Number.isFinite(result.confidence)
      ? result.confidence
      : undefined;

  if (kind !== "choice" || !label) {
    return { ok: false, fallbackUsed: true, error: "unsupported_kind" };
  }

  // The label must be one we actually requested — unknown labels are rejected
  const normalized = requestedLabels.map((l) => l.trim().toLowerCase());
  if (!normalized.includes(label.trim().toLowerCase())) {
    return { ok: false, fallbackUsed: true, error: "unknown_label" };
  }

  if (confidence !== undefined && confidence < MIN_CONFIDENCE) {
    return { ok: false, fallbackUsed: true, error: "low_confidence", label, confidence };
  }

  const probabilities = Array.isArray(result.probabilities)
    ? (result.probabilities as unknown[])
        .filter(
          (p): p is JevProbability =>
            !!p &&
            typeof p === "object" &&
            typeof (p as JevProbability).label === "string" &&
            typeof (p as JevProbability).probability === "number",
        )
        .map((p) => ({ key: String(p.key ?? p.label), label: p.label, probability: p.probability }))
    : undefined;

  return { ok: true, fallbackUsed: false, label, confidence, probabilities };
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

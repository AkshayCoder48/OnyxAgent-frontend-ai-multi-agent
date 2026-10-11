"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Sparkles, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, Textarea } from "@/components/ui";
import {
  chipClass,
  monoLabelClass,
  paperCardClass,
} from "@/components/assistant-ui/elements";
import { formatEstimate } from "@/lib/pollinations/capabilities";
import {
  respondToPollinationsConfirm,
  usePollinationsStore,
} from "@/lib/pollinations/store";
import type {
  ConfirmAction,
  ConfirmEstimate,
  ConfirmModelInfo,
} from "@/lib/pollinations/types";

/**
 * PollinationsConfirmDialog — the media_generation two-step confirmation.
 *
 * The tool BLOCKS on a window CustomEvent (`pollinations:confirm-response`)
 * until the user answers; this card (mounted above the composer, exactly
 * like QuestionPrompt) renders the pending payload from the Pollinations
 * store and dispatches exactly ONE response per requestId.
 *
 * Non-negotiable rules (product spec):
 *  - Opening / closing / editing NEVER triggers generation — only the
 *    explicit button dispatch does.
 *  - Every dismissal dispatches a response so the tool unblocks.
 *  - No auto-dispatch on unmount (the tool owns abort/timeout handling).
 */

/** Human labels for the generation `kind` (never show the raw slug). */
const KIND_LABELS: Record<string, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
  "3d": "3D Model",
  text: "Text",
  embeddings: "Embeddings",
  transcription: "Transcription",
  realtime: "Realtime Session",
};

function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/** Health dot: green = healthy, amber = degraded/down, gray = unknown. */
function healthOf(m: ConfirmModelInfo): { dot: string; label: string } {
  const status = m.health?.status?.toLowerCase();
  if (status === "healthy") return { dot: "bg-emerald-500", label: "healthy" };
  if (status && status !== "unknown") return { dot: "bg-amber-500", label: status };
  return { dot: "bg-muted-foreground/40", label: "unknown" };
}

/** success_rate arrives on a 0–100 scale (live catalogue); defensive 0–1
 *  normalization for older snapshots. Returns null when unpublished. */
function successRatePct(m: ConfirmModelInfo): number | null {
  const r = m.health?.successRate;
  if (typeof r !== "number" || !Number.isFinite(r)) return null;
  const pct = r <= 1 ? r * 100 : r;
  return Math.round(pct * 10) / 10;
}

/** The prominent tier badge — FREE models are the recommended ones. */
function TierBadge({ model }: { model: ConfirmModelInfo }) {
  if (model.tier === "free" || model.free) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold tracking-wide text-emerald-700 dark:text-emerald-300">
        FREE — 0 POLLEN • UNLIMITED
      </span>
    );
  }
  if (model.tier === "paid-only" || model.paidOnly) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold tracking-wide text-amber-700 dark:text-amber-300">
        PAID POLLEN ONLY
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center rounded-md border border-border bg-muted px-2 py-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground">
      Quest + Paid Pollen
    </span>
  );
}

/** The estimate line — honest at every tier, formatted via formatEstimate. */
function EstimateLine({ estimate }: { estimate: ConfirmEstimate }) {
  const text = formatEstimate(estimate);
  if (estimate.kind === "free") {
    return (
      <p className="text-sm">
        <span className="font-semibold text-emerald-600 dark:text-emerald-400">{text}</span>
        <span className="text-muted-foreground"> · unlimited use</span>
      </p>
    );
  }
  if (estimate.kind === "estimate") {
    const [head, ...rest] = text.split(" — ");
    const basis = rest.join(" — ");
    return (
      <p className="text-sm">
        <span className="font-semibold text-foreground">{head}</span>
        {basis ? <span className="text-muted-foreground"> — {basis}</span> : null}
      </p>
    );
  }
  // Unknown — never invent a number; show WHY it's unknown + the live rates.
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-2.5 py-2">
      <p className="text-sm font-semibold text-amber-600 dark:text-amber-400">
        Final cost unknown
      </p>
      {estimate.basis ? (
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{estimate.basis}</p>
      ) : null}
      {estimate.rateLines && estimate.rateLines.length > 0 ? (
        <ul className="mt-1.5 space-y-0.5">
          {estimate.rateLines.map((line) => (
            <li key={line} className="font-mono text-[10px] leading-relaxed text-foreground/70">
              {line}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The model card — title, publisher, community, health, live price lines. */
function ModelCard({ model }: { model: ConfirmModelInfo }) {
  const health = healthOf(model);
  const pct = successRatePct(model);
  return (
    <div className="rounded-lg border border-border bg-background/70 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground" title={model.id}>
            {model.title}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
            <span>by {model.publisher}</span>
            {model.community ? (
              <span className="inline-flex items-center rounded border border-border bg-muted px-1 py-px text-[10px] font-medium text-muted-foreground">
                Community
              </span>
            ) : null}
          </p>
        </div>
        <TierBadge model={model} />
      </div>
      <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", health.dot)} aria-hidden />
        <span>
          {health.label}
          {pct !== null ? ` · ${pct}% success` : ""}
        </span>
      </p>
      <ul className="mt-2 space-y-0.5">
        {model.priceLines.map((line) => (
          <li key={line} className="font-mono text-[10px] leading-relaxed text-foreground/70">
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PollinationsConfirmDialog() {
  const payload = usePollinationsStore((s) => s.pendingConfirmation);

  // Editable prompt — re-seeded whenever a NEW requestId arrives (each
  // enhancement round re-emits a fresh payload; the same id never changes
  // its prompt, so user edits are never clobbered). Render-time adjustment
  // pattern (same as tool-call-card's auto-expand) — no effect, no deps.
  const [prompt, setPrompt] = useState("");
  const [syncedId, setSyncedId] = useState<string | null>(null);
  // Mirrors respondedRef into renderable state (the ref itself is only
  // touched inside event handlers — never during render).
  const [respondedId, setRespondedId] = useState<string | null>(null);
  // Exactly ONE response per requestId — the tool unblocks on the first.
  const respondedRef = useRef<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  if (payload && syncedId !== payload.requestId) {
    setSyncedId(payload.requestId);
    setRespondedId(null);
    setPrompt(payload.prompt);
  }

  // Focus the textarea when the dialog (or a new stage/round) appears.
  useEffect(() => {
    if (payload) textareaRef.current?.focus();
  }, [payload]);

  if (!payload) return null;

  const stage = payload.stage;
  const isPrepare = stage === "prepare";
  const kind = kindLabel(payload.kind);
  const trimmed = prompt.trim();
  const promptEdited = trimmed !== payload.prompt.trim();

  /** Dispatch exactly one response for this requestId. */
  const respond = (action: ConfirmAction) => {
    if (respondedRef.current === payload.requestId) return;
    respondedRef.current = payload.requestId;
    setRespondedId(payload.requestId);
    respondToPollinationsConfirm(action);
  };

  const cancelAction = () =>
    respond(
      isPrepare
        ? { requestId: payload.requestId, action: "cancel" }
        : { requestId: payload.requestId, action: "reject" },
    );

  return (
    <div
      role="dialog"
      aria-label={`Pollinations ${kind.toLowerCase()} generation confirmation`}
      className={cn(paperCardClass, "step-card-in mb-2 w-full max-w-xl overflow-hidden")}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3 px-4 pt-3">
        <div className="min-w-0">
          <p className={monoLabelClass}>Pollinations · {kind}</p>
          <h3 className="mt-0.5 text-[15px] leading-snug font-semibold text-foreground">
            {isPrepare ? "What would you like to generate?" : "Ready to generate?"}
          </h3>
        </div>
        <button
          type="button"
          onClick={cancelAction}
          aria-label="Cancel generation request"
          className="text-muted-foreground hover:text-foreground shrink-0 rounded-md p-1 transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-3 px-4 pt-2.5 pb-3">
        <ModelCard model={payload.model} />

        {/* Editable prompt */}
        <div>
          <label
            htmlFor={`pollinations-prompt-${payload.requestId}`}
            className="text-foreground/70 mb-1 block text-xs font-medium"
          >
            {isPrepare ? "Prompt — edit freely before generating" : "Final prompt — you can still edit it"}
          </label>
          <Textarea
            ref={textareaRef}
            id={`pollinations-prompt-${payload.requestId}`}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            className="min-h-[84px] resize-y rounded-lg border-border bg-background/70 text-sm leading-relaxed"
            aria-label={`${kind} generation prompt`}
          />
          {payload.originalPrompt ? (
            <details className="mt-1.5">
              <summary className="text-muted-foreground hover:text-foreground cursor-pointer list-none text-[11px] italic transition-colors">
                AI-enhanced — original was: {payload.originalPrompt.slice(0, 90)}
                {payload.originalPrompt.length > 90 ? "…" : ""}
              </summary>
              <p className="text-muted-foreground/80 mt-1 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-[11px] leading-relaxed whitespace-pre-wrap">
                {payload.originalPrompt}
              </p>
            </details>
          ) : null}
          {!isPrepare && promptEdited && trimmed ? (
            <p className="text-primary mt-1.5 text-[11px] font-medium">
              Prompt edited — confirm to use the new text
            </p>
          ) : null}
        </div>

        {/* Locked generation settings */}
        {payload.params.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {payload.params.map((p) => (
              <span key={`${p.label}-${p.value}`} className={chipClass}>
                {p.label}: {p.value}
              </span>
            ))}
          </div>
        ) : null}

        <EstimateLine estimate={payload.estimate} />

        {payload.outputCount && payload.outputCount > 1 ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            This request will generate {payload.outputCount} outputs — the total
            estimated cost covers all {payload.outputCount}.
          </p>
        ) : null}

        {payload.warning ? (
          <div
            className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-2.5 py-2"
            role="note"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />
            <p className="min-w-0 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
              {payload.warning}
            </p>
          </div>
        ) : null}

        {/* Stage "confirm": the explicit Pollen disclosure */}
        {!isPrepare ? (
          <div
            className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-2.5 py-2"
            role="alert"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />
            <p className="min-w-0 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
              Are you sure you want to continue? This request may consume Pollen.{" "}
              <span className="font-medium">
                {payload.estimate.kind === "free"
                  ? "This model is free — 0 pollen."
                  : formatEstimate(payload.estimate)}
              </span>
            </p>
          </div>
        ) : null}

        {/* Actions — only these dispatches ever unblock the tool */}
        {isPrepare ? (
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={cancelAction}
              disabled={respondedId === payload.requestId}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => respond({ requestId: payload.requestId, action: "enhance" })}
              disabled={respondedId === payload.requestId}
            >
              <Sparkles className="h-3.5 w-3.5" aria-hidden />
              Enhance prompt
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() =>
                respond({ requestId: payload.requestId, action: "use", prompt })
              }
              disabled={respondedId === payload.requestId || !trimmed}
            >
              {payload.free ? "Generate — Free • 0 Pollen" : "Use my prompt"}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={cancelAction}
              disabled={respondedId === payload.requestId}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() =>
                respond({ requestId: payload.requestId, action: "confirm", prompt })
              }
              disabled={respondedId === payload.requestId || !trimmed}
            >
              Confirm &amp; Generate
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

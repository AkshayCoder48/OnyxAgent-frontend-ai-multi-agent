"use client";

import * as React from "react";
import { Check, ChevronRight, Clock, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { chipClass, CollapsePanel, fieldBlockClass, ShimmerLabel } from "./surfaces";
import {
  respondToApproval,
  selectPendingForToolCall,
  usePendingApprovals,
} from "@/lib/agent/approval-gate";

/**
 * ToolCall — one tool invocation with its request and result tucked behind
 * a disclosure. Collapses to one line while it works: a chevron, a
 * shimmering label, and the tool's primary argument as a chip, with a
 * checkmark once it settles (assistant-ui `elements-tool-call` recipe,
 * re-themed to the Terra palette).
 */
export function ToolCall({
  label,
  activeLabel,
  query,
  request,
  result,
  running,
  open,
  onOpenChange,
  className,
}: {
  label: string;
  activeLabel: string;
  query: string;
  request: string;
  result: string;
  running: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
}) {
  return (
    <div data-slot="tool-call" className={cn("max-w-md", className)}>
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left text-sm transition-colors hover:bg-accent/50"
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
            open && "rotate-90",
          )}
        />
        {running ? (
          <ShimmerLabel className="text-sm font-medium">{activeLabel}</ShimmerLabel>
        ) : (
          <span className="text-sm font-medium text-foreground/90">{label}</span>
        )}
        <span className={cn(chipClass, "ml-1")}>{query}</span>
        <span className="ml-auto inline-flex h-4 w-4 items-center justify-center">
          {!running && <Check className="h-3.5 w-3.5 text-primary" aria-label="Done" />}
        </span>
      </button>
      <CollapsePanel open={open}>
        <div className="space-y-2 px-6 pt-1 pb-2">
          <div>
            <p className="mb-1 font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
              Request
            </p>
            <div className={fieldBlockClass}>{request}</div>
          </div>
          <div className="border-t border-border/70" />
          <div>
            <p className="mb-1 font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
              Result
            </p>
            <div className={fieldBlockClass}>{result}</div>
          </div>
        </div>
      </CollapsePanel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HITL APPROVAL CARD (Task 2-d / PRD §13.4)
// ---------------------------------------------------------------------------

/** Keys whose VALUES must never be rendered in clear (PRD §8.2 — sensitive
 *  credentials must not be exposed in approval surfaces). */
const SENSITIVE_KEY_RE = /key|token|secret|password|credential/i;
const REDACTED = "••••";

/** Redact values of credential-looking keys, recursively (nested param
 *  objects keep their shape; only the sensitive leaf values are masked). */
function redactValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY_RE.test(key)) {
    return typeof value === "string" && value === "" ? value : REDACTED;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(k, v);
    }
    return out;
  }
  return value;
}

/** Human summary of one parameter value for the key-value list. */
function summarizeValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 120)}…` : value;
  if (typeof value === "object") {
    try {
      const s = JSON.stringify(value);
      return s.length > 160 ? `${s.slice(0, 160)}…` : s;
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * ApprovalCard — rendered IN PLACE of a tool card whose call is paused at the
 * approval gate (`status: "awaiting_approval"`). Everything shown comes from
 * the LIVE pending-approvals store (the gate's own payload — never
 * fabricated): operation label, the REAL parameters (credential-like values
 * redacted), the risk note, and a full-params disclosure.
 *
 * Approve/Reject dispatch the exact CustomEvent the gate waits on
 * (`agent:approval-response` with `{ approval_id, decision }`) via
 * `respondToApproval`; the gate then resolves the request row, and the
 * subsequent tool_result event replaces this card's state.
 */
export function ApprovalCard({
  toolCallId,
  toolName,
  className,
}: {
  toolCallId: string;
  toolName: string;
  className?: string;
}) {
  const pending = usePendingApprovals((s) => selectPendingForToolCall(s, toolCallId));
  const [decision, setDecision] = React.useState<"approved" | "rejected" | null>(null);
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const cardRef = React.useRef<HTMLDivElement>(null);

  // Focus the card when it opens so keyboard + screen-reader users land on
  // the decision immediately (role="alert" announces it as well).
  React.useEffect(() => {
    cardRef.current?.focus();
  }, []);

  // A NEW pending payload for the same tool call (a re-requested approval
  // after a rejection/expiry) re-arms the buttons.
  const approvalId = pending?.approval_id ?? null;
  const lastApprovalRef = React.useRef<string | null>(null);
  if (approvalId !== lastApprovalRef.current) {
    lastApprovalRef.current = approvalId;
    if (decision !== null) setDecision(null);
  }

  const handleDecision = (choice: "approved" | "rejected") => {
    if (!pending || decision !== null) return;
    setDecision(choice);
    // The EXACT event the gate's waitForApprovalDecision listens for.
    respondToApproval(pending.approval_id, choice);
  };

  if (!pending) {
    // The gate hasn't published (or the decision already resolved and the
    // tool_result event hasn't replaced the card yet) — honest wait state.
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-lg border border-border/70 px-3 py-2 text-sm text-muted-foreground",
          className,
        )}
        role="status"
      >
        <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          {toolName} is waiting for an approval decision…
        </span>
      </div>
    );
  }

  const params = Object.entries(pending.operation_parameters ?? {});
  const fullJson = (() => {
    try {
      return JSON.stringify(
        redactValue("(root)", pending.operation_parameters ?? {}),
        null,
        2,
      );
    } catch {
      return "(parameters could not be serialized)";
    }
  })();

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      role="alert"
      aria-live="assertive"
      aria-label="Approval required"
      data-slot="approval-card"
      className={cn(
        "step-card-in max-w-full rounded-xl border border-amber-500/40 bg-amber-500/[0.04] p-4 outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 sm:p-5",
        className,
      )}
    >
      <p className="flex items-center gap-2 text-sm font-semibold text-amber-700 dark:text-amber-400">
        <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden />
        Approval required
      </p>

      {/* Operation label (human, from the gate's payload). */}
      <p className="mt-2 text-sm text-foreground/90">
        <span className="font-medium">Action: </span>
        {pending.operation_type}
      </p>

      {/* REAL parameters from the pending request — credential-like values
          redacted, never fabricated. */}
      {params.length > 0 && (
        <dl className="mt-3 space-y-1.5 rounded-lg border border-border/60 bg-background/70 p-3">
          {params.map(([key, raw]) => (
            <div key={key} className="flex items-start justify-between gap-3 text-xs">
              <dt className="shrink-0 font-mono text-muted-foreground">{key}</dt>
              <dd className="min-w-0 break-all text-right font-mono text-foreground/85">
                {summarizeValue(redactValue(key, raw))}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {/* Risk note — why this action is gated. */}
      {pending.risk_note && (
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          {pending.risk_note}
        </p>
      )}

      {/* Review details — the full (redacted) params JSON. */}
      <button
        type="button"
        aria-expanded={detailsOpen}
        onClick={() => setDetailsOpen((v) => !v)}
        className="mt-3 inline-flex min-h-7 cursor-pointer items-center gap-1.5 rounded-md px-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
      >
        <ChevronRight
          className={cn("h-3.5 w-3.5 transition-transform duration-200", detailsOpen && "rotate-90")}
          aria-hidden
        />
        {detailsOpen ? "Hide details" : "Review details"}
      </button>
      <CollapsePanel open={detailsOpen}>
        <pre className="scrollbar-thin mt-1 max-h-64 overflow-auto rounded-lg border border-border/60 bg-background/70 p-2.5 font-mono text-[11px] leading-relaxed">
          {fullJson}
        </pre>
      </CollapsePanel>

      {/* Decision buttons. After a click both disable ("Waiting for
          execution…") until the tool_result event replaces the card. */}
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        {decision !== null && (
          <span className="mr-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="h-3 w-3 animate-pulse" aria-hidden />
            Waiting for execution…
          </span>
        )}
        <button
          type="button"
          onClick={() => handleDecision("rejected")}
          disabled={decision !== null}
          className="inline-flex h-9 items-center justify-center rounded-lg border border-border bg-background px-4 text-sm font-medium text-foreground transition-colors hover:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Reject
        </button>
        <button
          type="button"
          onClick={() => handleDecision("approved")}
          disabled={decision !== null}
          className="inline-flex h-9 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Approve
        </button>
      </div>
    </div>
  );
}

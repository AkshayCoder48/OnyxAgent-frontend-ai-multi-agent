"use client";

/**
 * Context Indicator (Onyx Infinite Context PRD §29/§30) — a compact pill
 * next to the composer showing how much of the model's context window the
 * NEXT turn would actually SEND.
 *
 *   ◉ Context 62%
 *
 * HONESTY CONTRACT (the "fake compacting" fix — the pill used to climb to
 * 110% and say "Compacting" forever because it measured the FULL local
 * history, which compaction never shrinks):
 *
 *   1. The pill's % is the POST-COMPACTION projection. It runs the SAME
 *      pure, client-safe manageContext() the runtime runs each turn, over
 *      the same bounded history window, with the MEASURED fixed tokens
 *      (system+tools from the last turn's managed snapshot published by the
 *      runtime; the 8.5K baseline only before the first turn).
 *   2. "· Compacting" appears ONLY while a turn is streaming AND the RAW
 *      (pre-compaction) ratio is ≥ 90% — a transient statement about the
 *      request being built right now. When idle the pill says
 *      "· Auto-compacts" (the 90% policy), never a fake in-progress claim.
 *   3. When the fixed tokens alone exceed the input budget — or even the
 *      emergency composition cannot fit (overflowUnfixable) — the pill shows
 *      a distinct rose "· Overflow — model window too small" state and the
 *      popover explains that compaction cannot fix it; switching to a
 *      larger-window model can. It never claims "Compacting" there.
 *
 * Clicking opens the Context Inspector popover: a per-section breakdown
 * (conversation raw → sent / system+tools / available), the resolved model
 * window with its source, and the last turn's factual compaction summary.
 * No private chain-of-thought is ever displayed — only usage math.
 */

import * as React from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { useChatStore, getPersistedConversationId, type ManagedContextSnapshot } from "@/stores/chat-store";
import { estimateTokens } from "@/lib/agent/context/token-counter";
import {
  manageContext,
  type CompactionMeta,
  type ContextMessage,
  type ContextStatus,
} from "@/lib/agent/context/context-manager";

/**
 * System + tools baseline BEFORE the first turn. The full system prompt (tool
 * digest, workspace policy, Onyx.md digest) measures ~7–9K tokens for the
 * default toolset. Replaced by the MEASURED systemTokens + toolsTokens from
 * the last managed snapshot as soon as one exists for the current model +
 * conversation.
 */
const SYSTEM_TOOLS_BASELINE_TOKENS = 8_500;

/**
 * Bounded history window — mirrors the runtime's DEFAULT_MAX_HISTORY
 * (cost-control pre-cap, PRD §36): only the last N history messages are ever
 * handed to the context manager. Keep in sync with runtime.ts.
 */
const MAX_HISTORY_WINDOW = 80;

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

function statusColor(status: ContextStatus): string {
  switch (status) {
    case "healthy":
      return "bg-emerald-500";
    case "monitor":
      return "bg-amber-400";
    case "prepare":
      return "bg-orange-400";
    default:
      return "bg-rose-500";
  }
}

function statusLabel(status: ContextStatus): string {
  switch (status) {
    case "healthy":
      return "Healthy";
    case "monitor":
      return "Monitor";
    case "prepare":
      return "Preparing compaction";
    default:
      return "Compacted";
  }
}

/** Factual one-liner about what the manager did LAST TURN (from the
 *  runtime-published snapshot — never a claim about the future). */
function lastTurnCompactionLine(c: CompactionMeta): string {
  switch (c.level) {
    case "window":
    case "emergency": {
      const n = c.digestedMessages > 0 ? c.digestedMessages : c.removedMessages;
      return `Last turn: compacted ${n} older message${n === 1 ? "" : "s"} into a summary (level: ${c.level}).`;
    }
    case "trim":
      return `Last turn: trimmed ${c.trimmedMessages} long message${c.trimmedMessages === 1 ? "" : "s"} to excerpts (level: trim).`;
    case "cleanup":
      return `Last turn: dropped ${c.removedMessages} empty message${c.removedMessages === 1 ? "" : "s"} (level: cleanup).`;
    default:
      return "";
  }
}

export function ContextIndicator() {
  const messages = useChatStore((s) => s.messages);
  const selectedModel = useChatStore((s) => s.selectedModel);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const lastManaged = useChatStore((s) => s.lastManagedContext);
  const [open, setOpen] = React.useState(false);

  // Coarse signature — recompute only when the conversation actually grows
  // or the model changes, not on every streaming token.
  const signature = React.useMemo(
    () => `${selectedModel ?? ""}:${messages.length}:${messages.reduce((n, m) => n + (m.content?.length ?? 0), 0)}`,
    [selectedModel, messages],
  );

  const estimate = React.useMemo(() => {
    const model = selectedModel ?? "";
    // The snapshot is only trustworthy for the SAME model + conversation
    // (fixed tokens differ per model/toolset; compaction facts are
    // conversation-specific). Otherwise fall back to the 8.5K baseline.
    const viewedConversation = getPersistedConversationId();
    const snapshot: ManagedContextSnapshot | null =
      lastManaged &&
      lastManaged.model === model &&
      lastManaged.conversationId !== null &&
      lastManaged.conversationId === viewedConversation
        ? lastManaged
        : null;
    const fixedTokens = snapshot
      ? snapshot.usage.systemTokens + snapshot.usage.toolsTokens
      : SYSTEM_TOOLS_BASELINE_TOKENS;

    // Local history → user/assistant text (the same text the runtime reads
    // from Dexie; tool parts never reach the request — pair safety PRD §22).
    const allHistory: ContextMessage[] = [];
    for (const m of messages) {
      if (m.role !== "user" && m.role !== "assistant") continue;
      const partsText = (m.parts ?? [])
        .filter((p) => p.type === "text" && p.content)
        .map((p) => p.content)
        .join("\n\n");
      allHistory.push({ role: m.role, content: m.content || partsText });
    }
    // RAW (pre-compaction) weight of everything the conversation holds.
    const rawHistoryTokens = allHistory.reduce((sum, m) => sum + estimateTokens(m.content), 0);

    // POST-COMPACTION PROJECTION — run the REAL context manager (pure +
    // client-safe) over the same bounded window the runtime uses, with the
    // measured fixed tokens riding along as an override. usage.historyTokens
    // is what the next request would actually carry (digest included);
    // usagePercentage is (fixed + history) / budget AFTER compaction.
    const sim = manageContext({
      systemPrompt: "",
      tools: [],
      history: allHistory.slice(-MAX_HISTORY_WINDOW),
      model,
      fixedTokensOverride: fixedTokens,
    });
    const inputBudget = sim.usage.inputBudget;
    const rawRatio = (fixedTokens + rawHistoryTokens) / inputBudget;
    const projectedRatio = sim.usage.usagePercentage;
    const projectedUsed = fixedTokens + sim.usage.historyTokens;
    return {
      fixedTokens,
      fixedMeasured: snapshot !== null,
      rawHistoryTokens,
      projectedHistoryTokens: sim.usage.historyTokens,
      inputBudget,
      rawRatio,
      projectedRatio,
      projectedUsed,
      available: Math.max(0, inputBudget - projectedUsed),
      status: sim.usage.status,
      modelLabel: sim.usage.modelLabel,
      modelSource: sim.usage.modelSource,
      snapshot,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, lastManaged]);

  // ── Pill state machine (honesty contract) ─────────────────────────────────
  //   overflow       — rose "· Overflow — model window too small": the fixed
  //                    tokens alone ≥ the input budget, the post-compaction
  //                    projection still ≥ 100%, or the last turn's manager
  //                    reported overflowUnfixable. Compaction cannot fix it,
  //                    so it NEVER says "Compacting".
  //   compacting     — transient "· Compacting": a turn is streaming AND the
  //                    raw (pre-compaction) ratio ≥ 90% — the manager is
  //                    compacting the request being built right now.
  //   auto-compacts  — idle "· Auto-compacts": raw ratio ≥ 90% but no turn is
  //                    running — the 90% policy WILL shape the next request.
  //   ok             — plain status dot (healthy/monitor/prepare) off the
  //                    post-compaction projection; no suffix.
  const overflow =
    estimate.fixedTokens >= estimate.inputBudget ||
    estimate.projectedRatio >= 1 ||
    estimate.snapshot?.usage.overflowUnfixable === true;
  const pillState: "overflow" | "compacting" | "auto-compacts" | "ok" = overflow
    ? "overflow"
    : isStreaming && estimate.rawRatio >= 0.9
      ? "compacting"
      : estimate.rawRatio >= 0.9
        ? "auto-compacts"
        : "ok";

  const pct = Math.round(estimate.projectedRatio * 100);
  const dotColor = overflow ? "bg-rose-500" : statusColor(estimate.status);
  const rawDiffers = estimate.projectedHistoryTokens < estimate.rawHistoryTokens;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[10px] tracking-wider uppercase transition-colors",
            estimate.status === "healthy" && !overflow
              ? "text-muted-foreground hover:bg-muted"
              : "text-foreground hover:bg-muted",
          )}
          title="Context usage the next turn would send (after auto-compaction)"
          aria-label={`Context usage ${pct}%${overflow ? " — overflow, model window too small" : ""}`}
        >
          <span className={cn("relative inline-block h-1.5 w-1.5 rounded-full", dotColor)}>
            {isStreaming && (
              <span className={cn("absolute inset-0 animate-ping rounded-full opacity-60", dotColor)} />
            )}
          </span>
          Context {pct}%
          {pillState === "overflow" && (
            <span className="text-rose-500">· Overflow — model window too small</span>
          )}
          {pillState === "compacting" && <span className="text-rose-500">· Compacting</span>}
          {pillState === "auto-compacts" && <span className="text-amber-500">· Auto-compacts</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-72 p-3">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold">Context</span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {estimate.modelLabel} · {estimate.modelSource === "safe-fallback" ? "assumed window" : "model window"}
            </span>
          </div>
          <Progress
            value={Math.min(100, estimate.projectedRatio * 100)}
            className={cn(
              "h-2",
              overflow && "[&>div]:bg-rose-500",
              !overflow && estimate.status === "healthy" && "[&>div]:bg-emerald-500",
              !overflow && estimate.status === "monitor" && "[&>div]:bg-amber-400",
              !overflow && (estimate.status === "prepare" || estimate.status === "compact") && "[&>div]:bg-orange-400",
              !overflow && estimate.status === "emergency" && "[&>div]:bg-rose-500",
            )}
          />
          <div className="space-y-1.5 text-[11px]">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Conversation</span>
              <span className="font-mono">{fmtTokens(estimate.projectedHistoryTokens)}</span>
            </div>
            {rawDiffers && (
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                Raw history {fmtTokens(estimate.rawHistoryTokens)} → sent{" "}
                {fmtTokens(estimate.projectedHistoryTokens)} after auto-compact.
              </p>
            )}
            <div className="flex justify-between">
              <span className="text-muted-foreground">System + tools</span>
              <span className="font-mono">
                {fmtTokens(estimate.fixedTokens)}
                <span className="text-muted-foreground/70"> ({estimate.fixedMeasured ? "measured" : "est."})</span>
              </span>
            </div>
            <div className="flex justify-between border-t border-border pt-1.5">
              <span className="text-muted-foreground">Available</span>
              <span className="font-mono">{fmtTokens(estimate.available)} / {fmtTokens(estimate.inputBudget)}</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5 border-t border-border pt-2 text-[10px] text-muted-foreground">
            <span className={cn("inline-block h-1.5 w-1.5 rounded-full", dotColor)} />
            <span>
              {pillState === "overflow"
                ? "Overflow — the request cannot fit this model's window even after compaction."
                : pillState === "compacting"
                  ? "Compacting — older turns are being summarized for the request in flight."
                  : pillState === "auto-compacts"
                    ? "Auto-compacts — older turns summarize at 90%; nothing is deleted from your history."
                    : `${statusLabel(estimate.status)} — older turns auto-compact at 90%; nothing is deleted from your history.`}
            </span>
          </div>
          {pillState === "overflow" && (
            <p className="text-[10px] leading-relaxed text-rose-500">
              The system prompt + tools alone need more room than this model&apos;s context window provides;
              compaction cannot fix this — switch to a larger-window model.
            </p>
          )}
          {estimate.snapshot?.compaction.applied && (
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              {lastTurnCompactionLine(estimate.snapshot.compaction)}
            </p>
          )}
          <p className="text-[9px] leading-relaxed text-muted-foreground/70">
            {estimate.fixedMeasured
              ? "Projection runs the real Onyx Context Manager with system+tools measured from the last turn"
              : "Estimate only — system+tools use an 8.5K-token baseline until the first turn measures them"}
            {selectedModel ? ` for ${selectedModel}` : ""}.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

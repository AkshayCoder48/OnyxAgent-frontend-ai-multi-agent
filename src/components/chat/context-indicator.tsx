"use client";

/**
 * Context Indicator (Onyx Infinite Context PRD §29/§30) — a compact pill
 * next to the composer showing how much of the model's context window the
 * current conversation + system prompt + tools are estimated to consume.
 *
 *   ◉ Context 62%
 *
 * Clicking opens the Context Inspector popover: a per-section breakdown
 * (conversation / system+tools / available), the resolved model window with
 * its source, and the live status (healthy → monitor → prepare → compact →
 * emergency). No private chain-of-thought is ever displayed — only usage
 * math.
 *
 * The estimate is CLIENT-SIDE and heuristic (same estimator the runtime's
 * Context Manager uses); the authoritative per-turn compaction happens
 * server-side of the request in runtime.ts. The indicator reflects what the
 * NEXT turn would approximately carry.
 */

import * as React from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chat-store";
import { estimateTokens } from "@/lib/agent/context/token-counter";
import { resolveModelContext } from "@/lib/agent/context/model-context";
import type { ContextStatus } from "@/lib/agent/context/context-manager";

/**
 * System + tools baseline. The full system prompt (tool digest, workspace
 * policy, Onyx.md digest) measures ~7–9K tokens for the default toolset.
 * Estimating it client-side avoids importing the whole prompt builder here.
 */
const SYSTEM_TOOLS_BASELINE_TOKENS = 8_500;

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
      return "Compacting";
  }
}

export function ContextIndicator() {
  const messages = useChatStore((s) => s.messages);
  const selectedModel = useChatStore((s) => s.selectedModel);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const [open, setOpen] = React.useState(false);

  // Coarse signature — recompute only when the conversation actually grows
  // or the model changes, not on every streaming token.
  const signature = React.useMemo(
    () => `${selectedModel ?? ""}:${messages.length}:${messages.reduce((n, m) => n + (m.content?.length ?? 0), 0)}`,
    [selectedModel, messages],
  );

  const estimate = React.useMemo(() => {
    const modelInfo = resolveModelContext(selectedModel);
    const inputBudget = Math.max(
      2048,
      Math.floor(modelInfo.contextWindow - modelInfo.reservedOutput - modelInfo.contextWindow * 0.06),
    );
    let conversationTokens = 0;
    for (const m of messages) {
      if (m.role === "system") continue;
      const partsText = (m.parts ?? [])
        .filter((p) => p.type === "text" && p.content)
        .map((p) => p.content)
        .join("\n\n");
      conversationTokens += estimateTokens(m.content || partsText);
    }
    const used = conversationTokens + SYSTEM_TOOLS_BASELINE_TOKENS;
    const ratio = used / inputBudget;
    const status: ContextStatus =
      ratio >= 0.95 ? "emergency" : ratio >= 0.9 ? "compact" : ratio >= 0.8 ? "prepare" : ratio >= 0.7 ? "monitor" : "healthy";
    return {
      conversationTokens,
      systemToolsTokens: SYSTEM_TOOLS_BASELINE_TOKENS,
      used,
      available: Math.max(0, inputBudget - used),
      inputBudget,
      ratio,
      status,
      modelInfo,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const pct = Math.round(estimate.ratio * 100);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[10px] tracking-wider uppercase transition-colors",
            estimate.status === "healthy"
              ? "text-muted-foreground hover:bg-muted"
              : "text-foreground hover:bg-muted",
          )}
          title="Estimated context usage for the next turn"
          aria-label={`Context usage ${pct}%`}
        >
          <span className={cn("relative inline-block h-1.5 w-1.5 rounded-full", statusColor(estimate.status))}>
            {isStreaming && (
              <span className={cn("absolute inset-0 animate-ping rounded-full opacity-60", statusColor(estimate.status))} />
            )}
          </span>
          Context {pct}%
          {(estimate.status === "compact" || estimate.status === "emergency") && (
            <span className="text-rose-500">· Compacting</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-72 p-3">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold">Context</span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {estimate.modelInfo.label} · {estimate.modelInfo.source === "safe-fallback" ? "assumed window" : "model window"}
            </span>
          </div>
          <Progress
            value={Math.min(100, estimate.ratio * 100)}
            className={cn(
              "h-2",
              estimate.status === "healthy" && "[&>div]:bg-emerald-500",
              estimate.status === "monitor" && "[&>div]:bg-amber-400",
              (estimate.status === "prepare" || estimate.status === "compact") && "[&>div]:bg-orange-400",
              estimate.status === "emergency" && "[&>div]:bg-rose-500",
            )}
          />
          <div className="space-y-1.5 text-[11px]">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Conversation</span>
              <span className="font-mono">{fmtTokens(estimate.conversationTokens)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">System + tools</span>
              <span className="font-mono">{fmtTokens(estimate.systemToolsTokens)}</span>
            </div>
            <div className="flex justify-between border-t border-border pt-1.5">
              <span className="text-muted-foreground">Available</span>
              <span className="font-mono">{fmtTokens(estimate.available)} / {fmtTokens(estimate.inputBudget)}</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5 border-t border-border pt-2 text-[10px] text-muted-foreground">
            <span className={cn("inline-block h-1.5 w-1.5 rounded-full", statusColor(estimate.status))} />
            <span>
              {statusLabel(estimate.status)} — older turns auto-compact at 90%; nothing is deleted from your history.
            </span>
          </div>
          <p className="text-[9px] leading-relaxed text-muted-foreground/70">
            Estimate only — the per-turn budget is computed by the Onyx Context Manager before each request
            {selectedModel ? ` for ${selectedModel}` : ""}.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

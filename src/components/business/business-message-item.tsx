"use client";

/**
 * Business Mode — chat message renderer (Task 4-b).
 *
 * Branches by message role (user / main / agent / activity) and hosts the
 * dependency-free lightweight markdown renderer shared with the inline draft
 * card (exported as `renderBusinessMarkdown` — function declaration, so the
 * circular import with business-draft-card.tsx is hoisting-safe).
 */

import * as React from "react";
import { ChevronDown, ExternalLink } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useBusinessStore } from "@/stores/business-store";
import { bt } from "@/lib/business/ui-text";
import type { BusinessChatMessageRow } from "@/lib/business/types";
import { cn } from "@/lib/utils";
import { AgentLogo } from "./agent-logos";
import { BusinessActivityItem } from "./business-activity-item";
import { BusinessDraftCard } from "./business-draft-card";

// ---------------------------------------------------------------------------
// Lightweight markdown renderer (no dependencies).
// Supports: paragraphs, headings #–####, **bold**, *italic*, `code`,
// [links](https://…), -/* unordered lists, 1. ordered lists, > quotes,
// ``` fenced code blocks and --- rules. Good enough for agent output and
// business profiles without pulling the heavy chat markdown stack.
// ---------------------------------------------------------------------------

/** Inline tokens: bold / italic / code / http(s) links. */
const INLINE_MD_RE =
  /(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(`[^`\n]+`)|(\[[^\]\n]*\]\((?:https?:\/\/|\/|mailto:)[^)\s]*\))/g;

function renderInlineMd(text: string, keyBase: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  INLINE_MD_RE.lastIndex = 0;
  while ((m = INLINE_MD_RE.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const token = m[0];
    const key = `${keyBase}-${i++}`;
    if (token.startsWith("**")) {
      nodes.push(
        <strong key={key} className="font-semibold">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("`")) {
      nodes.push(
        <code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("[")) {
      const label = token.slice(1, token.indexOf("]"));
      const href = token.slice(token.indexOf("](") + 2, -1);
      nodes.push(
        <a key={key} href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
          {label}
        </a>,
      );
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    last = m.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const MD_HEADING_RE = /^(#{1,4})\s+(.*)$/;
const MD_UL_RE = /^\s*[-*+]\s+/;
const MD_OL_RE = /^\s*\d+[.)]\s+/;
const MD_HR_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

const MD_HEADINGS: { tag: "h3" | "h4" | "h5" | "h6"; className: string }[] = [
  { tag: "h3", className: "text-base font-semibold" },
  { tag: "h4", className: "text-sm font-semibold" },
  { tag: "h5", className: "text-sm font-medium" },
  { tag: "h6", className: "text-xs font-semibold uppercase tracking-wide text-muted-foreground" },
];

/** Render a markdown string into React nodes (blocks + inline). */
export function renderBusinessMarkdown(
  content: string,
  opts?: { className?: string; keyPrefix?: string },
): React.ReactNode {
  const lines = (content ?? "").split(/\r?\n/);
  const kp = opts?.keyPrefix ?? "bmd";
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let bi = 0;
  const push = (node: React.ReactNode) => {
    blocks.push(<React.Fragment key={`${kp}-b${bi++}`}>{node}</React.Fragment>);
  };
  /** Safe indexed access ("" out of bounds — strict noUncheckedIndexedAccess). */
  const at = (idx: number): string => lines[idx] ?? "";

  while (i < lines.length) {
    const line = at(i);
    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code block.
    if (line.trim().startsWith("```")) {
      i++;
      const code: string[] = [];
      while (i < lines.length && !at(i).trim().startsWith("```")) code.push(at(i++));
      i++; // closing fence (or EOF)
      push(
        <pre className="scrollbar-thin overflow-x-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Horizontal rule.
    if (MD_HR_RE.test(line)) {
      i++;
      push(<hr className="border-border" />);
      continue;
    }

    // Heading.
    const h = line.match(MD_HEADING_RE);
    if (h) {
      const spec = MD_HEADINGS[(h[1] ?? "").length - 1];
      if (spec) {
        push(React.createElement(spec.tag, { className: spec.className }, renderInlineMd(h[2] ?? "", `${kp}-b${bi}`)));
        i++;
        continue;
      }
    }

    // Unordered / ordered list runs.
    if (MD_UL_RE.test(line) || MD_OL_RE.test(line)) {
      const ordered = MD_OL_RE.test(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? MD_OL_RE.test(at(i)) : MD_UL_RE.test(at(i)))) {
        items.push(at(i).replace(ordered ? MD_OL_RE : MD_UL_RE, ""));
        i++;
      }
      const items_ = items.map((t, idx) => <li key={`${kp}-li${idx}`}>{renderInlineMd(t, `${kp}-li${idx}`)}</li>);
      push(
        ordered ? (
          <ol className="ml-4 list-decimal space-y-1">{items_}</ol>
        ) : (
          <ul className="ml-4 list-disc space-y-1">{items_}</ul>
        ),
      );
      continue;
    }

    // Blockquote run.
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(at(i))) quote.push(at(i).replace(/^\s*>\s?/, ""));
      i = Math.min(i + quote.length, lines.length);
      push(
        <blockquote className="border-l-2 border-border pl-3 text-muted-foreground">
          {renderInlineMd(quote.join("\n"), `${kp}-b${bi}`)}
        </blockquote>,
      );
      continue;
    }

    // Paragraph — consecutive plain lines joined (single newlines preserved
    // via whitespace-pre-wrap so LLM output reads naturally).
    const para: string[] = [];
    while (
      i < lines.length &&
      at(i).trim() &&
      !at(i).trim().startsWith("```") &&
      !MD_HEADING_RE.test(at(i)) &&
      !MD_UL_RE.test(at(i)) &&
      !MD_OL_RE.test(at(i)) &&
      !MD_HR_RE.test(at(i)) &&
      !/^\s*>/.test(at(i))
    ) {
      para.push(at(i));
      i++;
    }
    push(
      <p className="whitespace-pre-wrap break-words">{renderInlineMd(para.join("\n"), `${kp}-b${bi}`)}</p>,
    );
  }

  if (blocks.length === 0) return null;
  return <div className={cn("min-w-0 space-y-3 leading-relaxed", opts?.className)}>{blocks}</div>;
}

// ---------------------------------------------------------------------------
// Message item.
// ---------------------------------------------------------------------------

/** One row in the business chat transcript, branched by role. */
export function BusinessMessageItem({ message }: { message: BusinessChatMessageRow }) {
  const agents = useBusinessStore((s) => s.agents);

  // --- activity → compact timeline row -------------------------------------
  if (message.role === "activity") {
    return <BusinessActivityItem message={message} />;
  }

  // --- user → right-aligned bubble ------------------------------------------
  if (message.role === "user") {
    const mentioned = (message.metadata?.mentions ?? [])
      .map((id) => agents.find((a) => a.id === id))
      .filter((a): a is NonNullable<typeof a> => Boolean(a));
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm border border-primary/20 bg-primary/10 px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words">
          {message.content}
        </div>
        {mentioned.length > 0 && (
          <p className="pr-1 text-[11px] text-muted-foreground">
            {bt("chat.mentionsLabel", { agents: mentioned.map((a) => a.name).join(", ") })}
          </p>
        )}
      </div>
    );
  }

  // --- main agent → orb + streamed markdown ---------------------------------
  if (message.role === "main") {
    const streaming = message.metadata?.streaming === true;
    const usage = message.metadata?.usage;
    return (
      <div className="flex items-start gap-3" aria-busy={streaming || undefined}>
        <AgentLogo logo="orb" label={bt("ws.mainAgent")} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-xs font-semibold text-foreground">{bt("ws.mainAgent")}</span>
            {streaming && (
              <span className="text-[11px] text-muted-foreground" aria-live="polite">
                {bt("chat.streaming")}
              </span>
            )}
          </div>
          <div className="mt-1 text-sm">
            {renderBusinessMarkdown(message.content, { keyPrefix: `msg-${message.id}` })}
            {streaming && (
              <span aria-hidden className="ml-0.5 inline-block animate-pulse text-primary">
                ▌
              </span>
            )}
          </div>
          {message.metadata?.cancelled && (
            <p className="mt-1.5 text-xs italic text-muted-foreground">{bt("chat.activityCancelled")}</p>
          )}
          {usage && (usage.prompt_tokens != null || usage.completion_tokens != null) && (
            <p className="mt-1.5 text-[10px] tabular-nums text-muted-foreground/70">
              {usage.prompt_tokens ?? 0}→{usage.completion_tokens ?? 0} tok
            </p>
          )}
        </div>
      </div>
    );
  }

  // --- specialist agent → logo + contribution -------------------------------
  const agent = message.agent_id ? agents.find((a) => a.id === message.agent_id) : undefined;
  const sources = message.metadata?.sources ?? [];
  return (
    <div className="flex items-start gap-3">
      <AgentLogo logo={agent?.svg_logo ?? "generic"} label={agent?.name} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-xs font-semibold text-foreground">{agent?.name ?? "Agent"}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">· {bt("chat.agentContribution")}</span>
        </div>
        <div className="scrollbar-thin mt-1 max-h-[32rem] overflow-y-auto pr-1 text-sm">
          {renderBusinessMarkdown(message.content, { keyPrefix: `msg-${message.id}` })}
        </div>
        {sources.length > 0 && (
          <Collapsible className="mt-2">
            <CollapsibleTrigger className="group inline-flex items-center gap-1 rounded-md text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
              <ChevronDown className="size-3.5 transition-transform duration-200 group-data-[state=open]:rotate-180" aria-hidden />
              {bt("chat.sources")} ({sources.length})
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {sources.map((s, idx) => {
                  const safe = /^https?:\/\//.test(s.url);
                  const label = s.title || s.url;
                  return safe ? (
                    <a
                      key={`${message.id}-src-${idx}`}
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex max-w-[240px] items-center gap-1 rounded-full border bg-muted/40 px-2.5 py-1 text-xs text-foreground/80 transition-colors hover:bg-accent hover:text-accent-foreground"
                    >
                      <span className="truncate">{label}</span>
                      <ExternalLink className="size-3 shrink-0" aria-hidden />
                    </a>
                  ) : (
                    <span
                      key={`${message.id}-src-${idx}`}
                      className="inline-flex max-w-[240px] items-center rounded-full border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground"
                    >
                      <span className="truncate">{label}</span>
                    </span>
                  );
                })}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
        {message.metadata?.draftId && (
          <div className="mt-3">
            <BusinessDraftCard draftId={message.metadata.draftId} />
          </div>
        )}
      </div>
    </div>
  );
}

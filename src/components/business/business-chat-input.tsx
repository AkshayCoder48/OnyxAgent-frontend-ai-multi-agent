"use client";

/**
 * Business Mode — chat composer with @mention autocomplete (Task 4-b).
 *
 * Auto-resizing textarea (1–8 rows, Enter sends / Shift+Enter newlines) with
 * a caret-tracked @mention palette anchored above the input: filter by typed
 * text, navigate with ↑/↓, complete with Enter/Tab or click, dismiss with
 * Esc or by moving focus away. While a swarm turn runs, the send button is
 * replaced by a destructive Stop control.
 */

import * as React from "react";
import { ArrowUp, Square } from "lucide-react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useBusinessStore } from "@/stores/business-store";
import { bt } from "@/lib/business/ui-text";
import type { BusinessAgentRow } from "@/lib/business/types";
import { cn } from "@/lib/utils";
import { AgentLogo } from "./agent-logos";

export interface BusinessChatInputProps {
  disabled: boolean;
  onSend: (content: string) => void;
  onStop: () => void;
  running: boolean;
}

/** Mention token before the caret: "@", then word/space/hyphen chars. */
const MENTION_TOKEN_RE = /@([\w\- ]*)$/;

/** Max textarea height ≈ 8 rows. */
const TEXTAREA_MAX_PX = 200;
/** Cap the palette list (scrolls inside). */
const MENTION_LIMIT = 8;

export function BusinessChatInput({ disabled, onSend, onStop, running }: BusinessChatInputProps) {
  const agents = useBusinessStore((s) => s.agents);

  const [value, setValue] = React.useState("");
  /** Active mention: { start = index of "@" } | null. */
  const [mention, setMention] = React.useState<{ start: number; query: string } | null>(null);
  const [highlight, setHighlight] = React.useState(0);

  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLUListElement>(null);
  /** Index of the "@" inserted by the LAST completion — the palette must not
   *  re-open for that same token while the user keeps typing after it. */
  const completedAtRef = React.useRef<number | null>(null);

  const filteredAgents = React.useMemo(() => {
    if (!mention) return [] as BusinessAgentRow[];
    const q = mention.query.trim().toLowerCase();
    const src = q ? agents.filter((a) => a.name.toLowerCase().includes(q)) : agents;
    return src.slice(0, MENTION_LIMIT);
  }, [mention, agents]);

  React.useEffect(() => {
    setHighlight(0);
  }, [mention?.start, mention?.query]);

  // Keep the highlighted row visible while arrow-keying.
  React.useEffect(() => {
    const el = listRef.current?.children[highlight] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight, filteredAgents.length]);

  // Auto-resize (1–8 rows).
  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, TEXTAREA_MAX_PX)}px`;
  }, [value]);

  /** Recompute the mention token from the live caret position. */
  const updateMention = React.useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? 0;
    const match = el.value.slice(0, caret).match(MENTION_TOKEN_RE);
    if (!match) {
      setMention(null);
      return;
    }
    const start = caret - match[0].length;
    // Skip the token produced by the most recent completion (it stays closed
    // until a freshly typed "@" appears at a different position).
    if (completedAtRef.current === start) {
      setMention(null);
      return;
    }
    setMention({ start, query: match[1] ?? "" });
  }, []);

  const completeMention = React.useCallback(
    (agent: BusinessAgentRow) => {
      const el = textareaRef.current;
      if (!el || !mention) return;
      const caret = el.selectionStart ?? 0;
      const insertion = `@${agent.name} `;
      const next = el.value.slice(0, mention.start) + insertion + el.value.slice(caret);
      const pos = mention.start + insertion.length;
      completedAtRef.current = mention.start;
      setMention(null);
      setValue(next);
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(pos, pos);
      });
    },
    [mention],
  );

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue("");
    setMention(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && filteredAgents.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => (h + 1) % filteredAgents.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => (h - 1 + filteredAgents.length) % filteredAgents.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const agent = filteredAgents[highlight];
        if (agent) completeMention(agent);
        return;
      }
    }
    if (e.key === "Escape" && mention) {
      e.preventDefault();
      setMention(null);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const canSend = value.trim().length > 0 && !disabled;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex items-end gap-2">
        <div ref={wrapRef} className="relative min-w-0 flex-1">
          <Popover open={mention !== null}>
            <PopoverAnchor asChild>
              <div className="w-full">
                <textarea
                  ref={textareaRef}
                  value={value}
                  onChange={(e) => {
                    setValue(e.target.value);
                    updateMention();
                  }}
                  onKeyDown={handleKeyDown}
                  onSelect={updateMention}
                  onClick={updateMention}
                  onBlur={() => setMention(null)}
                  placeholder={bt("chat.inputPlaceholder")}
                  aria-label={bt("chat.inputPlaceholder")}
                  disabled={disabled}
                  rows={1}
                  className="scrollbar-thin min-h-[44px] w-full resize-none rounded-xl border border-border/70 bg-background px-3.5 py-2.5 text-sm leading-relaxed transition-colors placeholder:text-muted-foreground/60 focus:border-primary/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  style={{ maxHeight: TEXTAREA_MAX_PX }}
                />
              </div>
            </PopoverAnchor>
            <PopoverContent
              side="top"
              align="start"
              sideOffset={8}
              className="w-80 rounded-xl p-1 shadow-lg"
              onOpenAutoFocus={(e) => e.preventDefault()}
              onEscapeKeyDown={(e) => e.preventDefault()}
              onPointerDownOutside={(e) => {
                // Clicks inside the composer (e.g. repositioning the caret)
                // keep the palette; everything else closes it.
                const target = e.detail.originalEvent.target as Node | null;
                if (target && wrapRef.current?.contains(target)) e.preventDefault();
                else setMention(null);
              }}
            >
              <ul ref={listRef} role="listbox" aria-label={bt("chat.mentionHint")} className="scrollbar-thin max-h-64 overflow-y-auto py-0.5">
                {filteredAgents.length === 0 ? (
                  <li className="px-3 py-2.5 text-xs text-muted-foreground">{bt("chat.mentionEmpty")}</li>
                ) : (
                  filteredAgents.map((agent, i) => (
                    <li
                      key={agent.id}
                      role="option"
                      aria-selected={i === highlight}
                      onPointerEnter={() => setHighlight(i)}
                      onPointerDown={(e) => {
                        e.preventDefault(); // keep the textarea focused
                        completeMention(agent);
                      }}
                      className={cn(
                        "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2",
                        i === highlight ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                      )}
                    >
                      <AgentLogo logo={agent.svg_logo} label={agent.name} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium leading-tight">{agent.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">{agent.description}</span>
                      </span>
                      <Badge
                        variant="outline"
                        className="shrink-0 px-1.5 py-0 text-[10px] font-medium text-muted-foreground"
                      >
                        {bt(`status.${agent.status}`)}
                      </Badge>
                    </li>
                  ))
                )}
              </ul>
            </PopoverContent>
          </Popover>
        </div>

        {running ? (
          <Button
            type="button"
            variant="destructive"
            onClick={onStop}
            className="size-11 shrink-0 rounded-full"
            aria-label={bt("chat.stop")}
            title={bt("chat.stop")}
          >
            <Square className="size-3.5 fill-current" />
          </Button>
        ) : (
          <Button
            type="submit"
            disabled={!canSend}
            className="size-11 shrink-0 rounded-full"
            aria-label={bt("chat.send")}
            title={bt("chat.send")}
          >
            <ArrowUp className="size-4" strokeWidth={2.5} />
          </Button>
        )}
      </div>

      <p className="hidden pt-1.5 text-[10px] text-muted-foreground/60 sm:block">{bt("chat.mentionHint")}</p>
    </form>
  );
}

"use client";

import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SourceItem } from "@/lib/chat-sources";

/**
 * CitationsFooter — Beta V1.2 compact source footer (AICSS "Inline
 * Citations" recipe). Renders under the answer: one numbered row per
 * source — `n · Title · host ↗` — each row linking straight to the source.
 * Rows with no URL (RAG chunks) render as plain text with their subtitle.
 *
 * The "N sources" button that opened the side panel is folded in: rows with
 * URLs open in a new tab directly (the AICSS behaviour), and an optional
 * trailing "+N more" affordance opens the full sources panel for long lists.
 */
const MAX_ROWS = 8;

export function CitationsFooter({
  sources,
  onOpenPanel,
  className,
}: {
  sources: readonly SourceItem[];
  onOpenPanel?: (index: number) => void;
  className?: string;
}) {
  if (sources.length === 0) return null;
  const shown = sources.slice(0, MAX_ROWS);
  const rest = sources.length - shown.length;

  return (
    <div
      data-slot="citations-footer"
      className={cn("border-foreground/10 bg-foreground/[0.015] mt-1 rounded-xl border px-2.5 py-2", className)}
      aria-label={`Sources — ${sources.length} total`}
    >
      <div className="text-muted-foreground mb-1.5 flex items-center gap-1.5 px-0.5 font-mono text-[9.5px] font-medium tracking-[0.12em] uppercase">
        <span>Sources</span>
        <span className="text-foreground/50 tabular-nums">{sources.length}</span>
      </div>
      <ul className="min-w-0 space-y-0.5">
        {shown.map((s) => {
          const row = (
            <>
              <span
                className="border-foreground/15 bg-foreground/[0.06] text-foreground/70 inline-flex h-[1.15rem] min-w-[1.15rem] shrink-0 items-center justify-center rounded-full px-1 font-mono text-[10px] font-semibold tabular-nums"
                aria-hidden
              >
                {s.index}
              </span>
              <span className="text-foreground/80 truncate text-[11.5px] font-medium">{s.title}</span>
              {s.subtitle && (
                <>
                  <span className="text-muted-foreground/70 shrink-0 text-[11px]" aria-hidden>
                    ·
                  </span>
                  <span className="text-muted-foreground truncate text-[11px]">{s.subtitle}</span>
                </>
              )}
            </>
          );
          return (
            <li key={`${s.index}-${s.title}`} className="min-w-0">
              {s.url ? (
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:bg-foreground/[0.05] group flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors"
                  title={s.title}
                >
                  {row}
                  <ArrowUpRight className="text-muted-foreground/50 group-hover:text-primary h-3 w-3 shrink-0 transition-colors" aria-hidden />
                </a>
              ) : (
                <button
                  type="button"
                  onClick={() => onOpenPanel?.(s.index - 1)}
                  className="hover:bg-foreground/[0.05] group flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors"
                  title={s.title}
                >
                  {row}
                </button>
              )}
            </li>
          );
        })}
        {rest > 0 && (
          <li className="pt-0.5">
            <button
              type="button"
              onClick={() => onOpenPanel?.(0)}
              className="text-muted-foreground hover:text-primary hover:bg-foreground/[0.05] rounded-md px-1.5 py-1 font-mono text-[10.5px] tabular-nums transition-colors"
            >
              +{rest} more…
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}

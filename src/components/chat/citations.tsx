"use client";

import * as React from "react";
import { ArrowUpRight, Globe, BookOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { SourceFavicon } from "@/components/chat/source-favicon";
import { useSourcesPanelStore } from "@/stores/sources-panel-store";
import type { SourceItem } from "@/lib/chat-sources";

/**
 * CitationsFooter — the SOURCES ORGANIZER (Task 24): the fixed 360px
 * sources SIDEBAR is gone. In its place, a modern inline organizer under
 * the answer:
 *
 *   REST    — one compact pill: the favicon stack of everything searched
 *             + "Searched N sources" + the web/knowledge-base split.
 *   OPEN    — the pill expands INLINE (blur-reveal, staggered rows) into
 *             the full organized list: every source grouped Web /
 *             Knowledge base, each row a favicon + title + host (+ link).
 *
 * The sources-panel store still drives it: citation chips in the text
 * call `open(sources, index)` → this footer (the one whose sources array
 * matches) expands, highlights and scrolls to the cited row. Escape or
 * the pill click collapses it again.
 */
export function CitationsFooter({
  sources,
  className,
}: {
  sources: readonly SourceItem[];
  className?: string;
}) {
  const storeOpen = useSourcesPanelStore((s) => s.isOpen);
  const storeSources = useSourcesPanelStore((s) => s.sources);
  const highlightedIndex = useSourcesPanelStore((s) => s.highlightedIndex);
  const open = useSourcesPanelStore((s) => s.open);
  const close = useSourcesPanelStore((s) => s.close);

  // This message's organizer is the active one when the store holds THIS
  // exact sources array (identity — message-item passes the same memoized
  // array to both the store and this footer).
  const isActive = storeOpen && storeSources === sources;
  const [expanded, setExpanded] = React.useState(false);

  // The store opening (citation-chip click) expands this organizer.
  React.useEffect(() => {
    if (isActive) setExpanded(true);
  }, [isActive]);

  // Escape collapses the organizer (the old sidebar's behaviour).
  React.useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setExpanded(false);
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, close]);

  if (sources.length === 0) return null;

  const webSources = sources.filter((s) => s.type === "web");
  const ragSources = sources.filter((s) => s.type === "rag");
  const stack = sources.slice(0, 4);
  const rest = sources.length - stack.length;

  const toggle = () => {
    if (expanded) {
      setExpanded(false);
      close();
    } else {
      open(sources, null);
      setExpanded(true);
    }
  };

  return (
    <div
      data-slot="citations-footer"
      className={cn("mb-object-in mt-1 min-w-0", className)}
      aria-label={`Sources — ${sources.length} total`}
    >
      {/* The pill — favicon stack + the total-searched summary. */}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        className={cn(
          "group flex w-full max-w-full cursor-pointer select-none items-center gap-2 rounded-xl px-2 py-1.5 text-left transition-colors",
          "hover:bg-foreground/[0.05]",
        )}
      >
        <span className="flex shrink-0 items-center -space-x-1.5" aria-hidden>
          {stack.map((s) => (
            <SourceFavicon
              key={`${s.index}-${s.title}`}
              url={s.url}
              kind={s.type}
              className="h-4 w-4 rounded-[5px] ring-1 ring-background"
            />
          ))}
          {rest > 0 && (
            <span className="bg-foreground/[0.08] text-foreground/70 inline-flex h-4 min-w-4 items-center justify-center rounded-[5px] px-1 font-mono text-[9px] font-semibold tabular-nums ring-1 ring-background">
              +{rest}
            </span>
          )}
        </span>
        <span className="text-foreground/85 min-w-0 truncate text-xs font-medium">
          {expanded ? "Hide sources" : `Searched ${sources.length} ${sources.length === 1 ? "source" : "sources"}`}
        </span>
        <span className="text-muted-foreground shrink-0 truncate text-[11px]">
          {webSources.length > 0 && `${webSources.length} web`}
          {webSources.length > 0 && ragSources.length > 0 && " · "}
          {ragSources.length > 0 && `${ragSources.length} knowledge base`}
        </span>
        <ArrowUpRight
          className={cn(
            "text-muted-foreground/50 group-hover:text-primary ml-auto h-3 w-3 shrink-0 transition-all duration-200",
            expanded && "rotate-90",
          )}
          aria-hidden
        />
      </button>

      {/* The organized list — ALL searched sources, grouped. */}
      {expanded && (
        <div className="mb-stagger mt-1 space-y-3">
          {webSources.length > 0 && (
            <section className="space-y-0.5">
              <h3 className="text-muted-foreground flex items-center gap-1.5 px-1 font-mono text-[9.5px] font-medium tracking-[0.12em] uppercase">
                <Globe className="h-3 w-3" aria-hidden />
                Web
                <span className="text-foreground/45 tabular-nums">{webSources.length}</span>
              </h3>
              {webSources.map((s) => (
                <SourceRow key={`web-${s.index}`} item={s} highlighted={s.index === highlightedIndex} />
              ))}
            </section>
          )}
          {ragSources.length > 0 && (
            <section className="space-y-0.5">
              <h3 className="text-muted-foreground flex items-center gap-1.5 px-1 font-mono text-[9.5px] font-medium tracking-[0.12em] uppercase">
                <BookOpen className="h-3 w-3" aria-hidden />
                Knowledge base
                <span className="text-foreground/45 tabular-nums">{ragSources.length}</span>
              </h3>
              {ragSources.map((s) => (
                <SourceRow key={`rag-${s.index}`} item={s} highlighted={s.index === highlightedIndex} />
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

/** One source row — favicon + title + host (+snippet for RAG). Web rows
 *  open in a new tab; RAG rows are plain (their content is local). The
 *  highlighted row (the citation chip the user clicked) glows. */
function SourceRow({ item, highlighted }: { item: SourceItem; highlighted: boolean }) {
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (highlighted) {
      ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [highlighted]);

  const inner = (
    <div
      ref={ref}
      className={cn(
        "mb-row-in flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 transition-colors",
        highlighted
          ? "bg-primary/10 ring-1 ring-primary/40"
          : "hover:bg-foreground/[0.05]",
        item.url && "cursor-pointer",
      )}
    >
      <span
        className="border-foreground/15 bg-foreground/[0.06] text-foreground/70 inline-flex h-[1.15rem] min-w-[1.15rem] shrink-0 items-center justify-center rounded-full px-1 font-mono text-[10px] font-semibold tabular-nums"
        aria-hidden
      >
        {item.index}
      </span>
      <SourceFavicon url={item.url} kind={item.type} className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="text-foreground/85 block truncate text-[11.5px] font-medium" title={item.title}>
          {item.title}
        </span>
        {item.subtitle && (
          <span className="text-muted-foreground block truncate text-[10.5px]">{item.subtitle}</span>
        )}
      </span>
      {item.score !== undefined && (
        <span
          className="bg-foreground/25 h-1.5 w-1.5 shrink-0 rounded-full"
          title={`Relevance: ${item.score.toFixed(2)}`}
          aria-hidden
        />
      )}
      {item.url && (
        <ArrowUpRight className="text-muted-foreground/50 group-hover:text-primary h-3 w-3 shrink-0" aria-hidden />
      )}
    </div>
  );

  if (item.url) {
    return (
      <a href={item.url} target="_blank" rel="noopener noreferrer" className="group block min-w-0">
        {inner}
      </a>
    );
  }
  return inner;
}

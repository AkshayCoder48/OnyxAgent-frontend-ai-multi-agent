"use client";

import * as React from "react";
import { FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { monoLabelClass, paperCardClass } from "./surfaces";

/** One page citation: the page it points at and the quoted passage. */
export interface DocumentAnchor {
  /** Page number this anchor cites. */
  page: number;
  /** The quoted passage shown under the page number. */
  quote: string;
}

/**
 * DocumentReference — a citation card for one source document
 * (assistant-ui `elements-document-reference` recipe, Terra retheme).
 *
 * A header naming the file, then a list of page anchors the answer leans
 * on, each stepping between "p. N" labels with the quoted passage below.
 * `activePage` highlights every anchor at that page; only the first anchor
 * in array order at that page carries `aria-current`. Clicking an anchor
 * calls `onJump` with that anchor's page (not its array index).
 */
export function DocumentReference({
  title,
  pages,
  anchors,
  activePage,
  onJump,
  className,
  ...props
}: {
  /** Heading text (shadows the native `title` attribute). */
  title: string;
  /** Total page count, shown in the header meta line. */
  pages: number;
  /** The citations to list, in order. */
  anchors: readonly DocumentAnchor[];
  /** Page number to highlight. May match zero, one, or several anchors. */
  activePage: number;
  /** Called with an anchor's page when its button is pressed. */
  onJump?: (page: number) => void;
  className?: string;
} & Omit<React.ComponentPropsWithoutRef<"div">, "title" | "children">) {
  // First anchor (in array order) at the active page gets aria-current.
  const firstActiveIdx = anchors.findIndex((a) => a.page === activePage);
  const cited = anchors.length;

  return (
    <div
      data-slot="document-reference"
      className={cn(paperCardClass, "max-w-md divide-y divide-border", className)}
      {...props}
    >
      {/* Header — file icon in a tinted square, name, "N pages · M cited" */}
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted">
          <FileText className="h-4 w-4 text-primary" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground/90">{title}</p>
          <p className={cn(monoLabelClass, "normal-case tracking-normal")}>
            {pages} pages · {cited} cited
          </p>
        </div>
      </div>

      {/* Anchors — one button per citation: "p. N" above the quoted passage */}
      <div className="p-1.5">
        {anchors.map((anchor, i) => {
          const isActive = anchor.page === activePage;
          return (
            <button
              key={`${anchor.page}-${i}`}
              type="button"
              aria-current={i === firstActiveIdx ? "true" : undefined}
              onClick={() => onJump?.(anchor.page)}
              className={cn(
                "flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors",
                isActive
                  ? "bg-accent/60"
                  : "hover:bg-accent/40",
              )}
            >
              <span
                className={cn(
                  "shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[10px] font-medium tabular-nums",
                  isActive
                    ? "bg-primary/15 text-primary"
                    : "bg-muted text-muted-foreground",
                )}
              >
                p. {anchor.page}
              </span>
              <span className="min-w-0 text-xs leading-relaxed text-foreground/80">
                {anchor.quote}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

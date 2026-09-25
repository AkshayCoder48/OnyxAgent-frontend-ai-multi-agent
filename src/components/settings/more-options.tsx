"use client";

import * as React from "react";
import { ChevronDown, Info } from "lucide-react";

import { cn } from "@/lib/utils";

interface MoreOptionsProps {
  /** Controlled open state — leave undefined for the unmanaged variant. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Initial open state for the unmanaged variant (e.g. auto-expand when an
   *  edited item already carries non-default advanced values). */
  defaultOpen?: boolean;
  /** Collapsed button label. Defaults to "More options". */
  label?: string;
  /** Extra classes for the outer wrapper. */
  className?: string;
  /** Advanced content revealed on expand. */
  children: React.ReactNode;
}

/**
 * Shared "More options ▾" disclosure for the Settings surfaces.
 *
 * Keeps the essentials of every form/section visible and tucks advanced or
 * rarely-used controls behind one consistent chevron button (the pattern
 * introduced by section-integrations-composio.tsx + section-skills.tsx,
 * extracted here so every section uses the exact same look & behavior).
 *
 * The reveal animates height + opacity via the CSS `grid-template-rows:
 * 0fr → 1fr` trick — no global CSS or JS measurement needed. Collapsed
 * content is `invisible` so it never catches focus or screen-reader hits.
 */
export function MoreOptions({
  open,
  onOpenChange,
  defaultOpen = false,
  label = "More options",
  className,
  children,
}: MoreOptionsProps) {
  const [unmanagedOpen, setUnmanagedOpen] = React.useState(defaultOpen);
  const isOpen = open ?? unmanagedOpen;

  const toggle = React.useCallback(() => {
    const next = !isOpen;
    if (onOpenChange) onOpenChange(next);
    else setUnmanagedOpen(next);
  }, [isOpen, onOpenChange]);

  return (
    <div className={cn("space-y-2", className)}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={isOpen}
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <Info className="size-3.5" />
        {isOpen ? "Hide" : label}
        <ChevronDown className={cn("size-3.5 transition-transform", isOpen && "rotate-180")} />
      </button>

      {/* Smooth height + opacity reveal (`.mb-collapse` — the shared Terra
          motion-system disclosure: grid rows 0fr→1fr + opacity). Collapsed
          content is `visibility:hidden` (delayed until the fade-out
          finishes) so it never catches focus or screen-reader hits. */}
      <div className="mb-collapse" data-open={isOpen}>
        <div className="overflow-hidden">
          <div className="space-y-4 pt-1">{children}</div>
        </div>
      </div>
    </div>
  );
}

export default MoreOptions;

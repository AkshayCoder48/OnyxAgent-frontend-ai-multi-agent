"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronsRight, X } from "lucide-react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useResizableSidebar } from "@/components/ui/resize-handle";
import { cn } from "@/lib/utils";

/**
 * DockedPanel — a right-hand panel that is a REAL part of the layout, not a
 * floating overlay (PRD §16/§17).
 *
 * Desktop (lg+): the panel is an in-flow flex column docked against the
 * right edge of the viewport — it participates in normal layout flow, so
 * the main chat column's width smoothly decreases while it opens (animated
 * width, ~250ms ease-out via the `.docked-panel` class in globals.css; no
 * overlay, no backdrop, no blur). A compact chevron docked on the panel's
 * left edge collapses it; a drag handle on the same edge resizes it. The
 * width persists to localStorage (via useResizableSidebar), so the user's
 * sizing choice survives reloads.
 *
 * Mobile (< lg): the same content becomes a full-height drawer sliding in
 * from the right edge (scrim + body scroll lock — standard mobile
 * navigation), rendered with the same Sheet primitive the conversation
 * sidebar uses, so it feels part of the navigation system rather than a
 * random floating overlay.
 *
 * Children mount on the first open and stay mounted afterwards, so the
 * close animation always has content to slide away and panel state
 * (drafts, scroll position) is preserved between toggles.
 */

/** Below the lg breakpoint the docked column becomes a mobile drawer. */
const DESKTOP_QUERY = "(min-width: 1024px)";

/** Is the viewport in the docked-panel (lg+) range? */
function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY);
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return isDesktop;
}

/**
 * Children mount once the panel has been opened (via effect — one frame
 * after the open animation starts) and stay mounted forever after.
 *
 * Deliberately NO render-time "adjust state when a prop changes"
 * setState here: the React Compiler (on by default in Next.js 16)
 * mis-compiles that pattern (set state during render from an inlined
 * custom hook) and silently drops the update — the panel would open with
 * an empty shell. Effect-based state (like useResizableSidebar's stored
 * width) compiles and runs correctly.
 */
function useMountedOnceOpen(open: boolean) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (!open) return;
    // Mount children one frame after the open animation starts. The setState
    // lives inside the rAF callback (never synchronously in the effect body)
    // so the react-compiler lint is satisfied; once mounted it stays mounted
    // forever — there is no setMounted(false) anywhere, so the close
    // animation always has content and panel state survives toggles.
    const raf = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(raf);
  }, [open]);
  return mounted;
}

interface DockedPanelProps {
  /** Panel element id — referenced by the header toggle's aria-controls. */
  id: string;
  /** Accessible name ("Subagent chat", "Files", …). */
  label: string;
  open: boolean;
  onClose: () => void;
  /** localStorage key for the persisted width (keep the legacy keys). */
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  children: React.ReactNode;
  /** Render a floating close button inside the mobile drawer (for panels
   *  whose content has no close affordance of its own). */
  sheetCloseButton?: boolean;
  /** Extra classes for the mobile SheetContent (width, e.g. w-[85vw]). */
  sheetClassName?: string;
}

export function DockedPanel({
  id,
  label,
  open,
  onClose,
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  children,
  sheetCloseButton = false,
  sheetClassName,
}: DockedPanelProps) {
  const isDesktop = useIsDesktop();
  const [width, setWidth] = useResizableSidebar(storageKey, defaultWidth, minWidth, maxWidth);
  const [dragging, setDragging] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const contentMounted = useMountedOnceOpen(open);

  // Closing must never leave focus inside the (now inert) panel.
  useEffect(() => {
    if (open) return;
    const panel = panelRef.current;
    if (panel && panel.contains(document.activeElement)) {
      (document.activeElement as HTMLElement | null)?.blur();
    }
  }, [open]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setDragging(true);
      const startX = e.clientX;
      const startWidth = width;
      const handleMouseMove = (moveEvent: MouseEvent) => {
        const delta = startX - moveEvent.clientX;
        setWidth(startWidth + delta);
      };
      const handleMouseUp = () => {
        setDragging(false);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [width, setWidth],
  );

  // Keyboard resize is intentionally not on the sash itself (jsx-a11y
  // flags role=separator + tabindex); the collapse chevron next to it is
  // the keyboard-operable affordance, matching the conversation sidebar's
  // handle pattern used across the app.

  return (
    <>
      {/* Docked desktop column — always in the DOM (it is the aria-controls
          target of the header toggle); `hidden lg:block` keeps it out of the
          mobile layout, where the Sheet below takes over. Its width is the
          animated property, so the main chat column shrinks seamlessly. */}
      <aside
        ref={panelRef}
        id={id}
        aria-label={label}
        aria-hidden={!open}
        inert={!open}
        data-dragging={dragging}
        className="docked-panel relative hidden shrink-0 overflow-hidden lg:block"
        style={{ width: open ? width : 0 }}
      >
        {/* Fixed-width inner column — the content never reflows while the
            outer aside animates its width; the outer clips it edge-to-edge
            so the panel hugs the viewport with just its hairline. */}
        <div
          className="border-border flex h-full flex-col border-l"
          style={{ width }}
        >
          {isDesktop && contentMounted ? children : null}
        </div>

        {/* Resize handle — the panel's left edge (same sash pattern as
            the conversation sidebar's handle). */}
        {open && (
          <div
            onMouseDown={handleMouseDown}
            className="hover:bg-primary/40 absolute inset-y-0 left-0 z-40 w-1 cursor-col-resize transition-colors"
            role="separator"
            aria-orientation="vertical"
            aria-label={`Resize ${label}`}
          >
            {/* Invisible wider hit area for easier grabbing */}
            <div className="absolute inset-y-0 -inset-x-2" />
          </div>
        )}

        {/* Compact collapse chevron — docked on the panel's edge; closing
            animates the width back smoothly. */}
        {isDesktop && contentMounted && (
          <button
            type="button"
            onClick={onClose}
            title="Collapse panel"
            aria-label={`Collapse ${label}`}
            aria-controls={id}
            className="bg-card text-muted-foreground hover:text-foreground absolute top-1/2 left-0 z-50 flex h-12 w-[18px] -translate-y-1/2 items-center justify-center rounded-r-md border border-l-0 border-border shadow-sm transition-colors hover:bg-accent"
          >
            <ChevronsRight className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
      </aside>

      {/* Mobile drawer (< lg) — full height, hugging the right edge. */}
      {!isDesktop && (
        <Sheet
          open={open}
          onOpenChange={(o) => {
            if (!o) onClose();
          }}
        >
          <SheetContent
            side="right"
            className={cn("border-border flex flex-col border-l p-0", sheetClassName)}
          >
            {sheetCloseButton && (
              <button
                type="button"
                onClick={onClose}
                aria-label={`Close ${label}`}
                title="Close"
                className="bg-background/80 text-foreground/60 hover:bg-foreground/5 hover:text-foreground absolute top-2 right-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-md backdrop-blur-sm transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            )}
            {children}
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}

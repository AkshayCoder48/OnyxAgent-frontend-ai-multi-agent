"use client";

import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ChevronsRight, X } from "lucide-react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useResizableSidebar } from "@/components/ui/resize-handle";
import { cn } from "@/lib/utils";

/**
 * DockedPanel — a right-hand panel that is a REAL part of the layout, not a
 * floating overlay (PRD §16/§17).
 *
 * Desktop (md+, i.e. ≥768px): the panel is an in-flow flex column docked
 * against the right edge of the viewport — it participates in normal layout
 * flow, so the main chat column's width smoothly decreases while it opens
 * (animated width, ~250ms ease-out via the `.docked-panel` class in
 * globals.css; no overlay, no backdrop, no blur). A compact chevron docked
 * on the panel's left edge collapses it; a drag handle on the same edge
 * resizes it. The width persists to localStorage (via useResizableSidebar),
 * so the user's sizing choice survives reloads.
 *
 * SPLIT LAYOUT FROM md (768px) — the split workspace is NOT a ≥1024px-only
 * luxury: the previous `lg` threshold left the whole 768–1023px band
 * (half-maximized windows, small laptops, embedded preview panes) with
 * full-screen overlay drawers that covered the chat — "one tab at a time".
 * From md up, the panel docks beside the chat; the conversation sidebar
 * auto-collapses to its icon rail (see ChatPage) and the panel width is
 * CSS-clamped (`min(width, 100vw - 448px)`) so the chat column NEVER shrinks
 * below ~400px.
 *
 * Mobile (< md): the same content becomes a full-height drawer sliding in
 * from the right edge (scrim + body scroll lock — standard mobile
 * navigation), rendered with the same Sheet primitive the conversation
 * sidebar uses, so it feels part of the navigation system rather than a
 * random floating overlay. keepAlive panels keep their content mounted
 * inside the (hidden) Sheet after the first open, so re-opens are instant.
 *
 * Content lifecycle (see usePanelContent): the open itself is immediate
 * (width transition starts on the tap's next frame); the content mount is
 * deferred one frame and committed inside startTransition so heavy panels
 * never block the animation or input. keepAlive panels stay mounted once
 * opened; the store-backed panels unmount shortly after closing so hidden
 * panels do zero work.
 */

/** Below the md breakpoint the docked column becomes a mobile drawer. */
const DESKTOP_QUERY = "(min-width: 768px)";

/** How long children stay mounted after a close flip — covers the 250ms
 * width/slide exit animation (+ tail) so the panel never visually empties
 * before it finishes animating out. Only used by non-keepAlive panels. */
const CLOSE_GRACE_MS = 320;

/** Space the docked panel must always leave for the rest of the workspace:
 * 48px collapsed conversation rail + a ~400px usable chat column. The
 * panel's rendered width is clamped with CSS `min()` against
 * `calc(100vw - ${PANEL_FIT_RESERVE}px)` so the chat can never be starved,
 * no JS resize listener needed, and browser resizes adapt live. */
const PANEL_FIT_RESERVE = 448;

/** Is the viewport in the docked-panel (md+) range? Lazily initialized from
 *  matchMedia (client) so the FIRST render already knows the branch — no
 *  one-frame mobile-Sheet flash on desktop, no hydration issue (both
 *  branches render null while the panel is closed, which it is at mount). */
function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(DESKTOP_QUERY).matches : false,
  );
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
 * Panel content lifecycle (the zero-lag sidebar contract):
 *
 *   - OPEN is IMMEDIATE: the `open` prop flips in the tap's own render —
 *     the aside's width transition starts painting on the very next frame.
 *     Nothing about opening waits for data, fetches, or the content mount.
 *   - The CONTENT MOUNT is deferred one animation frame and committed inside
 *     `startTransition`, so a heavy first render (Database/File/Preview)
 *     can never block the open animation or input — the shell slides in on
 *     the compositor while React renders the content interruptibly.
 *   - keepAlive panels (Database, Preview — state worth preserving: the
 *     preview IFRAME would reload, the DB panel holds editor/scroll state)
 *     stay mounted forever once opened; closing only animates the shell.
 *   - Non-keepAlive panels (files/timeline/logs/subagents/platforms — all
 *     store/query-backed) unmount CLOSE_GRACE_MS after closing, so their
 *     live subscriptions do ZERO work while the panel is hidden. Their data
 *     lives in stores/React-Query caches, so a re-open rehydrates instantly.
 *
 * Deliberately NO render-time "adjust state when a prop changes" setState
 * here: the React Compiler mis-compiles that pattern and silently drops the
 * update. Effect-based state compiles and runs correctly.
 */
function usePanelContent(open: boolean, keepAlive: boolean) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (open) {
      // One frame after the open flip: the shell's width transition has
      // started painting; now mount the content inside a transition so the
      // commit is interruptible (input/taps keep priority).
      const raf = requestAnimationFrame(() => {
        startTransition(() => {
          setVisible(true);
        });
      });
      return () => cancelAnimationFrame(raf);
    }
    // Closing — keepAlive panels keep their content mounted (state
    // preservation); others hold through the exit animation, then unmount
    // so hidden panels cost nothing.
    if (keepAlive) return;
    const t = window.setTimeout(() => setVisible(false), CLOSE_GRACE_MS);
    return () => window.clearTimeout(t);
  }, [open, keepAlive]);
  return visible;
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
  /** Keep content mounted once the panel has been opened (state-heavy
   *  panels: the preview iframe, the database panel). Non-keepAlive panels
   *  unmount shortly after closing — hidden panels must do zero work. */
  keepAlive?: boolean;
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
  keepAlive = false,
}: DockedPanelProps) {
  const isDesktop = useIsDesktop();
  const [width, setWidth] = useResizableSidebar(storageKey, defaultWidth, minWidth, maxWidth);
  const [dragging, setDragging] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const contentVisible = usePanelContent(open, keepAlive);

  // Closing must never leave focus inside the (now inert) panel.
  useEffect(() => {
    if (open) return;
    const panel = panelRef.current;
    if (panel && panel.contains(document.activeElement)) {
      (document.activeElement as HTMLElement | null)?.blur();
    }
  }, [open]);

  // ESC closes the open desktop panel (PRD §28) — but only when no modal
  // surface (dialog / sheet / popover / command palette) is open: those own
  // the Escape key first. The docked panel is a persistent workspace surface,
  // not a modal, so it must never steal Escape from a focused dialog.
  useEffect(() => {
    if (!open || !isDesktop) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[data-state="open"]')) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, isDesktop, onClose]);

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

  // Viewport-fit width: the user's persisted size, clamped live by CSS so
  // the panel can never push the chat column below ~400px (both the outer
  // animated shell and the fixed inner column use the SAME expression, so
  // the content is never clipped — it reflows to the fitted width).
  const fittedWidth = `min(${width}px, calc(100vw - ${PANEL_FIT_RESERVE}px))`;

  return (
    <>
      {/* Docked desktop column — always in the DOM (it is the aria-controls
          target of the header toggle); `hidden md:block` keeps it out of the
          mobile layout, where the Sheet below takes over. Its width is the
          animated property, so the main chat column shrinks seamlessly. */}
      <aside
        ref={panelRef}
        id={id}
        aria-label={label}
        aria-hidden={!open}
        inert={!open}
        data-dragging={dragging}
        data-open={open}
        className="docked-panel relative hidden shrink-0 overflow-hidden md:block"
        style={{ width: open ? fittedWidth : 0 }}
      >
        {/* Fixed-width inner column — the content never reflows while the
            outer aside animates its width; the outer clips it edge-to-edge
            so the panel hugs the viewport with just its hairline. The inner
            column ALSO translates (slide-in feel): as the outer widens, the
            content slides in from the right edge instead of being revealed
            through a static window — see .docked-panel-inner in globals.css
            (skipped entirely under prefers-reduced-motion). */}
        <div
          className="docked-panel-inner border-border flex h-full flex-col border-l"
          style={{ width: fittedWidth }}
        >
          {isDesktop && contentVisible ? children : null}
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
        {isDesktop && contentVisible && (
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

      {/* Mobile drawer (< md) — full height, hugging the right edge.
          keepAlive panels keep their content mounted inside a hidden Sheet
          after the first open (re-opens are INSTANT — no remount-per-tap);
          non-keepAlive panels unmount with the Sheet after the exit
          animation, same lifecycle as the desktop column. */}
      {!isDesktop && (
        <Sheet
          open={open}
          onOpenChange={(o) => {
            if (!o) onClose();
          }}
          keepMountedOnceOpen={keepAlive}
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
            {contentVisible ? children : null}
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}

"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";

/**
 * Sheet — full-height side drawer (mobile navigation pattern).
 *
 * MOTION (panel-animation fix): entrance slides in from its side with a
 * fade (tw-animate `animate-in slide-in-from-*` — the library is imported
 * in globals.css; before that import these classes were silent no-ops and
 * every overlay appeared instantly). Closing now plays the REVERSED
 * animation instead of a hard unmount: the open→false transition keeps the
 * sheet mounted for the exit duration with `animate-out slide-out-to-*`,
 * then unmounts. The global prefers-reduced-motion rule pins all durations
 * to 0.01ms, so reduced-motion users get an instant (but still clean)
 * close — the delayed unmount just settles the DOM afterwards.
 */

/** Exit duration — matches the `duration-300` on the drawer + scrim. */
const SHEET_EXIT_MS = 300;

/** True while the sheet is playing its closing animation. */
const SheetClosingContext = React.createContext(false);

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  /** ZERO-LAG SIDEBARS: once the sheet has been opened, keep the whole
   *  subtree mounted when closed (hidden via display:none after the exit
   *  animation) instead of unmounting it. Re-opens are then instant — no
   *  remount-per-tap of heavy content (the conversation list, docked
   *  panels). React state, scroll positions and iframes survive toggles;
   *  display:none removes the subtree from layout, paint and the a11y tree,
   *  so the hidden copy costs nothing visually. Use for state-heavy or
   *  heavy-to-remount content whose live work is quiet while hidden. */
  keepMountedOnceOpen?: boolean;
}

interface SheetContentProps {
  children?: React.ReactNode;
  className?: string;
  side?: "left" | "right";
  style?: React.CSSProperties;
  /** Allow arbitrary data-* / aria-* / unknown props to be forwarded. */
  [key: string]: unknown;
}

export function Sheet({
  open,
  onOpenChange,
  children,
  keepMountedOnceOpen = false,
}: SheetProps) {
  // `rendered` keeps the tree mounted through the exit animation; `closing`
  // flips the entrance classes to their exit counterparts. With
  // keepMountedOnceOpen, `rendered` additionally NEVER flips back to false
  // once the sheet has opened — the settled-closed state hides the wrapper
  // with the `hidden` attribute instead (see `settledClosed`).
  const [rendered, setRendered] = React.useState(open);
  const [closing, setClosing] = React.useState(false);
  // Latch: once the sheet has opened at least once, a keepMountedOnceOpen
  // sheet never unmounts again (state, not a ref — ref writes during render
  // are forbidden by react-hooks/refs and this must be readable in the
  // close-timeout effect's closure without a stale-capture risk).
  const [everOpened, setEverOpened] = React.useState(false);
  React.useEffect(() => {
    if (open) setEverOpened(true);
  }, [open]);

  React.useEffect(() => {
    if (open) {
      setRendered(true);
      setClosing(false);
      return;
    }
    // Nothing was shown — nothing to animate out.
    if (!rendered) return;
    // Play the reversed animation, then unmount — unless the caller asked
    // for the mounted-keepalive, in which case the wrapper stays mounted
    // (and gets hidden by `settledClosed` below) and only the closing flag
    // resets.
    setClosing(true);
    const t = window.setTimeout(() => {
      setClosing(false);
      if (!keepMountedOnceOpen || !everOpened) {
        setRendered(false);
      }
    }, SHEET_EXIT_MS);
    return () => window.clearTimeout(t);
  }, [open, rendered, keepMountedOnceOpen, everOpened]);

  // Body scroll lock while the sheet VISIBLE (enter + exit) — NOT while a
  // keepMounted sheet is settled-closed (rendered && !open && !closing).
  const visible = rendered && (open || closing);
  React.useEffect(() => {
    if (!visible) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [visible]);

  if (!rendered) return null;

  // Settled-closed keepMounted state: exit animation finished, wrapper
  // hidden from layout/paint/a11y but the React tree stays alive.
  const settledClosed = keepMountedOnceOpen && !open && !closing;

  return (
    <SheetClosingContext.Provider value={closing}>
      <div className="fixed inset-0 z-50" hidden={settledClosed || undefined}>
        <div
          className={cn(
            "fixed inset-0 bg-black/50 backdrop-blur-sm",
            closing ? "animate-out fade-out duration-300" : "animate-in fade-in duration-300",
          )}
          onClick={() => onOpenChange(false)}
          aria-hidden="true"
        />
        {children}
      </div>
    </SheetClosingContext.Provider>
  );
}

export function SheetContent({ children, className, side = "left" }: SheetContentProps) {
  const closing = React.useContext(SheetClosingContext);
  return (
    <div
      className={cn(
        "bg-background fixed inset-y-0 z-50 flex w-72 flex-col shadow-lg",
        closing
          ? `animate-out duration-300 ${side === "left" ? "slide-out-to-left left-0" : "slide-out-to-right right-0"}`
          : `animate-in duration-300 ${side === "left" ? "slide-in-from-left left-0" : "slide-in-from-right right-0"}`,
        className,
      )}
    >
      {children}
    </div>
  );
}

/** SheetBody — flex-1 + min-h-0 wrapper so the body scrolls inside the sheet
 *  while the header (and optional footer) stay pinned. Use this when the
 *  sheet content is taller than the viewport. */
export function SheetBody({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-h-0 flex-1 overflow-hidden", className)}>
      {children}
    </div>
  );
}

export function SheetHeader({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between border-b p-4", className)}>
      {children}
    </div>
  );
}

export function SheetTitle({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return <h2 className={cn("text-lg font-semibold", className)}>{children}</h2>;
}

export function SheetClose({ onClick, className }: { onClick?: () => void; className?: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "ring-offset-background rounded-sm opacity-70 transition-opacity",
        "focus:ring-ring hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-none",
        "flex h-10 w-10 items-center justify-center",
        className,
      )}
    >
      <X className="h-5 w-5" />
      <span className="sr-only">Close</span>
    </button>
  );
}

/** Description text rendered inside a Sheet header (typically sr-only for a11y). */
export function SheetDescription({
  children,
  className,
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return <p className={cn("text-sm text-muted-foreground", className)}>{children}</p>;
}

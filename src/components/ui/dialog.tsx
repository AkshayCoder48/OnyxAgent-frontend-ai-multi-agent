"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useModalViewport } from "@/hooks/use-modal-viewport";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 [background-color:var(--glass-scrim)]",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

/**
 * GLOBAL MODAL POSITIONING SYSTEM — every dialog in the app renders through
 * this one component:
 *
 *  · CENTERED ON EVERY VIEWPORT (Dialog Positioning PRD, 2026-11-14): the
 *    old mobile bottom-sheet behavior is gone — standard dialogs open at
 *    the center of the VISIBLE viewport on mobile too, never anchored to
 *    the bottom edge (bottom sheets are the Drawer's job, and they stay).
 *  · NEVER outside the visible viewport: the height cap is the VISUAL
 *    viewport (`--vvh`, written by useModalViewport; CSS falls back to
 *    100dvh → 100vh chain when JS is unavailable) minus a breathing margin
 *    AND both safe-area insets — centered, so clearance is symmetric.
 *  · Keyboard-aware while centered: `translate-y(-50% - --kb-shift/2)` keeps
 *    the card centered in the area ABOVE the on-screen keyboard (the hook
 *    halves the lift), and tall content scrolls inside (DialogBody) — the
 *    dialog never ends up underneath the keyboard.
 *  · flex-column anatomy: header (shrink-0) · DialogBody (flex-1, the ONLY
 *    designed scroll region) · footer (shrink-0) — long content scrolls
 *    INSIDE the dialog, the header and footer stay reachable.
 *  · CLIP SAFETY NET: the content element itself is overflow-y-auto. Raw
 *    (non-DialogBody) content that outgrows the cap scrolls instead of
 *    being clipped — no dialog can trap a field off-screen.
 *  · Entrance: fade + zoom-in-95 over 200ms from the CENTERED position
 *    (never animating up from the bottom edge).
 *  · Body scroll is locked while open; background never scrolls behind.
 */
const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, forwardedRef) => {
  const innerRef = React.useRef<HTMLDivElement | null>(null);
  const setRefs = React.useCallback(
    (node: HTMLDivElement | null) => {
      innerRef.current = node;
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef)
        (forwardedRef as React.MutableRefObject<HTMLDivElement | null>).current =
          node;
    },
    [forwardedRef],
  );
  useModalViewport(innerRef);

  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={setRefs}
        className={cn(
          // Base chrome + CENTERED geometry on EVERY viewport (mobile
          // included — no bottom sheet): left/top 50% + negative translates,
          // width capped to viewport minus 2rem gutters, height capped to
          // the VISUAL viewport minus a 2rem breathing margin and both
          // safe-area insets (centered, so the clearance is symmetric).
          // While the keyboard is up, --kb-shift re-centers the card in
          // the visible area above it.
          "bg-background text-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-1/2 left-1/2 z-50 flex max-h-[calc(var(--vvh,100dvh)-2rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-[calc(-50%-var(--kb-shift,0px))] flex-col gap-4 overflow-x-hidden overflow-y-auto overscroll-contain rounded-2xl border p-5 shadow-lg duration-200 [-webkit-overflow-scrolling:touch]",
          // sm+: the same centered card with roomier padding.
          "sm:p-6 sm:pb-6",
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="ring-offset-background focus:ring-ring data-[state=open]:bg-accent data-[state=open]:text-muted-foreground absolute top-4 right-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-none disabled:pointer-events-none">
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex shrink-0 flex-col space-y-1.5 text-center sm:text-left", className)}
      {...props}
    />
  );
}

/**
 * DialogBody — the ONE scrollable region of a dialog. Long content goes
 * here; the header above and the footer below stay pinned and reachable.
 * (flex: 1 + min-height: 0 inside the dialog's flex column, with contained
 * overscroll so touch scrolling never escapes to the page behind.)
 */
function DialogBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]",
        className,
      )}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex shrink-0 flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-lg leading-none font-semibold tracking-tight", className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-muted-foreground text-sm", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};

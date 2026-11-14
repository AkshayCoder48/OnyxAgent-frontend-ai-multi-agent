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
 * this one component (Modal Viewport & Responsive Positioning PRD):
 *
 *  · NEVER outside the visible viewport: the height cap is the VISUAL
 *    viewport (`--vvh`, written by useModalViewport; CSS falls back to
 *    100dvh → 100vh chain when JS is unavailable).
 *  · Mobile (<sm): a BOTTOM SHEET anchored above the keyboard
 *    (`bottom: var(--kb-lift, 0px)`), safe-area padded, never wider than
 *    the screen.
 *  · sm+: the classic centered card, capped at 85% of the visual viewport
 *    and shifted up by half the keyboard gap while typing.
 *  · flex-column anatomy: header (shrink-0) · DialogBody (flex-1, the ONLY
 *    scroll region) · footer (shrink-0) — long content scrolls INSIDE the
 *    dialog, the header and footer stay reachable.
 *  · CLIP SAFETY NET (2026-11-14, "dialogs at the bottom are not
 *    accessible"): the content element itself is overflow-y-auto. Dialogs
 *    that route their content through DialogBody never overflow the outer
 *    box (the inner region scrolls first), but dialogs with raw children
 *    used to get their tall content CLIPPED by overflow-hidden with no way
 *    to reach the fields below the fold. Now ANY content taller than the
 *    cap scrolls — no dialog can trap a field off-screen again.
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
          "bg-background text-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed inset-x-0 z-50 flex w-full flex-col gap-4 overflow-x-hidden overflow-y-auto overscroll-contain rounded-t-2xl border shadow-lg duration-200 [-webkit-overflow-scrolling:touch]",
          // Mobile bottom sheet: capped to the VISUAL viewport (keyboard +
          // address-bar aware), lifted above the keyboard while typing,
          // safe-area padded at the bottom edge.
          "bottom-[var(--kb-lift,0px)] max-h-[min(92dvh,calc(var(--vvh,100dvh)-12px))] p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]",
          // sm+: centered card with horizontal breathing room, capped at
          // 85% of the visual viewport, shifted up by half the keyboard gap.
          "sm:top-[50%] sm:bottom-auto sm:left-1/2 sm:w-[calc(100vw-2rem)] sm:max-w-lg sm:max-h-[min(85vh,calc(var(--vvh,100dvh)-32px))] sm:translate-x-[-50%] sm:translate-y-[calc(-50%-var(--kb-shift,0px))] sm:rounded-2xl sm:p-6 sm:pb-6",
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

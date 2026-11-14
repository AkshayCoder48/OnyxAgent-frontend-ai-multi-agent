"use client";

import * as React from "react";

/**
 * GLOBAL MODAL VIEWPORT SYSTEM (Modal Viewport & Responsive Positioning PRD).
 *
 * One hook every modal primitive (Dialog, AlertDialog) mounts on its content
 * element. It provides, via CSS custom properties written DIRECTLY on the
 * element (no React re-renders — PRD §11):
 *
 *   --vvh       the visual viewport height in px (falls back to 100dvh in
 *               CSS when unset — SSR, no-JS, older browsers).
 *   --kb-shift  half the keyboard gap, for the CENTERED dialog geometry:
 *               the card's translate-y subtracts it, keeping the card
 *               centered in the VISIBLE area above the on-screen keyboard
 *               (0 when no keyboard / no focused text field inside this
 *               modal). Written only while a text field inside the modal
 *               holds focus and the viewport gap is really a keyboard.
 *   --kb-lift   the full keyboard gap in px — kept as the raw value
 *               --kb-shift derives from (and for debugging); the centered
 *               dialogs consume only --kb-shift.
 *
 * Listeners: visualViewport resize/scroll + window resize + focusin/focusout,
 * all coalesced into ONE requestAnimationFrame per burst. The listeners live
 * only while the modal is mounted — nothing polls when no modal is open.
 *
 * The same mount acquires the BODY SCROLL LOCK (counted, so nested modals
 * never unlock early) with scrollbar-width compensation so centered layouts
 * don't shift when the scrollbar disappears.
 */

/** Text-ish fields whose focus implies the virtual keyboard is wanted. */
const TEXT_INPUT_SELECTOR =
  'input, textarea, select, [contenteditable="true"], [contenteditable=""]';

// ── body scroll lock (counted) ──────────────────────────────────────────────

let lockCount = 0;
let savedOverflow = "";
let savedPaddingRight = "";

function lockBodyScroll(): () => void {
  if (typeof document === "undefined") return () => {};
  if (lockCount === 0) {
    const body = document.body;
    savedOverflow = body.style.overflow;
    savedPaddingRight = body.style.paddingRight;
    const scrollbarGap =
      window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = "hidden";
    if (scrollbarGap > 0) body.style.paddingRight = `${scrollbarGap}px`;
  }
  lockCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lockCount = Math.max(0, lockCount - 1);
    if (lockCount === 0) {
      document.body.style.overflow = savedOverflow;
      document.body.style.paddingRight = savedPaddingRight;
    }
  };
}

/**
 * Mount the viewport-tracking + scroll-lock behavior on a modal content
 * element. `ref` must point at the element the CSS vars are consumed on.
 */
export function useModalViewport(
  ref: React.RefObject<HTMLElement | null>,
): void {
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const release = lockBodyScroll();

    const vv =
      typeof window !== "undefined" ? window.visualViewport : undefined;
    let raf = 0;

    const update = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        const height = vv ? vv.height : window.innerHeight;
        el.style.setProperty("--vvh", `${Math.round(height)}px`);

        // Keyboard lift — only while a text field INSIDE this modal holds
        // focus AND the visual viewport is meaningfully shorter than the
        // layout viewport (the keyboard gap). Anything ≤72px is treated as
        // browser chrome noise, not a keyboard.
        let lift = 0;
        if (vv) {
          const gap = window.innerHeight - vv.height - vv.offsetTop;
          if (gap > 72) {
            const active = document.activeElement as HTMLElement | null;
            const wantsKeyboard =
              !!active &&
              el.contains(active) &&
              typeof active.closest === "function" &&
              active.closest(TEXT_INPUT_SELECTOR) != null;
            if (wantsKeyboard) lift = Math.round(gap + 8);
          }
        }
        el.style.setProperty("--kb-lift", `${lift}px`);
        el.style.setProperty("--kb-shift", `${Math.round(lift / 2)}px`);
      });
    };

    update();
    window.addEventListener("resize", update, { passive: true });
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    if (vv) {
      vv.addEventListener("resize", update);
      vv.addEventListener("scroll", update);
    }

    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
      if (vv) {
        vv.removeEventListener("resize", update);
        vv.removeEventListener("scroll", update);
      }
      el.style.removeProperty("--vvh");
      el.style.removeProperty("--kb-lift");
      el.style.removeProperty("--kb-shift");
      release();
    };
  }, [ref]);
}

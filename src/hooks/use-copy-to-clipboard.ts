"use client";

import { useCallback, useRef, useState } from "react";

/**
 * Legacy clipboard fallback for browsers / non-secure contexts where the
 * async Clipboard API is unavailable (http previews, older WebViews).
 * Uses a transient off-screen textarea + execCommand("copy").
 */
function legacyCopy(text: string): boolean {
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    // Avoid scrolling to bottom on focus — position off-screen.
    textarea.style.position = "fixed";
    textarea.style.top = "-1000px";
    textarea.style.opacity = "0";
    textarea.setAttribute("readonly", "");
    textarea.setAttribute("aria-hidden", "true");
    document.body.appendChild(textarea);
    const selection = document.getSelection();
    const previousRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    // Restore the user's previous selection so the copy doesn't clobber it.
    if (previousRange && selection) {
      selection.removeAllRanges();
      selection.addRange(previousRange);
    }
    return ok;
  } catch {
    return false;
  }
}

export function useCopyToClipboard(resetMs = 2000) {
  const [copied, setCopied] = useState(false);
  /** True while a clipboard write is in flight — rapid repeated taps are
   *  ignored instead of stacking confirmation timers (PRD §4). */
  const inFlightRef = useRef(false);
  /** Timer handle for the "copied" reset so a second successful copy can
   *  restart the window cleanly. */
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      if (inFlightRef.current) return false; // ignore double-tap while writing
      inFlightRef.current = true;
      let ok = false;
      try {
        if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
          try {
            await navigator.clipboard.writeText(text);
            ok = true;
          } catch {
            // Rejected promise (permission denied / document not focused) —
            // fall through to the legacy path before giving up.
            ok = legacyCopy(text);
          }
        } else {
          ok = legacyCopy(text);
        }
      } finally {
        inFlightRef.current = false;
      }

      // CONFIRM ONLY ON SUCCESS: the check icon is a claim that the clipboard
      // actually holds the text — never show it when the write failed.
      if (ok && text.length > 0) {
        setCopied(true);
        if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
        resetTimerRef.current = setTimeout(() => setCopied(false), resetMs);
      }
      return ok;
    },
    [resetMs],
  );

  return { copy, copied };
}

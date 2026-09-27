"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Quote, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ghostButtonClass, monoLabelClass } from "./surfaces";

/**
 * QuoteReply — the assistant-ui "quote" element, runtime selection variant
 * (Terra retheme). Two pieces:
 *
 *  - `SelectionToolbar` — a floating toolbar that appears whenever the user
 *    selects text inside an ancestor marked `data-quoteable="true"` (message
 *    containers carry the attribute). Picking "Quote" hands the trimmed
 *    selection to `onQuote` (typically `useQuoteStore.setQuote`).
 *  - `ComposerQuotePreview` — the inset block rendered above the composer
 *    input while a quote is set, with a dismiss control.
 *
 * The static (pre-composed) quote variant is intentionally not provided —
 * the runtime selection flow above is the whole feature.
 */

/** Ideal toolbar anchor: the selection's top edge + the point to center on. */
interface ToolbarAnchor {
  top: number;
  centerX: number;
}

/** Viewport margin (px) the floating toolbar keeps when clamped. */
const VIEWPORT_MARGIN = 8;
/** Debounce for document `selectionchange` — it fires continuously on drags. */
const SELECTION_DEBOUNCE_MS = 150;

export function SelectionToolbar({ onQuote }: { onQuote?: (quotedText: string) => void }) {
  // Ideal anchor from the live selection; null = hidden.
  const [anchor, setAnchor] = React.useState<ToolbarAnchor | null>(null);
  // Measured, viewport-clamped placement, paired to the anchor it measured
  // (object identity) so a stale clamp never bleeds into a new position.
  const [placed, setPlaced] = React.useState<{
    for: ToolbarAnchor;
    top: number;
    left: number;
  } | null>(null);
  const toolbarRef = React.useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = React.useState(false);

  // Portal target (document.body) only exists after hydration.
  React.useEffect(() => {
    setMounted(true);
  }, []);

  // Read the live selection: show the toolbar above it when the selection is
  // non-empty AND both of its ends live inside a [data-quoteable] container.
  const updateFromSelection = React.useCallback(() => {
    const selection = window.getSelection();
    if (
      !selection ||
      selection.rangeCount === 0 ||
      selection.isCollapsed ||
      selection.toString().trim().length === 0
    ) {
      setAnchor(null);
      return;
    }
    if (!isInsideQuoteable(selection.anchorNode) || !isInsideQuoteable(selection.focusNode)) {
      setAnchor(null);
      return;
    }
    const range = selection.getRangeAt(0);
    let rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      // Zero-size rect (odd node shapes) — collapse to the start container's
      // element box instead.
      const startEl = elementOf(range.startContainer);
      if (startEl) rect = startEl.getBoundingClientRect();
    }
    if (rect.width === 0 && rect.height === 0) {
      setAnchor(null);
      return;
    }
    setAnchor({ top: rect.top, centerX: rect.left + rect.width / 2 });
  }, []);

  // Measure the rendered toolbar and clamp it into the viewport (8px
  // margins), keeping it above the selection start. Paired to `anchor` so
  // re-renders with an unchanged position keep their clamp.
  React.useEffect(() => {
    const el = toolbarRef.current;
    if (!anchor || !el) {
      setPlaced(null);
      return;
    }
    const half = el.offsetWidth / 2;
    const minLeft = VIEWPORT_MARGIN + half;
    const maxLeft = Math.max(window.innerWidth - VIEWPORT_MARGIN - half, minLeft);
    const left = Math.min(Math.max(anchor.centerX, minLeft), maxLeft);
    const top = Math.max(anchor.top - VIEWPORT_MARGIN, VIEWPORT_MARGIN + el.offsetHeight);
    setPlaced({ for: anchor, top, left });
  }, [anchor]);

  // Listeners: mouse + keyboard selection, debounced selectionchange, and
  // the hide triggers (scroll anywhere, resize, Escape, collapse).
  React.useEffect(() => {
    const hide = () => setAnchor(null);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onSelectionChange = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(updateFromSelection, SELECTION_DEBOUNCE_MS);
    };
    const onMouseUp = (e: MouseEvent) => {
      // Interactions inside our own toolbar (the Quote button) are handled
      // by the button itself — don't let them look like "click elsewhere".
      if (toolbarRef.current && e.target instanceof Node && toolbarRef.current.contains(e.target)) {
        return;
      }
      updateFromSelection();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      // Escape hides on keydown; ignore its keyup so it can't re-show.
      if (e.key === "Escape") return;
      updateFromSelection();
    };

    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("keydown", onKeyDown);
    // Capture: any scroll — window or a nested container — hides the toolbar.
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);

    return () => {
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [updateFromSelection]);

  const handleQuote = () => {
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? "";
    selection?.removeAllRanges(); // clear the selection
    setAnchor(null); // and hide the toolbar
    if (text) onQuote?.(text);
  };

  if (!mounted || !anchor) return null;

  // Prefer the measured clamp; fall back to the ideal for the first frame
  // (identical whenever no clamping is needed, which is the common case).
  const measurement = placed !== null && placed.for === anchor ? placed : null;
  const top = measurement ? measurement.top : Math.max(anchor.top - VIEWPORT_MARGIN, VIEWPORT_MARGIN);
  const left = measurement ? measurement.left : anchor.centerX;

  return createPortal(
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label="Quote selected text"
      className="quote-toolbar-in fixed z-50 flex items-center rounded-lg border border-border bg-background px-1 py-0.5 shadow-lg"
      style={{ top, left }}
    >
      <button
        type="button"
        // Keep the selection alive while the button is pressed (mousedown
        // would otherwise collapse it before the click lands).
        onMouseDown={(e) => e.preventDefault()}
        onClick={handleQuote}
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-foreground/85 transition-colors hover:bg-foreground/5 hover:text-foreground"
      >
        <Quote className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
        Quote
      </button>
    </div>,
    document.body,
  );
}

export function ComposerQuotePreview({
  quote,
  onDismiss,
  className,
}: {
  quote: { text: string } | null;
  onDismiss: () => void;
  className?: string;
}) {
  if (!quote) return null;

  return (
    <div
      data-slot="composer-quote-preview"
      className={cn(
        "animate-fade-in flex items-start gap-2 rounded-lg border border-border border-l-2 border-l-primary bg-muted/50 px-3 py-2",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <span className={monoLabelClass}>Quoted text</span>
        <p className="mt-0.5 line-clamp-3 text-xs leading-relaxed break-words text-foreground/80">
          {quote.text}
        </p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Remove quote"
        className={cn(ghostButtonClass, "mt-0.5 shrink-0")}
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

/** The closest Element for a node (itself for elements, parent otherwise). */
function elementOf(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/** True when the node sits inside an ancestor marked data-quoteable
 *  (any value except an explicit "false"). */
function isInsideQuoteable(node: Node | null): boolean {
  const el = elementOf(node);
  if (!el) return false;
  const quoteable = el.closest("[data-quoteable]");
  return quoteable !== null && quoteable.getAttribute("data-quoteable") !== "false";
}

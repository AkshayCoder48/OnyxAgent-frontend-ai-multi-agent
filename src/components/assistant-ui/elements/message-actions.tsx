"use client";

import * as React from "react";
import {
  Check,
  Copy,
  MoreHorizontal,
  RotateCcw,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ghostButtonClass, iconSwapClass, iconSwapInClass } from "./surfaces";

/**
 * MessageActions — the assistant-ui "Message actions" element (Terra retheme).
 *
 * The action row under an assistant reply: copy, thumbs up / down, regenerate,
 * and a catch-all more button. Fully controlled (standalone lane — no runtime
 * or provider required): the caller holds every piece of state each button
 * reflects and the callbacks it fires.
 *
 * Each action confirms its own outcome IN PLACE rather than with a toast:
 *  - copy swaps its icon (iconSwap cross-fade), tints emerald, and its label
 *    becomes "Copied response" while `copied` is true;
 *  - the two rating buttons are `aria-pressed` toggles and mutually exclusive
 *    — pressing the active one again calls onReactionChange(null) to clear
 *    it, pressing the other switches straight over;
 *  - the regenerate icon spins while `regenerating` is true;
 *  - `onMore` fires on click with NO built-in menu attached — open your own
 *    popover / dropdown from your component tree when it's called.
 *
 * Theme compatibility: every color is a semantic token (muted-foreground /
 * foreground / primary), so the row restyles itself under every appearance
 * color in the app. The only literal is the copy-success emerald tint from
 * the element spec (emerald-600 / dark emerald-400 — readable on every
 * canvas, same pair CopyButton already uses for the identical state).
 */

export type Reaction = "up" | "down" | null;

export interface MessageActionsProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "children"> {
  /** Shows the check mark + emerald tint on the copy button. */
  copied: boolean;
  /** Which rating button, if any, reads as pressed. */
  reaction: Reaction;
  /** Spins the regenerate icon. */
  regenerating: boolean;
  /** Called when the copy button is pressed. */
  onCopy: () => void;
  /** Called with the next reaction; null when the active one is pressed again. */
  onReactionChange: (reaction: Reaction) => void;
  /** Called when the regenerate button is pressed. */
  onRegenerate: () => void;
  /** Called when the more button is pressed (no built-in menu attached). */
  onMore: () => void;
}

export function MessageActions({
  copied,
  reaction,
  regenerating,
  onCopy,
  onReactionChange,
  onRegenerate,
  onMore,
  className,
  ...props
}: MessageActionsProps) {
  return (
    <div
      data-slot="message-actions"
      className={cn("flex items-center gap-0.5", className)}
      {...props}
    >
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? "Copied response" : "Copy response"}
        title={copied ? "Copied" : "Copy"}
        className={cn(
          ghostButtonClass,
          "h-7 w-7",
          copied && "text-emerald-600 dark:text-emerald-400",
        )}
      >
        {/* Icon swap: the key change remounts the glyph through the
            iconSwapIn entrance so the copy → check transition animates. */}
        <span key={copied ? "check" : "copy"} className={iconSwapClass}>
          <span className={iconSwapInClass}>
            {copied ? (
              <Check className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden />
            )}
          </span>
        </span>
      </button>

      <button
        type="button"
        onClick={() => onReactionChange(reaction === "up" ? null : "up")}
        aria-pressed={reaction === "up"}
        aria-label="Mark response helpful"
        title="Helpful"
        className={cn(
          ghostButtonClass,
          "h-7 w-7",
          reaction === "up" && "text-primary hover:text-primary",
        )}
      >
        <ThumbsUp
          className={cn("h-3.5 w-3.5", reaction === "up" && "fill-primary/25")}
          aria-hidden
        />
      </button>

      <button
        type="button"
        onClick={() => onReactionChange(reaction === "down" ? null : "down")}
        aria-pressed={reaction === "down"}
        aria-label="Mark response unhelpful"
        title="Not helpful"
        className={cn(
          ghostButtonClass,
          "h-7 w-7",
          reaction === "down" && "text-primary hover:text-primary",
        )}
      >
        <ThumbsDown
          className={cn("h-3.5 w-3.5", reaction === "down" && "fill-primary/25")}
          aria-hidden
        />
      </button>

      <button
        type="button"
        onClick={onRegenerate}
        aria-label="Regenerate response"
        title="Regenerate"
        disabled={regenerating}
        className={cn(
          ghostButtonClass,
          "h-7 w-7",
          regenerating && "text-primary",
        )}
      >
        <RotateCcw
          className={cn("h-3.5 w-3.5", regenerating && "animate-spin")}
          aria-hidden
        />
      </button>

      <button
        type="button"
        onClick={onMore}
        aria-label="More response actions"
        aria-haspopup="menu"
        title="More"
        className={cn(ghostButtonClass, "h-7 w-7")}
      >
        <MoreHorizontal className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}

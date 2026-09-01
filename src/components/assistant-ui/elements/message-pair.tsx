"use client";

import * as React from "react";
import { Copy, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { ghostButtonClass } from "./surfaces";

/**
 * MessagePair — one turn of a conversation: the message you sent, and the
 * reply landing beneath it with copy/regenerate tucked away until hover.
 * `variant="bubble"` wraps the sent message in the app's soft-terracotta
 * user card; `variant="flat"` sets it as plain right-aligned text
 * (assistant-ui `elements-message-pair` recipe, Terra retheme — the newest
 * words tint terracotta while streaming, not blue).
 */
export function MessagePair({
  userMessage,
  words,
  visibleWords,
  streaming,
  variant = "bubble",
  className,
  ...props
}: {
  userMessage: string;
  words: readonly string[];
  visibleWords: number;
  streaming: boolean;
  variant?: "bubble" | "flat";
  className?: string;
} & Omit<React.ComponentPropsWithoutRef<"div">, "children">) {
  const shown = Math.max(0, Math.min(Math.floor(visibleWords) || 0, words.length));

  return (
    <div data-slot="message-pair" className={cn("max-w-2xl space-y-2", className)} {...props}>
      {variant === "bubble" ? (
        <p
          className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-tr-sm border px-3.5 py-2 text-sm break-words"
          style={{
            backgroundColor: "var(--chat-user-bg)",
            borderColor: "var(--chat-user-border)",
            color: "var(--chat-user-fg)",
          }}
        >
          {userMessage}
        </p>
      ) : (
        <p className="text-right text-sm text-foreground/80">{userMessage}</p>
      )}
      <div className="group">
        <p className="text-sm leading-relaxed text-foreground">
          {words.slice(0, shown).map((word, i) => {
            const isFresh = streaming && i >= shown - 2;
            return (
              <React.Fragment key={i}>
                <span
                  className={cn(
                    "animate-[line-in_0.25s_ease-out_both] transition-colors duration-700",
                    isFresh ? "text-primary" : "text-foreground",
                  )}
                >
                  {word}
                </span>{" "}
              </React.Fragment>
            );
          })}
          {streaming && shown > 0 && (
            <span
              aria-hidden
              className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse bg-primary align-middle"
            />
          )}
        </p>
        <div className="mt-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <button type="button" aria-label="Copy reply" title="Copy" className={ghostButtonClass}>
            <Copy className="h-3.5 w-3.5" />
          </button>
          <button type="button" aria-label="Regenerate" title="Regenerate" className={ghostButtonClass}>
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

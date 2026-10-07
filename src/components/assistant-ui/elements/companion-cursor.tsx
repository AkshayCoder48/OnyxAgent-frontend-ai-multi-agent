"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * CompanionCursor — THE companion, as the user specced it: a cute little
 * face that rides INLINE right after the LATEST STREAMED LETTER and acts as
 * the living caret while the assistant writes. Not a floating pet, not a
 * logo — the companion IS the cursor: it sits exactly where the next
 * character will land, gently bobbing, blinking now and then, in the live
 * brand color.
 *
 * Pure CSS life (no JS timers): a soft brand-gradient face with a top
 * sheen, two dark eyes that blink on a slow loop, and a 1.6s breathing
 * bob. `prefers-reduced-motion` freezes it into a static face. Decorative
 * (aria-hidden) — the reading order of the text never includes it.
 *
 * Rendered by MarkdownContent at the streaming tail (the same inline slot
 * the old OrbCursor used) — `streaming-cursor-wrapper` makes the last
 * block inline so the face flows right after the final letter.
 */
export function CompanionCursor({
  size = 15,
  className,
  style,
}: {
  /** Face edge in px. ~1em of body text ≈ 15px. */
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      data-slot="companion-cursor"
      aria-hidden="true"
      className={cn(
        "ml-[0.14em] inline-block shrink-0 select-none align-[-0.18em] leading-none",
        "animate-companion-bob motion-reduce:animate-none",
        className,
      )}
      style={{ width: size, height: size, ...style }}
    >
      {/* The face — brand color with a soft top sheen (follows the live
          brand: --color-primary is restyled by Settings → Appearance). */}
      <span
        className="relative block h-full w-full overflow-hidden rounded-full"
        style={{
          background:
            "linear-gradient(160deg, color-mix(in srgb, var(--color-primary) 82%, white) 0%, var(--color-primary) 55%, color-mix(in srgb, var(--color-primary) 78%, black) 100%)",
          boxShadow:
            "0 0 0 1px color-mix(in srgb, var(--color-primary) 55%, transparent), 0 1px 3px rgb(0 0 0 / 0.18)",
        }}
      >
        {/* Top sheen — the "cute" highlight. */}
        <span
          className="absolute inset-x-[18%] top-[8%] h-[34%] rounded-[50%] bg-white/35"
        />
        {/* Eyes — two dark ovals on the lower half; they blink together on
            the slow companion-blink loop (static under reduced motion). */}
        <span className="animate-companion-blink absolute inset-0 block motion-reduce:animate-none">
          <span
            className="absolute rounded-[50%] bg-[#101418]"
            style={{ left: "26%", top: "48%", width: "13%", height: "26%" }}
          />
          <span
            className="absolute rounded-[50%] bg-[#101418]"
            style={{ right: "26%", top: "48%", width: "13%", height: "26%" }}
          />
        </span>
      </span>
    </span>
  );
}

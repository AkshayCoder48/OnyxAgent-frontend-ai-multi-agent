import type { CSSProperties } from "react";

/**
 * Text shimmer — a moving highlight that sweeps across a line of text.
 * Used by the streaming / reasoning states to show liveness.
 */

export const TEXT_SHIMMER_CLASS_NAME = "onyx-text-shimmer";

export const TEXT_SHIMMER_KEYFRAMES = `
@keyframes onyx-text-shimmer {
  0% {
    background-position: 150% 0;
  }
  100% {
    background-position: -50% 0;
  }
}
`;

/**
 * Inline style that paints the shimmer gradient clipped to the glyphs.
 * Colors follow the APP's theme tokens (muted → foreground → muted) so it
 * reads on both the light and dark palettes — the previous foreign `--ink`
 * tokens never existed here, so the hardcoded fallbacks painted a dull grey
 * that read as invisible on the black canvas (the "caption text goes dull/
 * invisible during shine" bug, Realtime PRD §16).
 */
export function textShimmerStyle(durationSeconds = 2.2): CSSProperties {
  return {
    backgroundImage:
      "linear-gradient(90deg, var(--color-muted-foreground, #8a8f98) 0%, var(--color-foreground, #f5f5f5) 50%, var(--color-muted-foreground, #8a8f98) 100%)",
    backgroundSize: "200% 100%",
    WebkitBackgroundClip: "text",
    backgroundClip: "text",
    color: "transparent",
    WebkitTextFillColor: "transparent",
    animation: `onyx-text-shimmer ${Math.max(0.4, durationSeconds)}s linear infinite`,
  };
}

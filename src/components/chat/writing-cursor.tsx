"use client";

import { useEffect, useState } from "react";

/**
 * WritingCursor — a streaming/writing indicator that renders as a small
 * geometric shape (circle → triangle → square → repeat) INLINE at the end
 * of the streaming text. The shape cycles every ~1.1s with a smooth scale +
 * rotate + opacity morph animation.
 *
 * IMPORTANT RENDERING NOTES:
 * 1. The outer span uses `display: inline` (NOT inline-flex / inline-block)
 *    so it flows inline with the text — sitting right after the last
 *    character, NOT on a new line below it.
 * 2. The inner SVG gets `key={shape}` so React fully remounts it on every
 *    shape change. Without the key, React would only swap the inner
 *    elements and the CSS `writing-cursor-morph` animation would NOT
 *    re-trigger — resulting in the cursor showing only the first shape
 *    (circle) forever.
 *
 * Props:
 *   - size: optional CSS length (default "0.95em" — matches the text cap height)
 *   - className: optional extra classes
 */

const SHAPES = ["circle", "triangle", "square"] as const;
type Shape = (typeof SHAPES)[number];

const SHAPE_DURATION_MS = 1100;

export function WritingCursor({
  size = "0.95em",
  className,
}: {
  size?: string;
  className?: string;
}) {
  const [shapeIndex, setShapeIndex] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setShapeIndex((i) => (i + 1) % SHAPES.length);
    }, SHAPE_DURATION_MS);
    return () => clearInterval(id);
  }, []);

  const shape = SHAPES[shapeIndex]!;

  return (
    <span
      className={`writing-cursor ${className ?? ""}`}
      style={{
        display: "inline",
        width: size,
        height: size,
        marginLeft: "0.1em",
        verticalAlign: "-0.125em",
        lineHeight: 0,
      }}
      role="status"
      aria-label="AI is writing"
    >
      {/* key={shape} forces React to FULLY remount the SVG on each shape
          change, which re-triggers the CSS morph animation. Without this
          key, the animation only plays once and the cursor gets stuck on
          the first shape (circle). */}
      <ShapeSVG key={shape} shape={shape} size={size} />
    </span>
  );
}

/** Inline SVG — one of three geometric shapes. The `key` on the parent
 *  ensures this component remounts on each shape change. */
function ShapeSVG({ shape, size }: { shape: Shape; size: string }) {
  const color = "var(--color-primary, currentColor)";

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="writing-cursor-shape"
      style={{ display: "inline-block", verticalAlign: "baseline" }}
    >
      {shape === "circle" && (
        <circle cx="12" cy="12" r="8" fill={color} opacity="0.85" />
      )}
      {shape === "triangle" && (
        <polygon points="12,3 21,20 3,20" fill={color} opacity="0.85" />
      )}
      {shape === "square" && (
        <rect x="4" y="4" width="16" height="16" rx="3" fill={color} opacity="0.85" />
      )}
    </svg>
  );
}

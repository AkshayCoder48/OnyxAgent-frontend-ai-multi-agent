"use client";

// ONYX 3D LOADER — generated with Onyx Loader Studio.
// Five stacked 4-point stars spinning at staggered delays produce the
// pseudo-3D tunnel. The .onyx-loader / .onyx-layer CSS (keyframes, layer
// sizes and delays, reduced-motion guard) lives ONCE in globals.css —
// this component only feeds the CSS custom properties.

import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

const STAR_PATH =
  "M10 1 L13.1816 6.8184 L19 10 L13.1816 13.1816 L10 19 L6.8184 13.1816 L1 10 L6.8184 6.8184 Z";

export interface OnyxLoaderProps {
  /** Square stage size in px (CSS --loader-size). Studio default: 181. */
  size?: number;
  /** Star color (CSS --loader-color). Pass "currentColor" to follow the
   *  surrounding text color — keeps the loader visible in light theme. */
  color?: string;
  /** Seconds per revolution (CSS --loader-speed). Studio default: 12. */
  speed?: number;
  /** Accessible description announced to screen readers. */
  label?: string;
  className?: string;
}

/** The Onyx 3D star loader. */
export function OnyxLoader({
  size = 181,
  color,
  speed,
  label = "Loading",
  className,
}: OnyxLoaderProps) {
  // Custom properties are not in React's CSSProperties type; the widening
  // below is the standard way to set them from a component.
  const style = {
    "--loader-size": `${size}px`,
    ...(color ? { "--loader-color": color } : {}),
    ...(speed ? { "--loader-speed": `${speed}s` } : {}),
  } as CSSProperties;

  return (
    <div className={cn("onyx-loader", className)} style={style} role="status" aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => (
        <div key={n} className={`onyx-layer onyx-layer-${n}`}>
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" aria-hidden="true">
            {/* fill is overridden to currentColor by .onyx-layer svg * */}
            <path d={STAR_PATH} fill="#FFFFFF" />
          </svg>
        </div>
      ))}
    </div>
  );
}

export default OnyxLoader;

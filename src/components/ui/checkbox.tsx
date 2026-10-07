"use client";

import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { cn } from "@/lib/utils";

/**
 * Tactile green checkbox (Task 8).
 *
 * Adapted from Uiverse (adamgiebl, "checkbox") — a 28px rounded-[10px]
 * plate with layered inset shadows (5px inner shadow + 24px-spread
 * vignette ring + 1px light bevel) and an inner 18px lighter square
 * ("double square", 64% of the plate, raised by a soft drop shadow).
 * Checking floods the box with the theme green: the unchecked 0px green
 * inset ring grows to 2px + 24px (the original's box-shadow "grow-in"
 * fill), a soft ~10px glow appears (`--checkbox-checked-glow`), the
 * inner plate turns white/85 and a check stroke draws on top (SVG
 * pathLength/dashoffset trick, 200ms, instant under
 * prefers-reduced-motion).
 *
 * The stroke is the theme GREEN (darkened 22% via color-mix so it stays
 * readable) on the white/85 plate — the spec asked for a white stroke,
 * but a white check would be invisible on the white inner square; the
 * green stroke keeps the double-square AND a legible check. Indeterminate
 * renders a green dash instead.
 *
 * Built on the Radix Checkbox primitive: controlled
 * `checked`/`onCheckedChange`, `indeterminate`, `disabled`, `id`/`name`/
 * `value` form props, Space/Enter toggle, focus-visible ring (same
 * pattern as the Switch) and aria state all keep working unchanged.
 */
const Checkbox = React.forwardRef<
  React.ComponentRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      // 28×28 tactile plate. The invisible ::before extends the pointer
      // / touch hit area to ≥44×44px without changing the layout box.
      "group relative inline-flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-[10px] bg-[var(--checkbox-surface)] shadow-[var(--checkbox-shadow)] transition-[background-color,box-shadow] duration-300 ease-in-out motion-reduce:transition-none data-[state=checked]:bg-[var(--checkbox-checked)] data-[state=checked]:shadow-[var(--checkbox-shadow-checked)] data-[state=indeterminate]:bg-[var(--checkbox-checked)] data-[state=indeterminate]:shadow-[var(--checkbox-shadow-checked)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 before:absolute before:-inset-2 before:content-['']",
      className,
    )}
    {...props}
  >
    {/* Inner 18px lighter square — the "double square" plate. Neutral
        when unchecked, white/85 when checked/indeterminate. Decorative:
        Radix conveys the state via aria-checked. */}
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-[5px] rounded-[5px] bg-[var(--checkbox-inner)] shadow-[0_6px_6px_rgb(0_0_0_/_0.3)] transition-colors duration-300 ease-in-out motion-reduce:transition-none group-data-[state=checked]:bg-white/85 group-data-[state=indeterminate]:bg-white/85"
    />
    {/* Check stroke (checked) / dash (indeterminate), drawn on the
        plate. The Indicator mounts on checked AND indeterminate, so the
        icons are swapped purely via the root's data-state — works for
        controlled AND uncontrolled usage. The stroke composes
        --checkbox-checked (darkened via color-mix for contrast on the
        white/85 plate) so one green drives fill, glow and glyph. */}
    <CheckboxPrimitive.Indicator className="absolute inset-0 flex items-center justify-center">
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        className="h-3.5 w-3.5 text-[color-mix(in_srgb,var(--checkbox-checked)_78%,black)] group-data-[state=indeterminate]:hidden"
      >
        <path
          d="M5 13l4 4L19 7"
          stroke="currentColor"
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={1}
          strokeDasharray={1}
          className="animate-check-draw motion-reduce:animate-none"
        />
      </svg>
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        className="hidden h-3.5 w-3.5 text-[color-mix(in_srgb,var(--checkbox-checked)_78%,black)] group-data-[state=indeterminate]:block"
      >
        <path
          d="M6 12h12"
          stroke="currentColor"
          strokeWidth={3}
          strokeLinecap="round"
          pathLength={1}
          strokeDasharray={1}
          className="animate-check-draw motion-reduce:animate-none"
        />
      </svg>
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };

"use client";

import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

/**
 * Physical iOS-style toggle (Task 8).
 *
 * Adapted from Uiverse (JaydipPrajapati1910, "switch") — a recessed pill
 * track with inset-shadow depth (`inset 0 4px 6px` style + top highlight)
 * and a hairline border, a raised light thumb carrying two inset "grip"
 * slots, and twin indicator LEDs at the far end of the track (dull red on
 * standby, lit green when active). Rescaled from the original 120×48
 * design to a 48×24 track — the same 24px height as the previous shadcn
 * switch so consumer row layouts don't shift; the extra width buys the
 * thumb a full 19px travel and leaves the LEDs visible beside the parked
 * thumb in the ON state. All colors come from the `--switch-*` CSS
 * variables in globals.css (light + dark values); the ACTIVE track
 * composes `var(--color-primary)` so the live brand color flows through.
 *
 * Built on the Radix Switch primitive: keyboard Space toggle,
 * focus-visible ring (same pattern as the repo's other inputs),
 * controlled `checked`/`onCheckedChange`, `defaultChecked`, `disabled`,
 * form props (`name`/`value`/`required`) and `id` for Label pairing all
 * keep working unchanged. prefers-reduced-motion stands every transition
 * down.
 */
const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      // Track: 48×24 pill. The invisible ::before extends the pointer /
      // touch hit area to ≥44×44px WITHOUT changing the component's
      // layout box, so the ~10 settings consumers keep their exact rows.
      "peer group relative inline-flex h-6 w-12 shrink-0 cursor-pointer items-center rounded-full border border-[var(--switch-border)] bg-[var(--switch-track)] shadow-[var(--switch-shadow-inset)] transition-[background-color,border-color,box-shadow] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none data-[state=checked]:bg-[var(--switch-track-active)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 before:absolute before:-inset-x-[6px] before:-inset-y-[10px] before:content-['']",
      className,
    )}
    {...props}
    ref={ref}
  >
    {/* Twin indicator LEDs at the far (right) end of the track — dull red
        when OFF, green with a soft LED glow when ON. They sit INSIDE the
        track and stay visible in both states: the thumb's 19px travel
        parks it 2px short of them. Decorative — Radix conveys the state
        via role="switch" + aria-checked. */}
    <span
      aria-hidden="true"
      className="pointer-events-none absolute right-[3px] top-1/2 flex -translate-y-1/2 flex-col gap-[3px]"
    >
      <span className="h-1 w-1 rounded-full bg-[var(--switch-indicator)] shadow-[0_0_4px_var(--switch-indicator)] transition-colors duration-200 motion-reduce:transition-none group-data-[state=checked]:bg-[var(--switch-indicator-active)] group-data-[state=checked]:shadow-[0_0_4px_var(--switch-indicator-active)]" />
      <span className="h-1 w-1 rounded-full bg-[var(--switch-indicator)] shadow-[0_0_4px_var(--switch-indicator)] transition-colors duration-200 motion-reduce:transition-none group-data-[state=checked]:bg-[var(--switch-indicator-active)] group-data-[state=checked]:shadow-[0_0_4px_var(--switch-indicator-active)]" />
    </span>
    {/* Raised thumb (drop shadow + top sheen + hairline rim via
        --switch-shadow-thumb) with two inset grip slots, sliding 19px
        when checked. Flow-positioned and vertically centered by the
        track's items-center — only the X translate animates. */}
    <SwitchPrimitives.Thumb
      className={cn(
        "pointer-events-none ml-[2px] flex h-4 w-4 shrink-0 items-center justify-center gap-[2px] rounded-full bg-[var(--switch-thumb)] shadow-[var(--switch-shadow-thumb)] transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none data-[state=checked]:translate-x-[19px] data-[state=unchecked]:translate-x-0",
      )}
    >
      {/* Machined grip slots: transparent spans whose entire look is an
          inset box-shadow (darkened top + hairline edge) so the slot
          reads recessed into the light thumb. Shadows, not fills. */}
      <span
        aria-hidden="true"
        className="h-2 w-1 rounded-[1.5px] shadow-[inset_0_0_0_1px_rgb(0_0_0_/_0.08),inset_0_1px_2px_rgb(0_0_0_/_0.35)]"
      />
      <span
        aria-hidden="true"
        className="h-2 w-1 rounded-[1.5px] shadow-[inset_0_0_0_1px_rgb(0_0_0_/_0.08),inset_0_1px_2px_rgb(0_0_0_/_0.35)]"
      />
    </SwitchPrimitives.Thumb>
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };

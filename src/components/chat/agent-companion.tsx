"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SwarmSurface, swarmActions, type SwarmSurfaceHandle, type SwarmTarget } from "dots-swarm";
import { useCompanionStore } from "@/stores/companion-store";
import type { AgentActivity } from "@/hooks/use-agent-activity";
import { cn } from "@/lib/utils";

/**
 * AgentCompanion (Realtime PRD §25–§37) — the dots-swarm companion that is
 * the app's visual identity now that every response logo is gone.
 *
 * One SwarmSurface (viewport canvas, fixed z-100, pointer-events:none —
 * portaled to body by the library) whose particle pool forms an AVATAR face
 * at the anchor div fixed above the composer's corner. The expression is
 * driven by AgentActivity; idle for a few seconds and the companion dozes
 * off with drifting Zs; clicking (or Enter/Space) scatters the dots and
 * they re-gather — the swarmActions explode → reform pair.
 *
 * Customizable in Settings → Appearance: on/off, solid-vs-dots face, size,
 * color (follows the live brand color by default).
 */

/** dots-swarm ships six expressions; map the richer activity set onto them. */
const EXPRESSION: Record<AgentActivity, "neutral" | "happy" | "curious" | "excited" | "dizzy"> = {
  idle: "neutral",
  thinking: "curious",
  browsing: "excited",
  executing: "excited",
  writing: "neutral",
  success: "happy",
  error: "dizzy",
};

const ACTIVITY_LABEL: Record<AgentActivity, string> = {
  idle: "idle",
  thinking: "thinking",
  browsing: "browsing the web",
  executing: "running a tool",
  writing: "writing a response",
  success: "happy with the result",
  error: "recovering from an error",
};

/** Seconds of idle before the Zs drift in. */
const SLEEP_AFTER_S = 4;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function AgentCompanion({ activity }: { activity: AgentActivity }) {
  const enabled = useCompanionStore((s) => s.enabled);
  const appearance = useCompanionStore((s) => s.appearance);
  const size = useCompanionStore((s) => s.size);
  const colorOverride = useCompanionStore((s) => s.color);

  const surface = useRef<SwarmSurfaceHandle>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const [sleeping, setSleeping] = useState(false);
  const [brand, setBrand] = useState<string | null>(null);
  const reducedMotion = useMemo(() => prefersReducedMotion(), []);

  // Live brand color: read --color-primary, refresh whenever <html>'s
  // inline styles (applyBrand) or theme class change.
  useEffect(() => {
    const read = () => {
      const v = getComputedStyle(document.documentElement)
        .getPropertyValue("--color-primary")
        .trim();
      setBrand(v || null);
    };
    read();
    const obs = new MutationObserver(read);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    return () => obs.disconnect();
  }, []);

  // Idle timer → sleeping (Zs). Any other activity retracts it render-time.
  useEffect(() => {
    if (activity !== "idle" || reducedMotion) return;
    const t = window.setTimeout(() => setSleeping(true), SLEEP_AFTER_S * 1000);
    return () => window.clearTimeout(t);
  }, [activity, reducedMotion]);
  if (activity !== "idle" && sleeping) setSleeping(false);

  const expression = EXPRESSION[activity];
  const showZs = sleeping && activity === "idle" && !reducedMotion;
  const color = colorOverride ?? brand ?? undefined;

  const targets = useMemo<SwarmTarget[]>(
    () => [
      {
        id: "companion",
        ref: anchor,
        kind: "avatar",
        expression,
        appearance,
      },
    ],
    [expression, appearance],
  );

  // Particle budget scales with the anchor area (70 at Small → ~200 at Large).
  const count = useMemo(() => Math.round((size * size) / 110), [size]);

  const scatter = () => {
    surface.current?.act(
      swarmActions.explode({ anticipation: 0.22, duration: 0.85 }),
    );
  };

  if (!enabled) return null;

  return (
    <div
      className="pointer-events-none fixed right-2 bottom-36 z-[90] sm:right-8 sm:bottom-28"
      aria-hidden={false}
    >
      <div className="origin-bottom-right max-sm:scale-[0.72]">
        <SwarmSurface
          ref={surface}
          viewport
          targets={targets}
          colliders={[
            { selector: "button, a, input, textarea, select, [role='button']", kind: "box" },
          ]}
          count={count}
          color={color}
          interactive
          reducedMotion={reducedMotion}
          onActionComplete={(action) => {
            if (action.type === "explode") {
              surface.current?.act(swarmActions.reform({ duration: 1.6 }));
            }
          }}
        >
          {/* The anchor: an invisible box the swarm forms inside. It is the
              click/keyboard target for the scatter trick. */}
          <div
            ref={anchor}
            role="button"
            tabIndex={0}
            aria-label={`OnyxAgent companion — ${ACTIVITY_LABEL[activity]}. Activate to scatter the dots.`}
            onClick={scatter}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                scatter();
              }
            }}
            className="pointer-events-auto relative cursor-pointer rounded-full transition-transform duration-200 hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring motion-reduce:transition-none"
            style={{ width: size, height: size }}
          >
            {/* Sleeping Zs — four staggered drifts up-right (user spec). */}
            {showZs
              ? [0, 1, 2, 3].map((i) => (
                  <span
                    key={i}
                    aria-hidden
                    className={cn(
                      "animate-companion-z absolute top-1 right-1 font-bold leading-none text-foreground/50 motion-reduce:hidden",
                    )}
                    style={{
                      fontSize: Math.round(size * (0.13 + i * 0.03)),
                      animationDelay: `${i * 0.5}s`,
                    }}
                  >
                    z
                  </span>
                ))
              : null}
          </div>
        </SwarmSurface>
      </div>
    </div>
  );
}

"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Motion primitives — the ONE reusable React layer over the motion.css
 * token system (Motion PRD §2/§18). Thin by design: every primitive maps
 * to a CSS class carved from the shared timing/easing tokens, so there is
 * exactly ONE animation implementation in the app (no competing engines,
 * no per-page re-inventions) and the prefers-reduced-motion kill switch in
 * motion.css covers every primitive automatically.
 *
 * Prefer the raw classes (mb-object-in etc.) inside CSS-driven surfaces;
 * reach for these components where React needs to CONTROL the motion
 * (delays, presence exits, pointer interaction).
 */

// ── MotionContainer ─────────────────────────────────────────────────────────

export type MotionVariant = "blur" | "fade" | "spring" | "scale" | "row" | "none";

const VARIANT_CLASS: Record<MotionVariant, string> = {
  blur: "mb-object-in",
  fade: "mb-fade-in",
  spring: "mb-spring-in",
  scale: "mb-scale-in",
  row: "mb-row-in",
  none: "",
};

export interface MotionContainerProps extends React.HTMLAttributes<HTMLElement> {
  /** Entrance recipe (defaults to the blur-to-sharp object reveal). */
  variant?: MotionVariant;
  /** Entrance delay in ms (inline animationDelay — beats stagger rules). */
  delay?: number;
  /** Duration override in ms (drives the --mb-dur token). */
  duration?: number;
  as?: "div" | "span" | "li" | "section";
}

/** Generic entrance container — opacity/blur/rise per variant, tokenized. */
export function MotionContainer({
  variant = "blur",
  delay,
  duration,
  className,
  style,
  as = "div",
  ...rest
}: MotionContainerProps) {
  const Tag = as as "div";
  return (
    <Tag
      className={cn(VARIANT_CLASS[variant], className)}
      style={{
        ...(delay !== undefined ? { animationDelay: `${delay}ms` } : {}),
        ...(duration !== undefined ? { "--mb-dur": `${duration}ms` } : {}),
        ...style,
      }}
      {...rest}
    />
  );
}

// ── BlurReveal ──────────────────────────────────────────────────────────────

/** Content materializes with the blur-to-sharp settle (the app's signature
 *  entrance — panels, cards, menus, messages, gen UI). */
export function BlurReveal({
  delay,
  duration,
  className,
  ...rest
}: Omit<MotionContainerProps, "variant">) {
  return (
    <MotionContainer variant="blur" delay={delay} duration={duration} className={className} {...rest} />
  );
}

/** Pure opacity entrance — for text swaps and quiet state changes. */
export function FadeTransition(props: Omit<MotionContainerProps, "variant">) {
  return <MotionContainer variant="fade" {...props} />;
}

/** Spring-settled rise — panels, drawers, floating elements (no bounce). */
export function SpringTransition(props: Omit<MotionContainerProps, "variant">) {
  return <MotionContainer variant="spring" {...props} />;
}

/** Scale-settled entrance — menus, popovers, compact confirmations. */
export function ScaleTransition(props: Omit<MotionContainerProps, "variant">) {
  return <MotionContainer variant="scale" {...props} />;
}

// ── StaggerContainer ────────────────────────────────────────────────────────

/** Children cascade in with the shared 26ms stagger (motion.css). */
export function StaggerContainer({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mb-stagger", className)} {...rest} />;
}

// ── MorphTransition ─────────────────────────────────────────────────────────

/** Interpolates a property set between states (the composer's height /
 *  border / shadow morph). Give the child `transition`-friendly values and
 *  swap them — the CSS handles the interpolation via the token timing. */
export function MorphTransition({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mb-morph", className)} {...rest} />;
}

// ── PresenceTransition ──────────────────────────────────────────────────────

/**
 * Mount/unmount with an exit animation: children stay mounted through the
 * `mb-fade-out` (≈130ms) after `present` flips false, then truly unmount.
 * Nothing disappears abruptly; nothing lingers past the animation.
 */
export function PresenceTransition({
  present,
  exitMs = 130,
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & {
  present: boolean;
  /** Exit duration — must match the CSS --mb-dur you pass. */
  exitMs?: number;
}) {
  const [mounted, setMounted] = React.useState(present);
  React.useEffect(() => {
    if (present) {
      setMounted(true);
      return;
    }
    const t = window.setTimeout(() => setMounted(false), exitMs);
    return () => window.clearTimeout(t);
  }, [present, exitMs]);
  if (!mounted) return null;
  return (
    <div
      className={cn(present ? undefined : "mb-fade-out", className)}
      style={present ? undefined : ({ "--mb-dur": `${exitMs}ms` } as React.CSSProperties)}
      {...rest}
    >
      {children}
    </div>
  );
}

// ── PressFeedback ───────────────────────────────────────────────────────────

/** Tactile press compression on any tappable surface (scale .97, token
 *  timing). Composable with any variant wrapper. */
export function PressFeedback({
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mb-press", className)} {...rest} />;
}

// ── MagneticHover ───────────────────────────────────────────────────────────

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/**
 * Subtle cursor-follow drift for selected desktop surfaces — max 4px,
 * pointer-fine devices only, fully disabled under reduced-motion and on
 * touch. Never alters hit-testing (transform only, same element).
 */
export function MagneticHover({
  children,
  strength = 4,
  className,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & {
  strength?: number;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const frame = React.useRef<number | null>(null);

  const onPointerMove = React.useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType !== "mouse" || prefersReducedMotion()) return;
      const el = ref.current;
      if (!el) return;
      if (frame.current !== null) return;
      const { clientX, clientY } = e;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        const rect = el.getBoundingClientRect();
        const dx = (clientX - rect.left) / rect.width - 0.5;
        const dy = (clientY - rect.top) / rect.height - 0.5;
        el.style.transform = `translate(${dx * strength}px, ${dy * strength}px)`;
      });
    },
    [strength],
  );

  const reset = React.useCallback(() => {
    const el = ref.current;
    if (el) el.style.transform = "";
  }, []);

  React.useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  return (
    <div
      ref={ref}
      onPointerMove={onPointerMove}
      onPointerLeave={reset}
      className={cn("transition-transform duration-200", className)}
      {...rest}
    >
      {children}
    </div>
  );
}

// ── SharedLayout ────────────────────────────────────────────────────────────

/**
 * Shared-layout wrapper (Motion PRD §2 SharedLayoutTransition): re-exports
 * framer-motion's layout animation for the few surfaces that genuinely
 * need cross-position continuity (the sidebar's active indicator, morphing
 * panels). Import framer-motion directly where trees are already motion
 * trees; this wrapper exists so call sites never depend on the library
 * choice.
 */
export { motion, AnimatePresence } from "framer-motion";

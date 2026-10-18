import type { OrbVariant } from "@/components/assistant-ui/elements/orb";

/**
 * Orb personalities (PRD §10 — Feature Two: Custom Orb Personalities and
 * Reaction Animations).
 *
 * A personality maps each of the app's nine REAL reaction states onto one of
 * the Orb lattice's 25 CSS variants (families S/G/C/B/M — see
 * `elements/orb.tsx` for the exact choreography semantics), plus a few
 * tuning knobs (idle motion, reaction intensity, celebration, chat
 * visibility). `resolveOrb` turns a personality + a live reaction state into
 * the concrete `<Orb>` props, including reduced-motion behavior.
 *
 * Pure data + pure functions — no React, no DOM. The store
 * (`src/stores/orb-personality-store.ts`) persists the user's choice;
 * `PersonalityOrb` renders it; the settings panel edits it.
 */

/** The nine REAL application reaction states an orb can express. */
export type OrbReactionState =
  | "idle"
  | "user_typing"
  | "submitted"
  | "thinking"
  | "tool_running"
  | "awaiting_approval"
  | "success"
  | "error"
  | "cancelled";

/** Ordered list (used by the settings panel's per-state editor). */
export const ORB_REACTION_STATES: readonly OrbReactionState[] = [
  "idle",
  "user_typing",
  "submitted",
  "thinking",
  "tool_running",
  "awaiting_approval",
  "success",
  "error",
  "cancelled",
];

/** Human labels for the settings UI. */
export const REACTION_STATE_LABELS: Record<OrbReactionState, string> = {
  idle: "Idle",
  user_typing: "User typing",
  submitted: "Request submitted",
  thinking: "Thinking",
  tool_running: "Tool running",
  awaiting_approval: "Awaiting approval",
  success: "Success",
  error: "Error",
  cancelled: "Cancelled",
};

export type OrbPersonalityId =
  | "professional"
  | "friendly"
  | "focused"
  | "playful"
  | "custom";

export type OrbIdleMotion = "none" | "subtle" | "warm";

export interface OrbPersonality {
  id: OrbPersonalityId;
  label: string;
  description: string;
  /** The lattice variant each reaction state renders. */
  stateVariants: Record<OrbReactionState, OrbVariant>;
  /**
   * Idle character: "none" = the personality prefers a resting lattice
   * (also opts OUT of the reduced-motion working pulse), "subtle" = quiet,
   * "warm" = alive. Feeds `resolveOrb`'s reduced-motion gating.
   */
  idleMotion: OrbIdleMotion;
  /** 0..1 — how strongly the orb reacts. Scales animation speed. */
  reactionIntensity: number;
  /** Play the one-shot success celebration overlay. */
  celebrationEnabled: boolean;
  /** Whether the personality orb appears in the chat interface at all. */
  showInChat: boolean;
}

/** All 25 lattice variants, registry order (S/G/C/B/M × 1–5). */
export const ALL_ORB_VARIANTS: readonly OrbVariant[] = [
  "S1", "S2", "S3", "S4", "S5",
  "G1", "G2", "G3", "G4", "G5",
  "C1", "C2", "C3", "C4", "C5",
  "B1", "B2", "B3", "B4", "B5",
  "M1", "M2", "M3", "M4", "M5",
];

const VALID_VARIANTS: ReadonlySet<string> = new Set(ALL_ORB_VARIANTS);

/** States during which the agent is actively working on the request. */
const WORKING_STATES: ReadonlySet<OrbReactionState> = new Set([
  "submitted",
  "thinking",
  "tool_running",
  "awaiting_approval",
]);

// ─── resolveOrb ─────────────────────────────────────────────────────────────

/** What `resolveOrb` hands to the `<Orb>` component. */
export interface ResolvedOrb {
  variant: OrbVariant;
  /** Multiplier for the cell cycle duration (`--orb-d`). <1 = faster. */
  durationScale: number;
  /** false = render a static lattice (reduced motion). */
  animate: boolean;
}

/**
 * Intensity (0..1) → duration scale. Calm personalities run SLOWER than
 * default (0 → 1.3), expressive ones faster (1 → 0.7); clamped to
 * [0.6, 1.6] so nothing ever becomes frantic or glacial.
 */
export function intensityToDurationScale(intensity: number): number {
  const t = Math.min(1, Math.max(0, Number.isFinite(intensity) ? intensity : 0));
  return Math.min(1.6, Math.max(0.6, 1.3 - 0.6 * t));
}

/** The slow, subtle breathing swell used as the reduced-motion working pulse. */
const REDUCED_PULSE_VARIANT: OrbVariant = "S1";
/** ~7s cell cycle — a gentle breath, not a choreography. */
const REDUCED_PULSE_SCALE = 3.4;

/**
 * Resolve a personality + reaction state into concrete Orb props.
 *
 * Normal motion: the personality's variant for the state, animated, at the
 * intensity-derived speed.
 *
 * Reduced motion (`prefers-reduced-motion: reduce`): the lattice is STATIC
 * (animate: false renders the resting frame) for every state — EXCEPT the
 * working states, which keep ONE slow, subtle centre-out pulse (S1 at a
 * ~7s cycle) so liveness is still communicated while the agent works.
 * Personalities with `idleMotion: "none"` (Focused) opt out of even that:
 * they stay fully static. Status is never carried by the orb alone (PRD
 * §10.4) — the text labels always remain.
 */
export function resolveOrb(
  personality: OrbPersonality,
  state: OrbReactionState,
  reducedMotion: boolean,
): ResolvedOrb {
  const requested = personality.stateVariants?.[state];
  const variant: OrbVariant =
    requested !== undefined && VALID_VARIANTS.has(requested)
      ? requested
      : // Defensive: a malformed/partial personality (e.g. an old persisted
        // shape) still resolves — fall back to idle, then to a safe swell.
        (VALID_VARIANTS.has(personality.stateVariants?.idle ?? "")
          ? personality.stateVariants.idle
          : "S1");
  const scale = intensityToDurationScale(personality.reactionIntensity);

  if (!reducedMotion) {
    return { variant, durationScale: scale, animate: true };
  }
  const keepWorkingPulse = WORKING_STATES.has(state) && personality.idleMotion !== "none";
  return keepWorkingPulse
    ? { variant: REDUCED_PULSE_VARIANT, durationScale: REDUCED_PULSE_SCALE, animate: true }
    : { variant, durationScale: scale, animate: false };
}

// ─── Presets ────────────────────────────────────────────────────────────────
//
// Variant semantics (from orb.tsx): S = swell (waves radiating: S1 from the
// centre, S2 diagonal band, S3 ring run w/ tail, S4 soft column, S5 scrambled
// jumps) · G = gather (reversed wavefronts: G1 collapses inward, G2 diagonal
// SE→NW, G3 column right→left, G4 rows bottom→top, G5 corners→cross) ·
// C = comet (perimeter runners: C1 ccw, C2 fast cw, C3 slow long tail, C4 two
// heads, C5 fastest) · B = blink (B1 checkerboard, B2 scatter, B3 columns,
// B4 rows, B5 cross-first) · M = march (M1 row scan, M2 column scan, M3
// perimeter patrol, M4 spiral, M5 cross sweep).

export const PROFESSIONAL_PRESET: OrbPersonality = {
  id: "professional",
  label: "Professional",
  description: "Calm, minimal reactions. Subtle movement with clear working and completion states.",
  // PRD §10.2 "Professional": calm & minimal — quiet B-family blinks for the
  // ambient states (no travelling motion at rest), one composed swell while
  // thinking, and a methodical scan while tools run.
  stateVariants: {
    // Checkerboard blink — two calm interleaved phases; nothing travels.
    idle: "B1",
    // Columns alternate with a slight stagger — a quiet acknowledgment.
    user_typing: "B3",
    // Cross lights first, corners answer — a composed "received" flash.
    submitted: "B5",
    // A broad diagonal band crossing steadily — controlled, predictable.
    thinking: "S2",
    // Column scan, top-to-bottom — methodical, orderly processing.
    tool_running: "M2",
    // Rows alternate — clear two-phase attention, non-alarming.
    awaiting_approval: "B4",
    // Corners pull into the cross — a composed landing (clear completion).
    success: "G5",
    // Scatter blink — restrained disturbance (errors stay subtle, PRD §10.3).
    error: "B2",
    // A soft column travels left-to-right and trails off — gentle wind-down.
    cancelled: "S4",
  },
  idleMotion: "subtle",
  reactionIntensity: 0.25,
  celebrationEnabled: false,
  showInChat: true,
};

export const FRIENDLY_PRESET: OrbPersonality = {
  id: "friendly",
  label: "Friendly",
  description: "Warm idle motion, gentle success reactions, and a welcoming presence.",
  // PRD §10.2 "Friendly": warm idle S-family waves + the gentle S1 success.
  stateVariants: {
    // Radiates from the centre — a warm heartbeat at rest.
    idle: "S1",
    // A soft column travelling — gently follows the user's input.
    user_typing: "S4",
    // The wave collapses inward — "got it, taking it in".
    submitted: "G1",
    // Broad diagonal band — steady and warm.
    thinking: "S2",
    // Cross sweep outward from the centre — open, friendly work.
    tool_running: "M5",
    // Cross lights first, corners answer — polite attention.
    awaiting_approval: "B5",
    // THE gentle centre-out bloom (PRD names S1 as the gentle success).
    success: "S1",
    // Scatter blink — gentle concern, never alarming.
    error: "B2",
    // Scrambled pulse jumps — a relaxed "okay, letting go".
    cancelled: "S5",
  },
  idleMotion: "warm",
  reactionIntensity: 0.5,
  celebrationEnabled: false,
  showInChat: true,
};

export const FOCUSED_PRESET: OrbPersonality = {
  id: "focused",
  label: "Focused",
  description: "Minimal idle animation with strong visual distinction between thinking, working, and completion.",
  // PRD §10.2 "Focused": minimal idle + STRONG state distinction — every one
  // of the nine states uses a DIFFERENT variant, and the M-family marches own
  // the working states (a distinct, steady activity per PRD §10.3 "Working").
  stateVariants: {
    // Checkerboard — as quiet as an animated lattice gets.
    idle: "B1",
    // Rows alternate — low-distraction input echo.
    user_typing: "B4",
    // Row scan starts immediately — work begins the moment you send.
    submitted: "M1",
    // Spiral — each ring leads the one outside it: an introspective scan,
    // unmistakably different from tool activity.
    thinking: "M4",
    // Perimeter patrol — THE distinct steady march while working.
    tool_running: "M3",
    // Corners pull into the cross — an unmistakable inward gather that reads
    // as "waiting on you" without alarm.
    awaiting_approval: "G5",
    // Column scan — a distinct completion signature.
    success: "M2",
    // Scatter — subtle for every personality (PRD §10.3).
    error: "B2",
    // Scrambled release.
    cancelled: "S5",
  },
  idleMotion: "none",
  reactionIntensity: 0.35,
  celebrationEnabled: false,
  showInChat: true,
};

export const PLAYFUL_PRESET: OrbPersonality = {
  id: "playful",
  label: "Playful",
  description: "Expressive comets, quick reactions, and a lightweight celebration on success.",
  // PRD §10.2 "Playful": expressive C-family comets + celebration on success
  // (the G3 gather plays, then the one-shot celebration overlay releases).
  stateVariants: {
    // Slow comet with a long tail — alive and expressive even at rest.
    idle: "C3",
    // Two heads chase each other — a playful echo of the keystrokes.
    user_typing: "C4",
    // Fast clockwise comet — zoom, off we go.
    submitted: "C2",
    // The quickest patrol — a quick mind at work.
    thinking: "C5",
    // Counterclockwise comet — energetic lap-running.
    tool_running: "C1",
    // Diagonal band running the other way — a curious tilt of the head:
    // attention without alarm.
    awaiting_approval: "G2",
    // Column sweep right-to-left gathers, then the celebration releases.
    success: "G3",
    // Scatter — even Playful keeps errors restrained (PRD §10.3).
    error: "B2",
    // Scrambled pulse — a playful shrug.
    cancelled: "S5",
  },
  idleMotion: "warm",
  reactionIntensity: 0.8,
  celebrationEnabled: true,
  showInChat: true,
};

/** The four fixed presets (the "custom" id is user-edited, never preset). */
export const PERSONALITY_PRESETS: Record<
  Exclude<OrbPersonalityId, "custom">,
  OrbPersonality
> = {
  professional: PROFESSIONAL_PRESET,
  friendly: FRIENDLY_PRESET,
  focused: FOCUSED_PRESET,
  playful: PLAYFUL_PRESET,
};

/**
 * Seed a fresh Custom personality from a base (usually the currently active
 * preset). The user's edited copy lives in the store and starts life as a
 * clone of the base with the "custom" identity.
 */
export function buildCustomPersonality(
  base: OrbPersonality = PROFESSIONAL_PRESET,
): OrbPersonality {
  return {
    ...base,
    id: "custom",
    label: "Custom",
    description: "Your own mix of variants, intensity, idle motion, and reactions.",
    stateVariants: { ...base.stateVariants },
  };
}

/**
 * Sanitize a (possibly stale/partial) persisted Custom personality: fills any
 * missing or invalid state mapping from the seed defaults so a rehydrated
 * shape can never produce an unresolvable variant.
 */
export function sanitizePersonality(
  p: Partial<OrbPersonality> | undefined,
): OrbPersonality {
  const seed = buildCustomPersonality();
  if (!p || typeof p !== "object") return seed;
  const variants = { ...seed.stateVariants };
  const incoming: Partial<Record<OrbReactionState, OrbVariant>> =
    p.stateVariants ?? {};
  for (const state of ORB_REACTION_STATES) {
    const v = incoming[state];
    if (typeof v === "string" && VALID_VARIANTS.has(v)) variants[state] = v as OrbVariant;
  }
  return {
    id: "custom",
    label: "Custom",
    description:
      typeof p.description === "string" && p.description
        ? p.description
        : seed.description,
    stateVariants: variants,
    idleMotion:
      p.idleMotion === "none" || p.idleMotion === "subtle" || p.idleMotion === "warm"
        ? p.idleMotion
        : seed.idleMotion,
    reactionIntensity:
      typeof p.reactionIntensity === "number" && Number.isFinite(p.reactionIntensity)
        ? Math.min(1, Math.max(0, p.reactionIntensity))
        : seed.reactionIntensity,
    celebrationEnabled:
      typeof p.celebrationEnabled === "boolean" ? p.celebrationEnabled : seed.celebrationEnabled,
    showInChat: typeof p.showInChat === "boolean" ? p.showInChat : seed.showInChat,
  };
}

/** Resolve the active personality for a persisted id + custom copy. */
export function getActivePersonality(
  id: OrbPersonalityId,
  custom: OrbPersonality,
): OrbPersonality {
  if (id === "custom") return custom;
  return PERSONALITY_PRESETS[id] ?? PROFESSIONAL_PRESET;
}

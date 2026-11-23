/**
 * Magic UI configuration — PRD "Premium Magic UI Integration" §13.
 *
 * ONE centralized place for every Magic UI effect's defaults, so the
 * effects stay consistent across the app and tunable in a single edit.
 * No settings UI is exposed (the existing design system has no home for
 * it — the PRD explicitly allows that).
 *
 * Usage map (the "component selection rules" the PRD demands):
 *   RainbowButton  — IMPORTANT actions only: the composer Send, project
 *                    creation, primary confirmations. Never navigation,
 *                    dropdowns or ordinary controls.
 *   BorderBeam     — ACTIVE + interactive containers: the composer dock,
 *                    open selection popovers, question/todo/approval UIs.
 *   TypingAnimation— the EMPTY prompt composer's rotating suggestions.
 *   ShineBorder    — media previews + AI-generated visual content
 *                    (image/video search, generation, GenUI, rich cards).
 */
export interface MagicUIConfig {
  rainbowButton: {
    enabled: boolean;
    /** Integration sites (documentation for reviewers — the components
     * import RainbowButton directly, this list is the source of truth for
     * WHERE it is allowed). */
    locations: string[];
  };
  borderBeam: {
    enabled: boolean;
    /** Seconds per revolution. */
    duration: number;
    /** Beam length in px. */
    size: number;
    colorFrom: string;
    colorTo: string;
    /** Ring thickness in px. */
    borderWidth: number;
  };
  typingAnimation: {
    enabled: boolean;
    /** Ms per typed character. */
    typeSpeed: number;
    /** Ms the finished word rests before deleting. */
    pauseDelay: number;
    /** Cycle through every suggestion forever. */
    loop: boolean;
    /** Rotating composer placeholder suggestions (PRD §6). */
    suggestions: string[];
  };
  shineBorder: {
    enabled: boolean;
    /** Seconds per shine cycle. */
    duration: number;
    borderWidth: number;
    /** Multicolor shine — Onyx cyan family, subtle on both themes. */
    shineColor: string[];
  };
}

/** The OnyxAgent defaults — cyan-forward, subtle, slow (premium, never
 * noisy: PRD §1 "animations should enhance, not distract"). */
export const MAGIC_UI_CONFIG: MagicUIConfig = {
  rainbowButton: {
    enabled: true,
    locations: [
      "chat composer Send button",
      "project creation entry",
      "primary confirmations in dialogs",
    ],
  },
  borderBeam: {
    enabled: true,
    // Subtle + slow: a 40px cyan beam lapping the container every 8s.
    duration: 8,
    size: 40,
    colorFrom: "#22d3ee", // --color-primary (cyan on black)
    colorTo: "#0e7490", // deep cyan
    borderWidth: 1.5,
  },
  typingAnimation: {
    enabled: true,
    typeSpeed: 65,
    pauseDelay: 1500,
    loop: true,
    suggestions: [
      "Ask Onyx anything...",
      "Build a complete website...",
      "Research a topic...",
      "Create an image...",
      "Analyze my codebase...",
      "Build an AI agent...",
    ],
  },
  shineBorder: {
    enabled: true,
    duration: 14,
    borderWidth: 1,
    shineColor: ["#22d3ee", "#67e8f9", "#0e7490"],
  },
};

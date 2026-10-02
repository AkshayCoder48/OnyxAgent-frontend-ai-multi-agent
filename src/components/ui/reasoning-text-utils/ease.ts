import type { Transition } from "framer-motion";

/**
 * Shared motion curves for the reasoning text family.
 * Kept in one place so every phrase variant swings the same way.
 */

/** Classic quartic ease-out for entrances and exits. */
export const EASE_OUT: Transition["ease"] = [0.215, 0.61, 0.355, 1];

/** Snappy spring used when one phrase swaps in for another. */
export const SPRING_SWAP: Transition = {
  type: "spring",
  stiffness: 480,
  damping: 38,
  mass: 0.7,
};

"use client";

/**
 * Response orb — ONE random orb per AI response (PRD §25–§29).
 *
 * The app has 25 orb variants (S1–S5, G1–G5, C1–C5, B1–B5, M1–M5). When a
 * new AI response begins, `beginResponseOrb()` randomly selects one from the
 * FULL 25-orb collection, avoiding an immediate repeat of the previous
 * response's orb when possible. The selection is stable for the whole
 * response — it never changes per streamed token/chunk — and lives in a
 * module singleton (NOT app state), so reading it never re-renders anything
 * except the tiny component that renders the orb itself.
 *
 * Consumers:
 *   - `ThinkingStatus` (chat-container) — pre-first-token "Thinking…" row.
 *   - The message-item streaming placeholder — same orb, same response.
 */

import type { OrbVariant } from "./orb";
import { ALL_ORB_VARIANTS as ORB_REGISTRY } from "@/lib/orb/personalities";

// Single source of truth for the 25-variant registry now lives with the
// personality model (src/lib/orb/personalities.ts) — re-exported here so
// every existing consumer of this module keeps working unchanged.
export { ALL_ORB_VARIANTS } from "@/lib/orb/personalities";
// The personality-aware orb (PRD §10): consumers that want the orb to react
// to the app's real states (and the user's chosen personality, respecting
// its showInChat flag) should render this instead of picking variants. The
// random per-response selection below is preserved unchanged for the
// GenUI/orb surfaces that want a surprise variant per response.
export { PersonalityOrb } from "./personality-orb";

/** The orb chosen for the current (or most recent) AI response. */
let current: OrbVariant | null = null;

/** Uniform random pick from the pool (excludes `exclude` when given). */
export function pickRandomOrb(exclude?: OrbVariant): OrbVariant {
  const pool =
    exclude === undefined
      ? (ORB_REGISTRY as readonly OrbVariant[])
      : ORB_REGISTRY.filter((v) => v !== exclude);
  return pool[Math.floor(Math.random() * pool.length)]!;
}

/**
 * A new AI response is starting — pick the response's orb ONCE. Avoids
 * repeating the previous response's orb when there's a choice (24 others),
 * per PRD §26. Called from the chat runtime when a user message is sent
 * (which is exactly when the next AI response begins).
 */
export function beginResponseOrb(): OrbVariant {
  current = pickRandomOrb(current ?? undefined);
  return current;
}

/** The orb for the response currently in flight (lazy-picks if none yet). */
export function currentResponseOrb(): OrbVariant {
  if (current === null) current = pickRandomOrb();
  return current;
}

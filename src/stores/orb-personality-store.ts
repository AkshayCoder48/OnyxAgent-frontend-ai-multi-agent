"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  buildCustomPersonality,
  getActivePersonality,
  sanitizePersonality,
  type OrbPersonality,
  type OrbPersonalityId,
  type OrbReactionState,
} from "@/lib/orb/personalities";

/**
 * Orb personality store — which personality the app's status orbs use, plus
 * the user's edited "custom" copy (PRD §10.2 — "These settings should be
 * persistent"). Persisted to localStorage under "onyx-orb-personality"
 * following the theme/companion store persist patterns.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OVERRIDE-STATE CONTRACT (for Task 2-d — approvals & project context)
 * ─────────────────────────────────────────────────────────────────────────────
 * The reaction state "awaiting_approval" has no first-class signal yet (the
 * approval-gate flow lands with Task 2-d). Until then, ANY code can force the
 * orb into a reaction state through the transient (NOT persisted) override:
 *
 *   import { setOrbOverrideState, clearOrbOverrideState }
 *     from "@/stores/orb-personality-store";
 *
 *   // When an approval request becomes pending (approval_request WSEvent /
 *   // approval-gate pause):
 *   setOrbOverrideState("awaiting_approval");
 *
 *   // When resolved (approved / rejected / cancelled / expired):
 *   clearOrbOverrideState();
 *
 * The override wins over every derived signal (it is checked first in
 * `useOrbReactionState`). It is intentionally generic: any OrbReactionState
 * can be forced ("success", "error", …) if a future surface needs to. React
 * consumers can subscribe with the `useOrbOverrideState()` hook below.
 *
 *   setOrbOverrideState("awaiting_approval"); // gate opened
 *   setOrbOverrideState(null);                // gate resolved — EXACT contract
 *
 * (`clearOrbOverrideState()` is a semantic alias for the null call.)
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface OrbPersonalityStoreState {
  /** The active personality ("custom" activates the edited copy below). */
  personalityId: OrbPersonalityId;
  /** The user's edited custom personality (seeded from the current preset
  * the moment the user switches to "custom"). */
  custom: OrbPersonality;
  /**
   * TRANSIENT reaction-state override — never persisted, cleared on reload.
   * See the contract block above (Task 2-d wires awaiting_approval here).
   */
  overrideState: OrbReactionState | null;
  setPersonality: (id: OrbPersonalityId) => void;
  /** Patch the custom copy. Only valid while personalityId === "custom";
   * a no-op otherwise (switch to custom first — setPersonality("custom")
   * seeds the copy from the current preset). */
  patchCustom: (partial: Partial<Omit<OrbPersonality, "id">>) => void;
  /** Reset the custom copy back to the seed defaults (professional-based). */
  resetCustom: () => void;
  setOverrideState: (state: OrbReactionState) => void;
  clearOverrideState: () => void;
}

export const useOrbPersonalityStore = create<OrbPersonalityStoreState>()(
  persist(
    (set, get) => ({
      personalityId: "professional",
      custom: buildCustomPersonality(),
      overrideState: null,
      setPersonality: (id) =>
        set((s) => ({
          personalityId: id,
          // Switching TO custom initializes the copy from the personality
          // that is active right now (PRD: custom configures a preset base).
          ...(id === "custom"
            ? { custom: buildCustomPersonality(getActivePersonality(s.personalityId, s.custom)) }
            : {}),
        })),
      patchCustom: (partial) => {
        if (get().personalityId !== "custom") return; // guard: preset active
        set((s) => ({
          custom: {
            ...s.custom,
            ...partial,
            id: "custom", // never let a patch smuggle in a preset identity
            stateVariants: { ...s.custom.stateVariants, ...(partial.stateVariants ?? {}) },
          },
        }));
      },
      resetCustom: () => set({ custom: buildCustomPersonality() }),
      setOverrideState: (state) => set({ overrideState: state }),
      clearOverrideState: () => set({ overrideState: null }),
    }),
    {
      name: "onyx-orb-personality",
      // The override is transient session state — never persist it.
      partialize: (s) => ({ personalityId: s.personalityId, custom: s.custom }),
      // Sanitize the persisted custom copy on rehydrate: an older shape (or a
      // hand-edited localStorage entry) must never yield an unresolvable
      // variant map.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<OrbPersonalityStoreState>;
        const id: OrbPersonalityId =
          p.personalityId === "friendly" ||
          p.personalityId === "focused" ||
          p.personalityId === "playful" ||
          p.personalityId === "custom"
            ? p.personalityId
            : "professional";
        return {
          ...current,
          personalityId: id,
          custom: sanitizePersonality(p.custom),
        };
      },
    },
  ),
);

/**
 * Standalone imperative setter — call from ANYWHERE (Task 2-d contract).
 * Passing `null` (or `undefined`) clears the override — resolved gates call
 * exactly `setOrbOverrideState(null)`.
 */
export function setOrbOverrideState(
  state: OrbReactionState | null,
): void {
  if (state === null || state === undefined) {
    useOrbPersonalityStore.getState().clearOverrideState();
    return;
  }
  useOrbPersonalityStore.getState().setOverrideState(state);
}

/** Semantic alias for `setOrbOverrideState(null)` — resolve the override. */
export function clearOrbOverrideState(): void {
  useOrbPersonalityStore.getState().clearOverrideState();
}

/** Reactive subscription to the transient override (Task 2-d contract). */
export function useOrbOverrideState(): OrbReactionState | null {
  return useOrbPersonalityStore((s) => s.overrideState);
}

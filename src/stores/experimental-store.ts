"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

interface ExperimentalState {
  /**
   * Glass buttons — the liquid-glass button skin (gradient glass fill,
   * animated conic edge, shine sweep, 3D press). When ON, a
   * `exp-glass` class lands on <html> and every button in the app is
   * restyled by `src/app/glass-buttons.css`. Colour-aware: follows the
   * light/dark theme and the active colour scheme.
   */
  glassButtons: boolean;
  setGlassButtons: (enabled: boolean) => void;
}

/**
 * Experimental UI features — toggles for work-in-progress looks we are
 * trying out. Each flag is persisted per browser (localStorage) and
 * defaults OFF: nothing experimental ships enabled.
 *
 * The Settings → "Experimental" section renders one card per flag, so
 * adding a future experiment = add a field here + a toggle card there.
 */
export const useExperimentalStore = create<ExperimentalState>()(
  persist(
    (set) => ({
      glassButtons: false,
      setGlassButtons: (enabled) => set({ glassButtons: enabled }),
    }),
    { name: "experimental-ui-storage" },
  ),
);

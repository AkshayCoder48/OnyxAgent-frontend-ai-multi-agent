"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Companion settings (Realtime PRD §31–§37) — the dots-swarm AI companion
 * that replaces every response logo as the app's visual identity. Persisted
 * so the choice survives reloads; appearance/size/color feed the
 * SwarmSurface target and surface props directly.
 */

export interface CompanionState {
  /** Master switch — off removes the companion entirely. */
  enabled: boolean;
  /** "solid" = smooth assembled face, "dots" = particle face. */
  appearance: "solid" | "dots";
  /** Anchor box size in px (the swarm forms inside it). */
  size: number;
  /** null = follow the live brand color; else a CSS color string. */
  color: string | null;
  setEnabled: (enabled: boolean) => void;
  setAppearance: (appearance: "solid" | "dots") => void;
  setSize: (size: number) => void;
  setColor: (color: string | null) => void;
}

export const COMPANION_SIZES = [
  { id: "small", label: "Small", px: 88 },
  { id: "medium", label: "Medium", px: 116 },
  { id: "large", label: "Large", px: 148 },
] as const;

export const useCompanionStore = create<CompanionState>()(
  persist(
    (set) => ({
      enabled: true,
      appearance: "solid",
      size: 116,
      color: null,
      setEnabled: (enabled) => set({ enabled }),
      setAppearance: (appearance) => set({ appearance }),
      setSize: (size) => set({ size }),
      setColor: (color) => set({ color }),
    }),
    { name: "companion-storage-v1" },
  ),
);

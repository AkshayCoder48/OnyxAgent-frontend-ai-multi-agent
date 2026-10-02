"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Theme = "light" | "dark" | "system";

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      // DARK is the app default: black canvas, white ink, cyan buttons.
      // (Key is versioned — "theme-storage-v2" — so the black default
      // reaches existing installs once; a persisted choice still wins
      // afterwards, and "system" remains a user choice.)
      theme: "dark",
      setTheme: (theme) => set({ theme }),
    }),
    {
      name: "theme-storage-v2",
    },
  ),
);

/**
 * Get the resolved theme (light or dark) based on the current theme setting.
 * When theme is "system", it checks the user's system preference.
 */
export function getResolvedTheme(theme: Theme): "light" | "dark" {
  if (theme === "system") {
    if (typeof window !== "undefined") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    return "dark";
  }
  return theme;
}

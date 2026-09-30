"use client";

import { useEffect } from "react";
import { useThemeStore, getResolvedTheme } from "@/stores/theme-store";

/**
 * Applies the resolved theme to <html>.
 *
 * While a light/dark switch is in flight, `html.theme-transitioning` is set
 * for ~250ms: the scoped rule in globals.css cross-fades colors ONLY for
 * that window (the old global `* { transition }` ran on every element at
 * every state change and was a serious interaction/perf tax).
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { theme } = useThemeStore();

  useEffect(() => {
    const root = document.documentElement;
    const resolvedTheme = getResolvedTheme(theme);

    const prev = root.classList.contains("dark") ? "dark" : "light";
    if (prev !== resolvedTheme) {
      // Cross-fade colors while the palette swaps, then stop transitioning
      // so everyday interactions never pay the transition cost.
      root.classList.add("theme-transitioning");
      root.classList.remove("light", "dark");
      root.classList.add(resolvedTheme);
      window.setTimeout(() => root.classList.remove("theme-transitioning"), 250);
    } else {
      root.classList.remove("light", "dark");
      root.classList.add(resolvedTheme);
    }

    // Update color-scheme for native elements
    root.style.colorScheme = resolvedTheme;
  }, [theme]);

  // Listen for system theme changes when using "system" theme
  useEffect(() => {
    if (theme !== "system") return;

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

    const handleChange = () => {
      const root = document.documentElement;
      const resolvedTheme = mediaQuery.matches ? "dark" : "light";

      const prev = root.classList.contains("dark") ? "dark" : "light";
      if (prev !== resolvedTheme) {
        root.classList.add("theme-transitioning");
        window.setTimeout(() => root.classList.remove("theme-transitioning"), 250);
      }
      root.classList.remove("light", "dark");
      root.classList.add(resolvedTheme);
      root.style.colorScheme = resolvedTheme;
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [theme]);

  return <>{children}</>;
}

"use client";

import { useEffect } from "react";
import { useExperimentalStore } from "@/stores/experimental-store";

/**
 * Experimental UI — applies the enabled experiment flags to <html> as
 * classes so the global stylesheets (e.g. `glass-buttons.css`, scoped
 * under `:root.exp-glass`) can skin the whole app.
 *
 * Mounted once in Providers. Everything happens client-side after mount,
 * so SSR output is unaffected (experiments default OFF).
 */
export function ExperimentalUiSync() {
  const glassButtons = useExperimentalStore((s) => s.glassButtons);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("exp-glass", glassButtons);
  }, [glassButtons]);

  return null;
}

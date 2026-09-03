"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Background-run preference — when enabled, agent turns execute INSIDE the
 * E2B sandbox as background commands, so the work continues even if the
 * browser is closed, stopped, or minimized (E2B sandboxes are server-side
 * VMs that outlive the client connection). The browser reconnects on the
 * next visit and replays the progress.
 *
 * Falls back to the normal in-browser turn when no E2B key is configured or
 * the sandbox launch fails.
 */
interface BackgroundRunState {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

export const useBackgroundRunStore = create<BackgroundRunState>()(
  persist(
    (set) => ({
      enabled: true,
      setEnabled: (enabled) => set({ enabled }),
    }),
    { name: "background-run-storage" },
  ),
);

"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, useEffect, type ReactNode } from "react";
import { Toaster } from "sonner";
import { ThemeProvider } from "@/components/theme";
import { ExperimentalUiSync } from "@/components/experimental/experimental-ui";
import { TooltipProvider } from "@/components/ui";
import { GlobalErrorCapture } from "@/components/dev/global-error-capture";
import { applyPersistedBrand } from "@/lib/brand";
import { SandboxLifecycleSync } from "@/lib/e2b/lifecycle-client";
import { TurnHandoffController } from "@/lib/agent/turn-handoff";
import { useAuthStore } from "@/stores/auth-store";

interface ProvidersProps {
  children: ReactNode;
}

/**
 * AUTH BOOTSTRAP ON EVERY PAGE (the "key saved under the wrong user" fix).
 * The auth store's init() — which resolves the REAL user id (last-user-id →
 * Dexie users row) and unlocks the vault — used to run only where a useAuth
 * consumer happened to mount (chat page, some settings sections). A direct
 * load / refresh of Settings → E2B mounted none of them, so the store kept
 * the transient "local-user" with authResolved=false: the saved E2B key
 * landed on a phantom user row (or died on Dexie "Invalid key provided"),
 * the handoff prewarm then read the wrong user — no key → no pagehide
 * handoff → every running turn auto-cancelled on refresh. Mounting init()
 * here (the root providers wrap EVERY route) resolves the user everywhere
 * before any save can happen.
 */
function AuthInitializer() {
  useEffect(() => {
    void useAuthStore.getState().init();
  }, []);
  return null;
}

/** Apply saved color scheme on app mount so it persists across refreshes. */
function ColorSchemeInitializer() {
  useEffect(() => {
    // BRAND FIRST (the “highlighted text is always cyan” fix): the
    // persisted brand preset + font size apply on EVERY app load — they
    // used to be set only while the Settings → Appearance section was
    // mounted, so every fresh load reverted to the default cyan tokens.
    // Runs BEFORE the custom color-scheme block below so a full custom
    // scheme (when one is saved) still takes precedence.
    applyPersistedBrand();
    try {
      const saved = localStorage.getItem("onyx-color-scheme");
      if (!saved) return;
      const scheme = JSON.parse(saved);
      if (!scheme.name) return;
      const root = document.documentElement;
      // Set ALL color variables so every component (including sidebars,
      // popovers, tool cards) picks up the scheme.
      root.style.setProperty("--color-primary", scheme.primary);
      root.style.setProperty("--color-primary-foreground", scheme.primaryForeground);
      root.style.setProperty("--color-background", scheme.background);
      root.style.setProperty("--color-foreground", scheme.foreground);
      root.style.setProperty("--color-card", scheme.card);
      root.style.setProperty("--color-card-foreground", scheme.cardForeground);
      root.style.setProperty("--color-popover", scheme.popover);
      root.style.setProperty("--color-popover-foreground", scheme.popoverForeground);
      root.style.setProperty("--color-muted", scheme.muted);
      root.style.setProperty("--color-muted-foreground", scheme.mutedForeground);
      root.style.setProperty("--color-secondary", scheme.secondary);
      root.style.setProperty("--color-secondary-foreground", scheme.secondaryForeground);
      root.style.setProperty("--color-accent", scheme.accent);
      root.style.setProperty("--color-accent-foreground", scheme.accentForeground);
      root.style.setProperty("--color-border", scheme.border);
      root.style.setProperty("--color-input", scheme.input);
      root.style.setProperty("--color-ring", scheme.ring);
      root.style.setProperty("--color-brand", scheme.primary);
      root.style.setProperty("--color-brand-hover", scheme.primary);
      root.style.backgroundColor = scheme.background;
      root.style.color = scheme.foreground;
      root.classList.add("custom-scheme");
    } catch {
      // ignore
    }
  }, []);
  return null;
}

export function Providers({ children }: ProvidersProps) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5 * 60 * 1000,
            gcTime: 30 * 60 * 1000,
            refetchOnWindowFocus: false,
            refetchOnReconnect: "always",
            retry: 1,
          },
          mutations: {
            retry: 0,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ColorSchemeInitializer />
        <ExperimentalUiSync />
        {/* Auth bootstrap FIRST (see AuthInitializer note above). */}
        <AuthInitializer />
        {/* AUTOMATIC CLOSE-HANDOFF — mounts STRICTLY ABOVE SandboxLifecycleSync:
            its pagehide listener must run FIRST so a handed-off turn's
            sandbox is flagged detached-active before the auto-pause handler
            scans. "Send, close the app, come back to finished work" with no
            toggle required. */}
        <TurnHandoffController />
        {/* E2B persistency: pre-warms the lifecycle caches + auto-pauses
            workspace sandboxes (full state: filesystem + RAM) on app exit;
            the next open auto-resumes them via Sandbox.connect. */}
        <SandboxLifecycleSync />
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster richColors position="bottom-right" />
        {/* Global error nets — every capture lands in the log store, shown
            by the docked Logs panel in the chat workspace (no floating UI). */}
        <GlobalErrorCapture />
      </ThemeProvider>
    </QueryClientProvider>
  );
}

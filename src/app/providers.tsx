"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, useEffect, type ReactNode } from "react";
import { Toaster } from "sonner";
import { ThemeProvider } from "@/components/theme";
import { ExperimentalUiSync } from "@/components/experimental/experimental-ui";
import { TooltipProvider } from "@/components/ui";

interface ProvidersProps {
  children: ReactNode;
}

/** Apply saved color scheme on app mount so it persists across refreshes. */
function ColorSchemeInitializer() {
  useEffect(() => {
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
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster richColors position="bottom-right" />
      </ThemeProvider>
    </QueryClientProvider>
  );
}

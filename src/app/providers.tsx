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
import { isLegacyClassicUrl } from "@/lib/agent/provider-url";
import { hydrateModelPrefFromRows } from "@/lib/agent/model-pref";

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

/**
 * LEGACY-ROW HEALER — the write-war winner against stale pre-migration tabs
 * (the "coming back changes my gen endpoint to text.pollinations" fix).
 *
 * Pre-migration app bundles (still running in old browser tabs) actively
 * DAMAGE the provider table: their mount effects re-seed a keyless row on
 * text.pollinations.ai AND their migrateLegacyPollinationsGateway runs the
 * OPPOSITE direction — it finds the row named "Pollinations" on
 * gen.pollinations.ai and FLIPS it onto the legacy host. Coming back to
 * such a tab therefore re-breaks the row the current app just healed.
 *
 * This root controller makes the CURRENT bundle win deterministically:
 *   · on boot (once the real user resolves) — sweep once;
 *   · on EVERY window focus/visibility return — sweep again, so any damage
 *     a ghost tab did while we were backgrounded is healed within
 *     milliseconds of the user returning to THIS tab.
 *
 * The sweep itself is migrateLegacyPollinationsGateway (new direction):
 * repoint-to-gen with the connected key + live models, delete when not
 * connected, and purge duplicate ghost rows. Cheap when nothing matches
 * (one indexed Dexie read).
 */
function LegacyRowHealer() {
  useEffect(() => {
    let stopped = false;

    const sweep = async () => {
      if (stopped || typeof document === "undefined") return;
      if (document.visibilityState === "hidden") return; // nothing to heal while hidden
      const { user, authResolved } = useAuthStore.getState();
      if (!authResolved || !user) return;
      try {
        // Quick pre-check: any "Pollinations" row on the legacy host at all?
        // (Keeps the common no-op sweep to a single Dexie read with no
        // dynamic-import churn.)
        const { aiProviderService } = await import("@/lib/services");
        const rows = await aiProviderService.list(user.id);
        const damaged = rows.some(
          (p) => p.name === "Pollinations" && isLegacyClassicUrl(p.base_url),
        );
        if (!damaged) return;
        const { migrateLegacyPollinationsGateway } = await import("@/lib/agent/pollinations-healer");
        await migrateLegacyPollinationsGateway(user.id);
        console.info(
          "[healer] repointed a legacy text.pollinations.ai provider row back to the gen gateway",
        );
      } catch {
        // best-effort — every AI turn re-runs the same guard lazily anyway
      }
    };

    const unsubAuth = useAuthStore.subscribe((s, prev) => {
      if (s.authResolved && s.authResolved !== prev.authResolved) void sweep();
    });

    const onFocus = () => void sweep();
    const onVisible = () => {
      if (document.visibilityState === "visible") void sweep();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);

    // Initial sweep (covers the case where auth resolved before mount).
    void sweep();

    return () => {
      stopped = true;
      unsubAuth();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return null;
}

/**
 * MODEL-PREF HYDRATOR — restores the user's picked model on EVERY route
 * (the "a non-chat route uses a fixed model instead of my selected model"
 * fix).
 *
 * The persisted model preference (onyx:selected-model) used to be re-applied
 * ONLY by ChatControls' mount effect — a chat-page-only component. On any
 * other route (projects, subagent dashboards, a fresh tab,
 * …) the chat store booted as {null, null}, so the resolution
 * chains saw "no selection" and silently fell to the first active
 * provider's FIRST catalog model (in the alphabetical Pollinations catalog:
 * community/CloudCompile/dots-studio-dots-3-note-preview:free). The user's
 * pick was never lost — it was never RESTORED off the chat page.
 *
 * This root controller hydrates the persisted pick into the chat store:
 *   · once auth resolves (boot), and
 *   · on every window focus / visibility return (cheap Dexie read + an
 *     idempotent guarded write).
 *
 * hydrateModelPrefFromRows never overwrites an explicit in-store selection
 * and never resurrects a deleted/healed provider row through the stale
 * preference — the same semantics the chat page's restore always had.
 */
function ModelPrefHydrator() {
  useEffect(() => {
    let stopped = false;

    const hydrate = async () => {
      if (stopped || typeof document === "undefined") return;
      if (document.visibilityState === "hidden") return;
      const { user, authResolved } = useAuthStore.getState();
      if (!authResolved || !user) return;
      try {
        const { aiProviderService } = await import("@/lib/services");
        const rows = await aiProviderService.list(user.id);
        hydrateModelPrefFromRows(rows);
      } catch {
        // best-effort — provider resolution re-runs the same hydration
        // against its own provider list at resolution time anyway
      }
    };

    const unsubAuth = useAuthStore.subscribe((s, prev) => {
      if (s.authResolved && s.authResolved !== prev.authResolved) void hydrate();
    });

    const onFocus = () => void hydrate();
    const onVisible = () => {
      if (document.visibilityState === "visible") void hydrate();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);

    void hydrate(); // initial (covers auth resolved before mount)

    return () => {
      stopped = true;
      unsubAuth();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
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
        {/* LEGACY-ROW HEALER — wins the write war against stale
            pre-migration tabs that flip the gen Pollinations row back onto
            the retired text.pollinations.ai host (see its doc comment). */}
        <LegacyRowHealer />
        {/* MODEL-PREF HYDRATOR — restores the user's picked model on every
            route so non-chat surfaces never fall back to a "fixed" first
            catalog model (see its doc comment). */}
        <ModelPrefHydrator />
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

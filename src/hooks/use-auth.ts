"use client";

import { useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore, resetInitState } from "@/stores";
import { authService } from "@/lib/services";
import { ApiError } from "@/lib/api-client";
import { ROUTES } from "@/lib/constants";
import type { User } from "@/types";

// ---------------------------------------------------------------------------
// Non-auth mode: the app runs locally with no login screen. The default
// user (`local-user`) is always considered authenticated. We still expose
// `login` / `register` / `logout` / `refreshToken` for components that
// import them, but they're thin no-ops that keep the default user in place.
// ---------------------------------------------------------------------------

const DEFAULT_USER: User = {
  id: "local-user",
  email: "user@onyxagent.local",
  full_name: "Local User",
  is_active: true,
  role: "ADMIN",
  created_at: new Date().toISOString(),
  avatar_url: null,
  onboarding_completed_at: null,
};

export function useAuth() {
  const router = useRouter();
  const { user, isAuthenticated, isLoading, setUser, setLoading, logout: storeLogout } =
    useAuthStore();

  // Run init once on mount. In non-auth mode this auto-creates the default
  // local user (if needed) and unlocks the vault. The store has a 5-second
  // timeout so this can never hang forever.
  useEffect(() => {
    void useAuthStore.getState().init();
  }, []);

  const login = useCallback(
    async (_email: string, _passphrase: string) => {
      setLoading(true);
      try {
        await useAuthStore.getState().init();
        resetInitState();
        setUser(useAuthStore.getState().user ?? DEFAULT_USER);
        useAuthStore.getState().setVaultUnlocked(true);
        router.push(ROUTES.CHAT);
        return { user: useAuthStore.getState().user ?? DEFAULT_USER, message: "Logged in" };
      } finally {
        setLoading(false);
      }
    },
    [router, setUser, setLoading],
  );

  const register = useCallback(
    async (_email: string, _fullName: string, _passphrase: string) => {
      await useAuthStore.getState().init();
      const u = useAuthStore.getState().user ?? DEFAULT_USER;
      return { id: u.id, email: u.email, full_name: u.full_name };
    },
    [],
  );

  const handleLogout = useCallback(async () => {
    try {
      await storeLogout();
    } catch {
      // Ignore logout errors — local state is already cleared by the store.
    } finally {
      // Stay on /chat — non-auth mode keeps the default user logged in.
      router.push(ROUTES.CHAT);
    }
  }, [storeLogout, router]);

  /**
   * Kept for backward compatibility — components may call `refreshToken()`
   * to force a re-check. In non-auth mode there's nothing to refresh, so we
   * just re-run init. Always returns true.
   */
  const refreshToken = useCallback(async () => {
    await useAuthStore.getState().init();
    return true;
  }, []);

  return {
    // Always authenticated in non-auth mode. Fall back to the default user
    // until init() resolves so consumers never see a null user during the
    // very first render.
    user: user ?? DEFAULT_USER,
    isAuthenticated: true,
    isLoading,
    login,
    register,
    logout: handleLogout,
    refreshToken,
  };
}

// Re-export so existing imports of `ApiError` from this hook module keep
// working (some components import { ApiError } from "@/hooks/use-auth").
export { ApiError };

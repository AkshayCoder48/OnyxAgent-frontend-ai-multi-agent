"use client";

import { create } from "zustand";
import type { User } from "@/types";
import { authService } from "@/lib/services";
import { isVaultUnlocked, restoreVaultFromSession } from "@/lib/crypto/vault";

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  vaultUnlocked: boolean;
  avatarVersion: number;
  /** Transient auth error message (set by login/register failures). */
  error: string | null;

  setUser: (user: User | null) => void;
  setLoading: (loading: boolean) => void;
  setVaultUnlocked: (unlocked: boolean) => void;
  setAvatarVersion: (v: number) => void;
  bumpAvatarVersion: () => void;
  /** Clear the transient `error` field. */
  clearError: () => void;
  init: () => Promise<void>;
  logout: () => Promise<void>;
  /** Email + passphrase login (legacy auth-screen entry point). In the
   *  backendless mode the default user is auto-created, so this is mostly
   *  used to switch to a different account when the user explicitly signs
   *  out and back in. */
  login: (email: string, passphrase: string) => Promise<void>;
  /** Email + passphrase registration (legacy auth-screen entry point). */
  register: (email: string, fullName: string, passphrase: string) => Promise<void>;
  /** Mark onboarding as complete by writing a timestamp on the user row. */
  completeOnboarding: () => Promise<void>;
}

const LAST_USER_ID_KEY = "agent-chat-app:last-user-id";

// ---------------------------------------------------------------------------
// Non-auth defaults — the app runs entirely locally without a login screen.
// A default user is auto-created on first launch (or reused on subsequent
// loads) so every part of the app that expects a `user.id` keeps working.
// ---------------------------------------------------------------------------

const DEFAULT_USER_ID = "local-user";
const DEFAULT_EMAIL = "user@onyxagent.local";
const DEFAULT_FULL_NAME = "Local User";
const DEFAULT_PASSPHRASE = "local-default-passphrase";

// Module-level init guard — but with a TIMEOUT so it can never hang forever.
let initDone = false;
let initPromise: Promise<void> | null = null;

export function resetInitState() {
  initDone = false;
  initPromise = null;
}

function getLastUserId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(LAST_USER_ID_KEY);
  } catch {
    return null;
  }
}

function setLastUserId(id: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (id === null) {
      window.localStorage.removeItem(LAST_USER_ID_KEY);
    } else {
      window.localStorage.setItem(LAST_USER_ID_KEY, id);
    }
  } catch {
    // best-effort
  }
}

// Timeout wrapper — ensures init never hangs forever.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("Timeout")), ms),
    ),
  ]);
}

/**
 * Build the default local User object. Used as a fallback when Dexie is
 * unavailable (e.g. SSR / private mode) so the UI still renders something.
 */
function makeDefaultUser(): User {
  return {
    id: DEFAULT_USER_ID,
    email: DEFAULT_EMAIL,
    full_name: DEFAULT_FULL_NAME,
    is_active: true,
    role: "ADMIN",
    created_at: new Date().toISOString(),
    avatar_url: null,
    onboarding_completed_at: null,
  };
}

export const useAuthStore = create<AuthState>((set) => ({
  // Non-auth mode: set the default user synchronously so components
  // that depend on user.id (like the file sidebar) work immediately
  // without waiting for the async init() to complete.
  user: {
    id: DEFAULT_USER_ID,
    email: DEFAULT_EMAIL,
    full_name: "Local User",
    is_active: true,
    role: "ADMIN",
    created_at: new Date().toISOString(),
    avatar_url: null,
    onboarding_completed_at: null,
  },
  isAuthenticated: true,
  isLoading: false,
  vaultUnlocked: true,
  avatarVersion: 0,
  error: null,

  setUser: (user) =>
    set({
      user,
      isAuthenticated: user !== null,
      isLoading: false,
    }),

  setLoading: (loading) => set({ isLoading: loading }),

  setVaultUnlocked: (unlocked) => set({ vaultUnlocked: unlocked }),

  setAvatarVersion: (v) => set({ avatarVersion: v }),

  bumpAvatarVersion: () => set((s) => ({ avatarVersion: s.avatarVersion + 1 })),

  clearError: () => set({ error: null }),

  login: async (email, passphrase) => {
    set({ isLoading: true, error: null });
    try {
      const user = await authService.login(email, passphrase);
      setLastUserId(user.id);
      set({
        user,
        isAuthenticated: true,
        vaultUnlocked: true,
        isLoading: false,
        error: null,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Login failed";
      set({ isLoading: false, error: msg });
      throw e;
    }
  },

  register: async (email, fullName, passphrase) => {
    set({ isLoading: true, error: null });
    try {
      const { user } = await authService.register(email, fullName, passphrase);
      setLastUserId(user.id);
      set({
        user,
        isAuthenticated: true,
        vaultUnlocked: true,
        isLoading: false,
        error: null,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Registration failed";
      set({ isLoading: false, error: msg });
      throw e;
    }
  },

  completeOnboarding: async () => {
    const u = useAuthStore.getState().user;
    if (!u) return;
    const now = new Date().toISOString();
    try {
      const { db } = await import("@/lib/db");
      await db.users.update(u.id, { onboarding_completed_at: now });
      set({ user: { ...u, onboarding_completed_at: now } });
    } catch {
      // best-effort — even if persist fails, advance the in-memory user so
      // the UI moves on instead of being stuck on the onboarding wizard.
      set({ user: { ...u, onboarding_completed_at: now } });
    }
  },

  init: async () => {
    // If already done, don't re-run (prevents flicker + infinite loops).
    if (initDone) return;
    // If already running, return the existing promise.
    if (initPromise) return initPromise;

    initPromise = (async () => {
      try {
        // Wrap in a 5-second timeout — if Dexie or crypto hangs, we bail out
        // and fall back to the default user so the UI doesn't spin forever.
        await withTimeout((async () => {
          // 1) Try to rehydrate the last-known user.
          const lastId = getLastUserId();
          let user: User | null = lastId
            ? await authService.getCurrentUser(lastId)
            : null;

          // 2) No previous user — try to register the default local user.
          //    register() creates the vault + unlocks it in one step.
          if (!user) {
            try {
              const { user: created } = await authService.register(
                DEFAULT_EMAIL,
                DEFAULT_FULL_NAME,
                DEFAULT_PASSPHRASE,
              );
              user = created;
            } catch {
              // Email already exists (last-user-id was wiped). Log in to
              // unlock the vault with the known default passphrase.
              try {
                user = await authService.login(
                  DEFAULT_EMAIL,
                DEFAULT_PASSPHRASE,
                );
              } catch {
                // Give up — fall back to an in-memory default user so the
                // UI still renders. Vault-dependent features may not work.
                user = makeDefaultUser();
              }
            }
          } else {
            // 3) Returning user — try to restore the vault from sessionStorage.
            try {
              const restored = await restoreVaultFromSession();
              if (!restored && !isVaultUnlocked()) {
                // Vault wasn't in storage — unlock with the default
                // passphrase (works for users we auto-created).
                try {
                  await authService.login(DEFAULT_EMAIL, DEFAULT_PASSPHRASE);
                } catch {
                  // If login fails the user was created with a different
                  // passphrase in a previous life. We can't unlock the
                  // vault, but we still set vaultUnlocked=true so the
                  // auth guard (kept for back-compat) doesn't redirect.
                }
              }
            } catch {
              try {
                sessionStorage.removeItem("__vault_key_jwk__");
              } catch {}
            }
          }

          setLastUserId(user.id);
          set({
            user,
            isAuthenticated: true,
            vaultUnlocked: true,
            isLoading: false,
          });
        })(), 5000);
      } catch {
        // Timeout or error — fall back to the default local user so the UI
        // never hangs. Vault-dependent features may not work in this state.
        const fallback = makeDefaultUser();
        setLastUserId(fallback.id);
        set({
          user: fallback,
          isAuthenticated: true,
          vaultUnlocked: true,
          isLoading: false,
        });
      } finally {
        initDone = true;
        initPromise = null;
      }
    })();

    return initPromise;
  },

  logout: async () => {
    // Non-auth mode: logout is a no-op. Keep the default user logged in so
    // the app continues to work without a login screen.
    try {
      await authService.logout();
    } catch {
      // Best-effort
    }
    const fallback = makeDefaultUser();
    setLastUserId(fallback.id);
    set({
      user: fallback,
      isAuthenticated: true,
      isLoading: false,
      vaultUnlocked: true,
    });
  },
}));

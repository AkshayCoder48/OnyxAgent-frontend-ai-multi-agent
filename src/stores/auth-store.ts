"use client";

import { create } from "zustand";
import type { User } from "@/types";
import { authService } from "@/lib/services";
import { isVaultUnlocked, restoreVaultFromSession } from "@/lib/crypto/vault";
import { getOrCreateGuestName, isLegacyLocalName } from "@/lib/guest-name";

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /** True once `init()` has resolved the real user (register/login/rehydrate
   *  or fallback). Data hooks key their queries on `user.id` — but the store
   *  SYNCHRONOUSLY starts with the transient "local-user" id, so reading
   *  providers/settings before `authResolved` would query the WRONG id and
   *  render stale rows (deleted "OnyxAI" ghosts) while hiding the user's
   *  real data. Consumers gate on this flag instead of racing init(). */
  authResolved: boolean;
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
const DEFAULT_PASSPHRASE = "local-default-passphrase";

/** Hydration-stable placeholder for the initial (pre-init) user name —
 *  the same string on the server and the first client render, so no
 *  hydration mismatch. init() swaps in the real (random, per-install)
 *  guest name from getOrCreateGuestName() once the user resolves. */
const INITIAL_USER_NAME = "Guest";

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

// ── AI-PROVIDER OWNERSHIP RECONCILE (stale "OnyxAI" ghost fix) ────────────
// Old app versions seeded an "OnyxAI" provider row under the TRANSIENT
// pre-auth id ("local-user") and adopted rows across ids, so rows survive
// in Dexie that no Settings view (keyed on the resolved user id) can show
// or delete — they resurfaced in the chat model picker via the old
// load-ALL fallback. Once init resolves the REAL user we heal the table:
//  - the user HAS providers under their own id → PURGE foreign rows that
//    belong to the transient id or to users that no longer exist (the
//    ghosts die permanently); other LIVE users' rows are never touched.
//  - the user has NO providers but foreign rows exist → ADOPT them
//    (rare race: providers created while the transient id was active),
//    EXCEPT rows that are recognizably the legacy OnyxAI seed (name
//    "OnyxAI"/"Onyx AI" or the QVAC base URL http://localhost:11434/v1)
//    — those are purged, never adopted (they would resurrect as ghosts).
let reconcileDone = false;
async function reconcileProviderOwnership(userId: string): Promise<void> {
  if (reconcileDone) return;
  reconcileDone = true;
  try {
    const { db } = await import("@/lib/db");
    const isLegacySeed = (r: { name?: string; base_url?: string }) =>
      /^onyx\s*ai$/i.test((r.name ?? "").trim()) ||
      /^https?:\/\/localhost:11434\/v1\/?$/i.test((r.base_url ?? "").trim());
    const own = await db.ai_providers.where("user_id").equals(userId).toArray();
    const foreign = (await db.ai_providers.toArray()).filter(
      (r) => r.user_id !== userId,
    );
    if (own.length > 0) {
      if (foreign.length === 0) return;
      const liveIds = new Set((await db.users.toArray()).map((u) => u.id));
      liveIds.add(userId);
      const stale = foreign.filter(
        (r) => r.user_id === DEFAULT_USER_ID || !liveIds.has(r.user_id),
      );
      if (stale.length > 0) {
        await db.ai_providers.bulkDelete(stale.map((r) => r.id));
        console.info(
          `[auth] purged ${stale.length} stale AI provider row(s) left under obsolete user ids`,
        );
      }
      return;
    }
    if (foreign.length === 0) return;
    const adoptable = foreign.filter((r) => !isLegacySeed(r));
    const ghosts = foreign.filter((r) => isLegacySeed(r));
    if (adoptable.length > 0) {
      await db.ai_providers.bulkPut(
        adoptable.map((r) => ({ ...r, user_id: userId, updated_at: new Date().toISOString() })),
      );
      console.info(
        `[auth] adopted ${adoptable.length} AI provider row(s) created before auth resolved`,
      );
    }
    if (ghosts.length > 0) {
      await db.ai_providers.bulkDelete(ghosts.map((r) => r.id));
      console.info(
        `[auth] purged ${ghosts.length} legacy OnyxAI seed row(s)`,
      );
    }
  } catch {
    // Dexie unavailable (private mode / SSR) — non-fatal; the reactive
    // loading fix alone already prevents the ghosts from rendering.
  }
}

/**
 * Build the default local User object. Used as a fallback when Dexie is
 * unavailable (e.g. SSR / private mode) so the UI still renders something.
 */
function makeDefaultUser(): User {
  return {
    id: DEFAULT_USER_ID,
    email: DEFAULT_EMAIL,
    // Random friendly name, stable per install ("Brave Falcon"-style) —
    // replaces the old literal "Local User".
    full_name: getOrCreateGuestName(),
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
    // "Guest" pre-init (hydration-stable); init() replaces it with the
    // per-install random guest name — or the healed legacy name.
    full_name: INITIAL_USER_NAME,
    is_active: true,
    role: "ADMIN",
    created_at: new Date().toISOString(),
    avatar_url: null,
    onboarding_completed_at: null,
  },
  isAuthenticated: true,
  isLoading: false,
  // The transient id above is NOT authoritative until init() resolves.
  authResolved: false,
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
        authResolved: true,
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
        authResolved: true,
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
                getOrCreateGuestName(),
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

          // LEGACY NAME HEALING: installs created before the random-guest-
          // name change still carry the literal "Local User" in their Dexie
          // users row (surfacing as "Welcome to OnyxAgent, Local"). Rename
          // to this install's random guest name — stable across reloads
          // (persisted by getOrCreateGuestName) and updated in the DB so
          // the heal runs exactly once.
          if (isLegacyLocalName(user.full_name)) {
            const guestName = getOrCreateGuestName();
            try {
              const { db } = await import("@/lib/db");
              await db.users.update(user.id, {
                full_name: guestName,
                updated_at: new Date().toISOString(),
              });
            } catch {
              // Dexie unavailable — the in-memory rename below still applies
              // for this session; the DB row heals on a later launch.
            }
            user = { ...user, full_name: guestName };
          }

          setLastUserId(user.id);
          set({
            user,
            isAuthenticated: true,
            vaultUnlocked: true,
            isLoading: false,
            authResolved: true,
          });
          // Heal the ai_providers table (stale OnyxAI ghosts under the
          // transient pre-auth id) once the real user id is known.
          if (user.id !== DEFAULT_USER_ID) {
            void reconcileProviderOwnership(user.id);
          }
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
          authResolved: true,
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
      authResolved: true,
    });
  },
}));

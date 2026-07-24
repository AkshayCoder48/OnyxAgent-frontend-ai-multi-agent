import { authService } from "@/lib/services";
import { useAuthStore } from "@/stores";
import type { User } from "@/types";

const STORAGE_KEY = "onboarding.completed_at";
/** Furthest step the user has reached — drives resume-from-last-step. */
const PROGRESS_KEY = "onboarding.furthest_step";
/** localStorage key the auth store writes the last signed-in user id to. */
const LAST_USER_ID_KEY = "agent-chat-app:last-user-id";

export const ONBOARDING_STEPS = ["welcome", "agent", "data", "team", "done"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/**
 * Source of truth for "is the user past onboarding":
 *   1. backend `user.onboarding_completed_at` (preferred — survives device swaps)
 *   2. localStorage flag (dev / pre-backend-wired fallback)
 *
 * Pass the `user` object when known (from `useAuth().user`); the helper falls
 * back to localStorage when called pre-auth or in places without user context.
 */
export function isOnboardingCompleted(user?: User | null): boolean {
  if (user && user.onboarding_completed_at) return true;
  if (typeof window === "undefined") return true;
  return Boolean(window.localStorage.getItem(STORAGE_KEY));
}

/**
 * Best-effort read of the current user id from either the auth store (when
 * running in a React context where it's already hydrated) or localStorage
 * (the auth store persists the last signed-in id there on login/register).
 */
function getCurrentUserId(): string | null {
  const fromStore = useAuthStore.getState().user?.id;
  if (fromStore) return fromStore;
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(LAST_USER_ID_KEY);
  } catch {
    return null;
  }
}

/**
 * Persist completion. Best-effort calls `authService.completeOnboarding(userId)`
 * so it's durable across reloads, AND writes localStorage so the banner hides
 * immediately without a round-trip. Both fail silently — the user-visible flow
 * shouldn't block on either side-effect.
 */
export async function markOnboardingCompleted(): Promise<void> {
  if (typeof window === "undefined") return;
  const now = new Date().toISOString();
  window.localStorage.setItem(STORAGE_KEY, now);
  try {
    const userId = getCurrentUserId();
    if (userId) {
      await authService.completeOnboarding(userId);
      // Refresh the in-memory user so `useAuth().user.onboarding_completed_at`
      // is set immediately — otherwise the banner / middleware check keeps
      // reading the stale `null` value until the next full reload.
      const updated = await authService.getCurrentUser(userId);
      if (updated) useAuthStore.getState().setUser(updated);
    }
  } catch {
    // Vault may not be unlocked, user row may be missing, etc. — localStorage
    // covers us for the immediate UX; the next auth init will rehydrate.
  }
}

export function resetOnboarding(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
  window.localStorage.removeItem(PROGRESS_KEY);
}

/**
 * Record that the user reached `step` (only ever advances — never rewinds, so
 * navigating Back doesn't lose progress). Best-effort: never throws.
 */
export function markStepReached(step: OnboardingStep): void {
  if (typeof window === "undefined") return;
  try {
    const prev = window.localStorage.getItem(PROGRESS_KEY) as OnboardingStep | null;
    if (prev && stepIndex(prev) >= stepIndex(step)) return;
    window.localStorage.setItem(PROGRESS_KEY, step);
  } catch {
    // Private mode / storage disabled — resume just falls back to welcome.
  }
}

/**
 * Where to send a user who lands on `/onboarding`: the furthest step they
 * reached (so they resume mid-flow), defaulting to the first step. A persisted
 * "done" resolves back to "welcome" — a completed flow shouldn't deep-link to
 * the finish screen; the higher-level completed check handles the real skip.
 */
export function getResumeStep(): OnboardingStep {
  if (typeof window === "undefined") return ONBOARDING_STEPS[0];
  try {
    const saved = window.localStorage.getItem(PROGRESS_KEY) as OnboardingStep | null;
    if (saved && ONBOARDING_STEPS.includes(saved) && saved !== "done") {
      return saved;
    }
  } catch {
    // Ignore — fall through to the first step.
  }
  return ONBOARDING_STEPS[0];
}

export function nextStep(current: OnboardingStep): OnboardingStep | null {
  const i = ONBOARDING_STEPS.indexOf(current);
  if (i < 0 || i >= ONBOARDING_STEPS.length - 1) return null;
  return ONBOARDING_STEPS[i + 1] ?? null;
}

export function prevStep(current: OnboardingStep): OnboardingStep | null {
  const i = ONBOARDING_STEPS.indexOf(current);
  if (i <= 0) return null;
  return ONBOARDING_STEPS[i - 1] ?? null;
}

export function stepIndex(step: OnboardingStep): number {
  return ONBOARDING_STEPS.indexOf(step);
}

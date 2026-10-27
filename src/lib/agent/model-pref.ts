"use client";

// ============================================================================
// Model preference — the ONE owner of the persisted "which model did the
// user pick" key (the "Business ignores my selected model" fix).
//
// ROOT CAUSE this module closes: the chat selection lived in TWO layers —
// the in-memory chat store (reset on every reload / fresh tab) and the
// persisted localStorage preference. The ONLY code that ever re-applied the
// persisted preference was ChatControls' mount effect — a chat-page-only
// component. On EVERY other route (Business wizard, projects, subagent
// dashboards, a refresh on /business, a direct /business visit in a new
// tab) the store booted as {null, null}, so the resolution chains saw "no
// selection" and fell to the first active provider's FIRST catalog model —
// which in the live Pollinations catalog (alphabetical order) is
// community/CloudCompile/dots-studio-dots-3-note-preview:free. The user
// experienced exactly that: "still using fixed model not the selected
// model" — their pick was never lost, it was never RESTORED off the chat
// page.
//
// Contract (BINDING):
//   - saveModelPref / loadModelPref — the single read/write pair for the
//     preference key. Every writer (chat picker, code-app picker, restore
//     paths) goes through here; no other module may hardcode the key.
//   - hydrateModelPrefFromRows — restores the persisted pick into the chat
//     store, ONLY when the store holds no explicit selection, and ONLY when
//     the pick's provider still exists (a healed/deleted legacy row must
//     never resurrect through the preference). Safe to call anywhere
//     (root boot controller, business lane, focus sweeps) — idempotent.
//
// The user's picked model then survives refresh, route changes and fresh
// tabs — and Business Mode resolves it model-first, together with the
// provider that offers it (provider-resolution).
// ============================================================================

import { useChatStore } from "@/stores/chat-store";

/** localStorage persistence for the model preference (model-desync PRD §14):
 *  saved on every pick, restored on boot + on every lane that resolves a
 *  model. */
export const MODEL_PREF_KEY = "onyx:selected-model";

export interface ModelPref {
  providerId: string | null;
  model: string | null;
}

export function saveModelPref(providerId: string | null, model: string | null): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MODEL_PREF_KEY, JSON.stringify({ providerId, model }));
  } catch {
    // Storage unavailable (private mode / quota) — non-fatal, session-only selection.
  }
}

export function loadModelPref(): ModelPref | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(MODEL_PREF_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { providerId?: string | null; model?: string | null };
    return { providerId: parsed.providerId ?? null, model: parsed.model ?? null };
  } catch {
    return null;
  }
}

/**
 * Restore the persisted pick into the chat store.
 *
 * Guards (in order):
 *   1. An EXPLICIT store selection always wins — hydration only fills the
 *      empty case (fresh boot / a route that never mounted the chat picker).
 *   2. An explicit "Default" preference ({null, null}) stays Default — the
 *      resolution chains' documented fallback applies (first active
 *      provider → its first model), exactly as on the chat page.
 *   3. The pick's provider must still exist in the given rows — a deleted
 *      or healed-away row (e.g. a legacy text.pollinations.ai row removed
 *      by the root LegacyRowHealer) must not resurrect through the
 *      preference.
 *
 * Returns true when a preference was adopted into the store.
 */
export function hydrateModelPrefFromRows(
  rows: ReadonlyArray<{ id: string }>,
): boolean {
  if (typeof window === "undefined") return false;
  const store = useChatStore.getState();
  if (store.selectedProviderId != null || store.selectedModel != null) return false;
  const pref = loadModelPref();
  if (!pref) return false;
  if (pref.providerId == null && pref.model == null) return false;
  if (pref.providerId != null && !rows.some((r) => r.id === pref.providerId)) {
    return false;
  }
  store.setSelectedProviderId(pref.providerId);
  store.setSelectedModel(pref.model);
  return true;
}

/**
 * OnyxAI provider seeding — makes OnyxAI (QVAC-powered local inference) the
 * app's OPTIONAL DEFAULT provider: the row is created automatically so it
 * appears in the model picker out of the box, but it stays inactive until the
 * user activates it (or it becomes the default when no other provider exists).
 *
 * Idempotent + dismissible: if the user deletes the OnyxAI provider, a
 * per-user dismissal flag stops the seeder from re-creating it.
 *
 * SINGLE-USER semantics (mirrors the services layer's own convention): the
 * app boots with a transient pre-auth "local-user" before `useAuthStore`
 * rehydration resolves, so a row may exist under a different user id. We
 * ADOPT any existing OnyxAI row (re-pointing it to the current user) instead
 * of duplicating one per identity.
 */
import { db, type AIProviderRow } from "@/lib/db";
import { aiProviderService } from "@/lib/services";
import {
  ONYXAI_PROVIDER_NAME,
  ONYXAI_DEFAULT_BASE_URL,
  ONYXAI_DEFAULT_MODELS,
} from "@/lib/onyxai/catalog";

const DISMISS_KEY = (userId: string) => `onyx:onyxai-dismissed:${userId}`;

/** Dismiss OnyxAI seeding for this user (called when they delete the row). */
export function dismissOnyxAiProvider(userId: string): void {
  try {
    window.localStorage.setItem(DISMISS_KEY(userId), "1");
    // Dismiss under the transient pre-auth id too — otherwise a seed that
    // ran before rehydration would recreate the row after dismissal.
    window.localStorage.setItem(DISMISS_KEY("local-user"), "1");
  } catch {
    // localStorage unavailable — seeding may return after a reset; harmless.
  }
}

/** Re-enable OnyxAI seeding (user re-adds it from Settings → OnyxAI). */
export function undismissOnyxAiProvider(userId: string): void {
  try {
    window.localStorage.removeItem(DISMISS_KEY(userId));
    window.localStorage.removeItem(DISMISS_KEY("local-user"));
  } catch {
    // ignore
  }
}

/** Is OnyxAI seeding dismissed for this user? */
export function isOnyxAiDismissed(userId: string): boolean {
  try {
    return (
      window.localStorage.getItem(DISMISS_KEY(userId)) === "1" ||
      window.localStorage.getItem(DISMISS_KEY("local-user")) === "1"
    );
  } catch {
    return false;
  }
}

/**
 * Find the user's OnyxAI provider row, if any — prefers the caller's row,
 * falls back to any OnyxAI row (single-user local app; the caller's id can
 * be the transient pre-auth "local-user" while the row carries the
 * post-init id, and vice versa).
 */
export async function findOnyxAiProvider(userId: string): Promise<AIProviderRow | undefined> {
  const all = await db.ai_providers.toArray();
  return (
    all.find((r) => r.name === ONYXAI_PROVIDER_NAME && r.user_id === userId) ??
    all.find((r) => r.name === ONYXAI_PROVIDER_NAME)
  );
}

/**
 * Ensure the OnyxAI provider row exists — creates it on first use (inactive
 * unless it would be the ONLY provider, in which case it becomes the default).
 * Safe to call on every mount: one cheap table read, no per-identity
 * duplicates (existing rows under other user ids are adopted).
 */
export async function ensureOnyxAiProvider(userId: string): Promise<AIProviderRow | undefined> {
  if (!userId) return undefined;
  if (isOnyxAiDismissed(userId)) return undefined;
  try {
    const all = await db.ai_providers.toArray();
    const own = all.find(
      (r) => r.name === ONYXAI_PROVIDER_NAME && r.user_id === userId,
    );
    if (own) return own;

    // Adopt an existing OnyxAI row created under a different (transient or
    // previous) user id instead of duplicating it.
    const foreign = all.find((r) => r.name === ONYXAI_PROVIDER_NAME);
    if (foreign) {
      await db.ai_providers.update(foreign.id, {
        user_id: userId,
        updated_at: new Date().toISOString(),
      });
      return { ...foreign, user_id: userId };
    }

    // Create the OnyxAI provider. It becomes the DEFAULT (active) only when
    // the user has no other provider — otherwise it's present but optional.
    const hasOtherProvider = all.some((r) => r.name !== ONYXAI_PROVIDER_NAME);
    const created = await aiProviderService.create(userId, {
      name: ONYXAI_PROVIDER_NAME,
      base_url: ONYXAI_DEFAULT_BASE_URL,
      api_key: "",
      models: [...ONYXAI_DEFAULT_MODELS],
      model_type: "chat",
      tools_enabled: true,
      is_active: !hasOtherProvider,
    });
    return created;
  } catch (e) {
    // Vault not unlocked / table unavailable — retry on the next mount.
    console.warn("[onyxai] provider seed skipped:", e);
    return undefined;
  }
}

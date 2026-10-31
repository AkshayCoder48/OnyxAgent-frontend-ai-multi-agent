"use client";

// ============================================================================
// Pollinations provider healer — the official gen.pollinations.ai gateway.
//
// Extracted from the removed Business Mode LLM layer (lib/business/llm.ts)
// because it is APP-WIDE infrastructure, not business code: the legacy-row
// sweep runs on every provider refresh (provider-resolution), every app boot
// and every window refocus (LegacyRowHealer in app/providers.tsx), and the
// authenticated-gateway upsert serves the Pollinations settings surface.
// ============================================================================

import { aiProviderService, settingsService } from "@/lib/services";
import {
  POLLINATIONS_TEXT_BASE_URL,
  textModelIds,
  upsertTextProvider,
} from "@/lib/pollinations/provider-sync";
import { fetchPollinationsModels } from "@/lib/pollinations/api";

/**
 * The user's connected Pollinations (BYOP) key, read straight from the
 * encrypted settings store — the pollinations zustand store is only
 * initialized inside the settings UI, so these flows must not depend on
 * it. Null when not connected or the connection expired.
 */
async function connectedPollinationsKey(userId: string): Promise<string | null> {
  const { token, meta } = await settingsService.getPollinationsConnection(userId);
  if (!token) return null;
  const expired =
    !!meta?.expiresAt && new Date(meta.expiresAt).getTime() <= Date.now();
  return expired ? null : token;
}

/**
 * Add (or refresh) the official Pollinations text provider — the NEW
 * authenticated gateway (user directive: real API, with auth):
 *
 *   base   https://gen.pollinations.ai/v1  (the app appends /chat/completions)
 *   auth   Bearer <the user's connected Pollinations key>
 *   models the LIVE catalogue (publisher/model ids rotate — never hardcoded;
 *           the same source the Pollinations settings UI uses)
 *
 * Requires the user to be connected (Settings → Pollinations): the BYOP
 * connection key IS the API key — there is no keyless tier anymore. Throws a
 * friendly error when not connected; callers route the user to the
 * Pollinations settings page. Returns the live model count now on the row.
 */
export async function addPollinationsProvider(userId: string): Promise<number> {
  const token = await connectedPollinationsKey(userId);
  if (!token) {
    throw new Error(
      "Connect your Pollinations account first (Settings → Pollinations) — the official gen.pollinations.ai API requires your own key.",
    );
  }
  const models = await fetchPollinationsModels();
  const result = await upsertTextProvider(userId, token, models);
  return result.modelCount;
}

/**
 * Self-limiting migration — NEW-API direction: every "Pollinations" provider
 * row still pointing at the RETIRED keyless text.pollinations.ai endpoint is
 * moved to the authenticated gateway.
 *
 *   connected → repoint the FIRST legacy row to gen.pollinations.ai/v1
 *               (attach the connection key, refresh models from the live
 *               catalogue, reset no_prefix) and DELETE any extra legacy rows
 *   not conn. → delete the dead rows (the keyless tier is gone — that base
 *               URL can never authenticate with the new API)
 *
 * WHY "delete extras": pre-migration app bundles (still running in stale
 * browser tabs) both RE-SEED a keyless legacy row on mount AND FLIP the
 * user's gen row back onto the legacy host (the old migration ran the
 * OPPOSITE direction). This sweep therefore heals ALL matching rows in one
 * pass — repoint one, purge the rest — so a ghost tab can never leave
 * duplicate legacy rows behind.
 *
 * No-op once no legacy row matches (cheap to call on every provider refresh,
 * every app boot and every window refocus — see LegacyRowHealer in
 * app/providers.tsx).
 */
export async function migrateLegacyPollinationsGateway(userId: string): Promise<void> {
  try {
    const providers = await aiProviderService.list(userId);
    const legacyRows = providers.filter(
      (p) => p.name === "Pollinations" && p.base_url.includes("text.pollinations.ai"),
    );
    if (legacyRows.length === 0) return;
    const token = await connectedPollinationsKey(userId);
    if (token) {
      const [primary, ...extras] = legacyRows;
      if (primary) {
        const models = await fetchPollinationsModels();
        await aiProviderService.update(primary.id, {
          base_url: POLLINATIONS_TEXT_BASE_URL,
          api_key: token,
          models: textModelIds(models),
          no_prefix: false,
          is_active: true,
        });
      }
      // A healthy gen row exists now — any additional legacy rows (re-seeded
      // by a stale pre-migration tab) are pure ghosts: delete, never adopt.
      // (When even the primary repoint was skipped, extras includes it.)
      for (const extra of extras) {
        await aiProviderService.delete(extra.id).catch(() => undefined);
      }
    } else {
      // Keyless tier is retired — legacy rows with no key to attach can
      // never work again. Remove them so the honest provider gate + connect
      // CTA take over.
      for (const row of legacyRows) {
        await aiProviderService.delete(row.id).catch(() => undefined);
      }
    }
  } catch {
    // Best-effort — provider listing errors surface through the UI paths.
  }
}

"use client";

// ============================================================================
// SHARED provider/model resolution + endpoint construction (endpoint-migration
// PRD §5/§8/§11).
//
// ONE place answers the two questions every AI workflow must answer the same
// way:
//
//   1. WHICH provider row serves the CURRENTLY SELECTED model?  → model-first
//      resolution (the chat store's selectedModel resolves together with the
//      provider that OFFERS it — a stale selectedProviderId pointing at a
//      deleted/legacy row can never send a model to a gateway that doesn't
//      serve it; this is the Classic-API-404 fix generalized to every
//      workflow, everywhere).
//
//   2. WHAT is the chat-completions URL for a provider?          →
//      chatCompletionsUrl() — the single construction (base + optional
//      /chat/completions, honoring the row's no_prefix flag). No workflow
//      builds its own URL, so no specialized path can drift to a different
//      endpoint (PRD §5: "Do not construct a separate base URL").
//
// Plus the LEGACY-CLASSIC GUARD: the retired text.pollinations.ai (Classic)
// endpoint can never serve gen-catalog model ids — it answers the
// "…isn't on the Classic API" 404. listUsableProviders() self-heals any stale
// row (repoint-to-gen with the connected key / delete when not connected) and
// NEVER returns a classic-URL row, so no caller can reach the legacy endpoint
// by accident.
//
// STATUS CAPTIONS ARE THE ONE EXCEPTION to shared-provider resolution — by
// design they never touch this module: they run keyless on the free-catalog
// tier through the dedicated /api/status-caption route (no user key, no
// provider rows, no selection). Nothing here may be imported there.
// ============================================================================

import { aiProviderService } from "@/lib/services";
import type { AIProviderRow } from "@/lib/db";
import {
  chatCompletionsUrl,
  isLegacyClassicUrl,
} from "./provider-url";

// Re-exported for the existing importers (runtime, subagent-runtime,
// use-chat, provider-diagnostics) — the pure
// helpers live in the leaf ./provider-url so the service layer and the
// server-side background lanes can share them without a module cycle.
export { chatCompletionsUrl, isLegacyClassicRow, isLegacyClassicUrl, LEGACY_CLASSIC_HOST };

/**
 * List the user's providers with the LEGACY-CLASSIC GUARD applied:
 *
 *   - a stale "Pollinations" row on text.pollinations.ai is self-healed
 *     FIRST (migrateLegacyPollinationsGateway: repoint to the authenticated
 *     gen.pollinations.ai gateway when the account is connected, delete the
 *     dead row when it isn't), then the list is re-read;
 *   - any classic-URL row that somehow survived the migration is filtered
 *     out — belt and braces: the legacy endpoint is unreachable from every
 *     caller of this function.
 *
 * Idempotent + best-effort: migration failures never block resolution (the
 * stale row is simply excluded).
 */
export async function listUsableProviders(userId: string): Promise<AIProviderRow[]> {
  let providers = await aiProviderService.list(userId);
  // MIGRATION TRIGGER — host-based, not name-based (renamed-row fix): a
  // row named anything other than exactly "Pollinations" that still points
  // at text.pollinations.ai used to skip the healer entirely and then get
  // dropped by the filter below — the user's provider silently vanished
  // from every resolution chain while Settings still showed the row.
  // Any legacy-host row triggers the self-heal; the healer repoints
  // connected rows (keeping their custom names) and deletes dead ones.
  if (providers.some((p) => isLegacyClassicUrl(p.base_url))) {
    // Dynamic import: keeps the agent layer free of a static healer
    // dependency (and out of the subagent bundle unless actually needed).
    const { migrateLegacyPollinationsGateway } = await import("./pollinations-healer");
    await migrateLegacyPollinationsGateway(userId).catch(() => undefined);
    providers = await aiProviderService.list(userId);
  }
  return providers.filter((p) => !isLegacyClassicUrl(p.base_url));
}

/**
 * MODEL-FIRST provider resolution: the provider that OFFERS the selected
 * model. Active providers are preferred; inactive ones still match when the
 * model lives only there. Returns undefined when no provider lists the model
 * (the caller's providerId chain then applies, and an orphaned selection
 * falls back to the provider's first model instead of a guaranteed-404 id).
 */
export function resolveProviderForModel(
  providers: AIProviderRow[],
  selectedModel: string | null | undefined,
): AIProviderRow | undefined {
  if (!selectedModel) return undefined;
  return (
    providers.find((p) => p.is_active && (p.models ?? []).includes(selectedModel)) ??
    providers.find((p) => (p.models ?? []).includes(selectedModel))
  );
}

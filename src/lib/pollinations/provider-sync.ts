/**
 * Pollinations ⇄ AI Providers sync — the BYOP "text provider" bridge.
 *
 * WHEN A USER CONNECTS their Pollen account (BYOP OAuth, or a pasted key),
 * the connection key is already a fully-scoped Pollinations API key. This
 * module mirrors it into the app's standard AI-provider config as
 * "Pollinations" (OpenAI-compatible Chat Completions at
 * https://gen.pollinations.ai/v1/chat/completions), so the connected account
 * is immediately selectable for CHAT — not just media generation.
 *
 * MODEL LIST: always derived from the LIVE catalogue the store holds
 * (fetched fresh from the instance — never hardcoded). Only available
 * chat-text models are included; free models are ordered to the top,
 * mirroring the "free / recommended first" ordering of the settings UI.
 *
 * OWNERSHIP RULES:
 *   - connect()      → upsert (create, or rotate key + refresh models)
 *   - init()         → ONE-TIME backfill for users connected before this
 *                      feature (flag-persisted); a user who deletes the
 *                      provider manually is never fighting auto-recreation
 *   - refreshModels()→ models-only refresh while the synced row exists
 *   - disconnect()   → the synced row is removed (the key is revoked)
 *
 * Rows are matched by name + the official gen.pollinations.ai base URL —
 * user-created providers with other names/URLs are never touched.
 */
import { aiProviderService } from "@/lib/services";
import { isFreeModel, isUnavailable } from "./capabilities";
import type { PollinationsModel } from "./types";

/** Row name of the auto-synced provider. */
export const POLLINATIONS_PROVIDER_NAME = "Pollinations";
/** OpenAI-compatible base — the app appends `/chat/completions`
 * (AIProviderRow.no_prefix stays false), landing on the official
 * POST https://gen.pollinations.ai/v1/chat/completions endpoint. */
export const POLLINATIONS_TEXT_BASE_URL = "https://gen.pollinations.ai/v1";

/** extra key that records the one-time init backfill happened. */
export const TEXT_PROVIDER_BACKFILL_FLAG = "pollinations_text_provider_backfilled";

export interface TextProviderSyncResult {
  id: string | null;
  created: boolean;
  modelCount: number;
}

const lc = (list: string[] | undefined) => (list ?? []).map((s) => s.toLowerCase());

/** True when the catalogue entry is a CHAT-text model (text in AND out —
 * embeddings take text in but do not chat; realtime/audio are separate
 * surfaces). Uses the canonical `category`, falling back to modalities only
 * when the provider sent none. */
function isChatTextModel(m: PollinationsModel): boolean {
  if (m.category) return m.category === "text";
  const input = lc(m.input_modalities);
  const output = lc(m.output_modalities);
  return input.includes("text") && output.includes("text");
}

/**
 * Chat-usable model ids from the LIVE catalogue: available, text-category,
 * tools-capable (or tools-unknown — never the explicit `tools: false` ones).
 * FREE models are sorted to the top, then tools-capable, then alphabetical —
 * the same "free first" policy the Pollinations settings UI highlights.
 */
export function textModelIds(models: PollinationsModel[]): string[] {
  const eligible = models.filter(
    (m) => !isUnavailable(m) && isChatTextModel(m) && m.tools !== false,
  );
  const freeFirst = (m: PollinationsModel) => (isFreeModel(m) ? 0 : 1);
  const toolsFirst = (m: PollinationsModel) => (m.tools === true ? 0 : 1);
  return eligible
    .slice()
    .sort(
      (a, b) =>
        freeFirst(a) - freeFirst(b) ||
        toolsFirst(a) - toolsFirst(b) ||
        a.name.localeCompare(b.name),
    )
    .map((m) => m.name);
}

/** The auto-synced provider row, if it exists — matched by name AND the
 * official base URL, so manually-added Pollinations entries with different
 * names/URLs are left alone. */
async function findSyncedProvider(userId: string) {
  const rows = await aiProviderService.list(userId);
  return (
    rows.find(
      (r) =>
        r.name === POLLINATIONS_PROVIDER_NAME &&
        r.base_url.startsWith("https://gen.pollinations.ai"),
    ) ?? null
  );
}

/** UI status — the synced row's id + live model count, or null when absent. */
export async function findTextProvider(
  userId: string,
): Promise<{ id: string; modelCount: number } | null> {
  const row = await findSyncedProvider(userId);
  return row ? { id: row.id, modelCount: row.models?.length ?? 0 } : null;
}

/**
 * connect() path — create the provider or rotate its key + models. Always
 * writes the (possibly still empty) live model list; refreshModels() keeps
 * it current afterwards.
 */
export async function upsertTextProvider(
  userId: string,
  token: string,
  models: PollinationsModel[],
): Promise<TextProviderSyncResult> {
  const modelIds = textModelIds(models);
  const existing = await findSyncedProvider(userId);
  if (existing) {
    await aiProviderService.update(existing.id, {
      api_key: token,
      models: modelIds,
      is_active: true,
    });
    return { id: existing.id, created: false, modelCount: modelIds.length };
  }
  const row = await aiProviderService.create(userId, {
    name: POLLINATIONS_PROVIDER_NAME,
    base_url: POLLINATIONS_TEXT_BASE_URL,
    api_key: token,
    models: modelIds,
    model_type: "chat",
    tools_enabled: true,
    is_active: true,
  });
  return { id: row.id, created: true, modelCount: modelIds.length };
}

/**
 * init() backfill — create ONLY when missing, and only ever once per user
 * (the caller persists the flag). A user who deleted the row on purpose
 * never sees it resurrected on boot; an explicit reconnect (connect())
 * always re-adds it, which is the requested "connect ⇒ provider" behavior.
 * Returns the sync result, or null when the backfill already happened.
 */
export async function backfillTextProvider(
  userId: string,
  token: string,
  models: PollinationsModel[],
): Promise<TextProviderSyncResult | null> {
  const existing = await findSyncedProvider(userId);
  if (existing) return { id: existing.id, created: false, modelCount: existing.models?.length ?? 0 };
  const modelIds = textModelIds(models);
  const row = await aiProviderService.create(userId, {
    name: POLLINATIONS_PROVIDER_NAME,
    base_url: POLLINATIONS_TEXT_BASE_URL,
    api_key: token,
    models: modelIds,
    model_type: "chat",
    tools_enabled: true,
    is_active: true,
  });
  return { id: row.id, created: true, modelCount: modelIds.length };
}

/**
 * refreshModels() path — keep the synced row's model list current (live
 * catalogue, never cached). No-op when the row is absent (deleted on
 * purpose) or the list is unchanged. Returns the new count or null.
 */
export async function syncProviderModels(
  userId: string,
  models: PollinationsModel[],
): Promise<number | null> {
  const existing = await findSyncedProvider(userId);
  if (!existing) return null;
  const modelIds = textModelIds(models);
  const current = existing.models ?? [];
  const same =
    current.length === modelIds.length && current.every((id, i) => id === modelIds[i]);
  if (same) return current.length;
  await aiProviderService.update(existing.id, { models: modelIds });
  return modelIds.length;
}

/** disconnect() path — remove the synced row (the connection key it holds
 * is revoked; leaving a dead provider would just produce auth errors). */
export async function removeTextProvider(userId: string): Promise<boolean> {
  const existing = await findSyncedProvider(userId);
  if (!existing) return false;
  await aiProviderService.delete(existing.id);
  return true;
}

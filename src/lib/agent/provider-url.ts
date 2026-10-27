// ============================================================================
// PURE endpoint-construction helpers — the leaf of the shared AI client layer
// (endpoint-migration PRD §5/§8).
//
// ZERO imports on purpose: the service layer (src/lib/services) and BOTH
// background dispatch lanes (runner-config, trigger-cloud — server-side)
// share these without importing lib/agent/provider-resolution, which depends
// on the services (a services → provider-resolution → services cycle). Every
// module that needs a chat-completions URL or a legacy-classic check imports
// from HERE (directly, or re-exported via provider-resolution).
//
//   · chatCompletionsUrl() — the ONE URL construction: the provider's base
//     URL + the standard OpenAI-compatible /chat/completions suffix, unless
//     the row's no_prefix flag says to use the base as-is. Never appends
//     duplicate path segments; the base is used exactly as configured.
//   · isLegacyClassicRow()/isLegacyClassicUrl() — match the RETIRED keyless
//     text.pollinations.ai (Classic) endpoint. It can never serve
//     gen-catalog model ids (it answers the "…isn't on the Classic API"
//     404), so every lane treats a classic URL as not-usable.
//
// STATUS CAPTIONS ARE THE ONE EXCEPTION (PRD §3) — the only surface allowed
// to run keyless on its own dedicated endpoint logic — and by design they
// never touch this module or the shared resolution.
// ============================================================================

/** The RETIRED keyless Classic endpoint host — never callable. */
export const LEGACY_CLASSIC_HOST = "text.pollinations.ai";

/** True when a provider row still points at the retired Classic endpoint. */
export function isLegacyClassicRow(p: { name: string; base_url: string }): boolean {
  return p.name === "Pollinations" && p.base_url.includes(LEGACY_CLASSIC_HOST);
}

/** True when a chat URL points at the retired Classic endpoint (any scheme,
 *  path or port — host substring match). Background lanes use this to drop
 *  stale pinned gateways onto the keyless bridge instead of calling a
 *  classic URL that can only 404 gen-catalog models. */
export function isLegacyClassicUrl(url: string | null | undefined): boolean {
  return typeof url === "string" && url.includes(LEGACY_CLASSIC_HOST);
}

/**
 * The ONE chat-completions URL construction (PRD §5: "Do not construct a
 * separate base URL"). `noPrefix` (the provider row's no_prefix flag) uses
 * the base URL as-is; otherwise the standard OpenAI-compatible
 * `/chat/completions` is appended to the trailing-slash-stripped base.
 * Never appends duplicate path segments — the base is used exactly as
 * configured, custom base URLs included.
 */
export function chatCompletionsUrl(baseUrl: string, noPrefix?: boolean): string {
  const base = baseUrl.replace(/\/+$/, "");
  return noPrefix ? base : `${base}/chat/completions`;
}

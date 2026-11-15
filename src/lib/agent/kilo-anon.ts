/**
 * Kilo Code anonymous gateway — the built-in, zero-configuration AI provider
 * for sandbox-native runs (PRD "Sandbox-Native AI Execution" + "Managed
 * Infrastructure": a user with NO AI provider and NO E2B key still gets a
 * working agent).
 *
 * VERIFIED LIVE (2026-11-15): https://ai-gateway.kilo.ai/api/v1 serves
 * OpenAI-compatible chat completions ANONYMOUSLY (no Authorization header)
 * for `:free`-tagged models, with full function calling — tool_calls +
 * multi-round tool loops + SSE streaming all work. Anonymous traffic is
 * rate-limited to 200 requests/hour per IP by the gateway.
 *
 * Precedence (PRD §23 migration — provider compatibility is preserved):
 *   1. The user's own configured provider (Settings → AI Providers) — used
 *      as-is whenever one is selected and has a base URL.
 *   2. THIS anonymous gateway — the default when no provider is configured,
 *      so background runs never hard-fail on missing BYOK setup again.
 */

/** The gateway base (OpenAI-compatible; chat completions at `${base}/chat/completions`). */
export const KILO_ANON_BASE_URL = "https://ai-gateway.kilo.ai/api/v1";

/**
 * Default model — `kilo-auto/free` is the documented STABLE free tier id:
 * the gateway reroutes the underlying model server-side while the tier id
 * stays valid (concrete `:free` ids rotate over time).
 */
export const KILO_ANON_DEFAULT_MODEL = "kilo-auto/free";

/**
 * Concrete fallbacks if the virtual tier is unavailable (verified 200 +
 * tool_calls 2026-11-15). The runner's model-fallback loop tries these in
 * order when the primary model 404s/400s.
 */
export const KILO_ANON_FALLBACK_MODELS: readonly string[] = [
  "nvidia/nemotron-3.5-super-vl:free",
  "baidu/ernie-5.5-flash-preview:free",
  "cohere/north-mini-code:free",
] as const;

/** The shape callers pass into startDetachedRun (chat_url / api_key / model). */
export interface KiloAnonProvider {
  baseUrl: string;
  apiKey: string;
  model: string;
  fallbackModels: readonly string[];
  /** True when this provider is the anonymous default (not user-configured). */
  anonymous: true;
}

/** The built-in anonymous provider config for a sandbox run. */
export function kiloAnonProvider(): KiloAnonProvider {
  return {
    baseUrl: KILO_ANON_BASE_URL,
    apiKey: "", // anonymous — no Authorization header for :free models
    model: KILO_ANON_DEFAULT_MODEL,
    fallbackModels: KILO_ANON_FALLBACK_MODELS,
    anonymous: true,
  };
}

/** Human-facing name for the provider pill / status copy. */
export const KILO_ANON_LABEL = "Kilo (free anonymous)";

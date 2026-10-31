// ============================================================================
// Background Task Execution Framework — BYOK credential policy (pure leaf).
//
// USER DIRECTIVE (2026-10-31): "I want users to use their own credentials
// not mine." Background agent runs execute their LLM calls ONLY through the
// user's own provider gateway with the user's own keys. The app's keyless
// LLM bridge (/api/tasks/llm → z-ai-web-dev-sdk, i.e. the operator's
// credentials) was REMOVED with this change — no background lane may ever
// spend the operator's model budget on a user's run.
//
// Consequences, enforced here in ONE place:
//   · an agent_run WITHOUT a pinned user gateway fails FAST with an
//     actionable error (add a provider in Settings) — never a silent
//     reroute onto the app's own model;
//   · a gateway pinned on the retired text.pollinations.ai (Classic)
//     endpoint fails with the migration hint (it can only ever 404);
//   · the run's task token is NEVER used as an LLM bearer — it authorizes
//     cancel/sync/artifact routes only, and must never travel to an
//     external provider;
//   · terminal_command runs need no LLM credentials at all.
//
// PURE leaf: imports only the shared provider-url guard — safe for server,
// worker-adjacent tooling and unit tests.
// ============================================================================

import { isLegacyClassicUrl } from "@/lib/agent/provider-url";

/** True for absolute http(s) URLs (the only gateways a cloud runner can
 *  reach — a relative or malformed pin is treated as "no gateway"). */
export function isAbsoluteHttpUrl(url: unknown): url is string {
  return typeof url === "string" && /^https?:\/\//i.test(url.trim());
}

/** Actionable error when a run carries no provider gateway of its own. */
export const NO_PROVIDER_CREDENTIALS_ERROR =
  "This background run has no AI provider of its own — add your provider and API key in Settings → Agent Settings → AI Providers, then retry. Background runs always execute with YOUR credentials; the app's built-in model is never used as a fallback. (code: byok_no_gateway)";

/** Error for a gateway pinned on the retired Classic endpoint. */
export const RETIRED_ENDPOINT_PIN_ERROR =
  "This run's pinned provider gateway is the retired text.pollinations.ai (Classic) endpoint, which can never serve the current model catalog. Reselect your provider in Settings → Agent Settings → AI Providers and retry. (code: legacy_endpoint_pin)";

/** The LLM credentials a cloud run carries in its payload. */
export interface RunLlmCredentials {
  /** The user's own OpenAI-compatible chat-completions URL. */
  chatUrl: string;
  /** Bearer for the gateway — the FIRST user key of the pool. Empty for
   *  keyless gateways (local runtimes etc.). NEVER the task token. */
  chatToken: string;
  /** FR-1.3 rotational user key pool (as provided, order preserved). */
  keyPool: string[];
}

export type RunLlmResolution =
  | { ok: true; credentials: RunLlmCredentials }
  | { ok: false; error: string };

/**
 * Resolve the LLM credentials for one run under the BYOK policy.
 *
 * `chatUrl` is the run config's pinned gateway (the provider the triggering
 * client resolved); `keyPool` the decrypted user keys (may be empty — a
 * keyless gateway is a legitimate setup). terminal_command runs never need
 * LLM credentials and always resolve ok with empty values.
 */
export function resolveRunLlmCredentials(input: {
  type: string;
  chatUrl?: string | null;
  keyPool?: string[];
}): RunLlmResolution {
  // Terminal commands execute in the sandbox — no LLM leg, no credentials.
  if (input.type === "terminal_command") {
    return { ok: true, credentials: { chatUrl: "", chatToken: "", keyPool: [] } };
  }

  const pinned = typeof input.chatUrl === "string" ? input.chatUrl.trim() : "";

  // No gateway (or a relative/malformed pin) → honest, actionable failure.
  // The app's own bridge used to be substituted here — removed by directive.
  if (!isAbsoluteHttpUrl(pinned)) {
    return { ok: false, error: NO_PROVIDER_CREDENTIALS_ERROR };
  }

  // LEGACY-CLASSIC GUARD (endpoint-migration PRD §3): the retired endpoint
  // can only answer "…isn't on the Classic API" 404s for gen-catalog
  // models — fail with the migration hint instead of hammering it.
  if (isLegacyClassicUrl(pinned)) {
    return { ok: false, error: RETIRED_ENDPOINT_PIN_ERROR };
  }

  const keyPool = (Array.isArray(input.keyPool) ? input.keyPool : [])
    .map((k) => (typeof k === "string" ? k.trim() : ""))
    .filter((k) => k.length > 0);

  return {
    ok: true,
    credentials: {
      chatUrl: pinned,
      // First user key leads; empty when the gateway is keyless. The task
      // token is NEVER substituted — it must not leak to an external host.
      chatToken: keyPool[0] ?? "",
      keyPool,
    },
  };
}

/** True when a URL points at the app's own (removed) LLM-bridge route —
 *  belt-and-braces for payloads minted before the BYOK policy: such a run
 *  would try to spend the operator's credentials and must fail instead. */
export function isAppBridgeUrl(url: string): boolean {
  if (!isAbsoluteHttpUrl(url)) return false;
  try {
    return new URL(url.trim()).pathname.replace(/\/+$/, "") === "/api/tasks/llm";
  } catch {
    return false;
  }
}

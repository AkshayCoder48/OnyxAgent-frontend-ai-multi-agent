/**
 * Request-parameter policy — enable/disable + auto-strip for model routes
 * that reject specific params.
 *
 * Some providers/model routes reject OpenAI-standard fields with HTTP 400
 * `{"error":{"code":"unsupported_parameter","param":"temperature"}}`.
 * Two layers of defense:
 *
 *  1. MANUAL: the user disables a parameter per provider in
 *     Settings → Config → Edit Provider ("Request parameters").
 *     Stored as `disabled_params: string[]` on the provider row.
 *
 *  2. AUTO (self-healing): when a 400 `unsupported_parameter` response
 *     arrives, the named param is stripped from the request body and the
 *     request is retried immediately. The ban is remembered for the rest of
 *     the session (per provider base URL + model) so every later request in
 *     this session already omits it.
 *
 * Used by the in-browser runtime (streamRound), subagent-runtime, and the
 * E2B background runner (which inlines its own copy — it must stay
 * self-contained).
 */

/** Parameter names the app may send in a chat-completions body. */
export type ChatParam =
  | "temperature"
  | "top_p"
  | "max_tokens"
  | "reasoning_effort"
  | "thinking"
  | "chat_template_kwargs"
  | "stream_options"
  | "tools"
  | "tool_choice";

/** Session-level memory of params a provider+model rejected with a 400 —
 *  auto-learned via the self-healing retry. */
const learnedBans = new Map<string, Set<string>>();

function banKey(baseUrl: string, model: string): string {
  return `${baseUrl.replace(/\/+$/, "")}|${model}`;
}

/** Record that `param` was rejected by this provider+model. */
export function learnParamBan(baseUrl: string, model: string, param: string): void {
  const key = banKey(baseUrl, model);
  let set = learnedBans.get(key);
  if (!set) {
    set = new Set();
    learnedBans.set(key, set);
  }
  set.add(param);
}

/** Params learned to be banned for this provider+model (session scope). */
export function getLearnedParamBans(baseUrl: string, model: string): Set<string> {
  return learnedBans.get(banKey(baseUrl, model)) ?? new Set();
}

/**
 * Parse an error body for an unsupported-parameter rejection.
 * Handles OpenAI-style payloads:
 *   {"error":{"code":"unsupported_parameter","param":"temperature",
 *              "message":"The parameter 'temperature' is not supported…"}}
 * as well as plain-text variants that mention the parameter name in quotes.
 * Returns the offending param name, or null when the body is not a
 * parameter-rejection error.
 */
export function parseUnsupportedParam(bodyText: string): string | null {
  if (!bodyText) return null;
  // Fast pre-check before any parsing work.
  if (!/unsupported[ _-]?param|not supported by this model/i.test(bodyText)) return null;
  try {
    const obj = JSON.parse(bodyText);
    const err = obj?.error ?? obj;
    if (err && typeof err === "object") {
      const code = typeof err.code === "string" ? err.code.toLowerCase().replace(/[ _-]/g, "") : "";
      if (code === "unsupportedparameter" || code === "invalidparameter") {
        if (typeof err.param === "string" && err.param) return err.param;
      }
      // Some gateways nest differently: {error:{message:"... 'temperature' ..."}}
      if (typeof err.param === "string" && err.param && /unsupported/i.test(String(err.code ?? ""))) {
        return err.param;
      }
    }
  } catch {
    // not JSON — fall through to the text scan
  }
  // Last resort: "The parameter 'temperature' is not supported"
  const m = bodyText.match(/parameter ['"]([a-z_]+)['"] (?:is )?not supported/i);
  if (m && m[1]) return m[1];
  return null;
}

/**
 * Strip disabled/learned params from a request body IN PLACE.
 * `disabledParams` comes from the provider row (`disabled_params`).
 * Returns the body for chaining.
 */
export function applyParamPolicy(
  body: Record<string, unknown>,
  opts: {
    baseUrl: string;
    model: string;
    disabledParams?: string[] | null;
  },
): Record<string, unknown> {
  const disabled = new Set<string>(opts.disabledParams ?? []);
  for (const p of getLearnedParamBans(opts.baseUrl, opts.model)) disabled.add(p);
  for (const name of disabled) {
    if (name === "reasoning_effort") {
      delete body.reasoning_effort;
      delete body.thinking; // paired — the app sets both together
    } else {
      delete body[name];
    }
  }
  return body;
}

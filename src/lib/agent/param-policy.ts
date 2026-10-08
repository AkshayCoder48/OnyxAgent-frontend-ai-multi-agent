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

/** THE tool-carrying params. These get SPECIAL treatment (the "browser tool
 * isn't available in this mode" bug): a 400 `unsupported_parameter` naming
 * tools/tool_choice is too often a CONTENT-FILTER false positive (verified
 * live on gen.pollinations.ai community routes — generic 400s that name no
 * param, plus gateways that reject agent workloads while accepting the
 * exact same shape for benign prompts). Auto-banning tools PERSISTENTLY on
 * that evidence silently stripped the ENTIRE tool surface — use_browser,
 * web_search, everything — from every later request for that provider, and
 * the model then TRUTHFULLY told users "the browser tool isn't available in
 * this mode" while falling back to plain search. Tool params therefore:
 *   - are NEVER persisted to localStorage (session-only at most),
 *   - are scrubbed from previously persisted state on load (self-heal),
 *   - should be handled by callers as a one-shot strip + retry, giving the
 *     next turn a fresh chance to send tools. */
const TOOL_PARAM_NAMES = new Set(["tools", "tool_choice"]);

/** True when a param name is one of the tool-carrying params (special
 * no-persist handling — see TOOL_PARAM_NAMES). */
export function isToolParam(param: string): boolean {
  return TOOL_PARAM_NAMES.has(param);
}

/** Learned bans — PERSISTED to localStorage so a provider's rejected
 *  params are learned ONCE ever, not once per browser session (each relearn
 *  cost an extra 400 on rate-limited providers). */
const learnedBans = new Map<string, Set<string>>();
const PERSIST_KEY = "onyx-param-bans-v1";

function banKey(baseUrl: string, model: string): string {
  return `${baseUrl.replace(/\/+$/, "")}|${model}`;
}

/** Read the persisted bans map (SSR/test-safe — {} when unavailable).
 *
 * SELF-HEAL (the "browser tool isn't available" fix): any tools/
 * tool_choice bans persisted by an OLDER build are dropped on read, and the
 * cleaned map is written back — a browser that already learned the bad ban
 * regains its full tool surface on the very next load. */
function readPersistedBans(): Record<string, string[]> {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string[]>;
    if (!parsed || typeof parsed !== "object") return {};
    let cleaned = false;
    for (const key of Object.keys(parsed)) {
      const list = parsed[key];
      if (!Array.isArray(list)) continue;
      const filtered = list.filter((p) => !TOOL_PARAM_NAMES.has(p));
      if (filtered.length !== list.length) {
        cleaned = true;
        if (filtered.length > 0) parsed[key] = filtered;
        else delete parsed[key];
      }
    }
    if (cleaned) {
      try {
        localStorage.setItem(PERSIST_KEY, JSON.stringify(parsed));
      } catch {
        /* best-effort write-back */
      }
    }
    return parsed;
  } catch {
    return {};
  }
}

/** Persist one provider's ban set (best-effort — never throws). */
function persistBans(key: string, bans: Set<string>): void {
  try {
    if (typeof localStorage === "undefined") return;
    const all = readPersistedBans();
    all[key] = [...bans];
    localStorage.setItem(PERSIST_KEY, JSON.stringify(all));
  } catch {
    // Quota / private-mode — session memory still works.
  }
}

/** Record that `param` was rejected by this provider+model. TOOL params
 * (tools / tool_choice) are NEVER recorded here — see isToolParam; the
 * strict-gateway ladder (wire-compat.ts) owns that decision with explicit
 * tool-evidence checks, and only ever session-scoped. */
export function learnParamBan(baseUrl: string, model: string, param: string): void {
  if (TOOL_PARAM_NAMES.has(param)) return; // never auto-ban the tool surface
  const key = banKey(baseUrl, model);
  let set = learnedBans.get(key);
  if (!set) {
    set = new Set(readPersistedBans()[key] ?? []);
    learnedBans.set(key, set);
  }
  if (set.has(param)) return;
  set.add(param);
  persistBans(key, set);
}

/** Params learned to be banned for this provider+model (persisted). */
export function getLearnedParamBans(baseUrl: string, model: string): Set<string> {
  const key = banKey(baseUrl, model);
  const cached = learnedBans.get(key);
  if (cached) return cached;
  const hydrated = new Set(readPersistedBans()[key] ?? []);
  learnedBans.set(key, hydrated);
  return hydrated;
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

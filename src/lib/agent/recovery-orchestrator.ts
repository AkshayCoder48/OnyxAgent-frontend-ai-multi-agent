/**
 * AUTONOMOUS RECOVERY ORCHESTRATOR (Self-Recovery PRD §§2, 3, 6, 7, 9, 11).
 *
 * WHY THIS EXISTS: the documented failure pattern — the model hits the
 * FIRST obstacle and converts it into the answer ("Lightpanda isn't
 * available, I'll use the default browser", "the package is missing",
 * "would you like me to try another approach?"). The PRD requires an
 * engineer's loop instead: understand the GOAL → check resources →
 * execute → on failure INVESTIGATE (root cause) → find fixes → evaluate
 * alternatives → execute the best fix → VERIFY → continue until the
 * objective is met, a genuine external blocker appears, authorization is
 * needed, or the budget runs out.
 *
 * HOW IT INTEGRATES (PRD §15 — not a separate agent): the orchestrator
 * is a pure CLASSIFIER + DIRECTIVE BUILDER used by the agent runtime at
 * the exact moment a tool result settles as failed:
 *
 *   · classifyFailure(tool, args, result) → the PRD §6 category
 *     (missing_dependency / browser_failure / network / auth / api /
 *     permission / code_error / timeout / environment / invalid_arguments
 *     / repetition_blocked / external_blocker).
 *   · investigationDirective(category, tool, result) → a SYSTEM-style
 *     directive the runtime APPENDS to the failed tool result the model
 *     reads: the category, the investigation steps for that category,
 *     and the FORBIDDEN passive exits ("don't stop at unavailable").
 *
 * The directive lands where the model is already looking — on the failed
 * result itself — so the next round continues the loop instead of
 * writing an apology. It is bounded: at most MAX_DIRECTIVES per category
 * per turn (after that the model has the pattern; more would be noise).
 */

export type FailureCategory =
  | "missing_dependency"
  | "browser_failure"
  | "network_failure"
  | "auth_failure"
  | "api_failure"
  | "permission_failure"
  | "code_error"
  | "timeout"
  | "environment_limitation"
  | "invalid_arguments"
  | "repetition_blocked"
  | "external_blocker"
  | "unknown";

/** PRD §6's investigation matrix — per category, the concrete steps the
 *  model must take BEFORE it may consider the step failed-and-final. */
const INVESTIGATION_STEPS: Record<FailureCategory, string[]> = {
  missing_dependency: [
    "Check what the error says is missing (package, binary, module).",
    "Detect the environment: which OS/arch, which runtime (pip/npm/apt/binary release).",
    "Find the OFFICIAL installation method for it (official docs, GitHub releases, the package registry).",
    "Install it (pip install / npm install / curl the vendor install script / apt) and CAPTURE the install output.",
    "Verify the installed version actually works (import it, run `--version`).",
    "Retry the ORIGINAL operation with the dependency now present.",
  ],
  browser_failure: [
    "Read the browser error fully — startup, runtime, CDP, or page-level?",
    "Inspect the browser runtime state: which engine, is the process alive, does the CDP endpoint answer.",
    "If the requested engine failed, investigate ITS install/boot requirements before substituting another engine.",
    "Check whether a different supported browser runtime is available (the driver ladder reports every rung it tried).",
    "Attempt the recovery: reboot the session via the tool, or switch rung, DISCLOSING the switch as a fallback.",
    "Verify the recovered session actually loads a page before continuing.",
  ],
  network_failure: [
    "Check basic connectivity (curl the endpoint, DNS resolution).",
    "Distinguish DNS failure / connection refused / TLS / timeout — each means a different fix.",
    "If the endpoint is truly unreachable, check whether an alternative endpoint or mirror exists.",
    "Retry with the diagnosis in hand; do not blind-retry the same call.",
  ],
  auth_failure: [
    "Identify WHAT credential the resource wants (API key, OAuth, session cookie).",
    "Check whether a configured integration already provides it (env vars, stored keys, MCP servers).",
    "If a credential exists but is invalid, say precisely that — do not call it 'unavailable'.",
    "Only ask the user when a credential genuinely must come from them (PRD §12: auth is a valid ask).",
  ],
  api_failure: [
    "Inspect the exact request you sent and the exact response (status, body, error code).",
    "Check the API's documentation/schema for the expected request shape.",
    "If the payload is unknown, DISCOVER it: inspect the calling app in the browser, capture its real network requests.",
    "Fix the request (path, method, headers, body) and retry; validate the response against the schema.",
  ],
  permission_failure: [
    "Determine whether the permission can be obtained inside the sandbox (file modes, PATH, user-scope installs).",
    "If it needs a system-level change, prefer a user-space workaround (local install dir, virtualenv).",
    "If it truly needs user authorization, ask for exactly that permission — not for permission to 'try something'.",
  ],
  code_error: [
    "Read the stack trace; identify the failing file, line, and operation.",
    "Reproduce minimally; inspect the relevant inputs (not just the symptom).",
    "Fix the cause, not the symptom; re-run and verify the fix.",
  ],
  timeout: [
    "Identify the bottleneck: slow endpoint, large output, deadlock, or undersized timeout.",
    "Adjust the execution strategy (background the work, raise the timeout, chunk the job).",
    "Retry with the adjustment; do not repeat the identical slow call.",
  ],
  environment_limitation: [
    "Identify exactly what the environment lacks (OS, arch, library, display, sandbox boundary).",
    "Search for a compatible alternative implementation of the same capability.",
    "If a compatible route exists, use it and DISCLOSE the substitution; if none, this is a genuine blocker — report it as BLOCKED with the specific limitation.",
  ],
  invalid_arguments: [
    "Read the validation error — it names the exact field and the expected type.",
    "Re-issue the call ONCE with corrected arguments (the error's hint shows the corrected shape).",
    "Never repeat the identical invalid call.",
  ],
  repetition_blocked: [
    "This exact call has failed repeatedly and is now blocked by the runtime.",
    "You MUST change strategy: different arguments, a different tool, a different approach to the same GOAL.",
    "If every route is exhausted, report the task as BLOCKED naming the specific failure — not as completed.",
  ],
  external_blocker: [
    "This failure is external (missing key/runtime/permission) — inside your sandbox it cannot be fixed by retrying.",
    "State the blocker precisely and what authorization or resource would remove it.",
    "Continue with every part of the objective that does NOT depend on the blocker.",
  ],
  unknown: [
    "Read the full error message and identify the failing component.",
    "Classify it yourself (dependency? network? code? environment?) and investigate accordingly.",
    "Do not stop at the first obstacle — the objective is still the objective.",
  ],
};

/** Forbidden passive exits — the PRD §11 bad responses. Appended to every
 *  directive so the model cannot convert an obstacle into an answer. */
const NO_PASSIVE_EXITS =
  "FORBIDDEN final responses for this situation (they are failure modes, not answers): " +
  "'it is not available' (before investigating why), 'I will use the default instead' (before genuinely trying the requested method), " +
  "'I cannot execute this' (without a diagnosed technical reason), 'the package is missing' (before installing it), " +
  "'the environment does not support this' (before checking compatible alternatives), " +
  "'would you like me to try another approach?' (try the best safe alternative yourself — ordinary reversible troubleshooting needs no permission).";

/** Max directives of one category per turn — after that the model has the
 *  pattern and repeated injections are just noise. */
export const MAX_DIRECTIVES_PER_CATEGORY = 3;

/** Max directives TOTAL per turn (any category) — the overall budget. */
export const MAX_DIRECTIVES_TOTAL = 10;

export interface ClassifiedFailure {
  category: FailureCategory;
  /** Short human label for logs/UI. */
  label: string;
}

/**
 * Classify a failed tool result into a PRD §6 category. Pure heuristics on
 * the structured error envelope (error codes/types) + the tool name; never
 * inspects payload bodies for secrets.
 */
export function classifyFailure(
  toolName: string,
  result: unknown,
): ClassifiedFailure {
  const env = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
  const err = (env.error && typeof env.error === "object" ? env.error : {}) as Record<string, unknown>;
  const code = typeof err.code === "string" ? err.code : "";
  const type = typeof err.type === "string" ? err.type : "";
  const message = typeof err.message === "string" ? err.message.toLowerCase() : "";
  const combined = `${code} ${type} ${message}`;

  // MISSING DEPENDENCY first (the PRD's Test 2/§4 core case): "No module
  // named 'lightpanda'" mentions an engine name but is a DEPENDENCY
  // problem — the browser regex below must never shadow it.
  if (
    /module not found|no module named|command not found|not installed|package .* (not found|missing)|importerror|modulenotfounderror|enoent|execvp/.test(
      combined,
    )
  ) {
    return { category: "missing_dependency", label: "missing dependency" };
  }

  // Runtime-refused classes (Task 56's structured errors).
  if (code === "REPETITION_BLOCKED" || code === "TURN_BUDGET_EXHAUSTED") {
    return { category: "repetition_blocked", label: "repetition blocked by runtime" };
  }
  if (code === "MISSING_REQUIRED_FIELD" || code === "INVALID_ARGUMENTS" || code === "INVALID_TYPE" || code === "INVALID_VALUE" || code === "MALFORMED_TOOL_ARGUMENTS") {
    return { category: "invalid_arguments", label: `invalid arguments (${code})` };
  }

  // Browser family.
  if (type === "browser_startup_failed" || /browser.*(fail|start|boot)|cdp|chromium|lightpanda|playwright/i.test(combined)) {
    return { category: "browser_failure", label: "browser failure" };
  }
  if (type === "unsupported_capability") {
    return { category: "environment_limitation", label: "engine capability limit" };
  }

  // Network family.
  if (/network|dns|econnrefused|econnreset|ehostunreach|enotfound|tls|ssl|certificate|timeout|timed out|etimedout/.test(combined)) {
    return { category: /timeout|timed out/.test(combined) ? "timeout" : "network_failure", label: /timeout|timed out/.test(combined) ? "timeout" : "network failure" };
  }

  // Auth / permission / API.
  if (/unauthorized|401|403|forbidden|api key|token|credential|auth/i.test(combined)) {
    return { category: "auth_failure", label: "authentication failure" };
  }
  if (/permission denied|eacces|eperm|read-only/.test(combined)) {
    return { category: "permission_failure", label: "permission failure" };
  }
  if (/4[0-9][0-9]|5[0-9][0-9]|bad request|invalid request|schema|payload/.test(combined)) {
    return { category: "api_failure", label: "API failure" };
  }

  // Code errors (tracebacks in tool output).
  if (/traceback|syntaxerror|exception|stack trace|referenceerror|typeerror/.test(combined)) {
    return { category: "code_error", label: "code error" };
  }

  // External blockers (sandbox/infrastructure).
  if (/sandbox|unavailable|e2b|quota|limit reached|rate limit/.test(combined)) {
    return { category: "external_blocker", label: "external blocker" };
  }

  // Tool-specific defaults.
  if (toolName === "use_browser" || toolName === "browser") {
    return { category: "browser_failure", label: "browser failure" };
  }
  return { category: "unknown", label: "unclassified failure" };
}

/**
 * Build the investigation directive for a failed call. Returns the text to
 * APPEND to the failed tool result, or null when the budget for that
 * category (or the turn) is exhausted.
 */
export function investigationDirective(
  category: FailureCategory,
  toolName: string,
  categoryCount: number,
  totalCount: number,
): string | null {
  // 1-based counts: directives 1..MAX pass; the (MAX+1)th is null. The
  // caller passes count = issued-so-far + 1 for the call being decided.
  if (categoryCount > MAX_DIRECTIVES_PER_CATEGORY || totalCount > MAX_DIRECTIVES_TOTAL) {
    return null;
  }
  const steps = INVESTIGATION_STEPS[category];
  const numbered = steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return (
    `\n\n[AUTONOMOUS RECOVERY — ${category.replace(/_/g, " ").toUpperCase()}]\n` +
    `The ${toolName} call above failed. This is an obstacle to INVESTIGATE, not a final answer. Work the loop:\n` +
    `${numbered}\n\n` +
    NO_PASSIVE_EXITS +
    `\n\nContinue until the ORIGINAL OBJECTIVE is met, a genuine external blocker is proven, or user authorization is required.`
  );
}

/**
 * OBJECTIVE vs METHOD tracking (PRD §2): extract the user's likely
 * objective when they name a method, so a method failure never reads as
 * an objective failure. Used by the prompt builder and the completion
 * check: "use Lightpanda to test X" → objective "test X", method
 * "lightpanda". The method gets a GENUINE effort first; a disclosed
 * fallback may still accomplish the objective.
 */
export function objectiveVsMethod(userPrompt: string): {
  objective: string;
  method?: string;
} {
  const text = String(userPrompt || "").trim();
  if (!text) return { objective: "" };
  // Known method keywords the ecosystem names explicitly.
  const methods = [
    "lightpanda",
    "playwright",
    "puppeteer",
    "chromium",
    "chrome",
    "selenium",
    "cloakbrowser",
    "patchright",
    "python",
    "node",
    "npm",
    "pip",
    "docker",
  ];
  const lower = text.toLowerCase();
  const found: string[] = [];
  for (const m of methods) {
    if (lower.includes(m)) found.push(m);
  }
  // Strip the "use X to ..." method clause for the objective sketch. The
  // clause runs from the method mention to the START of the real action
  // ("test", "check", "scrape", …) — the action belongs to the OBJECTIVE,
  // so only the method introduction is removed ("Use Lightpanda to test
  // the API" → "test the API").
  let objective = text;
  if (found.length > 0) {
    const stripped = text.replace(
      new RegExp(`^\\s*(?:please\\s+)?(?:can you\\s+)?(use|using|with|via|through)\\s+(?:the\\s+)?(${found.join("|")})(?:\\s+browser)?\\s+to\\s+`, "i"),
      "",
    );
    if (stripped !== text) {
      objective = stripped;
    }
  }
  return {
    objective: objective.trim() || text,
    method: found.length > 0 ? found[0] : undefined,
  };
}

/**
 * PASSIVE-FAILURE DETECTOR (PRD §11): does a final response contain the
 * forbidden passive-exit patterns when the ledger says work is incomplete?
 * Used by the completion check to challenge one more time.
 */
const PASSIVE_PATTERNS: RegExp[] = [
  /\b(?:is|are|was|were)\s+not\s+(?:available|installed|supported|accessible)\b[^.]*\./i,
  /\bI(?:'ll| will| am going to)?\s+use\s+the\s+default\b/i,
  /\bcannot\s+(?:execute|continue|proceed|access)\b/i,
  /\bthe\s+(?:package|module|library|tool)\s+(?:is\s+)?missing\b/i,
  /\bthe\s+environment\s+(?:does not|doesn't)\s+support\b/i,
  /\b(?:would you like|shall I|do you want me)\s+(?:me\s+)?to\s+try\b/i,
  /\bI\s+don't\s+(?:have|know)\s+(?:access|the\s+payload|the\s+request)\b/i,
];

export function isPassiveFailureResponse(text: string): boolean {
  const t = String(text || "");
  return PASSIVE_PATTERNS.some((re) => re.test(t));
}

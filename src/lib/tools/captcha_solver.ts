"use client";

/**
 * Captcha / Cloudflare-bypass tools.
 *
 * Backendless constraints: there is no server-side solver process we can
 * shell out to, so these tools implement a layered strategy:
 *
 *   1. **Image captchas** — POST the image to a free OCR endpoint
 *      (https://api.ocr.space/parse/image). The free public key (`helloworld`)
 *      works for low-volume use; users can configure `OCR_SPACE_API_KEY` in
 *      Settings → Config → Env Vars for higher limits / better accuracy.
 *      Runs directly from the browser (ocr.space sends CORS headers).
 *
 *   2. **hCaptcha / reCAPTCHA v2-v3 / Turnstile** — these token-based
 *      challenges cannot be solved without a third-party solver. When the
 *      user has configured `TWOCAPTCHA_API_KEY` or `ANTICAPTCHA_API_KEY` in
 *      env vars, we submit + poll for the token. Otherwise we return a
 *      structured `not_configured` result so the agent can surface guidance
 *      to the user.
 *
 *   3. **Cloudflare "I'm Under Attack" / Turnstile challenge pages** —
 *      there is no API-based bypass (the challenge requires a real browser
 *      with a TLS fingerprint that matches a known client). `bypass_cloudflare`
 *      returns the headers, cookies, and browser-automation recipe the agent
 *      (or the user) should use when driving a headless browser via the
 *      E2B sandbox terminal / code-execution tools.
 *
 * All long-running paths honor `ctx.signal` so the agent turn can be aborted.
 */

import { registerTool, type ToolContext } from "./registry";

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

type CaptchaType =
  | "image"
  | "hcaptcha"
  | "recaptcha_v2"
  | "recaptcha_v3"
  | "turnstile"
  | "cloudflare";

interface SolveCaptchaArgs {
  captcha_type: CaptchaType;
  image_url?: string;
  image_base64?: string;
  site_url?: string;
  sitekey?: string;
  action?: string;
  min_score?: number;
  user_agent?: string;
  language?: string;
}

interface BypassCloudflareArgs {
  target_url: string;
  scenario?: "auto" | "iuam" | "turnstile" | "managed_challenge";
  user_agent?: string;
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Strip the `data:...;base64,` prefix if the caller included it. */
function stripDataUri(b64: string): string {
  const idx = b64.indexOf(",");
  return idx > 0 && b64.slice(0, idx).includes("base64") ? b64.slice(idx + 1) : b64;
}

/** Sleep helper that respects an abort signal. */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Read the first non-empty value for an env var key from the tool context. */
function envVar(ctx: ToolContext, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = ctx.envVars?.[k];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Image captcha solver — calls ocr.space free API.
// ---------------------------------------------------------------------------

async function solveImageCaptcha(
  args: SolveCaptchaArgs,
  ctx: ToolContext,
): Promise<unknown> {
  const apiKey =
    envVar(ctx, "OCR_SPACE_API_KEY", "OCRSPACE_API_KEY") || "helloworld";
  const language = args.language || "eng";

  if (!args.image_url && !args.image_base64) {
    return {
      success: false,
      error: "image_url or image_base64 is required for image captchas",
    };
  }

  const body = new FormData();
  body.append("language", language);
  body.append("apikey", apiKey);
  body.append("scale", "true");
  body.append("isOverlayRequired", "false");
  if (args.image_url) {
    body.append("url", args.image_url);
  } else if (args.image_base64) {
    body.append("base64Image", "data:image/png;base64," + stripDataUri(args.image_base64));
  }

  try {
    const res = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      body,
      signal: ctx.signal,
    });
    const data = (await res.json().catch(() => null)) as {
      ParsedResults?: Array<{ ParsedText?: string }>;
      ErrorMessage?: string | string[];
      OCRExitCode?: number;
      IsErroredOnProcessing?: boolean;
    } | null;

    if (!data) {
      return { success: false, error: "OCR API returned an unparseable response" };
    }
    if (data.IsErroredOnProcessing || !data.ParsedResults?.length) {
      const errMsg = data.ErrorMessage
        ? Array.isArray(data.ErrorMessage)
          ? data.ErrorMessage.join("; ")
          : data.ErrorMessage
        : "OCR processing failed";
      return { success: false, error: errMsg, raw: data };
    }
    const text = (data.ParsedResults[0]?.ParsedText ?? "").trim();
    return {
      success: true,
      captcha_type: "image",
      text,
      confidence: null, // ocr.space free tier doesn't expose per-word confidence
      raw: data,
    };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return { success: false, error: "Aborted" };
    }
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
      hint: "If this is a CORS error, configure OCR_SPACE_API_KEY in Settings → Config and try a different provider.",
    };
  }
}

// ---------------------------------------------------------------------------
// Token-based solver (hCaptcha / reCAPTCHA / Turnstile) — uses 2captcha
// when an API key is configured. Falls back to anti-captcha if that's the
// only key present.
// ---------------------------------------------------------------------------

const METHOD_BY_TYPE: Record<Exclude<CaptchaType, "image" | "cloudflare">, string> = {
  hcaptcha: "hcaptcha",
  recaptcha_v2: "userrecaptcha",
  recaptcha_v3: "userrecaptcha",
  turnstile: "turnstile",
};

async function solveTokenCaptcha(
  args: SolveCaptchaArgs,
  ctx: ToolContext,
): Promise<unknown> {
  const twoCaptchaKey = envVar(ctx, "TWOCAPTCHA_API_KEY", "TWO_CAPTCHA_API_KEY");
  const antiCaptchaKey = envVar(ctx, "ANTICAPTCHA_API_KEY", "ANTI_CAPTCHA_API_KEY");

  if (!twoCaptchaKey && !antiCaptchaKey) {
    return {
      success: false,
      error: "not_configured",
      captcha_type: args.captcha_type,
      hint:
        "Token-based captchas (hCaptcha / reCAPTCHA / Turnstile) require a paid solver. " +
        "Configure TWOCAPTCHA_API_KEY or ANTICAPTCHA_API_KEY in Settings → Config → Env Vars. " +
        "For Cloudflare challenges specifically, prefer the bypass_cloudflare tool which " +
        "returns headers + a browser-automation recipe instead of a token.",
    };
  }

  if (!args.site_url || !args.sitekey) {
    return {
      success: false,
      error:
        "site_url and sitekey are required for token-based captchas " +
        "(sitekey = the data-sitekey attribute on the captcha element)",
    };
  }

  // Prefer 2captcha when both are present.
  if (twoCaptchaKey) {
    return solveWith2Captcha(args, twoCaptchaKey, ctx);
  }
  return solveWithAntiCaptcha(args, antiCaptchaKey!, ctx);
}

async function solveWith2Captcha(
  args: SolveCaptchaArgs,
  apiKey: string,
  ctx: ToolContext,
): Promise<unknown> {
  const method = METHOD_BY_TYPE[args.captcha_type as keyof typeof METHOD_BY_TYPE];
  const submitParams = new URLSearchParams({
    key: apiKey,
    method,
    json: "1",
    pageurl: args.site_url!,
    googlekey: args.sitekey!,
  });
  if (args.captcha_type === "recaptcha_v3") {
    submitParams.set("version", "v3");
    if (args.action) submitParams.set("action", args.action);
    if (args.min_score != null) submitParams.set("min_score", String(args.min_score));
  }
  if (args.user_agent) submitParams.set("userAgent", args.user_agent);

  // Submit.
  const submitRes = await fetch(`https://2captcha.com/in.php?${submitParams}`, {
    signal: ctx.signal,
  }).catch((e) => e);
  if (submitRes instanceof Error) {
    return { success: false, error: submitRes.message, provider: "2captcha" };
  }
  const submit = (await submitRes.json().catch(() => null)) as
    | { status?: number; request?: string }
    | null;
  if (!submit || submit.status !== 1 || !submit.request) {
    return {
      success: false,
      error: submit?.request || "2captcha submit failed",
      provider: "2captcha",
      raw: submit,
    };
  }
  const captchaId = submit.request;

  // Poll for the answer. 2captcha typical solve time is 10–40s; we cap at
  // ~3 minutes and respect the abort signal.
  const started = Date.now();
  const MAX_MS = 180_000;
  while (Date.now() - started < MAX_MS) {
    await sleep(5_000, ctx.signal);
    const pollParams = new URLSearchParams({
      key: apiKey,
      action: "get",
      id: captchaId,
      json: "1",
    });
    let poll: { status?: number; request?: string } | null;
    try {
      const r = await fetch(`https://2captcha.com/res.php?${pollParams}`, {
        signal: ctx.signal,
      });
      poll = (await r.json().catch(() => null)) as typeof poll;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        return { success: false, error: "Aborted", provider: "2captcha" };
      }
      continue;
    }
    if (poll?.status === 1 && poll.request) {
      return {
        success: true,
        provider: "2captcha",
        captcha_type: args.captcha_type,
        token: poll.request,
        solve_time_ms: Date.now() - started,
      };
    }
    if (poll?.request !== "CAPCHA_NOT_READY") {
      return {
        success: false,
        provider: "2captcha",
        error: poll?.request || "unknown 2captcha error",
        raw: poll,
      };
    }
    // else: still pending — loop again.
  }
  return {
    success: false,
    provider: "2captcha",
    error: "Timed out waiting for 2captcha solution",
    captcha_id: captchaId,
  };
}

async function solveWithAntiCaptcha(
  args: SolveCaptchaArgs,
  apiKey: string,
  ctx: ToolContext,
): Promise<unknown> {
  // anti-captcha.com uses a JSON-RPC style API.
  const methodName =
    args.captcha_type === "hcaptcha"
      ? "HCaptchaTaskProxyless"
      : args.captcha_type === "turnstile"
        ? "TurnstileTaskProxyless"
        : args.captcha_type === "recaptcha_v3"
          ? "RecaptchaV3TaskProxyless"
          : "NoCaptchaTaskProxyless";
  const task: Record<string, unknown> = {
    type: methodName,
    websiteURL: args.site_url,
    websiteKey: args.sitekey,
  };
  if (args.captcha_type === "recaptcha_v3") {
    if (args.action) task.pageAction = args.action;
    task.minScore = args.min_score ?? 0.3;
  }
  if (args.user_agent) task.userAgent = args.user_agent;

  // Submit.
  let createRes: { errorId?: number; errorCode?: string; taskId?: number } | null;
  try {
    const r = await fetch("https://api.anti-captcha.com/createTask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, task }),
      signal: ctx.signal,
    });
    createRes = (await r.json().catch(() => null)) as typeof createRes;
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      return { success: false, error: "Aborted", provider: "anti-captcha" };
    }
    return {
      success: false,
      provider: "anti-captcha",
      error: e instanceof Error ? e.message : String(e),
    };
  }
  if (!createRes || createRes.errorId || !createRes.taskId) {
    return {
      success: false,
      provider: "anti-captcha",
      error: createRes?.errorCode || "createTask failed",
      raw: createRes,
    };
  }
  const taskId = createRes.taskId;

  // Poll.
  const started = Date.now();
  const MAX_MS = 180_000;
  while (Date.now() - started < MAX_MS) {
    await sleep(5_000, ctx.signal);
    let poll: {
      errorId?: number;
      errorCode?: string;
      status?: string;
      solution?: { gRecaptchaResponse?: string; token?: string };
    } | null;
    try {
      const r = await fetch("https://api.anti-captcha.com/getTaskResult", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: apiKey, taskId }),
        signal: ctx.signal,
      });
      poll = (await r.json().catch(() => null)) as typeof poll;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        return { success: false, error: "Aborted", provider: "anti-captcha" };
      }
      continue;
    }
    if (poll?.errorId) {
      return {
        success: false,
        provider: "anti-captcha",
        error: poll.errorCode || "anti-captcha error",
        raw: poll,
      };
    }
    if (poll?.status === "ready" && poll.solution) {
      const token =
        poll.solution.gRecaptchaResponse || poll.solution.token || "";
      return {
        success: true,
        provider: "anti-captcha",
        captcha_type: args.captcha_type,
        token,
        solve_time_ms: Date.now() - started,
      };
    }
    // else: still processing.
  }
  return {
    success: false,
    provider: "anti-captcha",
    error: "Timed out waiting for anti-captcha solution",
    task_id: taskId,
  };
}

// ---------------------------------------------------------------------------
// Tool: solve_captcha
// ---------------------------------------------------------------------------

registerTool(
  "solve_captcha",
  "Solve a captcha challenge. Accepts image captchas (returns the recognized " +
    "text via a free OCR API) or token-based challenges — hCaptcha, reCAPTCHA " +
    "v2/v3, Cloudflare Turnstile — via 2captcha or anti-captcha when an API " +
    "key is configured in env vars. For Cloudflare 'I'm Under Attack' pages " +
    "use the bypass_cloudflare tool instead — there is no API token to solve. " +
    "Pass image_url OR image_base64 for image captchas; pass site_url + " +
    "sitekey (the data-sitekey attribute on the captcha element) for " +
    "token-based challenges.",
  {
    type: "object",
    properties: {
      captcha_type: {
        type: "string",
        enum: ["image", "hcaptcha", "recaptcha_v2", "recaptcha_v3", "turnstile", "cloudflare"],
        description:
          "Kind of captcha. 'image' = a static image with distorted text. " +
          "'hcaptcha', 'recaptcha_v2', 'recaptcha_v3', 'turnstile' = the " +
          "JavaScript widget challenges. 'cloudflare' = Cloudflare's " +
          "'I am under attack' interstitial (route to bypass_cloudflare).",
      },
      image_url: {
        type: "string",
        description: "Public URL of the captcha image (image captchas only).",
      },
      image_base64: {
        type: "string",
        description:
          "Base64-encoded captcha image bytes (image captchas only). " +
          "May include or omit the `data:image/png;base64,` prefix.",
      },
      site_url: {
        type: "string",
        description:
          "Full URL of the page where the captcha appears (token captchas only).",
      },
      sitekey: {
        type: "string",
        description:
          "The data-sitekey attribute from the captcha widget HTML " +
          "(token captchas only).",
      },
      action: {
        type: "string",
        description: "reCAPTCHA v3 action string (recaptcha_v3 only).",
      },
      min_score: {
        type: "number",
        description: "Minimum acceptable reCAPTCHA v3 score (0.0–1.0). Default 0.3.",
      },
      user_agent: {
        type: "string",
        description: "User-Agent to send to the solver (token captchas only).",
      },
      language: {
        type: "string",
        description: "OCR language code (image captchas only). Default 'eng'.",
      },
    },
    required: ["captcha_type"],
    additionalProperties: false,
  },
  async (args: SolveCaptchaArgs, ctx: ToolContext) => {
    switch (args.captcha_type) {
      case "image":
        return solveImageCaptcha(args, ctx);
      case "cloudflare":
        return {
          success: false,
          error: "use_bypass_tool",
          captcha_type: "cloudflare",
          hint:
            "Cloudflare 'I'm Under Attack' pages can't be solved with a token. " +
            "Call bypass_cloudflare(target_url=...) instead to get the headers + " +
            "browser-automation recipe.",
        };
      case "hcaptcha":
      case "recaptcha_v2":
      case "recaptcha_v3":
      case "turnstile":
        return solveTokenCaptcha(args, ctx);
      default:
        return { success: false, error: `Unknown captcha_type: ${args.captcha_type}` };
    }
  },
  false,
  "captcha",
);

// ---------------------------------------------------------------------------
// Tool: bypass_cloudflare
// ---------------------------------------------------------------------------

/**
 * Cloudflare's "I'm Under Attack" mode and Turnstile interstitial pages are
 * not captchas in the OCR sense — they're JS challenges that verify the TLS
 * fingerprint, browser feature surface, and runtime behaviour of the client.
 * No purely HTTP-based bypass exists. This tool returns the structured
 * guidance an agent needs to drive a real (headless) browser via the E2B sandbox
 * terminal / code-execution tools, plus the headers + cookies that should
 * be reused for any follow-up HTTP requests.
 */
registerTool(
  "bypass_cloudflare",
  "Get a structured bypass recipe for a Cloudflare-protected URL. Returns " +
    "the recommended browser headers, cookie expectations, and a Node/Python " +
    "snippet for driving a headless browser (puppeteer-real-browser or " +
    "playwright-extra + stealth) that solves the challenge and yields a " +
    "cf_clearance cookie. The cookie + User-Agent pair can then be reused on " +
    "plain fetch() requests for the next ~30 minutes. This tool does NOT " +
    "solve the challenge itself — it returns instructions the agent can " +
    "execute via run_terminal / code-execution, or surface to the user.",
  {
    type: "object",
    properties: {
      target_url: {
        type: "string",
        description: "The Cloudflare-protected URL to access.",
      },
      scenario: {
        type: "string",
        enum: ["auto", "iuam", "turnstile", "managed_challenge"],
        description:
          "Challenge scenario. 'auto' (default) lets the recipe detect. " +
          "'iuam' = the classic 'I'm Under Attack' 5-second interstitial. " +
          "'turnstile' = a Turnstile widget challenge. 'managed_challenge' " +
          "= a managed/interactive challenge.",
      },
      user_agent: {
        type: "string",
        description:
          "Optional User-Agent to use. If omitted, a current Chrome UA is " +
          "recommended (the cf_clearance cookie is bound to the UA).",
      },
    },
    required: ["target_url"],
    additionalProperties: false,
  },
  async (args: BypassCloudflareArgs, ctx: ToolContext) => {
    const ua = args.user_agent || DEFAULT_USER_AGENT;
    const scenario = args.scenario || "auto";
    const target = args.target_url;

    // These are the headers a real Chrome 124 sends on a navigation request.
    // Replaying them on subsequent fetch() calls (along with the cf_clearance
    // cookie) is what gets past CF's "is this a real browser?" heuristic.
    const recommendedHeaders: Record<string, string> = {
      "User-Agent": ua,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9," +
        "image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Cache-Control": "max-age=0",
      "Sec-Ch-Ua":
        '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Windows"',
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
      "Priority": "u=0, i",
    };

    const nodeSnippet = [
      "# Cloudflare bypass — puppeteer-real-browser (Node) variant.",
      "# Run inside the E2B sandbox terminal or a Node 20+ sandbox.",
      "npm i puppeteer-real-browser",
      "",
      "import { connect } from 'puppeteer-real-browser';",
      "const { page, browser } = await connect({",
      "  headless: false,             // CF often blocks headless mode",
      `  args: ['--disable-blink-features=AutomationControlled'],`,
      "  customConfig: {},",
      "});",
      `await page.setUserAgent(${JSON.stringify(ua)});`,
      `await page.goto(${JSON.stringify(target)}, { waitUntil: 'networkidle0', timeout: 60_000 });`,
      "// Wait for the CF interstitial to clear (cf_clearance cookie appears).",
      "await page.waitForFunction(() => document.cookie.includes('cf_clearance'), { timeout: 30_000 });",
      "const cookies = await page.cookies();",
      "const clearance = cookies.find(c => c.name === 'cf_clearance');",
      "console.log(JSON.stringify({ clearance, ua: await page.evaluate(() => navigator.userAgent) }));",
      "await browser.close();",
    ].join("\n");

    const pythonSnippet = [
      "# Alternative: playwright + playwright-stealth (works on Linux headless).",
      "pip install playwright playwright-stealth",
      "playwright install chromium",
      "",
      "from playwright.sync_api import sync_playwright",
      "from playwright_stealth import stealth_sync",
      "",
      "with sync_playwright() as p:",
      "    browser = p.chromium.launch(headless=False, args=['--disable-blink-features=AutomationControlled'])",
      "    ctx = browser.new_context(user_agent=" + JSON.stringify(ua) + ")",
      "    page = ctx.new_page()",
      "    stealth_sync(page)",
      `    page.goto(${JSON.stringify(target)}, wait_until='networkidle')`,
      "    page.wait_for_function(\"document.cookie.includes('cf_clearance')\", timeout=30_000)",
      "    cookies = ctx.cookies()",
      "    clearance = next((c for c in cookies if c['name'] == 'cf_clearance'), None)",
      "    print({'clearance': clearance, 'ua': " + JSON.stringify(ua) + "})",
      "    browser.close()",
    ].join("\n");

    return {
      success: true,
      captcha_type: "cloudflare",
      scenario,
      target_url: target,
      user_agent: ua,
      recommended_headers: recommendedHeaders,
      cookie_strategy: {
        cookie_name: "cf_clearance",
        lifetime: "~30 minutes",
        bound_to: "User-Agent + IP address",
        notes:
          "Replay the cf_clearance cookie AND the exact User-Agent it was " +
          "issued to on every subsequent request. A mismatch on either " +
          "invalidates the clearance.",
      },
      caveats: [
        "Cloudflare's challenge verifies the TLS (JA3) fingerprint — plain " +
          "fetch() from Node/bun will usually be flagged as a bot even with " +
          "the right headers. Use a real browser to obtain cf_clearance.",
        "Headless Chrome (default mode) is detected by CF. Use " +
          "puppeteer-real-browser or playwright-extra + stealth plugin " +
          "(both snippets below).",
        "If a Turnstile widget is shown, the cf_clearance cookie is issued " +
          "only after the widget solves — there is no API shortcut for this " +
          "step; the browser must render the page.",
        "For sustained access, consider rotating residential proxies and " +
          "refreshing the clearance cookie before its 30-minute expiry.",
      ],
      snippets: {
        node: nodeSnippet,
        python: pythonSnippet,
      },
      next_steps:
        "Run one of the snippets via the E2B sandbox run_terminal tool to obtain " +
        "cf_clearance + the matching User-Agent. Then replay those on plain " +
        "fetch() requests for ~30 minutes. If the user has a 2captcha API " +
        "key configured, solve_captcha(captcha_type='turnstile', site_url=..., " +
        "sitekey=...) can short-circuit Turnstile widgets without a browser.",
      env_hints: {
        TWOCAPTCHA_API_KEY:
          "Optional. When set, the solve_captcha tool can solve Turnstile " +
          "widgets via 2captcha — no browser required.",
        PROXY_URL:
          "Optional. Recommended for sustained scraping; CF rate-limits by IP.",
      },
      aborted: ctx.signal?.aborted ?? false,
    };
  },
  false,
  "captcha",
);

"use client";

/**
 * Perchance Official Image API v1 — browser-side, free and unlimited.
 *
 * Runs ENTIRELY in the user's browser (this app is backendless; tools execute
 * client-side), exactly like perchance.org's own embeds do:
 *
 *   1. WARM-UP  — one tiny hidden `https://perchance.org` iframe, kept around
 *      ~600ms after load (once per session — this is the handshake perchance's
 *      own example code performs before the first generation).
 *   2. GENERATE — a hidden iframe to
 *      `https://perchance.org/perchance-ai-api?<params>` with
 *      `format=json&id=<echo-id>`. The page postMessages its result back to
 *      the parent window:
 *
 *        { api: "perchance-image-api",
 *          result: { id, ok, url, prompt, seed, resolution, guidanceScale,
 *                    negativePrompt, removeBackground, generator,
 *                    generatedAt, timeMs } }
 *
 *      `url` is a PERMANENT image URL (user.uploads.dev). Errors come back as
 *      `{ ok: false, code: 400|429|500, error, retryAfter? }`.
 *
 * No API keys, no Turnstile, no server proxy — the user's own browser is the
 * client perchance expects. (Verified against perchance's own generator
 * source + the perchance-skill reverse-engineering notes, 2026-10.)
 */

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

export type PerchanceResolution = "512x512" | "512x768" | "768x512" | "768x768";

export interface PerchanceGenerateOptions {
  /** What to draw — subject, style, lighting, composition. Required. */
  prompt: string;
  /** Things to avoid in the image. */
  negativePrompt?: string;
  /** Output shape. Default "512x512". */
  resolution?: PerchanceResolution;
  /** Prompt adherence (1–14). Perchance default 7 — only sent when != 7. */
  guidanceScale?: number;
  /** -1 (default) = random seed. Only sent when >= 0. */
  seed?: number;
  /** Overall deadline. Default 180s (perchance's own example timeout). */
  timeoutMs?: number;
  /** Abort signal — cleans the iframe + listener up immediately. */
  signal?: AbortSignal;
}

export interface PerchanceImageSuccess {
  ok: true;
  /** Permanent image URL (user.uploads.dev) — safe to render and share. */
  url: string;
  prompt: string;
  seed: number;
  resolution: string;
  guidanceScale: number;
  negativePrompt?: string;
  removeBackground?: boolean;
  generator?: string;
  generatedAt?: string;
  timeMs?: number;
}

export interface PerchanceImageFailure {
  ok: false;
  /** HTTP-ish code from the API (400 bad args, 429 rate limited, 500 internal). */
  code?: number;
  error: string;
  /** Seconds to wait before retrying (429s). */
  retryAfter?: number;
}

export type PerchanceGenerateResult = PerchanceImageSuccess | PerchanceImageFailure;

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

const API_BASE = "https://perchance.org/perchance-ai-api";
const WARMUP_ORIGIN = "https://perchance.org";
const DEFAULT_TIMEOUT_MS = 180_000;
const WARMUP_SETTLE_MS = 600;
const WARMUP_TIMEOUT_MS = 15_000;
/** Only accept postMessage from perchance origins (page or its CDN frames). */
const PERCHANCE_ORIGIN_RE = /^https:\/\/([a-z0-9-]+\.)*perchance\.org$/;

export const PERCHANCE_RESOLUTIONS: readonly PerchanceResolution[] = [
  "512x512",
  "512x768",
  "768x512",
  "768x768",
];

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function randomEchoId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hiddenIframe(src: string): HTMLIFrameElement {
  const f = document.createElement("iframe");
  f.setAttribute("aria-hidden", "true");
  f.tabIndex = -1;
  f.style.cssText =
    "width:1px;height:1px;border:0;position:absolute;left:-9999px;top:-9999px;opacity:0;pointer-events:none;";
  f.src = src;
  return f;
}

// ---------------------------------------------------------------------------
// Warm-up (once per session).
// ---------------------------------------------------------------------------

let warmupPromise: Promise<boolean> | null = null;

/**
 * Establish the perchance.org session context once per page load — a 1px
 * iframe of the main site, settled ~600ms after its load event (mirrors
 * perchance's own example). Best-effort: a failed warm-up never blocks
 * generation; the API iframe is tried regardless.
 */
export function warmUpPerchance(): Promise<boolean> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.resolve(false);
  }
  if (!warmupPromise) {
    warmupPromise = new Promise<boolean>((resolve) => {
      const frame = hiddenIframe(WARMUP_ORIGIN);
      const timer = window.setTimeout(() => {
        frame.remove();
        resolve(false);
      }, WARMUP_TIMEOUT_MS);
      frame.addEventListener("load", () => {
        window.setTimeout(() => {
          window.clearTimeout(timer);
          frame.remove();
          resolve(true);
        }, WARMUP_SETTLE_MS);
      });
      document.body.appendChild(frame);
    });
  }
  return warmupPromise;
}

// ---------------------------------------------------------------------------
// Generation.
// ---------------------------------------------------------------------------

/**
 * Generate one image through Perchance's official API. Resolves with the
 * postMessage result (success carries a PERMANENT url) or a typed failure.
 * Never throws for API-level failures; only throws for environment problems
 * (no DOM) so callers can distinguish "perchance said no" from "can't run".
 */
export async function generatePerchanceImage(
  opts: PerchanceGenerateOptions,
): Promise<PerchanceGenerateResult> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return {
      ok: false,
      code: 500,
      error: "image generation needs a browser (no DOM available)",
    };
  }

  const prompt = (opts.prompt ?? "").trim();
  if (!prompt) {
    return { ok: false, code: 400, error: "Missing required parameter: prompt" };
  }
  const resolution =
    opts.resolution && PERCHANCE_RESOLUTIONS.includes(opts.resolution)
      ? opts.resolution
      : "512x512";
  const guidanceScale =
    typeof opts.guidanceScale === "number" && Number.isFinite(opts.guidanceScale)
      ? Math.min(14, Math.max(1, opts.guidanceScale))
      : 7;
  const seed = typeof opts.seed === "number" && Number.isFinite(opts.seed) ? opts.seed : -1;

  // Best-effort warm-up (never blocks beyond its own bounded timeout).
  await warmUpPerchance();

  const id = randomEchoId();
  const params = new URLSearchParams({
    prompt,
    format: "json",
    id,
    resolution,
  });
  const negativePrompt = (opts.negativePrompt ?? "").trim();
  if (negativePrompt) params.set("negativePrompt", negativePrompt);
  if (guidanceScale !== 7) params.set("guidanceScale", String(guidanceScale));
  if (seed >= 0) params.set("seed", String(seed));

  return new Promise<PerchanceGenerateResult>((resolve) => {
    const frame = hiddenIframe(`${API_BASE}?${params.toString()}`);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let settled = false;

    const finish = (result: PerchanceGenerateResult) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      window.clearTimeout(timer);
      frame.remove();
      resolve(result);
    };

    const onMessage = (event: MessageEvent) => {
      // Only perchance frames, only this API, only OUR echo id.
      if (typeof event.origin !== "string" || !PERCHANCE_ORIGIN_RE.test(event.origin)) return;
      const data = event.data as { api?: string; result?: Record<string, unknown> } | null;
      if (!data || data.api !== "perchance-image-api" || !data.result) return;
      const result = data.result;
      if (result.id !== undefined && result.id !== null && result.id !== id) return;
      if (result.ok === true) {
        finish({
          ok: true,
          url: String(result.url ?? ""),
          prompt: typeof result.prompt === "string" ? result.prompt : prompt,
          seed: typeof result.seed === "number" ? result.seed : seed,
          resolution: typeof result.resolution === "string" ? result.resolution : resolution,
          guidanceScale:
            typeof result.guidanceScale === "number" ? result.guidanceScale : guidanceScale,
          negativePrompt: negativePrompt || undefined,
          removeBackground: Boolean(result.removeBackground),
          generator: typeof result.generator === "string" ? result.generator : undefined,
          generatedAt: typeof result.generatedAt === "string" ? result.generatedAt : undefined,
          timeMs: typeof result.timeMs === "number" ? result.timeMs : undefined,
        });
      } else {
        finish({
          ok: false,
          code: typeof result.code === "number" ? result.code : undefined,
          error:
            typeof result.error === "string" && result.error
              ? result.error
              : "perchance returned an unknown error",
          retryAfter: typeof result.retryAfter === "number" ? result.retryAfter : undefined,
        });
      }
    };

    const onAbort = () =>
      finish({ ok: false, code: 499, error: "image generation was cancelled" });
    const timer = window.setTimeout(
      () =>
        finish({
          ok: false,
          code: 504,
          error: `perchance did not respond within ${Math.round(timeoutMs / 1000)}s (the frame may have been blocked — check your connection to perchance.org and try again)`,
        }),
      timeoutMs,
    );

    window.addEventListener("message", onMessage);
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    document.body.appendChild(frame);
  });
}

"use client";

import { registerTool } from "./registry";
import {
  generatePerchanceImage,
  type PerchanceResolution,
} from "@/lib/perchance/official-api";

/**
 * generate_image tool — free, unlimited AI image generation through
 * Perchance's official image API, running entirely in the user's browser
 * (no API keys, no server, no quotas — the same engine perchance.org's own
 * generators use).
 *
 * The result carries a PERMANENT image URL (user.uploads.dev) that the chat
 * UI renders inline beneath the assistant's reply — the user sees the image
 * the moment it resolves, with a Regenerate button beside it.
 *
 * In background (E2B) turns the call is bridged to the user's connected
 * browser tab (the only place the perchance iframe can run); with no browser
 * connected it fails fast with an actionable message instead of hanging.
 */

const RESOLUTIONS = ["512x512", "512x768", "768x512", "768x768"] as const;

function argString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v.trim() : "";
}

function argNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

registerTool(
  "generate_image",
  `Generate an image from a text description and show it inline in the chat. FREE, UNLIMITED and INSTANT (5-30s) — no API key, no quota; runs in the user's own browser via Perchance's image API. This is THE tool for any image-creation request (art, illustrations, photos, logos, concept art, textures, scene mockups). The rendered image appears directly in the conversation with a Regenerate button — describe what you want clearly and let it render; never pretend to have made an image without calling this tool.

Arguments:
- prompt (required): What to draw — subject, style, lighting, composition, quality terms. Be specific and descriptive (e.g. "a red apple on a wooden table, studio lighting, photorealistic").
- negative_prompt (optional): What to avoid (e.g. "blurry, low quality, text").
- resolution: "512x512" (square, default) | "512x768" (portrait) | "768x512" (landscape) | "768x768" (higher-quality square).
- guidance_scale: 1-14, default 7 — how strictly to follow the prompt.
- seed: integer, -1/omitted = random. Pass a previous seed to reproduce an image.

Returns { ok, url, prompt, seed, resolution, guidanceScale, timeMs } — url is PERMANENT (shareable). On failure returns { ok:false, error, code } with the real reason (429 = rate limited, retry shortly).`,
  {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "What to draw: subject, art style, lighting, composition, quality terms. Be specific and descriptive.",
      },
      negative_prompt: {
        type: "string",
        description: "Optional — things to avoid in the image (e.g. 'blurry, low quality, text').",
      },
      resolution: {
        type: "string",
        enum: [...RESOLUTIONS],
        description:
          "Output shape: 512x512 square (default), 512x768 portrait, 768x512 landscape, 768x768 higher-quality square.",
      },
      guidance_scale: {
        type: "number",
        description: "Prompt adherence, 1-14. Default 7. Higher = stricter, lower = more creative.",
      },
      seed: {
        type: "integer",
        description: "Reproducibility seed. -1 or omitted = random. Reuse a previous seed to reproduce an image.",
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const prompt = argString(args, "prompt");
    if (!prompt) {
      return {
        ok: false as const,
        code: 400,
        error: "Missing required parameter: prompt",
      };
    }
    const negativePrompt = argString(args, "negative_prompt") || argString(args, "negativePrompt");
    const resolutionArg = argString(args, "resolution");
    const resolution: PerchanceResolution | undefined = RESOLUTIONS.includes(
      resolutionArg as (typeof RESOLUTIONS)[number],
    )
      ? (resolutionArg as PerchanceResolution)
      : undefined;
    const guidanceScale = argNumber(args, "guidance_scale") ?? argNumber(args, "guidanceScale");
    const seed = argNumber(args, "seed");

    const result = await generatePerchanceImage({
      prompt,
      negativePrompt: negativePrompt || undefined,
      resolution,
      guidanceScale,
      seed,
      signal: ctx.signal,
    });

    if (!result.ok) {
      // Structured failure — the model reads it and can relay/retry honestly.
      return {
        ok: false as const,
        code: result.code,
        error: result.error,
        ...(result.retryAfter !== undefined ? { retryAfter: result.retryAfter } : {}),
      };
    }
    return {
      ok: true as const,
      url: result.url,
      prompt: result.prompt,
      seed: result.seed,
      resolution: result.resolution,
      guidanceScale: result.guidanceScale,
      ...(result.negativePrompt ? { negativePrompt: result.negativePrompt } : {}),
      ...(result.timeMs !== undefined ? { timeMs: result.timeMs } : {}),
    };
  },
  false,
  "media",
);

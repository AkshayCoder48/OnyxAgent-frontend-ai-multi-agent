"use client";

/**
 * inspect_image tool (Runtime PRD §49–§54, §57–§59, §110–§116, §120–§123) —
 * REAL image inspection. The model doesn't guess: the bytes are resolved
 * browser-side (workspace/sandbox files, OPFS uploads, http(s) URLs, or a
 * base64 data URL), size-conditioned (§58 downscale), and sent to the
 * server-side /api/vision route whose vision-capable model actually LOOKS
 * at the image. The description that comes back is what the agent — and the
 * user — see.
 *
 * Honesty contract (§114/§123): every failure returns
 *   { error: "Image unavailable", path, reason }
 * with a REAL reason (not found in sandbox / not an image / too large /
 * vision call failed + status). The tool NEVER invents a description and
 * never claims the model saw an image it didn't.
 *
 * SUCCESS result payload (§54/§111 — the user sees which image the AI is
 * analyzing): { kind: "image_inspection", source, url, alt, description }.
 * The runtime JSON-stringifies this return value into the model-visible
 * tool-result message, so the description lands in the conversation context
 * for the next round — the same single-value pattern preview_image,
 * create_app and manage_web_session use.
 */

import { registerTool } from "./registry";
import {
  ensureVisionSizedDataUrl,
  resolveImageSource,
} from "./image-sources";

const DEFAULT_PROMPT =
  "Describe this image precisely: contents, text visible, colors, layout, and anything notable.";

/** Route contract: prompts are capped at 4000 chars. */
const MAX_PROMPT_CHARS = 4000;

function visionPrompt(question: string): string {
  const q = question.trim();
  if (!q) return DEFAULT_PROMPT;
  const room = MAX_PROMPT_CHARS - DEFAULT_PROMPT.length - "\n\nQuestion: ".length;
  return `${DEFAULT_PROMPT}\n\nQuestion: ${q.slice(0, Math.max(0, room)).trim()}`;
}

registerTool(
  "inspect_image",
  `Actually LOOK at an image with real vision and get back a precise description of what's in it (contents, visible text, colors, layout, notable details). Use this whenever you need to see an image instead of guessing: uploaded photos, workspace/sandbox image files (e.g. "projects/my-app/public/logo.png"), web-session screenshots (".onyx/websession/shots/shot-3.png"), http(s) image URLs, or a base64 data URL.

Parameters:
- source (required): where the image lives —
  • a sandbox/workspace path (relative to /home/user): "projects/my-app/public/logo.png", "uploads/photo.jpg", ".onyx/websession/shots/shot-2.png"
  • an uploaded file name exactly as attached (e.g. "photo.jpg") — uploads are checked first, then the sandbox
  • an http(s):// URL
  • a base64 data URL ("data:image/png;base64,...")
  The file does not need an image extension — the content is verified by magic bytes.
- question (optional): what to look for or answer about the image (e.g. "What error message is shown in this screenshot?").

The image (or its thumbnail) and the description are shown to the user inline. On failure the tool reports an honest error with the reason — it never invents a description. To only DISPLAY an image without analysis, use preview_image instead.`,
  {
    type: "object",
    properties: {
      source: {
        type: "string",
        description:
          "Image source: a sandbox/workspace path, an uploaded file name, an http(s):// URL, or a base64 data URL.",
      },
      question: {
        type: "string",
        description:
          "Optional question about the image — what to look for or answer (appended to the vision prompt).",
      },
    },
    required: ["source"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const source = String(args.source ?? "").trim();
    const question = typeof args.question === "string" ? args.question.trim() : "";

    if (!source) {
      return { error: "Image unavailable", path: "", reason: "'source' is required." };
    }

    // ── 1. Resolve the image bytes → a verified data URL (§49–§57, §116). ──
    let resolved: Awaited<ReturnType<typeof resolveImageSource>>;
    try {
      resolved = await resolveImageSource(source, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: "Image unavailable", path: source, reason: `resolution failed — ${msg}` };
    }
    if (!resolved.ok) {
      return { error: "Image unavailable", path: source, reason: resolved.reason };
    }

    // ── 2. Size-condition for the vision call (§58) — downscale > 4 MB via
    //       canvas (long edge ≤ 1568, JPEG 0.85); never a placeholder. ─────
    let visionUrl: string;
    try {
      visionUrl = await ensureVisionSizedDataUrl(resolved.image.dataUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: "Image unavailable", path: source, reason: `image processing failed — ${msg}` };
    }

    // ── 3. The vision call itself — server-side only (the SDK never runs in
    //       the browser). Failures are surfaced honestly (§113/§123). ──────
    let res: Response;
    try {
      res = await fetch("/api/vision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: visionPrompt(question), imageDataUrl: visionUrl }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        error: "Image unavailable",
        path: source,
        reason: `vision call failed — the request to /api/vision did not complete (${msg})`,
      };
    }

    const data = (await res.json().catch(() => null)) as {
      description?: unknown;
      error?: unknown;
    } | null;
    if (!res.ok || !data || typeof data.description !== "string" || !data.description.trim()) {
      const reason =
        typeof data?.error === "string" && data.error
          ? data.error
          : `HTTP ${res.status}${res.statusText ? ` (${res.statusText})` : ""}`;
      return { error: "Image unavailable", path: source, reason: `vision call failed — ${reason}` };
    }

    // ── 4. Success: the payload renders inline (§54/§111) and the runtime
    //       stringifies it into the model-visible tool result, so the
    //       description is in the conversation context for the next round. ─
    return {
      kind: "image_inspection" as const,
      source,
      url: visionUrl,
      alt: source,
      description: data.description.trim(),
    };
  },
  false,
  "general",
);

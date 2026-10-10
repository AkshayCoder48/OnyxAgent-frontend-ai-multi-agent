/**
 * Vision inspection API (Runtime PRD §110–§116, §120–§123) — the ONLY place
 * the app's backendless image flow touches a real vision model.
 *
 * Contract:
 *   POST { prompt: string, imageDataUrl: string }
 *   → 200 { description: string }
 *   → 4xx/5xx { error: string }   (honest — never a fabricated description)
 *
 * The browser-side `inspect_image` tool resolves an image from the workspace
 * (sandbox), the uploads registry, a URL, or a data URL, size-conditions it
 * (§58 downscale) and posts it here. The z-ai-web-dev-sdk is BACKEND-ONLY —
 * it must never be imported from client code, which is exactly why this
 * route exists.
 *
 * Privacy: the image payload is never logged — only lengths and error
 * messages (capped) are.
 */

import { NextRequest, NextResponse } from "next/server";
import ZAI from "z-ai-web-dev-sdk";
import type { CreateChatCompletionVisionBody } from "z-ai-web-dev-sdk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Vision calls with multi-MB images can take tens of seconds — 2 minutes is
// a generous but bounded window (chat-proxy uses 300 for long streams).
export const maxDuration = 120;

/** Max prompt length (chars) — the description question, not the image. */
const MAX_PROMPT_CHARS = 4000;
/** Hard cap on the whole data URL (~7 MB, §58 keeps real payloads far below). */
const MAX_DATA_URL_CHARS = 7 * 1024 * 1024;
/**
 * Accepted data URL shapes (§57): base64 payload of a png/jpeg/jpg/gif/webp/bmp
 * image. Extension mimetypes are NOT trusted for the vision call either — the
 * client sniffs magic bytes before sending; this is defense in depth.
 */
const DATA_URL_RE = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+/=]+$/i;

function badRequest(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400 });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── Parse + validate (never log the body) ─────────────────────────────
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("Request body must be valid JSON: { prompt, imageDataUrl }.");
  }
  const { prompt, imageDataUrl } = (body ?? {}) as {
    prompt?: unknown;
    imageDataUrl?: unknown;
  };

  if (typeof prompt !== "string" || !prompt.trim()) {
    return badRequest("'prompt' is required (a non-empty string).");
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return badRequest(`'prompt' is too long (${prompt.length} chars; max ${MAX_PROMPT_CHARS}).`);
  }
  if (typeof imageDataUrl !== "string" || !DATA_URL_RE.test(imageDataUrl)) {
    return badRequest(
      "'imageDataUrl' must be a base64 data URL for a png, jpeg, jpg, gif, webp, or bmp image " +
        "(e.g. 'data:image/png;base64,...').",
    );
  }
  if (imageDataUrl.length > MAX_DATA_URL_CHARS) {
    return badRequest(
      `Image is too large (data URL is ${imageDataUrl.length} chars; max ~${MAX_DATA_URL_CHARS}). ` +
        "Downscale it before calling (long edge ≤ 1568 px).",
    );
  }

  // ── Vision call (server-side SDK only) ────────────────────────────────
  try {
    const zai = await ZAI.create();
    // The SDK's typings mark `model` as required, but both documented usages
    // (the SDK README §3.2 and the bundled CLI) omit it — the endpoint
    // applies its default vision-capable model. Follow the documented shape
    // and cast only to bridge the typings gap.
    const visionBody = {
      messages: [
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: prompt },
            { type: "image_url" as const, image_url: { url: imageDataUrl } },
          ],
        },
      ],
      thinking: { type: "disabled" as const },
    } as CreateChatCompletionVisionBody;

    const response = await zai.chat.completions.createVision(visionBody);
    const description: unknown = response?.choices?.[0]?.message?.content ?? "";
    if (typeof description !== "string" || !description.trim()) {
      // §123 — never claim the model saw the image when it produced nothing.
      return NextResponse.json(
        { error: "The vision model returned an empty description." },
        { status: 502 },
      );
    }
    return NextResponse.json({ description });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Never log the image payload — only the (capped) failure message.
    console.error("[api/vision] vision call failed:", message.slice(0, 300));
    return NextResponse.json(
      { error: `Vision call failed: ${message.slice(0, 300)}` },
      { status: 502 },
    );
  }
}

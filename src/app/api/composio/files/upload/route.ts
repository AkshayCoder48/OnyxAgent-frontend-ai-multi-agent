// ============================================================================
// POST /api/composio/files/upload — stage a file for a Composio tool.
//
//   Body: { toolkitSlug: string, toolSlug: string, filename: string,
//           mimetype?: string, contentB64: string }
//   Headers: x-composio-key, x-composio-session?, x-composio-user
//
// Two-step Composio Files API flow (verified docs.composio.dev, v3.1):
//   1. POST /api/v3.1/files/upload/request — mint a presigned URL + the
//      storage `key` (that key IS the `s3key` tool parameters want).
//   2. PUT the raw bytes to the presigned URL (azure backends additionally
//      need `x-ms-blob-type: BlockBlob`).
//
// The proxy exists so the API key + presigned URL never enter the browser
// beyond this one call, and the tool's `s3key` field stops being fabricated
// (the model used to invent `s3key: ""` — user report 2026-11-25, Apollo
// files API HTTP 400).
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { authComposio, composioErrorResponse, readJsonBody } from "@/lib/composio/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Hard cap on staged content (Composio tools aren't a file-drop service). */
const MAX_CONTENT_BYTES = 20 * 1024 * 1024; // 20 MB

/** Default mimetype when the caller doesn't know it — Composio requires the
 *  field; a plain-text fallback is safer than omitting it. */
const FALLBACK_MIME = "text/plain";

function b64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const a = authComposio(req);
  if ("error" in a) return a.error;
  const { client } = a;

  const body = await readJsonBody(req);
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const toolkitSlug = str(body.toolkitSlug).toLowerCase();
  const toolSlug = str(body.toolSlug);
  const filename = str(body.filename);
  const mimetype = str(body.mimetype) || FALLBACK_MIME;
  const contentB64 = typeof body.contentB64 === "string" ? body.contentB64 : "";

  if (!toolkitSlug || !toolSlug || !filename) {
    return NextResponse.json(
      {
        ok: false,
        error: "BAD_REQUEST",
        message: "toolkitSlug, toolSlug and filename are required.",
      },
      { status: 400 },
    );
  }
  if (!contentB64) {
    return NextResponse.json(
      { ok: false, error: "BAD_REQUEST", message: "contentB64 (base64 file bytes) is required." },
      { status: 400 },
    );
  }

  const bytes = b64ToBytes(contentB64);
  if (!bytes) {
    return NextResponse.json(
      { ok: false, error: "BAD_REQUEST", message: "contentB64 is not valid base64." },
      { status: 400 },
    );
  }
  if (bytes.length > MAX_CONTENT_BYTES) {
    return NextResponse.json(
      {
        ok: false,
        error: "BAD_REQUEST",
        message: `File too large: ${bytes.length} bytes (max ${MAX_CONTENT_BYTES}).`,
      },
      { status: 413 },
    );
  }

  try {
    // MD5 integrity digest the API requires (hex). Node's WebCrypto has no
    // MD5, but this route runs on the nodejs runtime — node:crypto does.
    const { createHash } = await import("node:crypto");
    const md5 = createHash("md5").update(bytes).digest("hex");

    // Step 1 — mint the presigned URL + storage key.
    const staged = await client.requestFileUpload({
      toolkitSlug,
      toolSlug,
      filename,
      mimetype,
      md5,
    });

    // Step 2 — PUT the bytes to the presigned URL. Azure Blob backends
    // require the block-blob type header (verified docs note).
    const headers: Record<string, string> = { "Content-Type": mimetype };
    if (/azure/i.test(staged.storageBackend)) headers["x-ms-blob-type"] = "BlockBlob";
    const put = await fetch(staged.presignedUrl, {
      method: "PUT",
      headers,
      body: bytes as unknown as BodyInit,
      signal: AbortSignal.timeout(30_000),
    });
    if (!put.ok) {
      const text = await put.text().catch(() => "");
      return NextResponse.json(
        {
          ok: false,
          error: "UPLOAD_FAILED",
          message: `Presigned PUT failed (HTTP ${put.status}). ${text.slice(0, 200)}`.trim(),
          ...(staged.id ? { requestId: staged.id } : {}),
        },
        { status: 502 },
      );
    }

    // The storage key IS the s3key the tool's file parameter wants.
    return NextResponse.json({
      ok: true,
      s3key: staged.key,
      requestId: staged.id,
      fileDescriptor: { name: filename, mimetype, s3key: staged.key },
      hint: `Pass { name, mimetype, s3key } as the tool's file_to_upload parameter.`,
    });
  } catch (e) {
    return composioErrorResponse(e);
  }
}

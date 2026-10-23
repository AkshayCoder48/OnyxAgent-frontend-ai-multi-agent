// ============================================================================
// JEV Decision Engine — server-side integration layer (PRD §9).
//
// Stateless proxy for POST https://jev-ai.dev/api/decide/ — keeps the browser
// off cross-origin restrictions, enforces a hard timeout, and applies the
// documented request headers. Mirrors the chat-proxy style: no auth, no DB,
// no logging of payloads.
//
// The upstream endpoint is currently documented with a "text-classifier" tool
// returning { ok, tool, result: { kind: "choice", value, label, confidence,
// probabilities: [{ key, label, probability }] } }. Every response is
// validated on the client adapter side — an HTTP 200 is NOT treated as proof
// of a usable decision (PRD §9.4).
// ============================================================================

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const JEV_ENDPOINT = "https://jev-ai.dev/api/decide/";
const REQUEST_TIMEOUT_MS = 20_000;

/** Max labels per request (guards payload size; the classifier is label-based). */
const MAX_LABELS = 12;
const MAX_INPUT_CHARS = 8_000;

export async function POST(request: NextRequest) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_body" } },
      { status: 400 },
    );
  }

  // ---- Validate the forwarded payload shape (tool / input / labels) -------
  const body = payload as {
    tool?: unknown;
    input?: unknown;
    labels?: unknown;
  };

  const errors: string[] = [];
  if (typeof body.tool !== "string" || !body.tool.trim()) errors.push("tool must be a non-empty string");
  if (typeof body.input !== "string" || !body.input.trim()) errors.push("input must be a non-empty string");
  if (
    !Array.isArray(body.labels) ||
    body.labels.length === 0 ||
    body.labels.some((l) => typeof l !== "string" || !l.trim())
  ) {
    errors.push("labels must be a non-empty array of strings");
  }
  if (errors.length > 0) {
    return NextResponse.json(
      { ok: false, error: { code: "invalid_payload", details: errors } },
      { status: 400 },
    );
  }

  const labels = (body.labels as string[]).slice(0, MAX_LABELS);
  const input = (body.input as string).slice(0, MAX_INPUT_CHARS);

  // ---- Call upstream with the documented headers --------------------------
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const resp = await fetch(JEV_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
        Origin: "https://jev-ai.dev",
        Referer: "https://jev-ai.dev/",
      },
      body: JSON.stringify({
        tool: body.tool,
        input,
        labels,
      }),
      signal: controller.signal,
      cache: "no-store",
    });

    const text = await resp.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    // Pass the upstream status + body through — the client adapter performs
    // schema validation and fallback (PRD §9.5). We never fake success here.
    return new NextResponse(text || '{"ok":false,"error":{"code":"empty_body"}}', {
      status: resp.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "x-jev-status": String(resp.status),
      },
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: aborted ? "timeout" : "network_error",
          message: aborted ? "JEV request timed out" : "JEV request failed",
        },
      },
      { status: aborted ? 504 : 502 },
    );
  } finally {
    clearTimeout(timer);
  }
}

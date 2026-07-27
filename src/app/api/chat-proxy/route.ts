/**
 * Stateless streaming CORS proxy for OpenAI-compatible AI providers.
 *
 * The browser cannot call most AI provider endpoints directly because of CORS
 * (e.g. `failed to fetch`). This route forwards the request server-side and
 * streams the response back, transparently adding permissive CORS headers so
 * the browser is happy.
 *
 * Design constraints:
 *   - NO database, NO auth, NO logging of request bodies.
 *   - The user's API key is passed through from the client (encrypted at rest
 *     on the client side; we only see it in transit to the upstream provider).
 *   - Stateless — every request is self-contained.
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 5 minutes — generous window for long streaming completions.
export const maxDuration = 300;

/**
 * Headers that we forward from the incoming client request to the upstream
 * AI provider. We always include Authorization + Content-Type, plus any
 * provider-specific hints the client attached (x-oai-*, anthropic-*).
 */
const FORWARDABLE_PREFIXES = ["x-oai-", "anthropic-"] as const;

/**
 * Response headers from the upstream that should pass through to the client
 * alongside the body. These include rate-limit information and model metadata
 * that the client may want to display.
 */
const PASSTHROUGH_RESPONSE_PREFIXES = [
  "x-ratelimit-",
  "x-model",
  "x-provider",
] as const;

function isForwardableHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === "authorization") return true;
  if (lower === "content-type") return true;
  return FORWARDABLE_PREFIXES.some((p) => lower.startsWith(p));
}

function isPassthroughResponseHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return PASSTHROUGH_RESPONSE_PREFIXES.some((p) =>
    p.endsWith("-") ? lower.startsWith(p) : lower === p,
  );
}

/**
 * Build a CORS preflight / response header set.
 */
function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers":
      "Content-Type, Authorization, x-target-url, x-oai-*, anthropic-*",
    "access-control-max-age": "86400",
  };
}

/**
 * Validate that the given URL string is an http(s) URL we can safely proxy to.
 * Returns the parsed URL or null if invalid.
 */
function safeParseTargetUrl(raw: string | null): URL | null {
  if (!raw) return null;
  let url: URL | null = null;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  return url;
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

// GET proxy — used for fetching the SkillsMP catalog and other GET APIs that
// don't support CORS. The target URL is passed in the x-target-url header.
export async function GET(
  request: Request,
): Promise<NextResponse | Response> {
  // Try header first, then ?url= query param as fallback.
  let targetUrl = safeParseTargetUrl(request.headers.get("x-target-url"));
  if (!targetUrl) {
    const urlParam = new URL(request.url).searchParams.get("url");
    if (urlParam) {
      targetUrl = safeParseTargetUrl(urlParam);
    }
  }
  if (!targetUrl) {
    return NextResponse.json(
      { error: "Missing or invalid target URL. Pass via x-target-url header or ?url= query param." },
      { status: 400, headers: corsHeaders() },
    );
  }

  const forwardHeaders: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
  };

  const authHeader = request.headers.get("authorization");
  if (authHeader) {
    forwardHeaders["authorization"] = authHeader;
  }

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl.toString(), {
      method: "GET",
      headers: forwardHeaders,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown network error";
    return NextResponse.json(
      { error: `Failed to reach upstream: ${message}` },
      { status: 502, headers: corsHeaders() },
    );
  }

  const responseHeaders: Record<string, string> = {
    ...corsHeaders(),
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    "cache-control": "no-store",
  };

  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export async function POST(
  request: Request,
): Promise<NextResponse | Response> {
  // Read the raw body as text — we never inspect or log it.
  let body: string;
  try {
    body = await request.text();
  } catch {
    return NextResponse.json(
      { error: "Failed to read request body." },
      { status: 400, headers: corsHeaders() },
    );
  }

  // Try in order: ?url= query param → x-target-url header → _targetUrl body field.
  // Vercel strips custom headers, so we need multiple fallbacks.
  const urlObj = new URL(request.url);
  let targetUrl = safeParseTargetUrl(urlObj.searchParams.get("url"));
  if (!targetUrl) {
    targetUrl = safeParseTargetUrl(request.headers.get("x-target-url"));
  }
  if (!targetUrl) {
    try {
      const parsed = JSON.parse(body) as { _targetUrl?: string };
      if (parsed._targetUrl) {
        targetUrl = safeParseTargetUrl(parsed._targetUrl);
        delete parsed._targetUrl;
        body = JSON.stringify(parsed);
      }
    } catch {
      // body is not JSON — skip
    }
  }
  if (!targetUrl) {
    return NextResponse.json(
      {
        error:
          "Missing or invalid target URL. Must be an http(s) URL passed via ?url= query param, x-target-url header, or _targetUrl body field.",
      },
      { status: 400, headers: corsHeaders() },
    );
  }

  // Build the forward headers. We only forward what's explicitly allow-listed
  // to avoid leaking internal headers (and to avoid breaking upstream with
  // browser-added headers like `origin`/`referer`).
  const forwardHeaders: Record<string, string> = {
    "content-type": "application/json",
  };

  const authHeader = request.headers.get("authorization");
  if (authHeader) {
    forwardHeaders["authorization"] = authHeader;
  }

  for (const [name, value] of request.headers.entries()) {
    if (isForwardableHeader(name) && name.toLowerCase() !== "content-type") {
      forwardHeaders[name.toLowerCase()] = value;
    }
  }

  // Always advertise we accept streaming responses.
  if (!forwardHeaders["accept"]) {
    forwardHeaders["accept"] = "text/event-stream,application/json;q=0.9";
  }

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl.toString(), {
      method: "POST",
      headers: forwardHeaders,
      body,
      // `duplex: "half"` is required by Node's undici when streaming a body
      // to a fetch() request and is a no-op otherwise.
      // @ts-expect-error — `duplex` is valid in undici but not in the DOM lib.
      duplex: "half",
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      return NextResponse.json(
        { error: "Client aborted the request." },
        { status: 499, headers: corsHeaders() },
      );
    }
    const message =
      err instanceof Error ? err.message : "Unknown network error";
    return NextResponse.json(
      { error: `Failed to reach upstream AI provider: ${message}` },
      { status: 502, headers: corsHeaders() },
    );
  }

  // ---- Error response: pass upstream content-type so clients can parse it ----
  if (!upstream.ok || !upstream.body) {
    const upstreamContentType =
      upstream.headers.get("content-type") ?? "application/json";

    const responseHeaders: Record<string, string> = {
      ...corsHeaders(),
      "content-type": upstreamContentType,
      "cache-control": "no-store",
    };

    // Pass through rate-limit headers even on errors so clients can back off.
    for (const [name, value] of upstream.headers.entries()) {
      if (isPassthroughResponseHeader(name)) {
        responseHeaders[name.toLowerCase()] = value;
      }
    }

    const errorBody = await upstream.text().catch(() => "");
    return new NextResponse(errorBody || null, {
      status: upstream.status,
      headers: responseHeaders,
    });
  }

  // ---- Success: stream the response body straight through ----
  const responseHeaders: Record<string, string> = {
    ...corsHeaders(),
    "content-type":
      upstream.headers.get("content-type") ??
      "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  };

  // Pass through rate-limit + model metadata headers.
  for (const [name, value] of upstream.headers.entries()) {
    if (isPassthroughResponseHeader(name)) {
      responseHeaders[name.toLowerCase()] = value;
    }
  }

  // Direct passthrough — no TransformStream, no buffering, no transformation.
  // Next.js will stream `upstream.body` chunk-by-chunk to the client.
  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

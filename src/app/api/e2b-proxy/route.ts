// ============================================================================
// Sandbox Proxy — server-side proxy for the E2B sandbox REST API.
// Fixes CORS errors. Forwards GET/POST/DELETE to https://api.e2b.dev.
//
// This was previously the Hopx proxy (https://api.e2b.dev). It now
// forwards to E2B (https://api.e2b.dev) but keeps the same proxy structure
// and accepts both the new `x-sandbox-target-url` header and the legacy
// `x-sandbox-target-url` header (for back-compat with any code that hasn't
// been updated yet — the client sets both).
//
// Headers (either name works):
//   x-sandbox-target-url  /  x-sandbox-target-url
//     Full target URL (e.g. https://api.e2b.dev/sandboxes or
//     https://api.e2b.dev/sandboxes/{id}/code).
//   Authorization: Bearer <e2b_api_key> — always sent.
//   X-API-Key: <e2b_api_key> — alternative auth header E2B accepts.
//   x-sandbox-jwt  /  x-hopx-jwt
//     Per-sandbox envd access token (set on sandbox-internal calls). When
//     present, overrides the master API key as the Authorization Bearer
//     token — matches E2B's RBAC for secure templates.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Read the target URL from either the new or legacy header name. */
function getTargetUrl(req: NextRequest): string | null {
  return (
    req.headers.get("x-sandbox-target-url") ??
    req.headers.get("x-sandbox-target-url") ??
    null
  );
}

/** Read the per-sandbox envd JWT from either header name. */
function getJwt(req: NextRequest): string | null {
  return (
    req.headers.get("x-sandbox-jwt") ??
    req.headers.get("x-hopx-jwt") ??
    null
  );
}

function buildForwardHeaders(req: NextRequest): Record<string, string> {
  const auth = req.headers.get("authorization");
  const jwt = getJwt(req);
  const xApiKey = req.headers.get("x-api-key");

  const forwardHeaders: Record<string, string> = {};
  // For sandbox-internal API calls, use the per-sandbox envd token as the
  // Bearer token. Otherwise fall back to the master API key.
  if (jwt) forwardHeaders["Authorization"] = `Bearer ${jwt}`;
  else if (auth) forwardHeaders["Authorization"] = auth;
  // E2B accepts X-API-Key as an alternative to Authorization — forward it
  // when present so the request works even if only X-API-Key was set.
  if (xApiKey) forwardHeaders["X-API-Key"] = xApiKey;
  return forwardHeaders;
}

function parseTargetUrl(targetUrl: string): URL | null {
  try {
    const u = new URL(targetUrl);
    if (u.protocol !== "https:") return null;
    // Allow only the E2B API host (and any per-sandbox envd host on the
    // e2b.dev domain). This is a CORS-safe allow-list — without it, a
    // malicious page could use the proxy to fetch arbitrary https URLs.
    // We permit:
    //   - api.e2b.dev
    //   - *.e2b.dev (per-sandbox envd hosts like {sandboxID}-3000.e2b.dev)
    // The legacy api.hopx.dev host is still allowed for back-compat with
    // any cached client config that points there.
    const host = u.hostname.toLowerCase();
    if (
      host === "api.e2b.dev" ||
      host.endsWith(".e2b.dev") ||
      host === "api.hopx.dev" ||
      host.endsWith(".hopx.dev")
    ) {
      return u;
    }
    return null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const targetUrl = getTargetUrl(req);
  if (!targetUrl) {
    return NextResponse.json(
      { error: "Missing x-sandbox-target-url (or x-sandbox-target-url) header" },
      { status: 400 },
    );
  }

  const parsedUrl = parseTargetUrl(targetUrl);
  if (!parsedUrl) {
    return NextResponse.json(
      { error: "Invalid target URL — must be on *.e2b.dev (or legacy *.hopx.dev)" },
      { status: 400 },
    );
  }

  const forwardHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...buildForwardHeaders(req),
  };

  const body = await req.text();

  try {
    const upstreamRes = await fetch(parsedUrl.toString(), {
      method: "POST",
      headers: forwardHeaders,
      body: body || undefined,
    });

    const contentType = upstreamRes.headers.get("content-type") ?? "application/json";
    const responseHeaders = new Headers({
      "content-type": contentType,
      "access-control-allow-origin": "*",
    });

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      return new NextResponse(errText, {
        status: upstreamRes.status,
        headers: responseHeaders,
      });
    }

    const text = await upstreamRes.text();
    return new NextResponse(text, { status: 200, headers: responseHeaders });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Proxy error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function GET(req: NextRequest) {
  const targetUrl = getTargetUrl(req);
  if (!targetUrl) {
    return NextResponse.json(
      { error: "Missing x-sandbox-target-url (or x-sandbox-target-url) header" },
      { status: 400 },
    );
  }

  const parsedUrl = parseTargetUrl(targetUrl);
  if (!parsedUrl) {
    return NextResponse.json(
      { error: "Invalid target URL — must be on *.e2b.dev (or legacy *.hopx.dev)" },
      { status: 400 },
    );
  }

  const forwardHeaders = buildForwardHeaders(req);

  try {
    const upstreamRes = await fetch(parsedUrl.toString(), {
      method: "GET",
      headers: forwardHeaders,
    });

    const contentType = upstreamRes.headers.get("content-type") ?? "application/json";
    const responseHeaders = new Headers({
      "content-type": contentType,
      "access-control-allow-origin": "*",
    });

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      return new NextResponse(errText, {
        status: upstreamRes.status,
        headers: responseHeaders,
      });
    }

    const text = await upstreamRes.text();
    return new NextResponse(text, { status: 200, headers: responseHeaders });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Proxy error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const targetUrl = getTargetUrl(req);
  if (!targetUrl) {
    return NextResponse.json(
      { error: "Missing x-sandbox-target-url (or x-sandbox-target-url) header" },
      { status: 400 },
    );
  }

  const parsedUrl = parseTargetUrl(targetUrl);
  if (!parsedUrl) {
    return NextResponse.json(
      { error: "Invalid target URL — must be on *.e2b.dev (or legacy *.hopx.dev)" },
      { status: 400 },
    );
  }

  const forwardHeaders = buildForwardHeaders(req);

  try {
    const upstreamRes = await fetch(parsedUrl.toString(), {
      method: "DELETE",
      headers: forwardHeaders,
    });

    const responseHeaders = new Headers({
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    });

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      return new NextResponse(errText, {
        status: upstreamRes.status,
        headers: responseHeaders,
      });
    }

    return new NextResponse(null, { status: 204, headers: responseHeaders });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Proxy error";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-max-age": "86400",
    },
  });
}

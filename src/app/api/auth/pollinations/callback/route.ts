/**
 * GET /api/auth/pollinations/callback — the canonical Pollinations OAuth
 * redirect target (registered as
 * `${NEXT_PUBLIC_APP_URL}/api/auth/pollinations/callback` on the App Key).
 *
 * Official flow: Pollinations redirects here with
 *   ?code=...&state=...   (success — code is single-use, expires in 10 min)
 *   ?error=access_denied&state=...  (user denied / provider error)
 *
 * This route validates the anti-CSRF `state` against the HttpOnly cookie set
 * by /api/pollinations/oauth/start, then hands the one-time code to the SPA
 * (a full-page navigation cannot return JSON). The SPA completes the
 * exchange server-side via POST /api/pollinations/oauth/complete — the
 * authorization code is a protocol-required, PKCE-protected, single-use
 * parameter, and the resulting sk_ token NEVER appears in any URL.
 */
import { OAUTH_COOKIE, publicOrigin } from "@/lib/pollinations-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function sanitizeParam(v: string | null): string | null {
  // Keep the value out of any header/reflection surface; cap length.
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t.length > 2048) return null;
  if (!/^[A-Za-z0-9._~:@\-\/+%=]+$/.test(t)) return null;
  return t;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = publicOrigin(req);
  const back = (params: Record<string, string>) => {
    const to = new URL("/", origin);
    for (const [k, v] of Object.entries(params)) to.searchParams.set(k, v);
    return Response.redirect(to.toString(), 302);
  };

  // Provider-reported failure (user denied, misconfig, …) — surface honestly.
  const errorParam = url.searchParams.get("error");
  if (errorParam) {
    return back({ pollinations_error: errorParam.slice(0, 64) });
  }

  const code = sanitizeParam(url.searchParams.get("code"));
  const state = sanitizeParam(url.searchParams.get("state"));
  if (!code || !state) {
    return back({ pollinations_error: "invalid_callback" });
  }

  // Validate state against the HttpOnly cookie (CSRF protection).
  let cookieState: string | null = null;
  try {
    const raw = readCookie(req, OAUTH_COOKIE);
    if (raw) cookieState = (JSON.parse(raw) as { state?: string }).state ?? null;
  } catch {
    cookieState = null;
  }
  if (!cookieState || cookieState !== state) {
    return back({ pollinations_error: "state_mismatch" });
  }

  // State is valid — hand the one-time code to the SPA (it completes the
  // server-side exchange immediately after load).
  return back({ pollinations_code: code, pollinations_state: state });
}

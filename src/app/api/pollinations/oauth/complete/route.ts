/**
 * POST /api/pollinations/oauth/complete — finish the Pollinations BYOP OAuth
 * flow: exchange the one-time authorization code for the user's scoped key,
 * SERVER-SIDE, using the PKCE verifier from the HttpOnly cookie.
 *
 * Official token endpoint (form-urlencoded, RFC 6749 + PKCE):
 *   POST https://enter.pollinations.ai/api/oauth/token
 *     grant_type=authorization_code
 *     code=...            client_id=pk_...   (when configured)
 *     redirect_uri=...    code_verifier=...
 *   → { "access_token": "sk_...", "token_type": "bearer", "expires_in": 604800, "scope": "..." }
 *
 * The returned key is the USER's own scoped credential (BYOP) — handed to the
 * SPA in the JSON body (never a URL) so it can store it vault-encrypted.
 */
import {
  AUTH_BASE_URL,
  GEN_BASE_URL,
  OAUTH_COOKIE,
  appClientId,
  jsonError,
  oauthRedirectUri,
  pfetch,
  readUpstreamError,
} from "@/lib/pollinations-server";

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

const CLEAR_COOKIE = `${OAUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

export async function POST(req: Request) {
  let body: { code?: unknown; state?: unknown };
  try {
    body = (await req.json()) as { code?: unknown; state?: unknown };
  } catch {
    return jsonError({ status: 400, code: "BAD_REQUEST", message: "Expected a JSON body {code, state}." });
  }
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const state = typeof body.state === "string" ? body.state.trim() : "";
  if (!code || !state || code.length > 2048 || state.length > 256) {
    return jsonError({ status: 400, code: "BAD_REQUEST", message: "Missing or malformed code/state." });
  }

  // 1. State must match the HttpOnly cookie from /oauth/start (CSRF).
  let verifier: string | null = null;
  let cookieState: string | null = null;
  try {
    const raw = readCookie(req, OAUTH_COOKIE);
    if (raw) {
      const parsed = JSON.parse(raw) as { state?: string; verifier?: string };
      cookieState = parsed.state ?? null;
      verifier = parsed.verifier ?? null;
    }
  } catch {
    /* fallthrough → mismatch */
  }
  if (!verifier || !cookieState || cookieState !== state) {
    return Response.json(
      {
        ok: false,
        error: {
          code: "state_mismatch",
          message: "The OAuth session could not be verified (state mismatch or expired). Restart the connection from Settings → Pollinations AI.",
          status: 400,
        },
      },
      { status: 400, headers: { "Set-Cookie": CLEAR_COOKIE } },
    );
  }

  // 2. Server-side token exchange (official endpoint, form-urlencoded).
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: oauthRedirectUri(req),
    code_verifier: verifier,
  });
  const clientId = appClientId();
  if (clientId) form.set("client_id", clientId);

  let res: Response;
  try {
    res = await pfetch(`${AUTH_BASE_URL}/api/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form.toString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonError(
      { status: 502, code: "PROVIDER_UNREACHABLE", message: `Token exchange failed: ${message}` },
      { headers: { "Set-Cookie": CLEAR_COOKIE } },
    );
  }

  if (!res.ok) {
    const err = await readUpstreamError(res);
    return jsonError(err, { headers: { "Set-Cookie": CLEAR_COOKIE } });
  }

  let tokenData: { access_token?: unknown; token_type?: unknown; expires_in?: unknown; scope?: unknown };
  try {
    tokenData = (await res.json()) as typeof tokenData;
  } catch {
    return jsonError(
      { status: 502, code: "BAD_UPSTREAM_BODY", message: "The token endpoint returned an unparseable body." },
      { headers: { "Set-Cookie": CLEAR_COOKIE } },
    );
  }
  const accessToken = typeof tokenData.access_token === "string" ? tokenData.access_token : "";
  if (!accessToken || !/^(sk|pk)_/.test(accessToken)) {
    return jsonError(
      { status: 502, code: "BAD_UPSTREAM_BODY", message: "The token endpoint did not return a usable API key." },
      { headers: { "Set-Cookie": CLEAR_COOKIE } },
    );
  }

  // 3. Best-effort profile fetch so the UI can greet the connected account
  //    (profile scope was requested; failures are non-fatal).
  let profile: { githubUsername?: string; name?: string; email?: string } | null = null;
  try {
    const profRes = await pfetch(`${GEN_BASE_URL}/account/profile`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      cache: "no-store",
    });
    if (profRes.ok) {
      const prof = (await profRes.json()) as Record<string, unknown>;
      profile = {
        githubUsername: typeof prof.githubUsername === "string" ? prof.githubUsername : undefined,
        name: typeof prof.name === "string" ? prof.name : undefined,
        email: typeof prof.email === "string" ? prof.email : undefined,
      };
    }
  } catch {
    /* non-fatal */
  }

  const expiresInS = typeof tokenData.expires_in === "number" ? tokenData.expires_in : 7 * 24 * 3600;
  return Response.json(
    {
      ok: true,
      access_token: accessToken,
      token_type: typeof tokenData.token_type === "string" ? tokenData.token_type : "bearer",
      expires_at: new Date(Date.now() + expiresInS * 1000).toISOString(),
      scope: typeof tokenData.scope === "string" ? tokenData.scope : "",
      profile,
    },
    { headers: { "Set-Cookie": CLEAR_COOKIE, "Cache-Control": "no-store" } },
  );
}

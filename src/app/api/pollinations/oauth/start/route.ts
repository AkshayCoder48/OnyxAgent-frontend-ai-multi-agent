/**
 * POST /api/pollinations/oauth/start — begin the official Pollinations
 * "Connect User Wallets" (BYOP) OAuth authorization-code flow with PKCE.
 *
 * Official contract (https://gen.pollinations.ai/docs — Connect User Wallets):
 *   authorize: GET https://enter.pollinations.ai/authorize
 *     ?response_type=code
 *     &client_id=pk_...          (App Key — server env POLLINATIONS_CLIENT_ID)
 *     &redirect_uri=<registered> (${NEXT_PUBLIC_APP_URL}/api/auth/pollinations/callback)
 *     &scope=profile%20usage
 *     &state=<csrf>
 *     &code_challenge=<S256(verifier)>
 *     &code_challenge_method=S256
 *
 * The PKCE verifier + state are generated HERE and stored in an HttpOnly
 * cookie (the browser never sees the verifier). The token exchange happens
 * server-side in /api/pollinations/oauth/complete.
 */
import { AUTH_BASE_URL, OAUTH_COOKIE, OAUTH_COOKIE_TTL_S, appClientId, oauthRedirectUri, pfetch, publicOrigin } from "@/lib/pollinations-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return new Uint8Array(digest);
}

export async function POST(req: Request) {
  // 1. Fresh PKCE verifier (43-128 chars) + CSRF state.
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(24)));
  const challenge = base64url(await sha256Hex(verifier));

  // 2. Canonical redirect URI (registered on the App Key).
  const redirectUri = oauthRedirectUri(req);
  const clientId = appClientId();

  // 3. Build the official authorize URL.
  const authorize = new URL(`${AUTH_BASE_URL}/authorize`);
  authorize.searchParams.set("response_type", "code");
  if (clientId) authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", "profile usage keys");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");

  // 4. Optionally verify the discovery document advertises the flow we call
  //    (best-effort — never blocks the handoff, but surfaces misconfig).
  let discoveryNote: string | null = null;
  try {
    const wellKnown = await pfetch(`${AUTH_BASE_URL}/.well-known/oauth-authorization-server`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (wellKnown.ok) {
      const doc = (await wellKnown.json()) as {
        authorization_endpoint?: string;
        token_endpoint?: string;
        code_challenge_methods_supported?: string[];
      };
      if (doc.authorization_endpoint && doc.authorization_endpoint !== `${AUTH_BASE_URL}/authorize`) {
        discoveryNote = `Discovery advertises a different authorization endpoint (${doc.authorization_endpoint}) — following the documented default.`;
      }
      if (Array.isArray(doc.code_challenge_methods_supported) && !doc.code_challenge_methods_supported.includes("S256")) {
        discoveryNote = "Discovery does not list S256 as a supported PKCE method.";
      }
    }
  } catch {
    // Discovery unreachable — proceed with the documented endpoints.
  }

  // 5. HttpOnly cookie carries the verifier + state (same-site top-level
  //    redirect back to our callback sends it — SameSite=Lax suffices).
  const cookie = [
    `${OAUTH_COOKIE}=${encodeURIComponent(JSON.stringify({ state, verifier }))}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${OAUTH_COOKIE_TTL_S}`,
  ].join("; ");

  return Response.json(
    {
      ok: true,
      authorizeUrl: authorize.toString(),
      redirectUri,
      clientIdConfigured: !!clientId,
      appOrigin: publicOrigin(req),
      ...(discoveryNote ? { discoveryNote } : {}),
    },
    { headers: { "Set-Cookie": cookie, "Cache-Control": "no-store" } },
  );
}

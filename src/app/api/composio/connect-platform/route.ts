// ============================================================================
// POST /api/composio/connect-platform — initiate the OAuth flow for a
// platform (toolkit) within the tool-router session.
//
//   Body: { toolkitSlug: string, callbackUrl?: string, alias?: string }
//   Headers: x-composio-key, x-composio-session?, x-composio-user
//
// Calls POST /api/v3/tool_router/session/{sid}/link and returns the REAL
// redirect_url the user must open to authorize. The session is auto-healed
// (created/re-created when missing) and the effective session id is echoed
// so the browser can persist it.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { authComposio, composioErrorResponse, readJsonBody, runWithSession } from "@/lib/composio/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const a = authComposio(req);
  if ("error" in a) return a.error;
  const { client, sessionId, composioUserId } = a;

  const body = await readJsonBody(req);
  const toolkitSlug = typeof body.toolkitSlug === "string" ? body.toolkitSlug.trim() : "";
  if (!toolkitSlug) {
    return NextResponse.json(
      { ok: false, error: "BAD_REQUEST", message: "toolkitSlug is required." },
      { status: 400 },
    );
  }
  const callbackUrl = typeof body.callbackUrl === "string" && body.callbackUrl ? body.callbackUrl : undefined;
  const alias = typeof body.alias === "string" && body.alias ? body.alias : undefined;

  try {
    const { result, sessionId: sid } = await runWithSession(client, sessionId, composioUserId, (s) =>
      client.initiateSessionLink(s, { toolkit: toolkitSlug, callbackUrl, alias }),
    );
    if (!result.redirect_url) {
      return NextResponse.json(
        {
          ok: false,
          error: "NO_REDIRECT_URL",
          message: "Composio did not return an authorization URL for this platform.",
        },
        { status: 502 },
      );
    }
    return NextResponse.json({
      ok: true,
      sessionId: sid,
      redirectUrl: result.redirect_url,
      connectedAccountId: result.connected_account_id ?? null,
      linkToken: result.link_token ?? null,
    });
  } catch (e) {
    return composioErrorResponse(e);
  }
}

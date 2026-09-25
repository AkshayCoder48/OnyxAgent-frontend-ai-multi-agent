// ============================================================================
// POST /api/composio/disconnect — clear the Composio connection.
//
// The routes are STATELESS (the key only ever lived in the browser vault +
// the per-request header), so there is nothing to clear server-side; this
// endpoint exists for API symmetry and replies ok. The browser deletes the
// vault key (settingsService.setComposioApiKey(null)) and the stored session
// id. Connected accounts on Composio are NOT deleted here — that's the
// explicit "Disconnect all" action in Settings → Integrations (session route,
// action "disconnect_all").
// ============================================================================

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  return NextResponse.json({
    ok: true,
    message:
      "Server holds no Composio state. The browser cleared the vault key + session id; use 'Disconnect all' to remove connected accounts on Composio.",
  });
}

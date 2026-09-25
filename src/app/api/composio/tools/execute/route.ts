// ============================================================================
// POST /api/composio/tools/execute — execute a discovered Composio tool
// within the tool-router session (server-side, session-scoped).
//
//   Body: { toolName: string, args?: object }
//   Headers: x-composio-key, x-composio-session?, x-composio-user
//
// Calls POST /api/v3/tool_router/session/{sid}/execute. When Composio
// rejects the call because the toolkit has no active connection, the route
// answers with error "CONNECTION_REQUIRED" (+ the toolkit when known) so
// the model surfaces a connect action instead of pretending success.
// Session auto-healed + echoed.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { authComposio, composioErrorResponse, readJsonBody, runWithSession } from "@/lib/composio/server";
import { ComposioError, type SessionExecuteResponse } from "@/lib/composio/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Error-message shapes Composio uses when a toolkit isn't connected. */
const CONNECTION_MISSING_RE =
  /connected\s*account|no\s+connection|not\s+connected|connection\s*(is\s*)?(required|missing)|authenticate|authorize/i;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const a = authComposio(req);
  if ("error" in a) return a.error;
  const { client, sessionId, composioUserId } = a;

  const body = await readJsonBody(req);
  const toolName = typeof body.toolName === "string" ? body.toolName.trim() : "";
  if (!toolName) {
    return NextResponse.json(
      { ok: false, error: "BAD_REQUEST", message: "toolName is required (a Composio tool slug)." },
      { status: 400 },
    );
  }
  const args =
    body.args && typeof body.args === "object" && !Array.isArray(body.args)
      ? (body.args as Record<string, unknown>)
      : {};

  try {
    const { result, sessionId: sid } = await runWithSession<SessionExecuteResponse>(
      client,
      sessionId,
      composioUserId,
      (s) => client.executeSessionTool(s, { toolSlug: toolName, arguments: args }),
    );

    // Composio answers 200 with {error} for some tool-level failures —
    // surface them honestly (never fake success, PRD §38).
    if (typeof result.error === "string" && result.error && result.data == null) {
      const connectionRequired = CONNECTION_MISSING_RE.test(result.error);
      return NextResponse.json(
        {
          ok: false,
          error: connectionRequired ? "CONNECTION_REQUIRED" : "TOOL_ERROR",
          message: result.error,
          ...(result.log_id ? { logId: result.log_id } : {}),
        },
        { status: connectionRequired ? 409 : 400 },
      );
    }

    return NextResponse.json({
      ok: true,
      sessionId: sid,
      data: result.data ?? null,
      ...(result.error ? { toolError: result.error } : {}),
      ...(result.log_id ? { logId: result.log_id } : {}),
    });
  } catch (e) {
    // Connection-missing rejections arrive as ComposioError (400/403).
    if (e instanceof ComposioError && CONNECTION_MISSING_RE.test(e.message)) {
      return NextResponse.json(
        {
          ok: false,
          error: "CONNECTION_REQUIRED",
          message:
            e.message ||
            "This platform is not connected yet. The user must authorize it first.",
        },
        { status: 409 },
      );
    }
    return composioErrorResponse(e);
  }
}

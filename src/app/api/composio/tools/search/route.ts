// ============================================================================
// POST /api/composio/tools/search — natural-language tool discovery scoped
// to the tool-router session (the agent-facing meta-tool path).
//
//   Body: { query: string }
//   Headers: x-composio-key, x-composio-session?, x-composio-user
//
// Calls POST /api/v3/tool_router/session/{sid}/search and compacts the
// response for the MODEL: matched tools (slug + description + input schema
// so composio_execute_tool can be called), per-toolkit connection status,
// and Composio's execution guidance. Session auto-healed + echoed.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { authComposio, composioErrorResponse, readJsonBody, runWithSession } from "@/lib/composio/server";
import type { SessionSearchResponse } from "@/lib/composio/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Cap the tools echoed back so one search can never blow the model context. */
const MAX_TOOLS = 15;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const a = authComposio(req);
  if ("error" in a) return a.error;
  const { client, sessionId, composioUserId } = a;

  const body = await readJsonBody(req);
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    return NextResponse.json(
      { ok: false, error: "BAD_REQUEST", message: "A natural-language query is required." },
      { status: 400 },
    );
  }

  try {
    const { result, sessionId: sid } = await runWithSession<SessionSearchResponse>(
      client,
      sessionId,
      composioUserId,
      (s) => client.searchSessionTools(s, query),
    );

    // Compact: primary tool slugs from each result, de-duplicated in order.
    const slugs: string[] = [];
    for (const r of result.results ?? []) {
      for (const s of r.primary_tool_slugs ?? []) {
        if (typeof s === "string" && !slugs.includes(s)) slugs.push(s);
      }
      for (const s of r.related_tool_slugs ?? []) {
        if (typeof s === "string" && !slugs.includes(s) && slugs.length < MAX_TOOLS) slugs.push(s);
      }
    }
    const capped = slugs.slice(0, MAX_TOOLS);

    const schemas = result.tool_schemas ?? {};
    const tools = capped.map((slug) => {
      const schema = schemas[slug];
      return {
        slug,
        toolkit: typeof schema?.toolkit === "string" ? schema.toolkit : null,
        description: typeof schema?.description === "string" ? schema.description : null,
        inputSchema: (schema?.input_schema as Record<string, unknown> | undefined) ?? null,
      };
    });

    const connections = (result.toolkit_connection_statuses ?? []).map((c) => ({
      toolkit: c.toolkit,
      connected: c.has_active_connection === true,
      statusMessage: typeof c.status_message === "string" ? c.status_message : null,
    }));

    const guidance = (result.results ?? [])
      .map((r) => (typeof r.execution_guidance === "string" ? r.execution_guidance : null))
      .filter((g): g is string => !!g)
      .slice(0, 3);

    return NextResponse.json({
      ok: true,
      sessionId: sid,
      query,
      tools,
      connections,
      ...(guidance.length ? { guidance } : {}),
    });
  } catch (e) {
    return composioErrorResponse(e);
  }
}

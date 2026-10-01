import { NextResponse, type NextRequest } from "next/server";
import {
  checkPreviewSession,
  ensurePreviewSession,
  listPreviewSessions,
  previewSessionIdFor,
  startPreviewSession,
  stopPreviewSession,
  stopWorkspacePreviews,
} from "@/lib/agent/code-tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Preview tab backing — ONE app project per Code chat.
 *
 * GET   ?workspace=W → the workspace's single preview session (plus the raw
 *                      list for backwards compatibility).
 * POST  { action: "ensure" }         → rehydrate: adopt running, else start
 *                                      from persisted files when a real page
 *                                      exists (silent when there is nothing
 *                                      previewable — no fake preview).
 * POST  { action: "start" }          → explicit Go live (refreshes the same
 *                                      deterministic session id).
 * POST  { action: "stop" }           → stop one session.
 * POST  { action: "stop_workspace" } → leaving the Code workspace: stop every
 *                                      running session (runtime destroyed,
 *                                      files preserved).
 */

function workspaceParam(request: NextRequest): string | null {
  const workspace = request.nextUrl.searchParams.get("workspace");
  return workspace && workspace.trim().length > 0 ? workspace.trim() : null;
}

export async function GET(request: NextRequest) {
  const workspaceId = workspaceParam(request);
  if (!workspaceId) {
    return NextResponse.json({ error: "A workspace id is required." }, { status: 400 });
  }
  try {
    const sessions = await listPreviewSessions(workspaceId);
    // The one logical project = the deterministic session id for this chat.
    const session =
      sessions.find((s) => s.sessionId === previewSessionIdFor(workspaceId)) ??
      sessions.find((s) => s.status === "running") ??
      null;
    return NextResponse.json({ session, sessions });
  } catch {
    return NextResponse.json({ error: "Preview sessions could not be listed." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
  const action = typeof body.action === "string" ? body.action : "";
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;
  if (!workspaceId) {
    return NextResponse.json({ error: "A workspace id is required." }, { status: 400 });
  }

  try {
    if (action === "ensure") {
      const outcome = await ensurePreviewSession(workspaceId);
      if (!outcome.ok) {
        // Silent outcome — nothing previewable yet. Not an error.
        return NextResponse.json({ ok: false, silent: true, reason: outcome.reason });
      }
      return NextResponse.json({
        ok: true,
        sessionId: outcome.sessionId,
        url: outcome.url,
        started: outcome.started,
      });
    }
    if (action === "start") {
      const outcome = await startPreviewSession(workspaceId, name);
      if (!outcome.ok) {
        return NextResponse.json({ error: outcome.error }, { status: 400 });
      }
      return NextResponse.json({ ok: true, sessionId: outcome.sessionId, url: outcome.url });
    }
    if (action === "stop") {
      if (!sessionId) {
        return NextResponse.json({ error: "A sessionId is required." }, { status: 400 });
      }
      const outcome = await stopPreviewSession(workspaceId, sessionId);
      if (!outcome.ok) {
        return NextResponse.json({ error: outcome.error ?? "Stop failed." }, { status: 400 });
      }
      return NextResponse.json({ ok: true });
    }
    if (action === "stop_workspace") {
      await stopWorkspacePreviews(workspaceId);
      return NextResponse.json({ ok: true });
    }
    if (action === "check") {
      if (!sessionId) {
        return NextResponse.json({ error: "A sessionId is required." }, { status: 400 });
      }
      const outcome = await checkPreviewSession(workspaceId, sessionId);
      return NextResponse.json({ ok: outcome.ok, status: outcome.status ?? null, title: outcome.title ?? "" });
    }
    return NextResponse.json({ error: "Unknown action. Use ensure | start | stop | stop_workspace | check." }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "The preview action could not be completed." }, { status: 500 });
  }
}

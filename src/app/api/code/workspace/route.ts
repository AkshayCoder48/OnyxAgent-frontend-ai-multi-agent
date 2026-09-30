import { NextResponse, type NextRequest } from "next/server";
import { getWorkspace } from "@/lib/agent/code-workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Workspace files listing for the Code Mode creation prompt (@file tagging)
 * and the header. Read-only — writes happen through the agent's tools.
 */
export async function GET(request: NextRequest) {
  const workspace = request.nextUrl.searchParams.get("workspace");
  const workspaceId = workspace && workspace.trim().length > 0 ? workspace.trim() : null;
  if (!workspaceId) {
    return NextResponse.json({ error: "A workspace id is required." }, { status: 400 });
  }
  const ws = await getWorkspace(workspaceId);
  const files = Object.keys(ws.files)
    .sort()
    .map((path) => ({ path, bytes: ws.files[path].length }));
  return NextResponse.json({
    files,
    fileCount: files.length,
    appMeta: ws.appMeta,
    updatedAt: ws.updatedAt,
  });
}

import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Database tab + manage_database tool backing — workspace-scoped JSON
 * documents (OnyxBase-style KV for this app's sandbox).
 */

interface RecordView {
  id: string;
  key: string;
  kind: string;
  data: string;
  createdAt: number;
  updatedAt: number;
}

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
    const rows = await db.codeRecord.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: "desc" },
    });
    const records: RecordView[] = rows.map((r) => ({
      id: r.id,
      key: r.key,
      kind: r.kind,
      data: r.data,
      createdAt: r.createdAt.getTime(),
      updatedAt: r.updatedAt.getTime(),
    }));
    return NextResponse.json({ records });
  } catch {
    return NextResponse.json({ error: "The database could not be reached." }, { status: 500 });
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
  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!workspaceId) {
    return NextResponse.json({ error: "A workspace id is required." }, { status: 400 });
  }
  if (!/^[a-zA-Z0-9_@.: -]{1,80}$/.test(key)) {
    return NextResponse.json({ error: "Keys must be 1-80 sane characters." }, { status: 400 });
  }

  try {
    if (action === "set") {
      const hasData = "data" in body;
      if (!hasData) {
        return NextResponse.json({ error: "A data value is required." }, { status: 400 });
      }
      const serialized = JSON.stringify(body.data ?? null);
      if (serialized.length > 60_000) {
        return NextResponse.json({ error: "Records are capped at 60KB." }, { status: 400 });
      }
      const row = await db.codeRecord.upsert({
        where: { workspaceId_key: { workspaceId, key } },
        create: { workspaceId, key, kind: "document", data: serialized },
        update: { data: serialized },
      });
      return NextResponse.json({
        ok: true,
        record: { id: row.id, key: row.key, kind: row.kind, data: row.data },
      });
    }
    if (action === "delete") {
      try {
        await db.codeRecord.delete({ where: { workspaceId_key: { workspaceId, key } } });
      } catch {
        // Already gone — deleting twice is fine.
      }
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Unknown action. Use set | delete." }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "The write could not be completed." }, { status: 500 });
  }
}

import { NextResponse, type NextRequest } from "next/server";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { getWorkspace } from "@/lib/agent/code-workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Binary assets for tool cards / previews:
 *  - ?id=<webSessionId>            → a captured web-session screenshot (PNG)
 *  - ?workspace=W&path=P           → a workspace image asset (base64 in the
 *                                    workspace store, decoded here). Strictly
 *                                    workspace-scoped — path traversal is
 *                                    rejected and only stored assets resolve.
 */
const SHOT_DIR = join(process.cwd(), "db", "web-sessions");

function pngResponse(filePath: string): NextResponse {
  const stat = statSync(filePath);
  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>;
  return new NextResponse(stream, {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(stat.size),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id") ?? "";
  const workspace = request.nextUrl.searchParams.get("workspace") ?? "";
  const path = request.nextUrl.searchParams.get("path") ?? "";

  /* Web-session screenshot by id. */
  if (id) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
      return NextResponse.json({ error: "Invalid asset id." }, { status: 400 });
    }
    const filePath = join(SHOT_DIR, `${id}.png`);
    if (!filePath.startsWith(SHOT_DIR) || !existsSync(filePath)) {
      return NextResponse.json({ error: "Asset not found." }, { status: 404 });
    }
    return pngResponse(filePath);
  }

  /* Workspace image asset. */
  if (workspace && path) {
    const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
    if (normalized.startsWith("..") || normalized.includes("/../")) {
      return NextResponse.json({ error: "Invalid asset path." }, { status: 400 });
    }
    const ws = await getWorkspace(workspace);
    const asset = ws.assets[normalized];
    if (!asset) {
      return NextResponse.json({ error: "Asset not found." }, { status: 404 });
    }
    const bytes = Buffer.from(asset.data, "base64");
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": asset.mime,
        "Content-Length": String(bytes.length),
        "Cache-Control": "no-store",
      },
    });
  }

  return NextResponse.json({ error: "An id or workspace+path is required." }, { status: 400 });
}

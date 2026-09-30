import { NextResponse, type NextRequest } from "next/server";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serves web-session screenshots captured by the start_web_session tool
 * (strict id validation — no path traversal).
 */
const SHOT_DIR = join(process.cwd(), "db", "web-sessions");

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id") ?? "";
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
    return NextResponse.json({ error: "Invalid asset id." }, { status: 400 });
  }
  const filePath = join(SHOT_DIR, `${id}.png`);
  if (!filePath.startsWith(SHOT_DIR) || !existsSync(filePath)) {
    return NextResponse.json({ error: "Asset not found." }, { status: 404 });
  }
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

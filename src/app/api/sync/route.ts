import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import type { CloudConversation } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cloud sync — versioned conversation snapshots with a hot in-memory cache.
 *
 * Design for "near-instant retrieve":
 *  - The client boots from its localStorage snapshot instantly, then asks the
 *    server "here are the versions I already have" — the server answers only
 *    with rows it has never seen before (usually zero bytes to transfer).
 *  - A module-level cache keeps every row hot after the first read, so a
 *    pull is a Map lookup, not a database query.
 */

interface CachedRow {
  id: string;
  title: string;
  group: string;
  separator: string;
  /** JSON-encoded message payload */
  messages: string;
  version: number;
  deletedAt: Date | null;
  updatedAt: Date;
}

const globalCache = globalThis as unknown as {
  terraSyncCache: Map<string, CachedRow> | undefined;
  terraSyncCacheLoadedAt: number | undefined;
};

const cache: Map<string, CachedRow> = (globalCache.terraSyncCache ??= new Map());

/** Hot-cache lifetime — bounds staleness if rows ever change outside the API. */
const CACHE_TTL_MS = 30_000;

async function ensureCacheLoaded(): Promise<void> {
  const loadedAt = globalCache.terraSyncCacheLoadedAt ?? 0;
  if (globalCache.terraSyncCacheLoadedAt && Date.now() - loadedAt < CACHE_TTL_MS) return;
  const rows = await db.cloudConversation.findMany();
  const fresh = new Map<string, CachedRow>();
  for (const row of rows) fresh.set(row.id, toCached(row));
  // Replace contents in place so live references keep working.
  cache.clear();
  for (const [id, row] of fresh) cache.set(id, row);
  globalCache.terraSyncCacheLoadedAt = Date.now();
}

function toCached(row: CloudConversation): CachedRow {
  return {
    id: row.id,
    title: row.title,
    group: row.group,
    separator: row.separator,
    messages: row.messages,
    version: row.version,
    deletedAt: row.deletedAt,
    updatedAt: row.updatedAt,
  };
}

interface SyncUpdate {
  id: string;
  title: string;
  group: string;
  separator: string;
  messages: string;
  version: number;
  deleted: boolean;
  updatedAt: string;
}

function toUpdate(row: CachedRow): SyncUpdate {
  return {
    id: row.id,
    title: row.title,
    group: row.group,
    separator: row.separator,
    messages: row.messages,
    version: row.version,
    deleted: row.deletedAt !== null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * GET /api/sync?versions={"conv-a":4,"conv-b":2}
 * Returns every conversation whose server version is newer than the client's.
 */
export async function GET(request: NextRequest) {
  try {
    await ensureCacheLoaded();
    const versionsParam = request.nextUrl.searchParams.get("versions") ?? "{}";
    let clientVersions: Record<string, number> = {};
    try {
      const parsed: unknown = JSON.parse(versionsParam);
      if (parsed && typeof parsed === "object") {
        clientVersions = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>)
            .filter(([, v]) => typeof v === "number")
            .map(([k, v]) => [k, v as number]),
        );
      }
    } catch {
      // Malformed handshake — treat as "client knows nothing".
      clientVersions = {};
    }

    const updates: SyncUpdate[] = [];
    for (const row of cache.values()) {
      if ((clientVersions[row.id] ?? -1) < row.version) {
        updates.push(toUpdate(row));
      }
    }

    return NextResponse.json(
      { serverTime: new Date().toISOString(), updates },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[/api/sync GET] failed:", error);
    return NextResponse.json({ error: "Cloud sync is unavailable right now." }, { status: 500 });
  }
}

interface PushConversation {
  id?: unknown;
  title?: unknown;
  group?: unknown;
  separator?: unknown;
  messages?: unknown;
  deleted?: unknown;
}

interface PushBody {
  conversations?: unknown;
}

/**
 * POST /api/sync — upsert a batch of conversation snapshots.
 * Responds with the authoritative version for each row so the client can
 * record what the cloud now holds.
 */
export async function POST(request: NextRequest) {
  let body: PushBody;
  try {
    body = (await request.json()) as PushBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!Array.isArray(body.conversations) || body.conversations.length === 0) {
    return NextResponse.json({ error: "A non-empty conversations array is required." }, { status: 400 });
  }
  if (body.conversations.length > 100) {
    return NextResponse.json({ error: "At most 100 conversations per push." }, { status: 400 });
  }

  try {
    await ensureCacheLoaded();
    const acks: { id: string; version: number; updatedAt: string }[] = [];

    for (const raw of body.conversations as PushConversation[]) {
      const id = typeof raw.id === "string" ? raw.id : null;
      if (!id || id.length > 80) continue;
      const title = typeof raw.title === "string" ? raw.title.slice(0, 200) : "Untitled";
      const group = typeof raw.group === "string" ? raw.group.slice(0, 20) : "today";
      const separator = typeof raw.separator === "string" ? raw.separator.slice(0, 120) : "";
      const deleted = raw.deleted === true;
      const messages = typeof raw.messages === "string" ? raw.messages : "[]";
      if (messages.length > 1_500_000) continue; // ~1.5 MB safety cap per row

      const existing = cache.get(id);
      const nextVersion = (existing?.version ?? 0) + 1;

      const row = await db.cloudConversation.upsert({
        where: { id },
        update: {
          title,
          group,
          separator,
          messages,
          deletedAt: deleted ? new Date() : null,
        },
        create: {
          id,
          title,
          group,
          separator,
          messages,
          version: nextVersion,
          deletedAt: deleted ? new Date() : null,
        },
      });
      // upsert does not bump version on update — set it explicitly.
      const saved =
        row.version === nextVersion
          ? row
          : await db.cloudConversation.update({
              where: { id },
              data: { version: nextVersion },
            });

      const cached = toCached(saved);
      cache.set(id, cached);
      acks.push({ id, version: cached.version, updatedAt: cached.updatedAt.toISOString() });
    }

    return NextResponse.json({ serverTime: new Date().toISOString(), acks });
  } catch (error) {
    console.error("[/api/sync POST] failed:", error);
    return NextResponse.json({ error: "Cloud sync is unavailable right now." }, { status: 500 });
  }
}

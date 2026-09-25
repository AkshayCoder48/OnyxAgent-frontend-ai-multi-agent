// ============================================================================
// GET /api/composio/toolkits — proxy the Composio platform catalog.
//
//   Query: ?cursor=&search=&category=&limit=100&withCategories=1
//   Headers: x-composio-key
//
// Server-side proxy of GET /api/v3/toolkits so the API key never reaches the
// browser bundle beyond the transient header. Search/category filtering and
// cursor pagination are performed BY COMPOSIO (server-side) — this route does
// NOT client-side-filter the first page. A short-TTL module cache (safe on
// serverless — it only speeds up repeat loads within one warm instance)
// keeps the catalog snappy.
//
// `withCategories=1` additionally returns Composio's real category list
// (GET /api/v3/toolkits/categories) for the filter chips — never hardcoded.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { authComposio, composioErrorResponse } from "@/lib/composio/server";
import type { ComposioCategory, ComposioToolkitPage } from "@/lib/composio/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── Module cache (per warm instance; key includes an api-key hash so
//    different users' catalogs can never cross) ────────────────────────────
const CACHE_TTL_MS = 5 * 60_000; // catalog metadata moves slowly
const CACHE_MAX_ENTRIES = 32;
const cache = new Map<string, { expires: number; page: ComposioToolkitPage; categories?: ComposioCategory[] }>();

async function cacheKey(rawKey: string, params: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawKey));
  const hex = Array.from(new Uint8Array(digest.slice(0, 8)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex}::${params}`;
}

function cacheGet(key: string) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    cache.delete(key);
    return null;
  }
  // LRU touch.
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cacheSet(key: string, entry: { expires: number; page: ComposioToolkitPage; categories?: ComposioCategory[] }) {
  cache.set(key, entry);
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const a = authComposio(req);
  if ("error" in a) return a.error;
  const { client } = a;

  const sp = req.nextUrl.searchParams;
  const search = (sp.get("search") ?? "").trim();
  const category = (sp.get("category") ?? "").trim();
  const cursor = (sp.get("cursor") ?? "").trim();
  const limit = Math.min(Math.max(Number(sp.get("limit") ?? 100) || 100, 1), 100);
  const withCategories = sp.get("withCategories") === "1";

  const params = `search=${encodeURIComponent(search)}&category=${encodeURIComponent(category)}&cursor=${encodeURIComponent(cursor)}&limit=${limit}&cats=${withCategories ? 1 : 0}`;
  const key = await cacheKey(req.headers.get("x-composio-key") ?? "", params);
  const cached = cacheGet(key);
  if (cached) {
    return NextResponse.json({
      ok: true,
      items: cached.page.items,
      nextCursor: cached.page.next_cursor ?? null,
      totalItems: cached.page.total_items ?? null,
      ...(cached.categories ? { categories: cached.categories } : {}),
      cached: true,
    });
  }

  try {
    const page = await client.listToolkits({ search, category, cursor: cursor || undefined, limit });
    let categories: ComposioCategory[] | undefined;
    if (withCategories) {
      try {
        categories = (await client.listToolkitCategories()).items ?? [];
      } catch {
        categories = undefined; // chips are optional — never fail the grid
      }
    }
    cacheSet(key, { expires: Date.now() + CACHE_TTL_MS, page, categories });
    return NextResponse.json({
      ok: true,
      items: page.items,
      nextCursor: page.next_cursor ?? null,
      totalItems: page.total_items ?? null,
      ...(categories ? { categories } : {}),
      cached: false,
    });
  } catch (e) {
    return composioErrorResponse(e);
  }
}

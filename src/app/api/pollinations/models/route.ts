/**
 * GET /api/pollinations/models — LIVE model catalogue passthrough.
 *
 * Official endpoint: https://gen.pollinations.ai/models (no auth required).
 * Fetched fresh on every call (`cache: "no-store"` both ways) — the client
 * must never depend on a hardcoded or stale model list (model IDs rotate).
 * Optional passthrough filters the official endpoint supports:
 *   ?source=official|community
 */
import { GEN_BASE_URL, pfetch, readUpstreamError, jsonError } from "@/lib/pollinations-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_SOURCES = new Set(["official", "community"]);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const source = url.searchParams.get("source");
  const upstream = new URL(`${GEN_BASE_URL}/models`);
  if (source && ALLOWED_SOURCES.has(source)) upstream.searchParams.set("source", source);

  let res: Response;
  try {
    res = await pfetch(upstream, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: req.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonError({
      status: 502,
      code: "PROVIDER_UNREACHABLE",
      message: `Could not reach the Pollinations model catalogue: ${message}`,
    });
  }

  if (!res.ok) {
    const upstreamErr = await readUpstreamError(res);
    return jsonError(upstreamErr);
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return jsonError({
      status: 502,
      code: "BAD_UPSTREAM_BODY",
      message: "The Pollinations model catalogue returned an unparseable body.",
    });
  }
  if (!Array.isArray(data)) {
    return jsonError({
      status: 502,
      code: "BAD_UPSTREAM_BODY",
      message: "The Pollinations model catalogue returned an unexpected shape (expected an array).",
    });
  }

  return Response.json(
    { ok: true, models: data, fetchedAt: new Date().toISOString(), count: data.length },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Fetch available models from an OpenAI-compatible AI provider.
 *
 * GET /api/fetch-models?baseUrl=...&apiKey=...
 *
 * Calls `GET {baseUrl}/models` (or `{baseUrl}/v1/models`) server-side to
 * avoid CORS issues, and returns a JSON array of model IDs.
 */
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

function buildModelsUrl(baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl);
  // If the base URL already ends with /v1, just append /models.
  // If it ends with /api/v1, same thing.
  // Otherwise, try /v1/models first, then /models.
  if (/\/v\d+$/.test(base)) {
    return `${base}/models`;
  }
  // Default: append /v1/models (standard OpenAI convention)
  return `${base}/v1/models`;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const baseUrl = searchParams.get("baseUrl");
  const apiKey = searchParams.get("apiKey");
  const noPrefix = searchParams.get("noPrefix") === "1";

  if (!baseUrl) {
    return NextResponse.json(
      { error: "Missing baseUrl query parameter" },
      { status: 400 },
    );
  }

  // Add User-Agent and Accept headers — some providers (OpenRouter, g4f)
  // return 403 for requests missing these.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": "OnyxAgent/1.0",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  // Build candidate URLs. If noPrefix is set, the base URL is the full
  // endpoint — try /models relative to it. Otherwise try standard patterns.
  const base = normalizeBaseUrl(baseUrl);
  const candidates: string[] = [];
  if (noPrefix) {
    // no_prefix provider — base URL is the full chat endpoint.
    // Try stripping /chat/completions and appending /models.
    const stripped = base.replace(/\/chat\/completions\/?$/, "");
    candidates.push(`${stripped}/models`);
    candidates.push(`${stripped}/v1/models`);
    candidates.push(`${base}/models`);
  } else {
    candidates.push(buildModelsUrl(baseUrl));
    candidates.push(`${base}/models`);
  }
  // Deduplicate
  const urls = [...new Set(candidates)];

  let lastError: string | null = null;

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        lastError = `${res.status} ${res.statusText}: ${await res.text().catch(() => "")}`;
        // Try next candidate
        continue;
      }

      const data: unknown = await res.json();

      // OpenAI-compatible response: { data: [{ id: "gpt-4o", ... }, ...] }
      // Some providers return: { models: [{ id: "..." }] } or just an array
      /** Extract a model id string from an unknown entry shape. */
      const modelIdOf = (m: unknown): unknown => {
        if (typeof m === "string") return m;
        if (m && typeof m === "object") {
          const rec = m as { id?: unknown; name?: unknown; model?: unknown };
          return rec.id ?? rec.name ?? rec.model;
        }
        return undefined;
      };
      const isNonEmptyString = (id: unknown): id is string =>
        typeof id === "string" && id.length > 0;

      let models: string[] = [];
      if (Array.isArray(data)) {
        models = data.map(modelIdOf).filter(isNonEmptyString);
      } else if (
        data &&
        typeof data === "object" &&
        Array.isArray((data as { data?: unknown }).data)
      ) {
        models = ((data as { data: unknown[] }).data)
          .map(modelIdOf)
          .filter(isNonEmptyString);
      } else if (
        data &&
        typeof data === "object" &&
        Array.isArray((data as { models?: unknown }).models)
      ) {
        models = ((data as { models: unknown[] }).models)
          .map(modelIdOf)
          .filter(isNonEmptyString);
      } else if (
        data &&
        typeof data === "object" &&
        typeof (data as { id?: unknown }).id === "string"
      ) {
        models = [(data as { id: string }).id];
      }

      if (models.length > 0) {
        return NextResponse.json({
          models: [...new Set(models)].sort(),
          source: url,
        });
      }

      lastError = "No models found in response";
    } catch (e) {
      lastError = e instanceof Error ? e.message : "Fetch failed";
      // Try next candidate
    }
  }

  return NextResponse.json(
    { error: lastError ?? "Failed to fetch models" },
    { status: 502 },
  );
}

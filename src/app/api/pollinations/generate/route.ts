/**
 * POST /api/pollinations/generate — the execution endpoint for OFFICIAL
 * Pollinations generation, called ONLY after the user's explicit two-step
 * confirmation (enforced client-side in the media_generation tool — this
 * route is the single server choke-point every chargeable call goes through).
 *
 * Official endpoints used (https://gen.pollinations.ai/docs):
 *   image      GET  /image/{prompt}   → JPEG/PNG/SVG binary (+ Link header)
 *   video      GET  /video/{prompt}   → MP4 binary              (+ Link header)
 *   audio      GET  /audio/{text}     → MPEG binary             (+ Link header)
 *   3d         GET  /3d/{prompt}      → GLB/PLY binary          (+ Link header)
 *   text       POST /v1/chat/completions → OpenAI-compatible JSON
 *   embeddings POST /v1/embeddings       → OpenAI-compatible JSON
 *
 * Binary results are resolved to a PUBLIC stored media URL (the provider's
 * `Link: <…>; rel="enclosure"` header — its own media.pollinations.ai
 * storage), with an authenticated upload fallback using the caller's key.
 * The chat renders that URL directly.
 *
 * Auth: the caller's own BYOP key (Authorization: Bearer sk_...). All params
 * are whitelisted + clamped per kind — this route never forwards arbitrary
 * upstream query/body fields.
 */
import {
  GEN_BASE_URL,
  clientIp,
  jsonError,
  mediaLinkFromHeaders,
  pfetch,
  rateLimit,
  readUpstreamError,
  safeSegment,
  uploadMedia,
  userBearerKey,
} from "@/lib/pollinations-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_PROMPT = 32_000; // official /v1/images/generations prompt cap
const B64_FALLBACK_LIMIT = 8 * 1024 * 1024; // only small images/audio inline
const RESOLUTIONS = new Set(["1k", "2k", "360p", "480p", "720p", "768p", "1080p", "4k"]);
const QUALITIES = new Set(["low", "medium", "high", "hd"]);
const AUDIO_FORMATS = new Set(["mp3", "opus", "aac", "flac", "wav", "pcm"]);
const SAFE_VALUES = /^(privacy|secrets|sexual|violence|shield|true|nsfw|false)(,(privacy|secrets|sexual|violence|shield|true|nsfw|false))*$/;

type Params = Record<string, unknown>;

const str = (p: Params, k: string, max = 4000): string | undefined => {
  const v = p[k];
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
};
const int = (p: Params, k: string, min: number, max: number): number | undefined => {
  const v = p[k];
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, Math.round(n)));
};
const bool = (p: Params, k: string): boolean | undefined => {
  const v = p[k];
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
};
const url = (p: Params, k: string): string | undefined => {
  const v = str(p, k, 8192);
  if (!v) return undefined;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
};
const enumOf = (p: Params, k: string, allowed: Set<string>): string | undefined => {
  const v = str(p, k, 20);
  return v && allowed.has(v.toLowerCase()) ? v.toLowerCase() : undefined;
};

/** Collect `x-usage-*` response headers the provider emits (honest actual
 *  cost reporting — passed through when present, absent otherwise). */
function usageHeaders(res: Response): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [k, v] of res.headers) {
    if (k.toLowerCase().startsWith("x-usage-") && typeof v === "string") out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------------------
// Param builders — one per binary media kind, strictly whitelisted.
// ---------------------------------------------------------------------------

function buildImageParams(p: Params): { prompt: string; search: URLSearchParams } | { error: string } {
  const prompt = str(p, "prompt", MAX_PROMPT);
  if (!prompt) return { error: "Missing required parameter: prompt" };
  const q = new URLSearchParams();
  const model = safeSegment(p.model, 160);
  if (model) q.set("model", model);
  const width = int(p, "width", 64, 4096);
  const height = int(p, "height", 64, 4096);
  if (width) q.set("width", String(width));
  if (height) q.set("height", String(height));
  const seed = int(p, "seed", -1, 2147483647);
  if (seed !== undefined) q.set("seed", String(seed));
  const quality = enumOf(p, "quality", QUALITIES);
  if (quality) q.set("quality", quality);
  const resolution = enumOf(p, "resolution", RESOLUTIONS);
  if (resolution) q.set("resolution", resolution);
  const aspect = str(p, "aspect_ratio", 12);
  if (aspect && /^\d+:\d+$/.test(aspect)) q.set("aspectRatio", aspect);
  const image = url(p, "image");
  if (image) q.set("image", image);
  const refs = p.reference_images;
  if (typeof refs === "string" && refs.trim()) {
    const list = refs.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 10);
    const okList = list.filter((u) => /^https?:\/\//i.test(u));
    if (okList.length) q.set("reference_images", okList.join(","));
  }
  const transparent = bool(p, "transparent");
  if (transparent !== undefined) q.set("transparent", String(transparent));
  const safe = str(p, "safe", 64);
  if (safe && SAFE_VALUES.test(safe)) q.set("safe", safe);
  return { prompt, search: q };
}

function buildVideoParams(p: Params): { prompt: string; search: URLSearchParams } | { error: string } {
  const built = buildImageParams(p); // shares the surface (prompt/model/seed/resolution/image/safe…)
  if ("error" in built) return built;
  const q = built.search;
  const duration = int(p, "duration", 1, 120);
  if (duration) q.set("duration", String(duration));
  const audio = bool(p, "audio");
  if (audio !== undefined) q.set("audio", String(audio));
  return { prompt: built.prompt, search: q };
}

function buildAudioParams(p: Params): { prompt: string; search: URLSearchParams } | { error: string } {
  const prompt = str(p, "prompt", MAX_PROMPT);
  if (!prompt) return { error: "Missing required parameter: prompt (the text to speak/sing)" };
  const q = new URLSearchParams();
  const model = safeSegment(p.model, 160);
  if (model) q.set("model", model);
  const voice = str(p, "voice", 40);
  if (voice && /^[a-z0-9][a-z0-9_.-]{0,39}$/i.test(voice)) q.set("voice", voice);
  const format = enumOf(p, "response_format", AUDIO_FORMATS);
  if (format) q.set("response_format", format);
  const instructions = str(p, "instructions", 2000);
  if (instructions) q.set("instructions", instructions);
  const seed = int(p, "seed", -1, 4294967295);
  if (seed !== undefined) q.set("seed", String(seed));
  const safe = str(p, "safe", 64);
  if (safe && SAFE_VALUES.test(safe)) q.set("safe", safe);
  return { prompt, search: q };
}

function build3dParams(p: Params): { prompt: string; search: URLSearchParams } | { error: string } {
  // Trellis & Asset Harvester ignore text prompts; the image is the input.
  const prompt = str(p, "prompt", 2000) || "3d";
  const q = new URLSearchParams();
  const model = safeSegment(p.model, 160);
  if (model) q.set("model", model);
  const image = url(p, "image");
  if (image) q.set("image", image);
  const resolution = enumOf(p, "resolution", new Set(["low", "medium", "high"]));
  if (resolution) q.set("resolution", resolution);
  return { prompt, search: q };
}

const MEDIA_BUILDERS: Record<string, (p: Params) => { prompt: string; search: URLSearchParams } | { error: string }> = {
  image: buildImageParams,
  video: buildVideoParams,
  audio: buildAudioParams,
  "3d": build3dParams,
};

const FILE_EXT: Record<string, string> = { image: "jpg", video: "mp4", audio: "mp3", "3d": "glb" };

// ---------------------------------------------------------------------------
// Route.
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  // Abuse guard: 40 generation calls / minute / IP. Chargeable safety comes
  // from the confirmation layer; this stops runaway loops only.
  if (!rateLimit(`pln-generate:${clientIp(req)}`, 40, 60_000)) {
    return jsonError({
      status: 429,
      code: "RATE_LIMITED",
      message: "Too many generation requests — wait a moment and try again.",
    });
  }

  const key = userBearerKey(req);
  if (!key) {
    return jsonError({
      status: 401,
      code: "UNAUTHORIZED",
      message: "Connect your Pollinations account first (Settings → Pollinations AI). Generation requires your own key.",
    });
  }

  let payload: { kind?: unknown; params?: unknown };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return jsonError({ status: 400, code: "BAD_REQUEST", message: "Expected a JSON body {kind, params}." });
  }
  const kind = typeof payload.kind === "string" ? payload.kind : "";
  const params: Params =
    payload.params && typeof payload.params === "object" && !Array.isArray(payload.params)
      ? (payload.params as Params)
      : {};

  // ── JSON kinds ──────────────────────────────────────────────────────────
  if (kind === "text") {
    return proxyJson(req, key, "/v1/chat/completions", buildTextBody(params));
  }
  if (kind === "embeddings") {
    return proxyJson(req, key, "/v1/embeddings", buildEmbeddingsBody(params));
  }

  // ── Binary media kinds ──────────────────────────────────────────────────
  const builder = MEDIA_BUILDERS[kind];
  if (!builder) {
    return jsonError({ status: 400, code: "BAD_REQUEST", message: `Unsupported generation kind: ${kind || "(none)"}` });
  }
  const built = builder(params);
  if ("error" in built) {
    return jsonError({ status: 400, code: "BAD_REQUEST", message: built.error });
  }

  const upstreamUrl = `${GEN_BASE_URL}/${kind === "3d" ? "3d" : kind}/${encodeURIComponent(built.prompt)}?${built.search.toString()}`;
  const startedAt = Date.now();
  let res: Response;
  try {
    res = await pfetch(upstreamUrl, {
      headers: { Authorization: `Bearer ${key}`, Accept: "*/*" },
      cache: "no-store",
      signal: req.signal,
    });
  } catch (err) {
    if (req.signal.aborted) {
      return jsonError({ status: 499, code: "CLIENT_CANCELLED", message: "The generation request was cancelled." });
    }
    const message = err instanceof Error ? err.message : String(err);
    return jsonError({ status: 502, code: "PROVIDER_UNREACHABLE", message: `Pollinations is unreachable: ${message}` });
  }

  if (!res.ok) {
    const err = await readUpstreamError(res);
    // Retry-After passthrough for rate limits.
    const retryAfter = res.headers.get("retry-after");
    return jsonError(err, retryAfter ? { headers: { "Retry-After": retryAfter } } : undefined);
  }

  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  const linkUrl = mediaLinkFromHeaders(res);
  const usage = usageHeaders(res);

  // Fast path: the provider already stored the file.
  if (linkUrl) {
    return Response.json({
      ok: true,
      url: linkUrl,
      mediaUrl: linkUrl,
      contentType,
      usage,
      timeMs: Date.now() - startedAt,
      stored: "provider",
    });
  }

  // Slow path: buffer the binary and upload it to the caller's media storage.
  let bytes: ArrayBuffer;
  try {
    bytes = await res.arrayBuffer();
  } catch (err) {
    if (req.signal.aborted) {
      return jsonError({ status: 499, code: "CLIENT_CANCELLED", message: "The generation request was cancelled while downloading." });
    }
    const message = err instanceof Error ? err.message : String(err);
    return jsonError({ status: 502, code: "DOWNLOAD_FAILED", message: `Reading the generated ${kind} failed: ${message}` });
  }
  if (bytes.byteLength === 0) {
    return jsonError({ status: 502, code: "EMPTY_RESULT", message: "The provider returned an empty file." });
  }

  const uploaded = await uploadMedia(key, bytes, contentType, `onyxagent-${kind}-${Date.now()}.${FILE_EXT[kind]}`);
  if (uploaded) {
    return Response.json({
      ok: true,
      url: uploaded,
      mediaUrl: uploaded,
      contentType,
      sizeBytes: bytes.byteLength,
      usage,
      timeMs: Date.now() - startedAt,
      stored: "upload",
    });
  }

  // Last resort (small payloads only): inline base64. Video/3D files are too
  // large — fail honestly instead of ballooning the tool result.
  if (bytes.byteLength <= B64_FALLBACK_LIMIT) {
    return Response.json({
      ok: true,
      url: null,
      b64: `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`,
      contentType,
      sizeBytes: bytes.byteLength,
      usage,
      timeMs: Date.now() - startedAt,
      stored: "inline",
    });
  }
  return jsonError({
    status: 502,
    code: "NO_MEDIA_URL",
    message: `The generated ${kind} could not be stored (${(bytes.byteLength / 1048576).toFixed(1)} MiB, no media URL returned).`,
  });
}

// ---------------------------------------------------------------------------
// JSON body builders (text + embeddings).
// ---------------------------------------------------------------------------

function buildTextBody(p: Params): Record<string, unknown> | { error: string } {
  const model = safeSegment(p.model, 160);
  if (!model) return { error: "Missing required parameter: model" };
  const rawMessages = p.messages;
  let messages: unknown;
  if (Array.isArray(rawMessages)) {
    messages = rawMessages.slice(0, 200).map((m) => {
      if (m && typeof m === "object") {
        const r = m as Record<string, unknown>;
        return { role: r.role === "assistant" ? "assistant" : r.role === "system" ? "system" : "user", content: typeof r.content === "string" ? r.content.slice(0, MAX_PROMPT) : String(r.content ?? "").slice(0, MAX_PROMPT) };
      }
      return { role: "user", content: String(m ?? "").slice(0, MAX_PROMPT) };
    });
  } else {
    const prompt = str(p, "prompt", MAX_PROMPT);
    if (!prompt) return { error: "Missing required parameter: prompt (or messages)" };
    messages = [{ role: "user", content: prompt }];
  }
  const body: Record<string, unknown> = { model, messages };
  const system = str(p, "system", 8000);
  if (system) (messages as Array<Record<string, unknown>>).unshift({ role: "system", content: system });
  const temperature = p.temperature;
  if (typeof temperature === "number" && Number.isFinite(temperature)) body.temperature = Math.min(2, Math.max(0, temperature));
  const maxTokens = int(p, "max_tokens", 1, 1_000_000);
  if (maxTokens) body.max_tokens = maxTokens;
  if (p.stream === true) body.stream = true;
  return body;
}

function buildEmbeddingsBody(p: Params): Record<string, unknown> | { error: string } {
  const model = safeSegment(p.model, 160);
  if (!model) return { error: "Missing required parameter: model" };
  const input = p.input;
  let normalized: unknown = input;
  if (Array.isArray(input)) normalized = input.slice(0, 32).map((s) => String(s ?? "").slice(0, 60_000));
  else if (typeof input === "string") normalized = input.slice(0, 60_000);
  else return { error: "Missing required parameter: input" };
  const body: Record<string, unknown> = { model, input: normalized };
  const dims = int(p, "dimensions", 64, 4096);
  if (dims) body.dimensions = dims;
  return body;
}

/** Forward a whitelisted JSON body to an official POST endpoint and pass the
 *  JSON response through untouched. */
async function proxyJson(req: Request, key: string, path: string, body: Record<string, unknown> | { error: string }): Promise<Response> {
  if (!body || "error" in body || Array.isArray(body)) {
    return jsonError({
      status: 400,
      code: "BAD_REQUEST",
      message: (body && "error" in body && typeof body.error === "string" ? body.error : null) || "Invalid request body.",
    });
  }
  let res: Response;
  try {
    res = await pfetch(`${GEN_BASE_URL}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: req.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonError({ status: 502, code: "PROVIDER_UNREACHABLE", message: `Pollinations is unreachable: ${message}` });
  }
  if (!res.ok) {
    const err = await readUpstreamError(res);
    const retryAfter = res.headers.get("retry-after");
    return jsonError(err, retryAfter ? { headers: { "Retry-After": retryAfter } } : undefined);
  }
  try {
    const result = await res.json();
    return Response.json({ ok: true, result, usage: usageHeaders(res) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return jsonError({ status: 502, code: "BAD_UPSTREAM_BODY", message: "Pollinations returned an unparseable response." });
  }
}

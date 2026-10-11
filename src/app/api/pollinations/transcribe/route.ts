/**
 * POST /api/pollinations/transcribe — audio transcription proxy for the
 * official OpenAI-compatible endpoint:
 *   POST https://gen.pollinations.ai/v1/audio/transcriptions (multipart)
 *
 * The client either:
 *   - posts multipart/form-data itself (file field + options) — forwarded
 *     byte-for-byte, or
 *   - posts JSON { url, model?, language?, prompt?, response_format?, speakers_expected? }
 *     — the server downloads the public audio URL and re-uploads it to the
 *     provider as multipart.
 *
 * Supported audio formats (per docs): mp3, mp4, mpeg, mpga, m4a, wav, webm.
 */
import {
  GEN_BASE_URL,
  clientIp,
  formBody,
  jsonError,
  pfetch,
  rateLimit,
  readUpstreamError,
  safeSegment,
  userBearerKey,
} from "@/lib/pollinations-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // generous cap for audio payloads
const FORMATS = new Set(["json", "text", "srt", "verbose_json", "vtt", "diarized_json"]);

export async function POST(req: Request) {
  if (!rateLimit(`pln-transcribe:${clientIp(req)}`, 30, 60_000)) {
    return jsonError({ status: 429, code: "RATE_LIMITED", message: "Too many transcription requests — retry shortly." });
  }
  const key = userBearerKey(req);
  if (!key) {
    return jsonError({
      status: 401,
      code: "UNAUTHORIZED",
      message: "Connect your Pollinations account first (Settings → Pollinations AI).",
    });
  }

  const contentType = req.headers.get("content-type") ?? "";
  let form: FormData;

  if (contentType.includes("multipart/form-data")) {
    // Passthrough multipart (browser-built).
    form = await req.formData();
  } else {
    // JSON shape with a public audio URL.
    let payload: { url?: unknown; model?: unknown; language?: unknown; prompt?: unknown; response_format?: unknown; speakers_expected?: unknown };
    try {
      payload = (await req.json()) as typeof payload;
    } catch {
      return jsonError({ status: 400, code: "BAD_REQUEST", message: "Expected multipart/form-data or JSON {url, ...}." });
    }
    const audioUrl = typeof payload.url === "string" ? payload.url.trim() : "";
    if (!audioUrl || !/^https?:\/\//i.test(audioUrl) || audioUrl.length > 8192) {
      return jsonError({ status: 400, code: "BAD_REQUEST", message: "Provide a public `url` for the audio file." });
    }
    let audioRes: Response;
    try {
      audioRes = await pfetch(audioUrl, { cache: "no-store", signal: req.signal });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonError({ status: 400, code: "AUDIO_DOWNLOAD_FAILED", message: `Could not download the audio: ${message}` });
    }
    if (!audioRes.ok) {
      return jsonError({ status: 400, code: "AUDIO_DOWNLOAD_FAILED", message: `The audio URL returned HTTP ${audioRes.status}.` });
    }
    const bytes = await audioRes.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_AUDIO_BYTES) {
      return jsonError({ status: 400, code: "AUDIO_TOO_LARGE", message: "The audio file is empty or larger than 25 MiB." });
    }
    const mime = audioRes.headers.get("content-type")?.split(";")[0] || "audio/mpeg";
    const nameFromUrl = (audioUrl.split("?")[0] ?? audioUrl).split("/").pop() || "audio.mp3";
    form = new FormData();
    form.append("file", new Blob([bytes], { type: mime }), nameFromUrl.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120));
    const model = safeSegment(payload.model, 160);
    if (model) form.append("model", model);
    if (typeof payload.language === "string" && /^[a-z]{2}(-[A-Z]{2})?$/i.test(payload.language)) form.append("language", payload.language.slice(0, 8));
    if (typeof payload.prompt === "string" && payload.prompt.trim()) form.append("prompt", payload.prompt.slice(0, 2000));
    const fmt = typeof payload.response_format === "string" ? payload.response_format.toLowerCase() : "";
    if (fmt && FORMATS.has(fmt)) form.append("response_format", fmt);
    const speakers = Number(payload.speakers_expected);
    if (Number.isFinite(speakers) && speakers >= 1 && speakers <= 30) form.append("speakers_expected", String(Math.round(speakers)));
  }

  // Validate the multipart file field (max size).
  const file = form.get("file");
  if (!file || typeof file === "string") {
    return jsonError({ status: 400, code: "BAD_REQUEST", message: "Missing multipart `file` field." });
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return jsonError({ status: 400, code: "AUDIO_TOO_LARGE", message: "The audio file is larger than 25 MiB." });
  }
  if (!safeSegment(form.get("model") ?? "", 160)) {
    return jsonError({ status: 400, code: "BAD_REQUEST", message: "Missing transcription `model` (see /api/pollinations/models, category audio)." });
  }

  let res: Response;
  try {
    res = await pfetch(`${GEN_BASE_URL}/v1/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      body: formBody(form),
      signal: req.signal,
    });
  } catch (err) {
    if (req.signal.aborted) {
      return jsonError({ status: 499, code: "CLIENT_CANCELLED", message: "The transcription request was cancelled." });
    }
    const message = err instanceof Error ? err.message : String(err);
    return jsonError({ status: 502, code: "PROVIDER_UNREACHABLE", message: `Pollinations is unreachable: ${message}` });
  }
  if (!res.ok) {
    return jsonError(await readUpstreamError(res));
  }
  const outType = res.headers.get("content-type") ?? "";
  if (!outType.includes("json")) {
    const text = await res.text();
    return Response.json({ ok: true, transcript: text.slice(0, 200_000), format: "text" }, { headers: { "Cache-Control": "no-store" } });
  }
  try {
    const result = await res.json();
    return Response.json({ ok: true, result }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return jsonError({ status: 502, code: "BAD_UPSTREAM_BODY", message: "The transcription endpoint returned an unparseable body." });
  }
}

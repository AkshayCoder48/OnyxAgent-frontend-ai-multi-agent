"use client";

/**
 * Shared image-source resolver (Runtime PRD §49–§54, §57–§59, §114–§116) —
 * used by BOTH `inspect_image` (real vision analysis) and `preview_image`
 * (display-only). Everything here runs browser-side: this app is
 * backendless, the sandbox is reached through the /api/sandbox proxy via
 * the E2B client, uploads live in OPFS, and the host filesystem is never
 * touched (sandbox reads are inherently bounded to the sandbox FS, §115).
 *
 * Resolution precedence for a `source` string:
 *   1. `data:image/...;base64,...`      → used directly (mime verified by
 *                                         magic-byte sniff, §57)
 *   2. uploads registry (exact name)    → OPFS bytes (browser-side)
 *   3. E2B sandbox/workspace path       → read via the E2B client, base64
 *   4. `http(s)://` URL                 → fetched browser-side, sniffed
 *
 * Honesty rules (§114): every failure carries a REAL reason — which stages
 * were tried, what the sandbox/HTTP actually said, why the bytes were
 * rejected (not found / not an image / too large). No placeholders, no
 * silent substitutions.
 */

import { getE2BClient } from "@/lib/e2b/client";
import type { E2BClient } from "@/lib/e2b/client";
import { ensureFreshSandboxForCtx } from "@/lib/e2b/sandbox-rotation";
import { getUploadByName, readUploadBytes } from "@/lib/uploads/registry";
import type { UploadedFileRecord } from "@/lib/uploads/registry";
import type { ToolContext } from "./registry";

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

export type ImageOrigin = "data-url" | "upload" | "sandbox" | "http";

export interface ResolvedImage {
  /** Ready-to-render / ready-to-post data URL (`data:<mime>;base64,...`). */
  dataUrl: string;
  /** Magic-byte-verified MIME type (never just the extension, §57). */
  mime: string;
  /** Decoded byte length of the image payload. */
  byteLength: number;
  /** Which resolution stage produced the bytes. */
  origin: ImageOrigin;
  /** The normalized sandbox path when origin === "sandbox". */
  sandboxPath?: string;
}

export type ImageSourceResult =
  | { ok: true; image: ResolvedImage }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Size policy (§58).
// ---------------------------------------------------------------------------

/** Images larger than this (decoded bytes) are downscaled before the vision
 *  call: long edge ≤ 1568 px, JPEG quality 0.85 (§58). Display-only uses
 *  (preview_image) keep the original bytes. */
export const VISION_DOWNSCALE_THRESHOLD_BYTES = 4 * 1024 * 1024;
export const VISION_MAX_LONG_EDGE = 1568;
export const VISION_JPEG_QUALITY = 0.85;
/** Hard cap the resolver will hand back at all (~12 MB decoded) — beyond
 *  this the honest answer is "too large" rather than a frozen tab. */
export const MAX_RESOLVED_IMAGE_BYTES = 12 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Pure helpers — magic-byte sniff + path normalization (§57, §116).
// ---------------------------------------------------------------------------

/**
 * Sniff an image MIME type from magic bytes (§57). Extension alone is never
 * trusted. Recognized: PNG (\x89PNG), JPEG (\xFF\xD8\xFF), GIF (GIF8),
 * WebP (RIFF....WEBP), BMP (BM). Returns null when the bytes are not a
 * recognized image format.
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (!bytes || bytes.length < 4) return null;
  const eq = (magic: string, at: number): boolean => {
    if (at + magic.length > bytes.length) return false;
    for (let i = 0; i < magic.length; i++) {
      if (bytes[at + i] !== magic.charCodeAt(i)) return false;
    }
    return true;
  };
  if (bytes[0] === 0x89 && eq("PNG", 1)) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (eq("GIF8", 0)) return "image/gif";
  if (eq("RIFF", 0) && eq("WEBP", 8)) return "image/webp";
  if (eq("BM", 0)) return "image/bmp";
  return null;
}

/**
 * Normalize a sandbox/workspace path (§116): strip a leading `/`, `./` or
 * the `/home/user/` workspace prefix, drop empty and `.` segments, and
 * REFUSE `..` escapes (null). Returns the workspace-relative path or null
 * when the input is empty/unsafe. This follows the e2b_files `safePath`
 * precedent (but rejects `..` per-SEGMENT, so a legal name like
 * "a..b.png" still reads while "../x" never does) — reads stay bounded to
 * the sandbox FS (§115).
 */
export function normalizeSandboxPath(raw: string): string | null {
  let cleaned = raw.trim();
  if (!cleaned) return null;
  // Accept the absolute workspace-root prefix tools report (/home/user/…).
  cleaned = cleaned.replace(/^\/home\/user\/+/, "");
  const parts = cleaned.split("/").filter((s) => s !== "" && s !== ".");
  if (parts.length === 0) return null;
  if (parts.some((s) => s === "..")) return null; // reject traversal escapes
  return parts.join("/");
}

/** Accepted base64 data URL prefix (aligned with the /api/vision contract). */
export const IMAGE_DATA_URL_RE = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i;

/** Encode bytes → base64 without stack overflow on large payloads. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Decoded byte length of a base64 data URL (padding-aware: computed from
 *  the UNPADDED payload length — floor(L·3/4) — so padding is never
 *  subtracted twice). */
export function estimateDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return 0;
  let payload = dataUrl.slice(comma + 1).trim();
  while (payload.endsWith("=")) {
    payload = payload.slice(0, -1);
  }
  return Math.floor((payload.length * 3) / 4);
}

/** Split a data URL into { header, payload } — null when malformed. */
function splitDataUrl(
  dataUrl: string,
): { header: string; payload: string } | null {
  const m = IMAGE_DATA_URL_RE.exec(dataUrl);
  if (!m) return null;
  return { header: m[0], payload: dataUrl.slice(m[0].length) };
}

/** Decode just enough of a data URL's head to sniff magic bytes. */
function sniffDataUrl(dataUrl: string): string | null {
  const parts = splitDataUrl(dataUrl);
  if (!parts) return null;
  // Slice to a multiple of 4 chars so atob never sees a truncated group.
  const head = parts.payload.slice(0, 44);
  if (!head) return null;
  try {
    const binary = atob(head);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return sniffImageMime(bytes);
  } catch {
    return null;
  }
}

/** Build a success result from raw bytes (sniff-verified, size-capped). */
function fromBytes(
  bytes: Uint8Array,
  origin: ImageOrigin,
  extra?: { sandboxPath?: string },
): ImageSourceResult {
  if (bytes.length > MAX_RESOLVED_IMAGE_BYTES) {
    return {
      ok: false,
      reason: `the image is too large (${(bytes.length / (1024 * 1024)).toFixed(1)} MB decoded; the limit is ${
        MAX_RESOLVED_IMAGE_BYTES / (1024 * 1024)
      } MB)`,
    };
  }
  const mime = sniffImageMime(bytes);
  if (!mime) {
    return {
      ok: false,
      reason:
        "the file is not a recognized image (magic bytes are not PNG/JPEG/GIF/WebP/BMP)",
    };
  }
  return {
    ok: true,
    image: {
      dataUrl: `data:${mime};base64,${bytesToBase64(bytes)}`,
      mime,
      byteLength: bytes.length,
      origin,
      ...extra,
    },
  };
}

// ---------------------------------------------------------------------------
// Resolution stages.
// ---------------------------------------------------------------------------

/** Stage 1 — a base64 data URL (mime verified against the actual bytes). */
function resolveDataUrl(source: string): ImageSourceResult {
  const parts = splitDataUrl(source);
  if (!parts) {
    return {
      ok: false,
      reason: "the data URL is malformed (expected data:image/<type>;base64,...)",
    };
  }
  const sniffed = sniffDataUrl(source);
  if (!sniffed) {
    return {
      ok: false,
      reason:
        "the data URL payload is not a recognized image (magic bytes are not PNG/JPEG/GIF/WebP/BMP)",
    };
  }
  // §57 — trust the bytes over the declared label: rebuild with the sniffed
  // mime when they disagree.
  const headerMime = parts.header
    .slice("data:".length, parts.header.indexOf(";"))
    .toLowerCase();
  const mime = sniffed === "image/jpeg" && headerMime === "image/jpg" ? headerMime : sniffed;
  const byteLength = estimateDataUrlBytes(source);
  if (byteLength > MAX_RESOLVED_IMAGE_BYTES) {
    return {
      ok: false,
      reason: `the image is too large (${(byteLength / (1024 * 1024)).toFixed(1)} MB decoded; the limit is ${
        MAX_RESOLVED_IMAGE_BYTES / (1024 * 1024)
      } MB)`,
    };
  }
  return {
    ok: true,
    image: { dataUrl: source, mime, byteLength, origin: "data-url" },
  };
}

/** Stage 4 — an http(s) URL fetched browser-side. */
async function resolveHttpUrl(source: string): Promise<ImageSourceResult> {
  let res: Response;
  try {
    res = await fetch(source, { redirect: "follow" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `the URL could not be fetched (${msg}; the host may be unreachable or CORS-blocked)`,
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      reason: `the URL returned HTTP ${res.status}${res.statusText ? ` (${res.statusText})` : ""}`,
    };
  }
  const declaredLength = Number(res.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_RESOLVED_IMAGE_BYTES) {
    return {
      ok: false,
      reason: `the image is too large (${(declaredLength / (1024 * 1024)).toFixed(1)} MB; the limit is ${
        MAX_RESOLVED_IMAGE_BYTES / (1024 * 1024)
      } MB)`,
    };
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return fromBytes(bytes, "http");
}

/**
 * Stage 3 — the E2B sandbox / workspace. Reads are workspace-relative
 * (§116-normalized); the read itself is inherently bounded to the sandbox
 * FS (§115). A bare filename (no slashes) is ALSO tried under `uploads/`
 * in the same round-trip — that's where the uploads mirror lives.
 */
async function resolveSandboxPath(
  path: string,
  ctx: ToolContext,
): Promise<ImageSourceResult> {
  const norm = normalizeSandboxPath(path);
  if (norm === null) {
    return {
      ok: false,
      reason:
        "the path is empty or unsafe (paths must stay inside the workspace; '..' is not allowed)",
    };
  }

  let apiKey: string | null = null;
  try {
    apiKey = await ensureFreshSandboxForCtx(ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `the sandbox could not be reached (${msg})` };
  }
  if (!apiKey) {
    return {
      ok: false,
      reason:
        "no E2B Sandbox API key is configured, so sandbox files cannot be read " +
        "(add one in Settings → Config → E2B Sandbox)",
    };
  }

  // One round-trip: the path itself, plus the uploads mirror for bare names.
  const paths = norm.includes("/") ? [norm] : [norm, `uploads/${norm}`];
  let read: Awaited<ReturnType<E2BClient["readFilesBatch"]>>;
  try {
    const client = getE2BClient(apiKey, null, "shared");
    read = await client.readFilesBatch(paths);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `the sandbox read failed (${msg})` };
  }

  const hit = read.files.find((f) => f.path === paths[0]) ?? read.files[0];
  if (!hit) {
    const detail = read.errors
      .map((e) => `${e.path}: ${e.error}`)
      .join("; ")
      .slice(0, 300);
    return {
      ok: false,
      reason: `not found in the sandbox (tried ${paths.map((p) => `"${p}"`).join(" and ")}${detail ? ` — ${detail}` : ""})`,
    };
  }

  // readFilesBatch hands back base64 — decode to bytes so the magic-byte
  // sniff (not the extension) decides whether this is an image (§57).
  try {
    const binary = atob(hit.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return fromBytes(bytes, "sandbox", { sandboxPath: hit.path });
  } catch {
    return { ok: false, reason: "the sandbox file could not be decoded (invalid base64)" };
  }
}

/**
 * Stage 2 — the OPFS uploads registry (exact filename match, newest wins).
 *  Falls through (returns null) when there is no match or the bytes are
 *  unreadable — the sandbox mirror may still have it.
 */
async function tryResolveUpload(
  name: string,
  ctx: ToolContext,
): Promise<ImageSourceResult | null> {
  let record: UploadedFileRecord | null = null;
  try {
    record = await getUploadByName(name, ctx.userId);
  } catch {
    return null; // registry unavailable — fall through to the sandbox
  }
  if (!record) return null;

  let blob: Blob | null = null;
  try {
    blob = await readUploadBytes(record);
  } catch {
    blob = null;
  }
  if (!blob) {
    // Canonical bytes unreadable — the sandbox mirror is the remaining hope.
    return null;
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const result = fromBytes(bytes, "upload");
  if (result.ok) return result;
  // A sniff failure on the CANONICAL upload is a real answer, not a miss.
  return {
    ok: false,
    reason: `the uploaded file "${record.filename}" (${record.mimeType}) — ${result.reason}`,
  };
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

/**
 * Resolve an image `source` to ready-to-use bytes (Runtime PRD §49–§54).
 * Precedence: data URL → uploads registry (exact name) → E2B sandbox path →
 * http(s) URL. Every failure carries an honest, specific reason (§114).
 */
export async function resolveImageSource(
  source: string,
  ctx: ToolContext,
): Promise<ImageSourceResult> {
  const src = source.trim();
  if (!src) return { ok: false, reason: "the source is empty" };

  // 1. Data URL — use directly (after magic-byte verification).
  if (src.toLowerCase().startsWith("data:image/")) {
    return resolveDataUrl(src);
  }

  // 4. http(s) URL — fetched browser-side, sniffed, converted to a data URL.
  if (/^https?:\/\//i.test(src)) {
    return resolveHttpUrl(src);
  }

  // 2. Uploads registry (exact name), then 3. E2B sandbox/workspace path.
  const upload = await tryResolveUpload(src, ctx);
  if (upload) return upload;

  const tried: string[] = [`uploads registry (no file named "${src}")`];
  const sandbox = await resolveSandboxPath(src, ctx);
  if (sandbox.ok) return sandbox;
  tried.push(sandbox.reason);

  return {
    ok: false,
    reason: tried.join("; "),
  };
}

// ---------------------------------------------------------------------------
// §58 size conditioning (vision calls only — display keeps originals).
// ---------------------------------------------------------------------------

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new Error("the browser could not decode the image (corrupt or unsupported)"));
    img.src = src;
  });
}

/** Downscale a data URL via canvas (long edge ≤ maxLongEdge, JPEG q). */
export async function downscaleDataUrl(
  dataUrl: string,
  maxLongEdge = VISION_MAX_LONG_EDGE,
  quality = VISION_JPEG_QUALITY,
): Promise<string> {
  if (typeof document === "undefined") {
    throw new Error("image downscaling requires a browser (canvas unavailable)");
  }
  const img = await loadImage(dataUrl);
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;
  const longEdge = Math.max(width, height);
  if (!longEdge) throw new Error("the image has no dimensions (corrupt?)");
  const scale = Math.min(1, maxLongEdge / longEdge);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx2d = canvas.getContext("2d");
  if (!ctx2d) throw new Error("a canvas 2D context is unavailable");
  ctx2d.drawImage(img, 0, 0, w, h);
  const out = canvas.toDataURL("image/jpeg", quality);
  if (!out.startsWith("data:image/")) throw new Error("canvas encoding failed");
  return out;
}

/** Hard cap from the /api/vision contract (~7 MB data URL). */
const MAX_VISION_DATA_URL_CHARS = 7 * 1024 * 1024;

/**
 * Size-condition an image for the vision call (§58): images over
 * VISION_DOWNSCALE_THRESHOLD_BYTES decoded bytes are downscaled via canvas
 * (long edge ≤ 1568 px, JPEG 0.85). NEVER substitutes a placeholder — a
 * processing failure throws with an honest message for the caller to
 * surface. Returns the (possibly downscaled) data URL.
 */
export async function ensureVisionSizedDataUrl(dataUrl: string): Promise<string> {
  if (dataUrl.length > MAX_VISION_DATA_URL_CHARS) {
    throw new Error(
      `the image is too large for the vision API (${(dataUrl.length / (1024 * 1024)).toFixed(
        1,
      )} MB base64; the limit is ~7 MB)`,
    );
  }
  const bytes = estimateDataUrlBytes(dataUrl);
  if (bytes <= VISION_DOWNSCALE_THRESHOLD_BYTES) return dataUrl;
  const out = await downscaleDataUrl(dataUrl);
  if (out.length > MAX_VISION_DATA_URL_CHARS) {
    throw new Error(
      `the downscaled image is still too large for the vision API (${(
        out.length /
        (1024 * 1024)
      ).toFixed(1)} MB base64; the limit is ~7 MB)`,
    );
  }
  return out;
}

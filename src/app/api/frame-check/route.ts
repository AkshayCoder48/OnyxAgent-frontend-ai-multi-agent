/**
 * Frame check — can this URL be embedded in an <iframe>, and if not, what
 * does its content look like?
 *
 * GET /api/frame-check?url=https://example.com
 *
 * The server fetches the URL (browser-ish UA, redirects followed) and
 * inspects the framing headers:
 *   - x-frame-options: DENY / SAMEORIGIN / ALLOW-FROM …  → not frameable
 *   - content-security-policy: frame-ancestors without `*` → not frameable
 *
 * Alongside the verdict it returns a READER SNAPSHOT (page title + the
 * readable text extracted server-side), so the LivePageFrame can fall back
 * to a readable snapshot when a site refuses embedding ("refused to
 * connect" / "content is blocked" browser error pages) or is unreachable.
 *
 * Always answers 200 + `{ ok, … }` so the client can branch on the payload
 * without mixing network errors of its own into the logic.
 */
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Desktop-Chrome-ish UA — many sites 403 the plain fetch UA on sight. */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Cap on the extracted reader text (the pane is scrollable). */
const TEXT_CAP = 32_000;
/** Cap on the raw HTML we buffer for extraction. */
const HTML_CAP = 2_000_000;

interface FrameCheckResponse {
  ok: boolean;
  /** False when the site sends framing-refusal headers. */
  frameable: boolean;
  /** Why it is not frameable ("x-frame-options" | "frame-ancestors"), when known. */
  reason?: string;
  /** HTTP status of the server's response, when it answered. */
  status?: number;
  /** Final URL after redirects, when the server answered. */
  url?: string;
  title?: string;
  /** Server-extracted readable text (the reader snapshot). */
  text?: string;
  error?: string;
}

/** Does an x-frame-options value forbid third-party framing? */
function xfoBlocks(value: string): boolean {
  const v = value.trim().toUpperCase();
  if (!v) return false;
  if (v === "DENY" || v === "SAMEORIGIN") return true;
  // ALLOW-FROM <uri> — deprecated; our origin is never the listed one.
  if (v.startsWith("ALLOW-FROM")) return true;
  return true; // unknown directives default to refusing
}

/** Does a Content-Security-Policy forbid third-party framing? */
function cspBlocks(policy: string): boolean {
  // Find the frame-ancestors directive (case-insensitive, ; separated).
  for (const directive of policy.split(";")) {
    const d = directive.trim();
    if (!/^frame-ancestors\s/i.test(d)) continue;
    const sources = d.replace(/^frame-ancestors\s/i, "").trim().split(/\s+/);
    // `*` (optionally with a scheme) is the only source that admits us —
    // our origin is never explicitly listed by a third-party site.
    return !sources.some((s) => s === "*" || s === "http:*" || s === "https:*");
  }
  return false;
}

/** Extract <title>. */
function titleOf(html: string): string {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return m?.[1]?.trim() ?? "";
}

/** Extract the readable text (strip scripts/styles/boilerplate tags + HTML). */
function textOf(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim()
    .slice(0, TEXT_CAP);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const raw = req.nextUrl.searchParams.get("url");
  if (!raw) {
    return NextResponse.json(
      { ok: false, frameable: false, error: "Missing url query parameter" } satisfies FrameCheckResponse,
      { status: 200 },
    );
  }
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return NextResponse.json(
      { ok: false, frameable: false, error: "Invalid URL" } satisfies FrameCheckResponse,
      { status: 200 },
    );
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return NextResponse.json(
      { ok: false, frameable: false, error: "Only http(s) URLs are supported" } satisfies FrameCheckResponse,
      { status: 200 },
    );
  }

  try {
    const res = await fetch(target.toString(), {
      redirect: "follow",
      signal: AbortSignal.timeout(12_000),
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
    });

    const contentType = res.headers.get("content-type") ?? "";
    const xfo = res.headers.get("x-frame-options");
    const csp = res.headers.get("content-security-policy") ?? res.headers.get("content-security-policy-report-only");

    let frameable = true;
    let reason: string | undefined;
    if (xfo && xfoBlocks(xfo)) {
      frameable = false;
      reason = "x-frame-options";
    } else if (csp && cspBlocks(csp)) {
      frameable = false;
      reason = "frame-ancestors";
    }

    // Snapshot only for textual content (HTML / plain text / JSON …).
    const isTextual = /^text\/|html|json|xml/i.test(contentType) || contentType === "";
    let title = "";
    let text = "";
    if (isTextual) {
      const body = (await res.text()).slice(0, HTML_CAP);
      title = titleOf(body);
      text = textOf(body);
    }

    const payload: FrameCheckResponse = {
      ok: true,
      frameable,
      reason,
      status: res.status,
      url: res.url || target.toString(),
      title: title || undefined,
      text: text || undefined,
    };
    return NextResponse.json(payload);
  } catch (err: unknown) {
    const message =
      err instanceof Error
        ? err.name === "TimeoutError"
          ? "The site took too long to respond (12s timeout)"
          : err.message
        : "Fetch failed";
    return NextResponse.json(
      { ok: false, frameable: false, error: message } satisfies FrameCheckResponse,
      { status: 200 },
    );
  }
}

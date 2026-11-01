/**
 * DUCKDUCKGO VIA THE E2B SANDBOX — the "call from the sandbox's IP" egress.
 *
 * USER DIRECTIVE (2026-11-01): "make ddg use current acquired e2b sandbox's
 * ip okay, if e2b not configured then miklium works". DuckDuckGo's WAF
 * blocks Vercel's ENTIRE egress range (live-verified 2026-11-01 across
 * iad1/sin1/hkg1/fra1 — the identical handshake, WAF anomaly page every
 * time), while a plain cloud-VM IP sails through with 90+ results. The E2B
 * sandbox the app already acquires for code execution IS such a machine:
 * running the DDG handshake INSIDE it puts every duckduckgo.com request on
 * the sandbox's own IP — a genuinely different egress, not a header trick.
 *
 * HOW (zero new infrastructure — reuses everything the app already runs):
 *   The handshake executes as a small stdlib-only Python script inside the
 *   CURRENT ACQUIRED shared sandbox via the existing /api/sandbox exec
 *   action (the same one the chat's code-execution tools use). That route
 *   owns the whole sandbox lifecycle — shared-instance cache (one sandbox
 *   per API key), dead-sandbox recovery, quota recovery, 20h rotation — so
 *   search rides on the very sandbox the user's session already holds,
 *   instead of provisioning a parallel one. A cold account (no sandbox yet)
 *   pays one sandbox boot; afterwards the shared sandbox serves both code
 *   execution and search.
 *
 *   Server-side, this module never imports the E2B SDK: it POSTs to
 *   /api/sandbox like the browser client does (the SDK cannot bundle into
 *   every route anyway — undici/Node built-ins).
 *
 * WIRE CONTRACT (mirrors the in-house direct clients exactly, so the
 * downstream normalizers are reused verbatim):
 *   1. GET https://duckduckgo.com/?q=…&iax=images&ia=images  (browser-grade
 *      headers) → regex out the `vqd` session token.
 *   2. GET https://duckduckgo.com/i.js|v.js?o=json&q=…&l=us-en&vqd=…&f=,,,,
 *      &p=-1 (safe-search OFF by default — the search tool's per-call
 *      `safeSearch` parameter overrides it, else the DDG_SAFE_SEARCH env;
 *      the same live-verified knob as the direct clients) → JSON rows; walk
 *      the `next` cursor up to 3 pages (bulk, like ddg-images.ts).
 *   3. stdout: {"results":[…]} — raw DDG rows — or {"error":"token"|
 *      "blocked"|"bad-json","status":…} when the handshake failed. The
 *      script NEVER exits non-zero for a DDG-level failure; non-zero means
 *      the script itself blew up (Python missing, OOM) and is treated as an
 *      engine failure so the route can rescue.
 *
 * SAFETY:
 *   - The query crosses the shell boundary BASE64-encoded (DDG_B64 env) —
 *     no quoting/injection surface; kind and limit are validated literals.
 *   - The heredoc delimiter is quoted ('DDGPY') so the shell never expands
 *     the script body.
 *   - The script is stdlib-only Python; the E2B code-interpreter template
 *     ships Python 3.
 *
 * When this leg fails (no key, sandbox down, DDG blocks the sandbox IP
 * too), the route's Miklium rescue keeps image/video search working and the
 * provider field honestly reports who answered.
 */

import { normalizeDDGImages, type DDGImage, type DDGImageResult } from "./ddg-images";
import { normalizeDDGVideos, type DDGVideo, type DDGVideoResult } from "./ddg-videos";
import { ddgSafeSearchParam } from "./ddg-egress";

// ---------------------------------------------------------------------------
// The in-sandbox script (stdlib Python only)
// ---------------------------------------------------------------------------

/**
 * The Python program executed inside the E2B sandbox. Reads the query from
 * the DDG_B64 env (base64 — shell-safe), performs the vqd → i.js/v.js
 * handshake with the same browser-grade headers the direct clients send,
 * and prints one JSON line for the server to parse. Every failure mode
 * prints {"error": …} and exits 0 — the exit code is reserved for "the
 * script itself could not run".
 */
const DDG_SANDBOX_SCRIPT = `import base64, gzip, json, os, re, sys, urllib.error, urllib.parse, urllib.request

Q = base64.b64decode(os.environ.get("DDG_B64", "")).decode("utf-8", "replace").strip()
KIND = os.environ.get("DDG_KIND", "image")
SAFE = "1" if os.environ.get("DDG_SAFE", "-1").strip() == "1" else "-1"
try:
    LIMIT = max(1, min(150, int(os.environ.get("DDG_LIMIT", "30"))))
except Exception:
    LIMIT = 30

def out(obj):
    print(json.dumps(obj))
    sys.exit(0)

if not Q:
    out({"error": "empty-query"})

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
HTML_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
}
XHR_HEADERS = {
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://duckduckgo.com/",
    "X-Requested-With": "XMLHttpRequest",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
}

def fetch(url, extra):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **extra})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            raw = r.read()
            if "gzip" in (r.headers.get("Content-Encoding") or "").lower():
                try:
                    raw = gzip.decompress(raw)
                except Exception:
                    pass
            return r.status, raw.decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        try:
            raw = e.read() or b""
            if "gzip" in (e.headers.get("Content-Encoding") or "").lower():
                try:
                    raw = gzip.decompress(raw)
                except Exception:
                    pass
            return e.code, raw.decode("utf-8", "replace")
        except Exception:
            return e.code, ""
    except Exception as e:
        return 0, "error: " + repr(e)

tab = "videos" if KIND == "video" else "images"
status, html = fetch(
    "https://duckduckgo.com/?q=" + urllib.parse.quote_plus(Q) + "&iax=" + tab + "&ia=" + tab,
    HTML_HEADERS,
)
m = re.search(r'vqd\\s*=\\s*["\\']?([0-9-]+)', html or "")
if not m:
    out({"error": "token", "status": status})
VQD = m.group(1)

endpoint = "v.js" if KIND == "video" else "i.js"
rows = []
start = 0
pages = 0
while pages < 3:
    qs = urllib.parse.urlencode(
        {"o": "json", "q": Q, "l": "us-en", "vqd": VQD, "f": ",,,,", "p": SAFE, "s": start}
    )
    status2, body = fetch("https://duckduckgo.com/" + endpoint + "?" + qs, XHR_HEADERS)
    if status2 != 200:
        out({"error": "blocked", "status": status2})
    low = (body or "")[:2000].lower()
    if "anomaly" in low or "ratelimit" in low or "rate limit" in low or "challenge" in low:
        out({"error": "blocked", "status": status2})
    try:
        data = json.loads(body)
    except Exception:
        out({"error": "bad-json", "status": status2})
    got = data.get("results") or []
    if isinstance(got, list):
        rows.extend(got)
    nxt = data.get("next") or ""
    if not nxt or len(rows) >= LIMIT:
        break
    mm = re.search(r"[?&]s=(\\d+)", nxt)
    start = int(mm.group(1)) if mm else start + 100
    pages += 1

out({"results": rows[: LIMIT * 3]})`;

// ---------------------------------------------------------------------------
// Sandbox exec plumbing
// ---------------------------------------------------------------------------

/** E2B command timeout (seconds) — the /api/sandbox exec action's ceiling.
 * Generous enough for a fresh sandbox boot + the 4-fetch handshake. */
const SANDBOX_COMMAND_TIMEOUT_S = 40;

/** Wall-clock ceiling on the internal /api/sandbox POST from this module. */
const SANDBOX_CALL_TIMEOUT_MS = 50_000;

/** Options for the sandbox-egress search. */
export interface DDGSandboxEgressOptions {
  /**
   * Absolute origin of THIS deployment (APP_URL or the request's origin) —
   * the internal POST to /api/sandbox is addressed from it.
   */
  origin: string;
  /** E2B API key: the caller's BYOK key or the server's E2B_API_KEY. */
  apiKey: string;
  /**
   * Per-call safe-search override from the search tool's `safeSearch`
   * parameter (true → DDG_SAFE=1 filtered, false → DDG_SAFE=-1 unfiltered);
   * omitted → the deployment's DDG_SAFE_SEARCH default. Threads into the
   * sandbox script's DDG_SAFE env as a validated literal.
   */
  safeSearch?: boolean;
}

/**
 * Build the shell command that runs the DDG handshake inside the sandbox.
 * Exported for tests — the command's injection-safety properties (query
 * only as base64, quoted heredoc, validated literals) are pinned there.
 *
 * The env assignments MUST stay on the python3 command line (prefix form):
 * as separate lines they would be shell-LOCAL variables that never reach
 * the child process's environment (verified live — python3 saw an empty
 * DDG_B64 until they were joined onto the command). DDG_SAFE is the
 * safe-search flag ("1"/"-1") — `safeSearch` is the search tool's per-call
 * override, resolved through ddgSafeSearchParam(); a validated literal
 * either way, so the command line stays injection-safe.
 */
export function buildDDGSandboxCommand(
  query: string,
  kind: "image" | "video",
  limit: number,
  safeSearch?: boolean,
): string {
  const b64 = Buffer.from(query, "utf8").toString("base64");
  // Over-fetch the raw pool (3× limit, floor 30, cap 150) — normalization
  // dedupes by image URL, and a starved pool shortchanges large limits
  // (the same lesson as the Miklium over-fetch fix).
  const fetchLimit = Math.min(Math.max(limit * 3, 30), 150);
  const safe = ddgSafeSearchParam(safeSearch);
  return [
    `DDG_B64='${b64}' DDG_KIND='${kind}' DDG_LIMIT='${fetchLimit}' DDG_SAFE='${safe}' python3 - <<'DDGPY'`,
    DDG_SANDBOX_SCRIPT,
    "DDGPY",
  ].join("\n");
}

/**
 * Run the DDG media handshake inside the acquired E2B sandbox and return
 * the RAW DDG rows (the wire shape ddg-images.ts / ddg-videos.ts emit).
 *
 * Throws on every failure shape (sandbox route error, non-zero exit,
 * script-level {"error":…}, invalid stdout) — the route's retry + Miklium
 * rescue handle those; a query that simply matches nothing resolves to [].
 */
async function runDDGMediaInSandbox(
  query: string,
  kind: "image" | "video",
  limit: number,
  opts: DDGSandboxEgressOptions,
): Promise<unknown[]> {
  const command = buildDDGSandboxCommand(query, kind, limit, opts.safeSearch);

  const url = new URL("/api/sandbox", opts.origin).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      apiKey: opts.apiKey,
      action: "exec",
      args: { command, timeout: SANDBOX_COMMAND_TIMEOUT_S },
      sandboxMode: "shared",
    }),
    signal: AbortSignal.timeout(SANDBOX_CALL_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`E2B sandbox call HTTP ${res.status}`);
  }
  const data = (await res.json().catch(() => null)) as
    | { stdout?: string; exit_code?: number; error?: string }
    | null;
  if (!data) {
    throw new Error("E2B sandbox call returned an unreadable body");
  }
  if (typeof data.error === "string" && data.error) {
    throw new Error(`E2B sandbox error: ${data.error.slice(0, 120)}`);
  }
  if (typeof data.exit_code === "number" && data.exit_code !== 0) {
    throw new Error(`E2B sandbox exec exited ${data.exit_code}`);
  }
  const stdout = (data.stdout ?? "").trim();
  if (!stdout) {
    throw new Error("E2B sandbox exec produced no output");
  }

  let parsed: { error?: unknown; results?: unknown };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    throw new Error("DDG-in-sandbox script returned invalid JSON");
  }
  if (typeof parsed.error === "string" && parsed.error) {
    throw new Error(`DDG-in-sandbox failed: ${parsed.error}`);
  }
  return Array.isArray(parsed.results) ? parsed.results : [];
}

/**
 * Image search with the handshake executed inside the acquired E2B
 * sandbox — every duckduckgo.com request leaves from the sandbox's IP.
 * Raw rows are normalized by the SAME pure normalizer the direct client
 * uses, so dedupe/shape/provider semantics are identical. `opts.safeSearch`
 * is the per-call override (true/false); omitted → env default.
 */
export async function searchDDGImagesViaSandbox(
  query: string,
  limit: number,
  opts: DDGSandboxEgressOptions,
): Promise<DDGImageResult[]> {
  const raw = await runDDGMediaInSandbox(query, "image", limit, opts);
  return normalizeDDGImages(raw as DDGImage[], limit);
}

/**
 * Video search with the handshake executed inside the acquired E2B
 * sandbox — same egress story as searchDDGImagesViaSandbox, same per-call
 * `safeSearch` override semantics.
 */
export async function searchDDGVideosViaSandbox(
  query: string,
  limit: number,
  opts: DDGSandboxEgressOptions,
): Promise<DDGVideoResult[]> {
  const raw = await runDDGMediaInSandbox(query, "video", limit, opts);
  return normalizeDDGVideos(raw as DDGVideo[], limit);
}

/**
 * DDG EGRESS CONTROL — the "no datacenter IP involved" support for
 * DuckDuckGo image/video search on cloud deployments (user directive
 * 2026-11-01: "add a thing that on any cloud deployment it would take user
 * IP and call from it so no data center ip should be involved into it").
 *
 * THE PHYSICS (why this module offers two mechanisms, not one):
 *   A server-side HTTP call can only leave from the server's own network
 *   interface — a Vercel function cannot "borrow" a website visitor's IP for
 *   the TCP connection. And the browser cannot fetch DDG's JSON on the
 *   user's behalf either: duckduckgo.com serves NO CORS headers (verified
 *   live 2026-11-01 — token page and i.js/v.js answer with only
 *   `server: nginx` / `vary: Accept-Encoding`, no Access-Control-Allow-
 *   Origin), so a cross-origin browser fetch can never READ the response.
 *
 * What CAN be done — both are implemented here:
 *
 *   1. FORWARD THE CALLER'S IP (automatic, default ON):
 *      The route extracts the end user's public IP from the request's
 *      proxy headers (x-vercel-forwarded-for / x-forwarded-for /
 *      x-real-ip) and the engines attach it to every DDG request as
 *      X-Forwarded-For / X-Real-IP / Forwarded — exactly what a transparent
 *      proxy does. Standard, correct HTTP semantics; honored by many
 *      providers. NOTE (honesty): DDG's own WAF IGNORES these headers today
 *      — verified live 2026-11-01, requests from an allowed IP carrying
 *      X-Forwarded-For values pointing at AWS/GCP/Azure ranges sailed
 *      through with full result sets, so header forwarding alone does NOT
 *      lift a datacenter-egress block. Kill-switch: DDG_FORWARD_CLIENT_IP
 *      = "false" stops forwarding (privacy-sensitive deployments).
 *
 *   2. ROUTE DDG THROUGH A NON-DATACENTER EXIT (the one that works):
 *      Set DDG_PROXY_BASE to a relay the deployer controls whose egress IP
 *      is NOT a datacenter IP — a box at home, a Tailscale exit node, or a
 *      residential-proxy service in URL-rewrite mode. Every DDG endpoint
 *      call (token page, i.js, v.js) is then rewritten to
 *      ${DDG_PROXY_BASE}${path} while keeping duckduckgo.com-grade headers,
 *      so DDG sees the RELAY's IP, results stay genuine DuckDuckGo rows,
 *      and the provider field keeps reporting "ddg". One-time nginx recipe:
 *
 *        location /ddg/ {
 *            proxy_pass https://duckduckgo.com/;
 *            proxy_set_header Host duckduckgo.com;
 *            proxy_ssl_server_name on;
 *        }
 *        # DDG_PROXY_BASE=https://home.example.com/ddg
 *
 *      Only SERVER→DDG endpoint calls are rewritten. Result thumbnails
 *      (external-content.duckduckgo.com) are loaded by the END USER'S
 *      browser and pass through untouched.
 *
 * When DDG is unreachable either way, the Miklium rescue
 * (miklium-media.ts) keeps image/video search working — provider honestly
 * reports "miklium" for those rows.
 */

// ---------------------------------------------------------------------------
// Options threading (route → engine → token client)
// ---------------------------------------------------------------------------

/** Egress options threaded from /api/ddg-search into the DDG engines. */
export interface DDGEgressOptions {
  /**
   * The end user's public IP to forward on DDG requests (standard proxy
   * headers). `undefined` = do not forward anything.
   */
  clientIp?: string;
}

// ---------------------------------------------------------------------------
// Relay URL building (DDG_PROXY_BASE)
// ---------------------------------------------------------------------------

/** Relay warn-once state — one log line per process, not per request. */
let relayWarnedOrLogged = false;

/**
 * Read and validate DDG_PROXY_BASE at CALL time (never at module load, so
 * tests can stub the env per-case). Returns "" when unset or malformed.
 */
function relayBase(): string {
  const raw = process.env.DDG_PROXY_BASE?.trim() ?? "";
  if (!raw) return "";
  const base = raw.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) {
    if (!relayWarnedOrLogged) {
      relayWarnedOrLogged = true;
      console.warn(
        `[ddg-egress] DDG_PROXY_BASE "${raw.slice(0, 60)}" is not an http(s) URL — ignoring it`,
      );
    }
    return "";
  }
  if (!relayWarnedOrLogged) {
    relayWarnedOrLogged = true;
    console.log(`[ddg-egress] DuckDuckGo traffic routed via relay ${base}`);
  }
  return base;
}

/**
 * Build the URL for a DDG endpoint call.
 *
 * @param path — always starts with "/" (e.g. "/i.js?o=json&q=…").
 * @returns the direct duckduckgo.com URL, or `${DDG_PROXY_BASE}${path}`
 *          when a relay is configured.
 */
export function ddgUrl(path: string): string {
  const base = relayBase();
  if (base) return `${base}${path}`;
  return `https://duckduckgo.com${path}`;
}

/**
 * True when DDG_PROXY_BASE is set to a valid http(s) URL (read at CALL
 * time, like every other relay decision). The /api/ddg-search route uses
 * this to decide whether the DIRECT DDG engines are a usable leg — with
 * the E2B sandbox as the primary DDG egress (user directive 2026-11-01:
 * "make ddg use current acquired e2b sandbox's ip; if e2b not configured
 * then miklium works"), the direct-from-server leg only runs when the
 * operator pinned it to a relay.
 */
export function isDDGRelayConfigured(): boolean {
  return relayBase() !== "";
}

// ---------------------------------------------------------------------------
// Client-IP forwarding (DDG_FORWARD_CLIENT_IP)
// ---------------------------------------------------------------------------

/** Falsey spellings accepted for the forwarding kill-switch. */
const FORWARDING_DISABLED = /^(false|0|no|off)$/i;

/**
 * Build the standard proxy-forwarding headers for a DDG request.
 * Returns {} when there is no client IP to forward (local dev, disabled,
 * or a private-IP caller whose IP must not leak upstream).
 */
export function buildForwardedHeaders(clientIp?: string): Record<string, string> {
  if (!clientIp) return {};
  // RFC 7239: IPv6 literals in `for=` are bracketed.
  const forToken = clientIp.includes(":") ? `[${clientIp}]` : clientIp;
  return {
    "X-Forwarded-For": clientIp,
    "X-Real-IP": clientIp,
    Forwarded: `for=${forToken}`,
  };
}

/**
 * Extract the caller's public IP from the incoming request's proxy headers.
 *
 * Vercel (and most CDNs/proxies) set `x-vercel-forwarded-for` /
 * `x-forwarded-for` to "clientIp, proxy1, proxy2…" — the FIRST entry is the
 * original client. Only PUBLIC IPs are returned: a private/loopback first
 * entry (local dev behind `next dev`, or an obfuscated token) is never
 * forwarded upstream. Returns null when nothing forwardable exists or when
 * DDG_FORWARD_CLIENT_IP disables the feature.
 */
export function extractClientIp(headers: Headers | undefined | null): string | null {
  if (FORWARDING_DISABLED.test(process.env.DDG_FORWARD_CLIENT_IP?.trim() ?? "")) {
    return null;
  }
  if (!headers || typeof headers.get !== "function") return null;
  const raw =
    headers.get("x-vercel-forwarded-for") ??
    headers.get("x-forwarded-for") ??
    headers.get("x-real-ip");
  if (!raw) return null;
  // Normalize bracketed IPv6 entries ("[2001:db8::7]") to the bare literal
  // so re-emitted X-Forwarded-For values carry a clean address.
  const first = (raw.split(",")[0]?.trim() ?? "").replace(/^\[/, "").replace(/\]$/, "");
  if (!first) return null;
  return isPublicIp(first) ? first : null;
}

// ---------------------------------------------------------------------------
// Public-IP validation (pure)
// ---------------------------------------------------------------------------

/**
 * True when `ip` is a PUBLIC routable IP (v4 or v6, optionally bracketed or
 * carrying a port). Private / loopback / link-local / CGNAT / ULA / multicast
 * addresses return false — they must never be forwarded upstream.
 */
export function isPublicIp(rawIp: string): boolean {
  const ip = rawIp.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!ip || ip.includes("]")) return false; // malformed bracketed form

  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — evaluate the embedded IPv4.
  const mapped = ip.toLowerCase().match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  const v4Candidate = mapped?.[1] ?? ip;

  // Bare IPv4, optionally with a :port (Forwarded `for=` forms).
  const v4 = v4Candidate.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::\d+)?$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    const c = Number(v4[3]);
    const d = Number(v4[4]);
    if (a > 255 || b > 255 || c > 255 || d > 255) return false;
    if (a === 0 || a === 10 || a === 127) return false; // this-net, private, loopback
    if (a === 169 && b === 254) return false; // link-local (cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return false; // private
    if (a === 192 && b === 168) return false; // private
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    if (a >= 224) return false; // multicast / reserved / broadcast
    return true;
  }

  // IPv6 literal: reject unspecified, loopback, link-local (fe80::/10),
  // and unique-local (fc00::/7) ranges.
  const v6 = ip.toLowerCase();
  if (!/^[0-9a-f:]+$/.test(v6)) return false;
  if (v6 === "::" || v6 === "::1") return false;
  if (/^fe[89ab]/.test(v6)) return false;
  if (/^f[cd]/.test(v6)) return false;
  return true;
}

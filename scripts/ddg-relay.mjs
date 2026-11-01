#!/usr/bin/env node
/**
 * DDG EGRESS RELAY — the turnkey "no datacenter IP involved" exit.
 *
 * WHY: DuckDuckGo's WAF hard-blocks the shared egress IPs of serverless
 * platforms (the 2026-11-01 image/video outage: Vercel's iad1 egress got
 * HTTP-403/anomaly pages while the IDENTICAL handshake from non-hammered
 * IPs returns full result sets). The app already supports routing every
 * DDG engine call (token page, i.js, v.js) through a relay via the
 * DDG_PROXY_BASE env var — see src/lib/search/ddg-egress.ts. This file is
 * that relay: run it ONCE on any always-on machine whose IP DDG serves
 * (your home box, a Tailscale exit node, or a cheap VPS — live-verified
 * 2026-11-01: a plain cloud-VM IP passes, the block targets hammered
 * serverless egress, not "all datacenters"), then set on Vercel:
 *
 *   DDG_PROXY_BASE=http(s)://<this-machine>[:PORT]
 *   # optional shared secret so only YOUR deployment can use the relay:
 *   DDG_RELAY_TOKEN=<random-string>   (same value on both sides)
 *
 * HOW (zero dependencies, Node 18+):
 *   PORT=8787 node scripts/ddg-relay.mjs
 *
 *   $ curl "http://localhost:8787/i.js?l=us-en&o=json&q=cat&vqd=…"
 *   → proxies https://duckduckgo.com/i.js?… with browser-grade headers.
 *
 * DESIGN NOTES
 *   - PATH ALLOWLIST ("/", "/i.js", "/v.js"): the relay can only ever
 *     reach DuckDuckGo endpoints the app actually calls — it is not an
 *     open proxy (SSRF guard).
 *   - Header fidelity: forwards exactly the browser-grade headers the
 *     in-house DDG clients send (User-Agent, Accept, sec-fetch-*, Referer,
 *     X-Requested-With) plus the visitor-IP transparency headers
 *     (X-Forwarded-For / X-Real-IP / Forwarded) when the app sends them.
 *   - Nothing is rewritten upstream; responses pass through with their
 *     real status (403/202 anomaly pages included — the app's
 *     isDDGBlocked() then retries/rescues as designed).
 *   - Lock it down further with the DDG_RELAY_TOKEN bearer check and/or a
 *     firewall allowlist for your Vercel deployment's egress range.
 *   - Only the ENGINE handshake is proxied. Result thumbnails
 *     (external-content.duckduckgo.com) are fetched by the END USER'S
 *     browser directly — never through this relay.
 */

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const DEFAULT_UPSTREAM = "https://duckduckgo.com";
const DEFAULT_PORT = 8787;

/** The only upstream paths the app's DDG clients ever request. */
const ALLOWED_PATHS = new Set(["/", "/i.js", "/v.js"]);

/** Request headers forwarded verbatim (engine fidelity + IP transparency). */
const FORWARDED_REQUEST_HEADERS = [
  "User-Agent",
  "Accept",
  "Accept-Language",
  "Referer",
  "X-Requested-With",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-fetch-user",
  "upgrade-insecure-requests",
  "X-Forwarded-For",
  "X-Real-IP",
  "Forwarded",
];

/** Response headers passed back to the caller (undici decompresses bodies,
 *  so content-encoding must NOT be forwarded; set-cookie never is). */
const PASSTHROUGH_RESPONSE_HEADERS = ["content-type", "cache-control"];

const UPSTREAM_TIMEOUT_MS = 20_000;

/**
 * Start the relay. Returns a Promise<Node http.Server> that resolves once
 * the listener is ready (port 0 = ephemeral, for tests).
 */
export function startRelayServer({
  port = DEFAULT_PORT,
  host = "0.0.0.0",
  upstream = DEFAULT_UPSTREAM,
  token = "",
} = {}) {
  const upstreamBase = upstream.replace(/\/+$/, "");

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      }
      res.end(`[ddg-relay] upstream unreachable: ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url ?? "/", "http://relay.invalid");

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      return res.end("[ddg-relay] method not allowed (GET only)");
    }
    // Protocol-relative ("//host/path") and absolute-form request targets
    // parse with a DIFFERENT host than our dummy base — reject them: only
    // origin-form paths ("/i.js?…") are ever proxied.
    if (url.host !== "relay.invalid") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return res.end("[ddg-relay] only origin-form paths are accepted");
    }
    if (!ALLOWED_PATHS.has(url.pathname)) {
      // Not an open proxy: only the DDG handshake endpoints exist here.
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return res.end("[ddg-relay] not a DuckDuckGo endpoint (path allowlist)");
    }
    if (token) {
      const auth = Array.isArray(req.headers.authorization)
        ? req.headers.authorization.join(", ")
        : (req.headers.authorization ?? "");
      if (auth !== `Bearer ${token}`) {
        res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
        return res.end("[ddg-relay] missing/invalid bearer token (DDG_RELAY_TOKEN)");
      }
    }

    const outHeaders = {};
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers[name.toLowerCase()];
      if (value !== undefined) {
        outHeaders[name] = Array.isArray(value) ? value.join(", ") : value;
      }
    }

    // Normalized origin-form target: pathname is allowlisted, so the
    // upstream can only ever be one of the three DDG endpoints.
    const upstreamRes = await fetch(`${upstreamBase}${url.pathname}${url.search}`, {
      method: "GET",
      headers: outHeaders,
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    const passthrough = {};
    for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
      const value = upstreamRes.headers.get(name);
      if (value !== null) passthrough[name] = value;
    }
    const body = Buffer.from(await upstreamRes.arrayBuffer());
    res.writeHead(upstreamRes.status, {
      ...passthrough,
      "content-length": String(body.length),
    });
    res.end(req.method === "HEAD" ? undefined : body);

    console.log(
      `[ddg-relay] ${req.socket.remoteAddress ?? "?"} ${url.pathname}${url.search} -> ${upstreamRes.status} (${body.length}B)`,
    );
  }

  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server));
  });
}

// CLI entry — `node scripts/ddg-relay.mjs`
const isMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const token = process.env.DDG_RELAY_TOKEN?.trim() ?? "";
  startRelayServer({ port, token }).then((server) => {
    const addr = server.address();
    const where = typeof addr === "object" && addr ? `${addr.address}:${addr.port}` : String(addr);
    console.log(`[ddg-relay] listening on ${where} -> ${DEFAULT_UPSTREAM}`);
    console.log(
      token
        ? "[ddg-relay] bearer-token auth ON — set the same DDG_RELAY_TOKEN on the app"
        : "[ddg-relay] auth OFF — protect with a firewall, or set DDG_RELAY_TOKEN",
    );
    console.log(
      `[ddg-relay] app side: DDG_PROXY_BASE=http://<this-machine>${port === 80 ? "" : `:${port}`}`,
    );
  });
}

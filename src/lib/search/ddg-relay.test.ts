/**
 * Unit tests for the DDG egress relay (scripts/ddg-relay.mjs) — the
 * turnkey DDG_PROXY_BASE target an operator runs on a non-datacenter box.
 *
 * The relay is exercised against a LOCAL stub upstream (node:http) so the
 * suite makes zero external network calls while asserting the wire
 * contract the app's DDG engines rely on:
 *   - engine headers ride through verbatim (browser-grade + visitor-IP
 *     transparency headers),
 *   - upstream status/body/content-type pass through untouched,
 *   - the path allowlist keeps the relay from ever being an open proxy,
 *   - the optional DDG_RELAY_TOKEN bearer check gates access.
 */
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { startRelayServer } from "../../../scripts/ddg-relay.mjs";

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

describe("ddg-relay (DDG_PROXY_BASE target)", () => {
  let stub: Server;
  let stubPort: number;
  let relay: Server;
  let relayPort: number;
  const seen: RecordedRequest[] = [];
  /** Sent by the app's engines on every DDG call (ddg-vqd.ts shapes). */
  const ENGINE_HEADERS = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    Accept: "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://duckduckgo.com/",
    "X-Requested-With": "XMLHttpRequest",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    // Visitor-IP transparency headers the route attaches (ddg-egress.ts).
    "X-Forwarded-For": "203.0.113.7",
    "X-Real-IP": "203.0.113.7",
    Forwarded: "for=203.0.113.7",
  };

  beforeAll(async () => {
    // Stub "duckduckgo": records what arrived, answers with a JSON body.
    stub = createServer((req, res) => {
      seen.push({ method: req.method ?? "", url: req.url ?? "/", headers: { ...req.headers } });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: [{ title: "stubbed" }] }));
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    stubPort = (stub.address() as { port: number }).port;

    relay = await startRelayServer({
      port: 0,
      host: "127.0.0.1",
      upstream: `http://127.0.0.1:${stubPort}`,
      token: "s3cret-token",
    });
    relayPort = (relay.address() as { port: number }).port;
  });

  afterAll(async () => {
    await Promise.all([
      new Promise<void>((resolve) => relay.close(() => resolve())),
      new Promise<void>((resolve) => stub.close(() => resolve())),
    ]);
  });

  afterEach(() => seen.length = 0);

  const relayUrl = (path: string) => `http://127.0.0.1:${relayPort}${path}`;

  it("proxies an allowlisted i.js call with engine + visitor-IP headers intact", async () => {
    const res = await fetch(
      relayUrl("/i.js?l=us-en&o=json&q=cat&vqd=4-123&f=,,,&p=1"),
      { headers: { ...ENGINE_HEADERS, Authorization: "Bearer s3cret-token" } },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = (await res.json()) as { results: unknown[] };
    expect(body.results).toHaveLength(1);

    expect(seen).toHaveLength(1);
    const hit = seen[0];
    expect(hit.method).toBe("GET");
    expect(hit.url).toBe("/i.js?l=us-en&o=json&q=cat&vqd=4-123&f=,,,&p=1");
    // Browser-grade fidelity headers survive the hop…
    expect(hit.headers["user-agent"]).toBe(ENGINE_HEADERS["User-Agent"]);
    expect(hit.headers["referer"]).toBe("https://duckduckgo.com/");
    expect(hit.headers["x-requested-with"]).toBe("XMLHttpRequest");
    expect(hit.headers["sec-fetch-site"]).toBe("same-origin");
    // …and so do the standard visitor-IP transparency headers.
    expect(hit.headers["x-forwarded-for"]).toBe("203.0.113.7");
    expect(hit.headers["x-real-ip"]).toBe("203.0.113.7");
    expect(hit.headers["forwarded"]).toBe("for=203.0.113.7");
  });

  it("proxies the token page (/) and the video endpoint (v.js) too", async () => {
    for (const path of ["/?q=cat", "/v.js?l=us-en&o=json&q=cat&vqd=4-123"]) {
      const res = await fetch(relayUrl(path), {
        headers: { ...ENGINE_HEADERS, Authorization: "Bearer s3cret-token" },
      });
      expect(res.status).toBe(200);
    }
    expect(seen.map((h) => new URL(h.url, "http://x").pathname)).toEqual(["/", "/v.js"]);
  });

  it("passes upstream failure statuses through untouched (DDG 403 anomaly)", async () => {
    // Swap in a 403-answering stub response for this one request.
    const blocker = createServer((_req, res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ anomaly: true }));
    });
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const blockerPort = (blocker.address() as { port: number }).port;
    const relay2 = await startRelayServer({
      port: 0,
      host: "127.0.0.1",
      upstream: `http://127.0.0.1:${blockerPort}`,
      token: "s3cret-token",
    });
    const relay2Port = (relay2.address() as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${relay2Port}/i.js?q=cat`, {
      headers: { Authorization: "Bearer s3cret-token" },
    });
    expect(res.status).toBe(403); // isDDGBlocked() sees the real status
    expect((await res.json()).anomaly).toBe(true);

    await Promise.all([
      new Promise<void>((resolve) => relay2.close(() => resolve())),
      new Promise<void>((resolve) => blocker.close(() => resolve())),
    ]);
  });

  it("rejects requests without the bearer token (DDG_RELAY_TOKEN)", async () => {
    const res = await fetch(relayUrl("/i.js?q=cat"), { headers: ENGINE_HEADERS });
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0); // never reached the upstream
  });

  it("rejects a wrong bearer token", async () => {
    const res = await fetch(relayUrl("/i.js?q=cat"), {
      headers: { ...ENGINE_HEADERS, Authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("is not an open proxy — non-DDG paths 404 and never reach the upstream", async () => {
    for (const path of [
      "/etc/passwd",
      "/admin",
      "//evil.example.com/i.js",
      "/i.js/../../secret",
    ]) {
      const res = await fetch(relayUrl(path), {
        headers: { ...ENGINE_HEADERS, Authorization: "Bearer s3cret-token" },
      });
      expect(res.status).toBe(404);
    }
    expect(seen).toHaveLength(0);
  });

  it("rejects non-GET methods", async () => {
    const res = await fetch(relayUrl("/i.js?q=cat"), {
      method: "POST",
      headers: { ...ENGINE_HEADERS, Authorization: "Bearer s3cret-token" },
    });
    expect(res.status).toBe(405);
    expect(seen).toHaveLength(0);
  });
});

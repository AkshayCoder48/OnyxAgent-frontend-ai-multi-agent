/**
 * DDG egress-control tests — the "no datacenter IP involved" mechanics.
 *
 * Pure logic only (no network): relay URL rewriting (DDG_PROXY_BASE),
 * client-IP extraction from proxy headers (DDG_FORWARD_CLIENT_IP), the
 * standard forwarding headers, and public-IP validation.
 *
 * The evidence documented in ddg-egress.ts (verified live 2026-11-01):
 *   - duckduckgo.com serves no CORS headers → the user's browser can never
 *     read DDG JSON cross-origin, so server-side calls are the only option;
 *   - DDG's WAF ignores X-Forwarded-For entirely (datacenter XFFs from an
 *     allowed IP sail through) → forwarding is standard-correct semantics,
 *     NOT a block-bypass; the relay (DDG_PROXY_BASE) is the real escape.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildForwardedHeaders,
  ddgSafeSearchParam,
  ddgUrl,
  extractClientIp,
  isPublicIp,
} from "./ddg-egress";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ddgSafeSearchParam (DDG_SAFE_SEARCH env)", () => {
  it("defaults to OFF — p=-1, the live-verified unfiltered value (operator directive 2026-11-01)", () => {
    expect(ddgSafeSearchParam()).toBe("-1");
  });

  it("accepts every truthy spelling as filter ON (p=1)", () => {
    for (const truthy of ["true", "TRUE", "1", "yes", "on"]) {
      vi.stubEnv("DDG_SAFE_SEARCH", truthy);
      expect(ddgSafeSearchParam()).toBe("1");
    }
  });

  it("treats explicit-off, garbage, and whitespace-only values as OFF", () => {
    for (const off of ["false", "0", "no", "off", "banana", "   "]) {
      vi.stubEnv("DDG_SAFE_SEARCH", off);
      expect(ddgSafeSearchParam()).toBe("-1");
    }
  });
});

describe("ddgSafeSearchParam — per-call safeSearch override (the search tools' parameter)", () => {
  it("safeSearch:true forces the filtered p=1 leg regardless of the env", () => {
    vi.stubEnv("DDG_SAFE_SEARCH", "false");
    expect(ddgSafeSearchParam(true)).toBe("1");
    vi.stubEnv("DDG_SAFE_SEARCH", "true");
    expect(ddgSafeSearchParam(true)).toBe("1");
  });

  it("safeSearch:false forces the unfiltered p=-1 leg even when the env says ON", () => {
    vi.stubEnv("DDG_SAFE_SEARCH", "true");
    expect(ddgSafeSearchParam(false)).toBe("-1");
  });

  it("undefined (param omitted) falls back to the deployment env", () => {
    vi.stubEnv("DDG_SAFE_SEARCH", "true");
    expect(ddgSafeSearchParam(undefined)).toBe("1");
    vi.stubEnv("DDG_SAFE_SEARCH", "off");
    expect(ddgSafeSearchParam(undefined)).toBe("-1");
    vi.unstubAllEnvs();
    expect(ddgSafeSearchParam(undefined)).toBe("-1"); // unset env → OFF
  });
});

describe("isPublicIp (pure)", () => {
  it("accepts public IPv4 and IPv6 addresses", () => {
    expect(isPublicIp("203.0.113.7")).toBe(true); // TEST-NET-3 (documentation)
    expect(isPublicIp("8.8.8.8")).toBe(true);
    expect(isPublicIp("2607:f8b0:4004:800::200e")).toBe(true);
    expect(isPublicIp("2001:db8:1234::1")).toBe(true);
  });

  it("tolerates brackets and ports", () => {
    expect(isPublicIp("[2001:db8::1]")).toBe(true);
    expect(isPublicIp("203.0.113.7:54321")).toBe(true);
  });

  it("rejects IPv4 private / loopback / link-local / CGNAT / reserved ranges", () => {
    expect(isPublicIp("10.0.0.5")).toBe(false);
    expect(isPublicIp("172.16.1.1")).toBe(false);
    expect(isPublicIp("172.31.255.255")).toBe(false);
    expect(isPublicIp("192.168.1.5")).toBe(false);
    expect(isPublicIp("127.0.0.1")).toBe(false);
    expect(isPublicIp("169.254.169.254")).toBe(false); // cloud metadata
    expect(isPublicIp("100.64.0.1")).toBe(false); // CGNAT
    expect(isPublicIp("0.0.0.0")).toBe(false);
    expect(isPublicIp("224.0.0.1")).toBe(false); // multicast
    expect(isPublicIp("198.18.0.1")).toBe(false); // benchmarking
  });

  it("rejects IPv6 loopback / link-local / unique-local, and mapped privates", () => {
    expect(isPublicIp("::1")).toBe(false);
    expect(isPublicIp("::")).toBe(false);
    expect(isPublicIp("fe80::1")).toBe(false);
    expect(isPublicIp("fc00::1")).toBe(false);
    expect(isPublicIp("fd12:3456::1")).toBe(false);
    expect(isPublicIp("::ffff:10.0.0.1")).toBe(false); // mapped private
    expect(isPublicIp("::ffff:192.168.0.1")).toBe(false);
    expect(isPublicIp("::ffff:8.8.8.8")).toBe(true); // mapped public passes
  });

  it("rejects garbage, empty, and malformed inputs", () => {
    expect(isPublicIp("")).toBe(false);
    expect(isPublicIp("not-an-ip")).toBe(false);
    expect(isPublicIp("999.1.1.1")).toBe(false);
    expect(isPublicIp("1.2.3")).toBe(false);
    expect(isPublicIp("[2001:db8::1]:443")).toBe(false); // bracket+port not split
    expect(isPublicIp("  ")).toBe(false);
  });
});

describe("ddgUrl — DDG_PROXY_BASE relay rewriting", () => {
  it("defaults to direct duckduckgo.com URLs", () => {
    expect(ddgUrl("/i.js?o=json&q=cats")).toBe(
      "https://duckduckgo.com/i.js?o=json&q=cats",
    );
    expect(ddgUrl("/?q=cats")).toBe("https://duckduckgo.com/?q=cats");
  });

  it("rewrites every endpoint through the relay when configured", () => {
    vi.stubEnv("DDG_PROXY_BASE", "https://home.example.com/ddg");
    expect(ddgUrl("/?q=cats")).toBe("https://home.example.com/ddg/?q=cats");
    expect(ddgUrl("/i.js?o=json")).toBe("https://home.example.com/ddg/i.js?o=json");
    expect(ddgUrl("/v.js?o=json")).toBe("https://home.example.com/ddg/v.js?o=json");
  });

  it("trims trailing slashes from the relay base", () => {
    vi.stubEnv("DDG_PROXY_BASE", "https://relay.example.com/");
    expect(ddgUrl("/i.js")).toBe("https://relay.example.com/i.js");
    vi.stubEnv("DDG_PROXY_BASE", "https://relay.example.com///");
    expect(ddgUrl("/i.js")).toBe("https://relay.example.com/i.js");
  });

  it("ignores non-http(s) garbage instead of building broken URLs", () => {
    vi.stubEnv("DDG_PROXY_BASE", "home.example.com/ddg");
    expect(ddgUrl("/i.js")).toBe("https://duckduckgo.com/i.js");
    vi.stubEnv("DDG_PROXY_BASE", "ftp://relay.example.com");
    expect(ddgUrl("/i.js")).toBe("https://duckduckgo.com/i.js");
  });
});

describe("buildForwardedHeaders (pure)", () => {
  it("returns no headers when there is no client IP to forward", () => {
    expect(buildForwardedHeaders(undefined)).toEqual({});
    expect(buildForwardedHeaders("")).toEqual({});
  });

  it("emits the three standard proxy-forwarding headers for an IPv4 client", () => {
    expect(buildForwardedHeaders("203.0.113.7")).toEqual({
      "X-Forwarded-For": "203.0.113.7",
      "X-Real-IP": "203.0.113.7",
      Forwarded: "for=203.0.113.7",
    });
  });

  it("brackets IPv6 literals in the RFC 7239 Forwarded header", () => {
    const h = buildForwardedHeaders("2001:db8::1");
    expect(h["X-Forwarded-For"]).toBe("2001:db8::1");
    expect(h.Forwarded).toBe("for=[2001:db8::1]");
  });
});

describe("extractClientIp — caller IP from proxy headers", () => {
  const mkHeaders = (entries: Record<string, string>) => new Headers(entries);

  it("takes the FIRST (original client) entry of the XFF chain", () => {
    expect(
      extractClientIp(mkHeaders({ "x-forwarded-for": "203.0.113.7, 10.0.0.1, 192.168.0.5" })),
    ).toBe("203.0.113.7");
  });

  it("prefers x-vercel-forwarded-for, then x-forwarded-for, then x-real-ip", () => {
    expect(extractClientIp(mkHeaders({ "x-vercel-forwarded-for": "203.0.113.9" }))).toBe(
      "203.0.113.9",
    );
    expect(
      extractClientIp(
        mkHeaders({ "x-vercel-forwarded-for": "198.51.100.3", "x-forwarded-for": "203.0.113.8" }),
      ),
    ).toBe("198.51.100.3");
    expect(extractClientIp(mkHeaders({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
  });

  it("never forwards a private/loopback first entry (local dev must stay silent)", () => {
    expect(extractClientIp(mkHeaders({ "x-forwarded-for": "192.168.1.5" }))).toBeNull();
    expect(extractClientIp(mkHeaders({ "x-forwarded-for": "127.0.0.1" }))).toBeNull();
    expect(extractClientIp(mkHeaders({ "x-forwarded-for": "10.0.0.1, 203.0.113.7" }))).toBeNull();
    expect(extractClientIp(mkHeaders({ "x-forwarded-for": "::1" }))).toBeNull();
  });

  it("returns null for missing headers, empty chains, and non-IP tokens", () => {
    expect(extractClientIp(mkHeaders({}))).toBeNull();
    expect(extractClientIp(undefined)).toBeNull();
    expect(extractClientIp(null)).toBeNull();
    expect(extractClientIp(mkHeaders({ "x-forwarded-for": "" }))).toBeNull();
    expect(
      extractClientIp(mkHeaders({ "x-forwarded-for": "obfuscated.token.http." })),
    ).toBeNull();
  });

  it("handles bracketed and bare IPv6 client entries", () => {
    expect(extractClientIp(mkHeaders({ "x-forwarded-for": "[2001:db8::7]" }))).toBe(
      "2001:db8::7",
    );
    expect(extractClientIp(mkHeaders({ "x-forwarded-for": "2607:f8b0::1, 10.0.0.9" }))).toBe(
      "2607:f8b0::1",
    );
  });

  it("DDG_FORWARD_CLIENT_IP=false (or 0/no/off) disables forwarding entirely", () => {
    for (const off of ["false", "0", "no", "off", "FALSE"]) {
      vi.stubEnv("DDG_FORWARD_CLIENT_IP", off);
      expect(extractClientIp(mkHeaders({ "x-forwarded-for": "203.0.113.7" }))).toBeNull();
      vi.unstubAllEnvs();
    }
    // Any other value (or unset) leaves forwarding on.
    vi.stubEnv("DDG_FORWARD_CLIENT_IP", "true");
    expect(extractClientIp(mkHeaders({ "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
  });
});

import withBundleAnalyzer from "@next/bundle-analyzer";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n.ts");

const withAnalyzer = withBundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

// In dev (live preview), allow embedding in the preview iframe; keep the
// strict frame lock for production builds.
const _isDev = process.env.NODE_ENV !== "production";
const _frameAncestors = _isDev
  ? "frame-ancestors 'self' https:;"
  : "frame-ancestors 'none';";
const ContentSecurityPolicy = `
  default-src 'self';
  script-src 'self' 'unsafe-eval' 'unsafe-inline';
  style-src 'self' 'unsafe-inline';
  img-src 'self' blob: data: https:;
  font-src 'self' data:;
  connect-src 'self' https: ws: wss:;
  ${_frameAncestors}
  base-uri 'self';
  form-action 'self';
`
  .replace(/\n/g, " ")
  .trim();

const securityHeaders = [
  { key: "Content-Security-Policy", value: ContentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // X-Frame-Options: DENY is production-only (dev preview needs iframes).
  ...(_isDev ? [] : [{ key: "X-Frame-Options", value: "DENY" }]),
  { key: "X-XSS-Protection", value: "1; mode=block" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  // For Capacitor APK builds, uncomment the following line:
  // output: "export",
  typescript: {
    ignoreBuildErrors: true,
  },
  // eslint config is no longer supported in next.config.ts (Next.js 16).
  // Use `next lint` or eslint CLI directly.
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve = config.resolve ?? {};
      // Stub Node built-in modules so @hopx-ai/sdk (loaded via dynamic import)
      // doesn't break the browser build. The SDK's browser-compatible HTTP
      // path still works via fetch/XHR.
      const nodeModules = [
        "assert", "buffer", "child_process", "cluster", "crypto", "dgram",
        "dns", "events", "fs", "fs/promises", "http", "http2", "https",
        "net", "os", "path", "punycode", "querystring", "readline", "repl",
        "stream", "string_decoder", "sys", "timers", "tls", "tty", "url",
        "util", "v8", "vm", "zlib", "ws", "tar", "glob", "form-data",
      ];
      config.resolve.fallback = {
        ...(config.resolve.fallback ?? {}),
        ...Object.fromEntries(nodeModules.map((m) => [m, false])),
        ...Object.fromEntries(nodeModules.map((m) => [`node:${m}`, false])),
      };
    }
    return config;
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default withAnalyzer(withNextIntl(nextConfig));

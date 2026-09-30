import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  async rewrites() {
    return [
      {
        // OnyxCode live previews are served by the preview mini-service on
        // :3212. Through the sandbox gateway the ?XTransformPort=3212 query
        // routes there directly; this rewrite is the same-origin fallback so
        // preview URLs also work when they land on the Next.js origin itself.
        source: "/preview/:path*",
        destination: "http://localhost:3212/preview/:path*",
      },
    ];
  },
};

export default nextConfig;

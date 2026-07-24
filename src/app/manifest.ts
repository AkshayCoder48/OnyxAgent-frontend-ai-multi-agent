import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "OnyxAgent",
    short_name: "OnyxAgent",
    description: "AI Agent Chat App with 51 tools, code execution, web search, file management, and more.",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: "#1ec677",
    categories: ["productivity", "business", "ai"],
    icons: [
      { src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}

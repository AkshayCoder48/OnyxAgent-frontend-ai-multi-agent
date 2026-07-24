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
      { src: "/icon.png", sizes: "1024x1024", type: "image/png", purpose: "any" },
      { src: "/apple-icon.png", sizes: "1024x1024", type: "image/png", purpose: "maskable" },
      { src: "/logo.png", sizes: "1024x1024", type: "image/png", purpose: "any" },
    ],
  };
}

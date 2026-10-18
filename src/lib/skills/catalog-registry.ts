"use client";

/**
 * MCP-Market catalog.
 *
 * A STATIC, always-available registry of the curated MCPMarket servers
 * with REAL connection configs bundled as local files under
 * `public/mcp-market/index.json` (extracted from each server's marketplace
 * page + GitHub README): remote HTTP endpoints are registered directly via
 * manage_mcp create; stdio/npx/uvx servers run inside the E2B sandbox via
 * an MCP client script.
 *
 * SKILLS no longer live here: the skill-repository system was replaced by
 * the MASTER SKILL LIBRARY (user request 2026-10-19) — every skill ships
 * inside one bundle that is attached to EVERY E2B sandbox at startup and
 * extracted to /home/user/skills/ (index: MASTER-INDEX.md; module:
 * src/lib/agent/master-skills.ts; builder: scripts/build_master_skill.py).
 */

// ---------------------------------------------------------------------------
// MCP Market catalog (offline fallback — the bundled
// public/mcp-market/index.json with REAL connection configs is the runtime
// source of truth; these static entries mirror it).
// ---------------------------------------------------------------------------

export interface McpMarketServer {
  /** Stable id. */
  id: string;
  name: string;
  /** Marketplace detail page. */
  url: string;
  description: string;
  /**
   * Connection hint — how the server is deployed. The bundled
   * public/mcp-market/index.json carries the exact commands/URLs.
   */
  hint?: string;
}

export const MCP_MARKET_SERVERS: readonly McpMarketServer[] = [
  {
    id: "chrome-devtools",
    name: "Chrome DevTools",
    url: "https://mcpmarket.com/server/chrome-devtools-1",
    description: "Drive Chrome via CDP: navigate, screenshot, read console + network, capture performance traces. 24 tools.",
    hint: "stdio npm — npx -y chrome-devtools-mcp (run inside the E2B sandbox as the MCP client).",
  },
  {
    id: "serena",
    name: "Serena",
    url: "https://mcpmarket.com/server/serena",
    description: "Semantic code intelligence: LSP-powered symbols, references, edits and refactors over codebases.",
    hint: "stdio Python — uv tool install -p 3.13 serena-agent, then serena start-mcp-server (inside the sandbox; upstream says NOT to use marketplace install commands).",
  },
  {
    id: "2ools",
    name: "2ools",
    url: "https://mcpmarket.com/server/2ools",
    description: "Build, version, review and export websites/web apps/games from chat. Free tool: create_public_preview. 43 tools.",
    hint: "REMOTE streamable-HTTP — https://2ools.app/mcp (register via manage_mcp create; OAuth sign-in once in the browser).",
  },
  {
    id: "superpowers",
    name: "Superpowers",
    url: "https://mcpmarket.com/server/superpowers",
    description: "Extended agent-capabilities toolkit (brainstorming, writing-plans, executing-plans, parallel agents, git worktrees).",
    hint: "NOT an MCP stdio server — a per-harness skills/hook plugin collection (npm package 'superpowers' exists; read its README in the sandbox).",
  },
  {
    id: "tubealfred-youtube",
    name: "TubeAlfred YouTube",
    url: "https://mcpmarket.com/server/tubealfred-youtube",
    description: "YouTube automation through TubeAlfred (search, playlists, channel actions).",
    hint: "stdio npm — npx -y @tubealfred/mcp (inside the sandbox).",
  },
  {
    id: "chatgpt-redis",
    name: "ChatGPT Redis",
    url: "https://mcpmarket.com/server/chatgpt-redis",
    description: "Redis-backed memory/context store for conversational agents (memory_query, memory_store, …).",
    hint: "REMOTE streamable-HTTP — https://freebase.cloud/api/mcp/<TOKEN> (free signup → token in the URL path; register via manage_mcp create).",
  },
  {
    id: "youtube-search-download",
    name: "YouTube Search & Download",
    url: "https://mcpmarket.com/server/youtube-search-download",
    description: "Search YouTube and download videos/audio programmatically.",
    hint: "stdio Python — uvx youtube-search-mcp (or pip install youtube-search-mcp) inside the sandbox.",
  },
  {
    id: "pdf-generator",
    name: "PDF Generator",
    url: "https://mcpmarket.com/server/pdf-generator-1",
    description: "Generate PDF documents from HTML, plain text, or any URL (3 tools; free tier 50 PDFs/month).",
    hint: "stdio Python — git clone rumblingb/pdf-generator-mcp, pip install -r requirements.txt, python3 server.py (inside the sandbox).",
  },
  {
    id: "free-proxy-list",
    name: "Free Proxy List",
    url: "https://mcpmarket.com/server/free-proxy-list",
    description: "Fetch rotating lists of free proxy servers.",
    hint: "REMOTE streamable-HTTP — https://mcp.hproxy.com/mcp, no auth (register via manage_mcp create).",
  },
  {
    id: "site-shot",
    name: "Site Shot",
    url: "https://mcpmarket.com/server/site-shot",
    description: "Capture website screenshots on demand.",
    hint: "stdio npm — SITESHOT_API_KEY=<key> npx -y site-shot-mcp@1.2.0 (API key REQUIRED — sign up at site-shot.com; run inside the sandbox).",
  },
];

// ---------------------------------------------------------------------------
// Lookup + summary helpers.
// ---------------------------------------------------------------------------

export function getMcpMarketServer(id: string): McpMarketServer | null {
  return MCP_MARKET_SERVERS.find((s) => s.id === id) ?? null;
}

/** MCP-Market summary for `analyze_workspace` (id + name + URL only). */
export function summarizeMcpMarket(): Array<Pick<McpMarketServer, "id" | "name" | "url">> {
  return MCP_MARKET_SERVERS.map((s) => ({ id: s.id, name: s.name, url: s.url }));
}

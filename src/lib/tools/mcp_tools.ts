"use client";

/**
 * MCP tools — ON-DEMAND meta-tools (no schema dumping).
 *
 * WHY: MCP servers can expose HUGE catalogs (a single Composio MCP endpoint
 * exposes 500+ tools; big public servers 900+). Registering every tool as an
 * individual LLM function definition bloats EVERY request with hundreds of
 * schemas — providers reject it (400/413), rate limits burn faster, and the
 * model gets distracted. That was the "MCP tool flood" bug.
 *
 * DESIGN (mirrors the proven Composio meta-tool approach): the prompt carries
 * exactly TWO generic tools no matter how many servers/tools are connected —
 *
 *   1. `mcp_search_tools` — discover what's available (natural-language
 *      query or per-server listing) → returns matching tool slugs with
 *      descriptions + input schemas.
 *   2. `mcp_call_tool`    — execute one discovered tool.
 *
 * The AI sees and uses MCP tools ONLY when it needs them. The app's own
 * built-in tools (~64) are always present as before; MCP adds just +2.
 *
 * Flow baked into the descriptions: search first → build args from the
 * schema → call. Discovery happens once per turn (`loadMCPTools`, called by
 * the runtime) and fills a session catalog the meta-tools read from.
 */

import { registerTool } from "./registry";
import { mcpService } from "@/lib/services";
import {
  MCPClient,
  callMCPTool,
  type MCPServerConfig,
  type MCPTool,
  type MCPDiscoveryResult,
  type MCPTransport,
} from "@/lib/mcp/client";
import type { ToolResult } from "@/types";

/** One MCP server's live catalog entry (filled at discovery time). */
interface MCPServerCatalogEntry {
  server: MCPServerConfig;
  tools: MCPTool[];
}

/**
 * The session catalog — server name → discovered tools. Rebuilt at every
 * `loadMCPTools()` call (turn start), read by the meta-tools.
 */
const catalog = new Map<string, MCPServerCatalogEntry>();

/** Whether the two meta-tools have been registered (idempotent guard). */
let metaToolsRegistered = false;

/** Build an MCPServerConfig from a stored row. */
function toConfig(row: {
  name: string;
  transport: string;
  url?: string | null;
  headers?: Record<string, string> | null;
}): MCPServerConfig | null {
  if (!row.url) return null;
  // Coerce legacy `stdio` rows to `streamable_http` so we at least try —
  // the connect will fail fast and we surface the error in discovery.
  const transport: MCPTransport =
    row.transport === "sse" ? "sse" : "streamable_http";
  return {
    id: row.name,
    name: row.name,
    transport,
    url: row.url,
    headers: row.headers ?? {},
  };
}

// ---------------------------------------------------------------------------
// Discovery — connect to every active server, fill the catalog, register the
// two meta-tools. Individual MCP tools are NEVER registered as LLM schemas.
// ---------------------------------------------------------------------------

export async function loadMCPTools(userId: string): Promise<MCPDiscoveryResult[]> {
  // Reset the catalog each turn — stale servers/tools disappear, newly added
  // ones appear (the meta-tools stay registered; they read the catalog live).
  catalog.clear();

  const rows = await mcpService.list(userId, true /* activeOnly */);
  const configs: MCPServerConfig[] = [];
  for (const row of rows) {
    const cfg = toConfig(row);
    if (cfg) configs.push(cfg);
  }

  if (configs.length === 0) {
    registerMetaTools();
    return [];
  }

  // Discovery — connect to each server in parallel, collect tools.
  const discovery: MCPDiscoveryResult[] = await Promise.all(
    configs.map(async (server) => {
      const client = new MCPClient({
        url: server.url,
        transport: server.transport,
        headers: server.headers,
      });
      try {
        const tools = await client.connect();
        client.disconnect();
        catalog.set(server.name, { server, tools });
        return { server, tools };
      } catch (err) {
        client.disconnect();
        return {
          server,
          tools: [] as MCPTool[],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  registerMetaTools();
  return discovery;
}

// ---------------------------------------------------------------------------
// Meta-tool 1 — mcp_search_tools
// ---------------------------------------------------------------------------

/** Score a tool against the query tokens (name/description/server matches). */
function scoreTool(tool: MCPTool, serverName: string, tokens: string[]): number {
  const name = (tool.name || "").toLowerCase();
  const desc = (tool.description || "").toLowerCase();
  const server = serverName.toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (!t) continue;
    if (name === t) score += 12;
    else if (name.includes(t)) score += 6;
    if (desc.includes(t)) score += 2;
    if (server.includes(t)) score += 3;
  }
  return score;
}

function registerMetaTools(): void {
  if (metaToolsRegistered) return;
  metaToolsRegistered = true;

  registerTool(
    "mcp_search_tools",
    "Discover tools exposed by the user's connected MCP servers (external integrations — a single server can host hundreds of tools, so they are NOT pre-loaded into your tool list). FIRST STEP whenever a task might need an MCP tool: search with a natural-language description of WHAT you want to do (e.g. 'scrape a webpage', 'query a database', 'post to social media') or a server name. Returns matching tools with their input schemas. Then build the arguments from the schema and call mcp_call_tool. If no servers are connected, the result says so — suggest Settings → MCPs.",
    {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural-language use case or keyword, e.g. 'scrape webpage' or 'slack'. Empty lists everything (first N per server).",
        },
        server: {
          type: "string",
          description: "Optional: restrict the search to one MCP server name.",
        },
        limit: {
          type: "number",
          description: "Max tools to return per server (default 10, max 25).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async (args): Promise<ToolResult> => {
      const input = args as { query?: unknown; server?: unknown; limit?: unknown };
      const query = String(input.query ?? "");
      const serverFilter =
        typeof input.server === "string" && input.server.trim()
          ? input.server.trim().toLowerCase()
          : null;
      const perServerLimit = Math.min(
        Math.max(Number(input.limit) || 10, 1),
        25,
      );

      if (catalog.size === 0) {
        return {
          success: true,
          output: {
            servers: [],
            tools: [],
            message:
              "No MCP servers are connected (or none exposed tools this turn). The user can add servers in Settings → MCPs.",
          },
        };
      }

      const tokens = query.toLowerCase().split(/[\s,.:/_-]+/).filter(Boolean);
      const serversSummary: Array<{ name: string; toolCount: number }> = [];
      const matched: Array<{
        server: string;
        tool: string;
        description: string;
        inputSchema: unknown;
      }> = [];

      for (const [name, entry] of catalog) {
        serversSummary.push({ name, toolCount: entry.tools.length });
        if (serverFilter && name.toLowerCase() !== serverFilter) continue;
        if (tokens.length === 0) {
          for (const t of entry.tools.slice(0, perServerLimit)) {
            matched.push({
              server: name,
              tool: t.name,
              description: (t.description || "").slice(0, 300),
              inputSchema: t.inputSchema ?? { type: "object", properties: {} },
            });
          }
          continue;
        }
        const ranked = entry.tools
          .map((t) => ({ t, s: scoreTool(t, name, tokens) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, perServerLimit);
        for (const { t } of ranked) {
          matched.push({
            server: name,
            tool: t.name,
            description: (t.description || "").slice(0, 300),
            inputSchema: t.inputSchema ?? { type: "object", properties: {} },
          });
        }
      }

      if (matched.length === 0) {
        return {
          success: true,
          output: {
            query,
            servers: serversSummary,
            tools: [],
            message:
              "No matching tools. Try different keywords, or list everything with an empty query. Available servers: " +
              serversSummary.map((s) => `${s.name} (${s.toolCount} tools)`).join(", "),
          },
        };
      }

      return {
        success: true,
        output: {
          query,
          servers: serversSummary,
          tools: matched,
          nextStep:
            "Pick the right tool, build its arguments from inputSchema, and call mcp_call_tool with the exact server and tool names.",
        },
      };
    },
    false,
    "mcp",
  );

  registerTool(
    "mcp_call_tool",
    "Execute a tool on one of the user's connected MCP servers — a tool that was found with mcp_search_tools. Pass the exact server name, tool name and an arguments object built from the tool's inputSchema. Results are returned verbatim; if a tool errors, report the error honestly (never fabricate a result).",
    {
      type: "object",
      properties: {
        server: {
          type: "string",
          description: "MCP server name (from mcp_search_tools results).",
        },
        tool: {
          type: "string",
          description: "Tool name on that server (from mcp_search_tools results).",
        },
        args: {
          type: "object",
          description: "Arguments matching the tool's inputSchema.",
        },
      },
      required: ["server", "tool", "args"],
      additionalProperties: false,
    },
    async (args): Promise<ToolResult> => {
      const input = args as { server?: unknown; tool?: unknown; args?: unknown };
      const serverName = String(input.server ?? "").trim();
      const toolName = String(input.tool ?? "").trim();
      const callArgs = input.args;

      if (!serverName || !toolName) {
        return {
          success: false,
          output: null,
          error: "Both 'server' and 'tool' are required (find them with mcp_search_tools).",
        };
      }
      if (!callArgs || typeof callArgs !== "object" || Array.isArray(callArgs)) {
        return {
          success: false,
          output: null,
          error: "'args' must be an object matching the tool's inputSchema.",
        };
      }

      const entry = catalog.get(serverName) ?? null;
      if (!entry) {
        const known = catalog.size
          ? [...catalog.keys()].join(", ")
          : "(none connected this turn)";
        return {
          success: false,
          output: null,
          error: `MCP server '${serverName}' is not connected. Known servers: ${known}.`,
        };
      }
      if (!entry.tools.some((t) => t.name === toolName)) {
        return {
          success: false,
          output: null,
          error: `Tool '${toolName}' was not found on server '${serverName}'. Search again (mcp_search_tools) to see what it exposes.`,
        };
      }

      try {
        const result = await callMCPTool(
          entry.server,
          toolName,
          callArgs as Record<string, unknown>,
        );
        return {
          success: true,
          output: {
            server: serverName,
            tool: toolName,
            result,
          },
        };
      } catch (err) {
        return {
          success: false,
          output: null,
          error: `MCP tool '${toolName}' on '${serverName}' failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    },
    false,
    "mcp",
  );
}

/** Number of MCP tools in the catalog (across all servers) this turn. */
export function mcpToolCount(): number {
  let n = 0;
  for (const entry of catalog.values()) n += entry.tools.length;
  return n;
}

/** List of MCP server names that exposed at least one tool this turn. */
export function activeMCPServers(): string[] {
  return [...catalog.values()]
    .filter((e) => e.tools.length > 0)
    .map((e) => e.server.name);
}

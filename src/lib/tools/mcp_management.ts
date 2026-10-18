// MCP server management — ONE multi-function tool.
//
// MERGE NOTE (tool-count cap): the four former MCP tools
// (list_mcps / create_mcp / edit_mcp / delete_mcp) were merged into this
// single `manage_mcp` tool with an `action` parameter. Each action preserves
// the EXACT result shape of the tool it replaced.
//
// MCP servers are stored in IndexedDB and connected at agent turn start.
import { registerTool } from "./registry";
import type { ToolResult } from "@/types";
import { mcpService } from "@/lib/services";
import { bumpWorkspaceVersion } from "./workspace-snapshot";
import { MCP_MARKET_SERVERS } from "@/lib/skills/catalog-registry";

// ---------------------------------------------------------------------------
// Bundled MCP-Market configs (public/mcp-market/index.json — extracted from
// each server's marketplace page + GitHub README, bundled AS FILES so the
// agent never has to web_fetch the marketplace to learn how to connect).
// ---------------------------------------------------------------------------

interface BundledMcpTool {
  name: string;
  description?: string;
}

interface BundledMcpServer {
  id: string;
  name: string;
  url: string;
  description: string;
  github?: string;
  npm?: string;
  transport: string;
  stdio?: { command: string; args?: string[] };
  remote?: { url: string; transport: string; auth?: string };
  env_required?: Record<string, string>;
  sandbox?: string;
  register_hint?: string;
  note?: string;
  tools?: BundledMcpTool[];
}

let bundledMcpCache: BundledMcpServer[] | null = null;

async function loadBundledMcpMarket(): Promise<BundledMcpServer[]> {
  if (bundledMcpCache) return bundledMcpCache;
  try {
    const res = await fetch("/mcp-market/index.json", { headers: { Accept: "application/json" } });
    if (res.ok) {
      const json = (await res.json()) as { servers?: BundledMcpServer[] };
      if (Array.isArray(json?.servers) && json.servers.length > 0) {
        bundledMcpCache = json.servers;
        return bundledMcpCache;
      }
    }
  } catch (err) {
    console.warn("[manage_mcp] bundled market index fetch failed:", err);
  }
  // Fallback: the static registry (id/name/url/description only).
  bundledMcpCache = MCP_MARKET_SERVERS.map((s) => ({
    id: s.id,
    name: s.name,
    url: s.url,
    description: s.description,
    transport: "unknown",
    ...(s.hint ? { note: s.hint } : {}),
  }));
  return bundledMcpCache;
}

const MANAGE_MCP_DESCRIPTION = `Manage MCP (Model Context Protocol) server configurations — one tool for every MCP operation. Pass \`action\` plus the fields that action needs:

- action "list": list all configured MCP servers (id, name, transport, url, active status). No other fields.
- action "create": register a REMOTE MCP server (HTTP/SSE endpoint — the ONLY kind the app can call as a first-class tool via mcp_search_tools / mcp_call_tool). Requires \`name\`, \`transport\` (sse | streamable_http — stdio is NOT supported in the browser), \`url\`. Optional: \`headers\` (object), \`is_active\` (default true). After creating, search its tools with mcp_search_tools. Note: MCP servers installed inside the E2B sandbox (npm/stdio packages) CANNOT be registered here — they are separate processes in that VM; use them by running an MCP client script or their CLI inside the sandbox instead.
- action "edit": edit an existing server's name / transport / url / headers / active status. Requires \`id\` (find it with action "list"); the other fields are optional patches.
- action "delete": delete an MCP server. Requires \`id\`.
- action "market": the curated MCPMarket catalog WITH FULL BUNDLED CONNECTION CONFIGS (remote URLs, stdio commands, required env, tool lists) — no web_fetch needed. Remote HTTP/SSE servers → register with action "create" here; stdio/npx/uvx servers → run inside the E2B sandbox via an MCP client script.`;

registerTool(
  "manage_mcp",
  MANAGE_MCP_DESCRIPTION,
  {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "create", "edit", "delete", "market"],
        description: "Which MCP operation to perform.",
      },
      id: { type: "string", description: "MCP server id (edit / delete). Use action 'list' to find ids." },
      name: { type: "string", description: "Display name (create, or new name on edit)." },
      transport: { type: "string", enum: ["sse", "streamable_http"], description: "Transport protocol (create / edit)." },
      url: { type: "string", description: "Server URL, e.g. https://mcp-server.example.com/sse (create / edit)." },
      headers: {
        type: "object",
        description: "Optional headers, e.g. { \"Authorization\": \"Bearer ...\" } (create / edit — replaces all existing headers).",
        additionalProperties: { type: "string" },
      },
      is_active: { type: "boolean", description: "Whether the server is active (create / edit, default true)." },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async (args, ctx): Promise<ToolResult> => {
    const action = String(args.action ?? "");
    const id = args.id as string | undefined;

    // ---- action: list (was list_mcps) ----
    if (action === "list") {
      const servers = await mcpService.list(ctx.userId);
      if (servers.length === 0) {
        return { success: true, output: { servers: [], message: "No MCP servers configured" } };
      }
      return {
        success: true,
        output: {
          servers: servers.map((s) => ({
            id: s.id,
            name: s.name,
            transport: s.transport,
            url: s.url,
            is_active: s.is_active,
            created_at: s.created_at,
          })),
          total: servers.length,
        },
      };
    }

    // ---- action: create (was create_mcp) ----
    if (action === "create") {
      const name = args.name as string | undefined;
      const transport = args.transport as "sse" | "streamable_http" | undefined;
      const url = args.url as string | undefined;
      if (!name || !url) {
        return { success: false, output: null, error: "name and url are required for action 'create'" };
      }
      if ((transport as string) === "stdio") {
        return { success: false, output: null, error: "stdio transport is not supported in browser mode. Use sse or streamable_http." };
      }
      const server = await mcpService.create(ctx.userId, {
        name,
        transport: transport ?? "sse",
        url,
        headers: (args.headers as Record<string, string>) || {},
        is_active: Boolean(args.is_active ?? true),
      });
      bumpWorkspaceVersion("local"); // mcp_servers changed — refresh snapshot cache
      return { success: true, output: { created: server.name, id: server.id } };
    }

    // ---- action: edit (was edit_mcp) ----
    if (action === "edit") {
      if (!id) return { success: false, output: null, error: "id is required for action 'edit'" };
      const servers = await mcpService.list(ctx.userId);
      const existing = servers.find((s) => s.id === id);
      if (!existing) {
        return { success: false, output: null, error: `MCP server with id '${id}' not found` };
      }
      const patch: Record<string, unknown> = {};
      if (args.name) patch.name = args.name;
      if (args.transport) patch.transport = args.transport;
      if (args.url) patch.url = args.url;
      if (args.headers !== undefined) patch.headers = args.headers;
      if (args.is_active !== undefined) patch.is_active = args.is_active;
      await mcpService.update(id, patch);
      bumpWorkspaceVersion("local"); // mcp_servers changed
      return { success: true, output: { edited: existing.name, id } };
    }

    // ---- action: delete (was delete_mcp) ----
    if (action === "delete") {
      if (!id) return { success: false, output: null, error: "id is required for action 'delete'" };
      const servers = await mcpService.list(ctx.userId);
      const existing = servers.find((s) => s.id === id);
      if (!existing) {
        return { success: false, output: null, error: `MCP server with id '${id}' not found` };
      }
      await mcpService.delete(id);
      bumpWorkspaceVersion("local"); // mcp_servers changed
      return { success: true, output: { deleted: existing.name, id } };
    }

    // ---- action: market (bundled MCPMarket configs — real connection data) ----
    if (action === "market") {
      const servers = await loadBundledMcpMarket();
      return {
        success: true,
        output: {
          servers: servers.map((s) => ({
            id: s.id,
            name: s.name,
            marketplace_url: s.url,
            description: s.description,
            ...(s.github ? { github: s.github } : {}),
            ...(s.npm ? { npm: s.npm } : {}),
            transport: s.transport,
            ...(s.remote
              ? {
                  remote_url: s.remote.url,
                  remote_transport: s.remote.transport,
                  ...(s.remote.auth ? { auth: s.remote.auth } : {}),
                }
              : {}),
            ...(s.stdio ? { stdio_command: [s.stdio.command, ...(s.stdio.args ?? [])].join(" ") } : {}),
            ...(s.env_required ? { env_required: s.env_required } : {}),
            ...(s.sandbox ? { sandbox: s.sandbox } : {}),
            ...(s.register_hint ? { register_hint: s.register_hint } : {}),
            ...(s.note ? { note: s.note } : {}),
            ...(s.tools?.length
              ? { tools: s.tools.map((t) => t.name).slice(0, 50), tool_count: s.tools.length }
              : {}),
          })),
          total: servers.length,
          how_to_connect:
            "Configs are BUNDLED (local files — extracted from each server's marketplace page + GitHub README). Decision order: transport 'remote-http' → register DIRECTLY with manage_mcp action 'create' (transport + url above; complete its auth in the app browser if OAuth). transport 'stdio-npm' / 'stdio-python' / 'plugin' → run INSIDE the E2B sandbox via run_terminal (an MCP client script with @modelcontextprotocol/sdk spawning the stdio command, or the server's own CLI). Never guess connection details — everything needed is in this payload.",
        },
      };
    }

    return { success: false, output: null, error: `Unknown action: ${action}` };
  },
  false,
  "general",
);

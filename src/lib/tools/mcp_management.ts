// MCP server management tools — create, edit, list MCP servers.
// MCP servers are stored in IndexedDB and connected at agent turn start.
import { registerTool } from "./registry";
import type { ToolResult } from "@/types";
import { mcpService } from "@/lib/services";

registerTool(
  "list_mcps",
  "List all configured MCP servers for the current user. Returns name, transport, URL, and active status.",
  {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  async (_args, ctx): Promise<ToolResult> => {
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
  },
);

registerTool(
  "create_mcp",
  "Create a new MCP server configuration. Only SSE and streamable_http transports are supported (no stdio in browser).",
  {
    type: "object",
    properties: {
      name: { type: "string", description: "Display name for the MCP server" },
      transport: { type: "string", enum: ["sse", "streamable_http"], description: "Transport protocol" },
      url: { type: "string", description: "Server URL (e.g., https://mcp-server.example.com/sse)" },
      headers: {
        type: "object",
        description: "Optional headers (e.g., Authorization: Bearer ...)",
        additionalProperties: { type: "string" },
      },
      is_active: { type: "boolean", description: "Whether the server should be active (default: true)" },
    },
    required: ["name", "transport", "url"],
    additionalProperties: false,
  },
  async (args, ctx): Promise<ToolResult> => {
    const name = args.name as string;
    const transport = args.transport as "sse" | "streamable_http";
    const url = args.url as string;
    if (!name || !url) {
      return { success: false, output: null, error: "name and url are required" };
    }
    if (transport === "stdio") {
      return { success: false, output: null, error: "stdio transport is not supported in browser mode. Use sse or streamable_http." };
    }
    const server = await mcpService.create(ctx.userId, {
      name,
      transport,
      url,
      headers: (args.headers as Record<string, string>) || {},
      is_active: args.is_active ?? true,
    });
    return { success: true, output: { created: server.name, id: server.id } };
  },
);

registerTool(
  "edit_mcp",
  "Edit an existing MCP server's configuration (URL, headers, active status, name).",
  {
    type: "object",
    properties: {
      id: { type: "string", description: "ID of the MCP server to edit (use list_mcps to find it)" },
      name: { type: "string", description: "New display name (optional)" },
      transport: { type: "string", enum: ["sse", "streamable_http"], description: "New transport (optional)" },
      url: { type: "string", description: "New server URL (optional)" },
      headers: {
        type: "object",
        description: "New headers (optional, replaces all existing headers)",
        additionalProperties: { type: "string" },
      },
      is_active: { type: "boolean", description: "Toggle active status (optional)" },
    },
    required: ["id"],
    additionalProperties: false,
  },
  async (args, ctx): Promise<ToolResult> => {
    const id = args.id as string;
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
    return { success: true, output: { edited: existing.name, id } };
  },
);

registerTool(
  "delete_mcp",
  "Delete an MCP server by ID.",
  {
    type: "object",
    properties: {
      id: { type: "string", description: "ID of the MCP server to delete" },
    },
    required: ["id"],
    additionalProperties: false,
  },
  async (args, ctx): Promise<ToolResult> => {
    const id = args.id as string;
    const servers = await mcpService.list(ctx.userId);
    const existing = servers.find((s) => s.id === id);
    if (!existing) {
      return { success: false, output: null, error: `MCP server with id '${id}' not found` };
    }
    await mcpService.delete(id);
    return { success: true, output: { deleted: existing.name, id } };
  },
);

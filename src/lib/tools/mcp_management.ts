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

const MANAGE_MCP_DESCRIPTION = `Manage MCP (Model Context Protocol) server configurations — one tool for every MCP operation. Pass \`action\` plus the fields that action needs:

- action "list": list all configured MCP servers (id, name, transport, url, active status). No other fields.
- action "create": create a new MCP server configuration. Requires \`name\`, \`transport\` (sse | streamable_http — stdio is NOT supported in the browser), \`url\`. Optional: \`headers\` (object), \`is_active\` (default true).
- action "edit": edit an existing server's name / transport / url / headers / active status. Requires \`id\` (find it with action "list"); the other fields are optional patches.
- action "delete": delete an MCP server. Requires \`id\`.`;

registerTool(
  "manage_mcp",
  MANAGE_MCP_DESCRIPTION,
  {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "create", "edit", "delete"],
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
      return { success: true, output: { deleted: existing.name, id } };
    }

    return { success: false, output: null, error: `Unknown action: ${action}` };
  },
  false,
  "general",
);

"use client";

/**
 * MCP tool registration — bridges the MCP client (`@/lib/mcp/client`) and
 * the agent's tool registry (`@/lib/tools/registry`).
 *
 * At the start of every agent turn, the runtime calls `loadMCPTools(userId)`
 * which:
 *   1. Reads the user's active MCP servers from `mcpService`.
 *   2. Connects to each server in parallel via `MCPClient.connect()` to
 *      enumerate tools.
 *   3. For every tool, registers a thin wrapper in the tool registry that
 *      routes `handler(args, ctx)` through `callMCPTool(server, name, args)`.
 *
 * Failures are per-server — one bad MCP server doesn't block the others;
 * its tools simply don't show up in the registry and the agent can't call
 * them. A console warning is logged for diagnostics.
 *
 * Tool names are namespaced as `mcp_<serverName>__<toolName>` so they
 * don't collide with built-in tools (`run_terminal`, `web_search`, etc.)
 * or custom user tools. The LLM sees the description as
 * `[mcp:<serverName>] <tool description>` so it knows where the tool
 * came from.
 */

import { registerTool, type ToolHandler } from "@/lib/tools/registry";
import { mcpService } from "@/lib/services";
import {
  MCPClient,
  callMCPTool,
  type MCPServerConfig,
  type MCPTool,
  type MCPDiscoveryResult,
  type MCPTransport,
} from "@/lib/mcp/client";

/** Track which server each registered tool belongs to (for routing calls). */
interface MCPToolBinding {
  server: MCPServerConfig;
  toolName: string;
  /** The namespaced registry name (`mcp_<server>__<tool>`). */
  registryName: string;
}

const bindings = new Map<string, MCPToolBinding>();
/** Set of registry names registered this turn — cleared + re-populated each turn. */
const registeredThisTurn = new Set<string>();

/** Namespaced tool name shown to the LLM. */
export function mcpToolRegistryName(serverName: string, toolName: string): string {
  const safeServer = serverName.replace(/[^a-zA-Z0-9_]+/g, "_").slice(0, 32);
  const safeTool = toolName.replace(/[^a-zA-Z0-9_]+/g, "_").slice(0, 64);
  return `mcp_${safeServer}__${safeTool}`;
}

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

/**
 * Connect to every active MCP server for the user and register each tool
 * with the agent's tool registry. Safe to call multiple times — tools
 * registered in a previous turn are kept (the registry dedupes by name),
 * and stale bindings (server no longer active / tool no longer exposed)
 * are left in place but harmless.
 *
 * Returns the discovery results so the caller can surface errors to the
 * UI (e.g. a banner listing failed MCP servers).
 */
export async function loadMCPTools(userId: string): Promise<MCPDiscoveryResult[]> {
  // Reset the per-turn tracker (the registry itself is process-lifetime,
  // but we want to know which bindings are "live" for THIS turn so the
  // UI can show the current tool count).
  registeredThisTurn.clear();

  const rows = await mcpService.list(userId, true /* activeOnly */);
  const configs: MCPServerConfig[] = [];
  for (const row of rows) {
    const cfg = toConfig(row);
    if (cfg) configs.push(cfg);
  }

  if (configs.length === 0) return [];

  // Discovery — connect to each server in parallel, collect tools.
  const discovery = await Promise.all(
    configs.map(async (server) => {
      const client = new MCPClient({
        url: server.url,
        transport: server.transport,
        headers: server.headers,
      });
      try {
        const tools = await client.connect();
        client.disconnect();
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

  // Register every tool as a thin wrapper.
  for (const { server, tools, error } of discovery) {
    if (error) {
      console.warn(`[mcp] ${server.name}: discovery failed — ${error}`);
      continue;
    }
    for (const tool of tools) {
      const registryName = mcpToolRegistryName(server.name, tool.name);
      const binding: MCPToolBinding = { server, toolName: tool.name, registryName };
      bindings.set(registryName, binding);
      registeredThisTurn.add(registryName);

      const handler: ToolHandler = async (args) => {
        try {
          const result = await callMCPTool(
            binding.server,
            binding.toolName,
            args as Record<string, unknown>,
          );
          return result;
        } catch (err) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `MCP tool '${binding.toolName}' on '${binding.server.name}' failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              },
            ],
          };
        }
      };

      const description = `[mcp:${server.name}] ${tool.description || tool.name}`;
      registerTool(
        registryName,
        description,
        tool.inputSchema ?? { type: "object", properties: {} },
        handler,
        false,
        "mcp",
      );
    }
  }

  return discovery;
}

/** Number of MCP tools registered this turn. */
export function mcpToolCount(): number {
  return registeredThisTurn.size;
}

/** List of MCP server names that exposed at least one tool this turn. */
export function activeMCPServers(): string[] {
  const out = new Set<string>();
  for (const name of registeredThisTurn) {
    const binding = bindings.get(name);
    if (binding) out.add(binding.server.name);
  }
  return [...out];
}

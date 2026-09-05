// Dynamic tool creation — AI creates/edits/deletes custom tools at runtime.
// Tools are persisted to IndexedDB via customToolService and hot-registered.
import { registerTool, type ToolHandler } from "./registry";
import type { ToolResult } from "@/types";
import { customToolService } from "@/lib/services";

// In-memory cache of dynamically registered tool handlers (keyed by tool name)
const dynamicHandlers = new Map<string, ToolHandler>();

/** Re-register all active custom tools from IndexedDB for the given user. */
export async function loadDynamicTools(userId: string): Promise<void> {
  const tools = await customToolService.list(userId);
  for (const t of tools) {
    if (!t.is_active) continue;
    const handler = buildHandler(t.impl_kind, t.http_url ?? null, t.http_headers, t.python_source ?? null);
    if (handler) {
      dynamicHandlers.set(t.name, handler);
      registerTool(
        t.name,
        t.description,
        t.parameters_schema as Record<string, unknown>,
        handler,
        false,
      );
    }
  }
}

function buildHandler(
  implKind: string,
  httpUrl: string | null,
  httpHeaders: Record<string, string> | null,
  pythonSource: string | null,
): ToolHandler | null {
  if (implKind === "http_webhook" && httpUrl) {
    return async (args) => {
      try {
        // Route through the in-app CORS proxy (`/api/chat-proxy`) to bypass
        // browser cross-origin restrictions. Most webhook hosts don't send
        // `Access-Control-Allow-Origin`, so a direct `fetch(httpUrl)` from
        // the browser fails with "failed to fetch". The proxy forwards the
        // POST server-side, then returns the upstream response with
        // permissive CORS headers. The target URL is carried in the
        // `x-target-url` header (same convention the AI provider calls use).
        const res = await fetch(`/api/chat-proxy?url=${encodeURIComponent(httpUrl)}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-target-url": httpUrl,
            ...(httpHeaders || {}),
          },
          body: JSON.stringify(args),
        });
        const text = await res.text();
        let output: unknown = text;
        try {
          output = JSON.parse(text);
        } catch {
          // keep as text
        }
        // `res.ok` reflects the proxy's own status — when the upstream
        // returns e.g. 4xx/5xx, the proxy forwards the same status code
        // (see `route.ts`), so this is a faithful signal.
        return {
          success: res.ok,
          output,
          error: res.ok ? undefined : `HTTP ${res.status}`,
        };
      } catch (e) {
        return { success: false, output: null, error: e instanceof Error ? e.message : String(e) };
      }
    };
  }
  if (implKind === "python_snippet" && pythonSource) {
    // Python execution requires an E2B sandbox — return a handler that
    // spins up a sandbox client via the user's stored key.
    return async (args, ctx) => {
      const apiKey = ctx.e2bApiKey ?? ctx.sandboxApiKey;
      if (!apiKey) {
        return { success: false, output: null, error: "Python tools require an E2B Sandbox API key" };
      }
      try {
        // Write the tool source + args to a temp file and exec
        const code = `${pythonSource}\n\nimport json\n_result = run(**json.loads('${JSON.stringify(args).replace(/'/g, "\\'")}'))\nprint(json.dumps(_result if not isinstance(_result, str) else _result))`;
        const { getE2BClient } = await import("@/lib/e2b/client");
        const client = getE2BClient(apiKey, ctx.userId);
        // Use STREAMING Python execution so custom tool output appears
        // live in the tool call card (via onToolOutput callback). Previously
        // used the non-streaming client.runPython() which waited for the
        // full execution before returning — custom Python tools appeared
        // "stuck" until completion.
        const onOutput = ctx.onToolOutput;
        let stdout = "";
        let stderr = "";
        let exitCode = 0;
        for await (const chunk of client.runPythonStream(code, { timeout: 60 })) {
          if (chunk.type === "stdout" && chunk.data) {
            stdout += chunk.data;
            if (onOutput) onOutput("", chunk.data, "stdout");
          } else if (chunk.type === "stderr" && chunk.data) {
            stderr += chunk.data;
            if (onOutput) onOutput("", chunk.data, "stderr");
          } else if (chunk.type === "result") {
            exitCode = chunk.exit_code ?? 0;
          }
        }
        return {
          success: exitCode === 0,
          output: stdout || stderr,
          error: exitCode !== 0 ? stderr : undefined,
        };
      } catch (e) {
        return { success: false, output: null, error: e instanceof Error ? e.message : String(e) };
      }
    };
  }
  return null;
}

// MERGE NOTE (tool-count cap): the three former custom-tool management tools
// (create_tool / edit_tool / delete_tool) were merged into this single
// `manage_custom_tool` tool with an `action` parameter. Each action preserves
// the EXACT result shape of the tool it replaced.
const MANAGE_CUSTOM_TOOL_DESCRIPTION = `Create, edit, or delete CUSTOM TOOLS that you can call in future turns — one tool for all three operations. A custom tool is defined by a name, description, JSON-schema parameters, and an implementation (either 'http_webhook' — calls a URL with the args as JSON body — or 'python_snippet' — runs a Python function \`run(**params)\` in the sandbox). Pass \`action\` plus the fields that action needs:

- action "create": define a new custom tool. Requires \`name\`, \`description\`, \`parameters\` (JSON Schema), \`impl_kind\`; plus \`http_url\` (+ optional \`http_headers\`) for http_webhook, or \`python_source\` for python_snippet.
- action "edit": edit an existing custom tool's description / parameters / implementation. Requires \`name\`; all other fields are optional patches.
- action "delete": delete a custom tool. Requires \`name\`.`;

registerTool(
  "manage_custom_tool",
  MANAGE_CUSTOM_TOOL_DESCRIPTION,
  {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "edit", "delete"],
        description: "Which custom-tool operation to perform.",
      },
      name: { type: "string", description: "Custom tool name (snake_case, unique)." },
      description: { type: "string", description: "What the tool does (create) or new description (edit)." },
      parameters: {
        type: "object",
        description: "JSON Schema for the tool's parameters — same format as OpenAI function parameters (create, or new schema on edit).",
      },
      impl_kind: { type: "string", enum: ["http_webhook", "python_snippet"], description: "Implementation kind." },
      http_url: { type: "string", description: "URL for http_webhook impl." },
      http_headers: { type: "object", description: "Headers for http_webhook impl." },
      python_source: { type: "string", description: "Python source with a run(**params) function for python_snippet impl." },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async (args, ctx): Promise<ToolResult> => {
    const action = String(args.action ?? "");
    const name = args.name as string | undefined;
    if (!name) return { success: false, output: null, error: "name is required for action '" + action + "'" };

    // ---- action: create (was create_tool) ----
    if (action === "create") {
      if (!args.description || !args.parameters || !args.impl_kind) {
        return { success: false, output: null, error: "description, parameters and impl_kind are required for action 'create'" };
      }
      // Check for conflicts with existing custom tools
      const existing = await customToolService.list(ctx.userId);
      if (existing.some((t) => t.name === name)) {
        return { success: false, output: null, error: `Tool '${name}' already exists` };
      }
      const tool = await customToolService.create(ctx.userId, {
        name,
        description: args.description as string,
        parameters_schema: args.parameters as Record<string, unknown>,
        impl_kind: args.impl_kind as "http_webhook" | "python_snippet",
        http_url: (args.http_url as string) || undefined,
        http_headers: (args.http_headers as Record<string, string>) || null,
        python_source: (args.python_source as string) || undefined,
        is_active: true,
      });
      // Hot-register the handler
      const handler = buildHandler(tool.impl_kind, tool.http_url, tool.http_headers, tool.python_source);
      if (handler) {
        dynamicHandlers.set(name, handler);
        registerTool(name, tool.description, tool.parameters_schema as Record<string, unknown>, handler, false);
      }
      return { success: true, output: { created: name, id: tool.id } };
    }

    // ---- action: edit (was edit_tool) ----
    if (action === "edit") {
      const tools = await customToolService.list(ctx.userId);
      const existing = tools.find((t) => t.name === name);
      if (!existing) return { success: false, output: null, error: `Tool '${name}' not found` };
      const patch: Record<string, unknown> = {};
      if (args.description) patch.description = args.description;
      if (args.parameters) patch.parameters_schema = args.parameters;
      if (args.impl_kind) patch.impl_kind = args.impl_kind;
      if (args.http_url !== undefined) patch.http_url = args.http_url;
      if (args.http_headers !== undefined) patch.http_headers = args.http_headers;
      if (args.python_source !== undefined) patch.python_source = args.python_source;
      await customToolService.update(existing.id, patch);
      // Re-register
      const updated = (await customToolService.list(ctx.userId)).find((t) => t.name === name)!;
      const handler = buildHandler(updated.impl_kind, updated.http_url ?? null, updated.http_headers, updated.python_source ?? null);
      if (handler) {
        dynamicHandlers.set(name, handler);
        registerTool(name, updated.description, updated.parameters_schema as Record<string, unknown>, handler, false);
      }
      return { success: true, output: { updated: name } };
    }

    // ---- action: delete (was delete_tool) ----
    if (action === "delete") {
      const tools = await customToolService.list(ctx.userId);
      const existing = tools.find((t) => t.name === name);
      if (!existing) return { success: false, output: null, error: `Tool '${name}' not found` };
      await customToolService.delete(existing.id);
      dynamicHandlers.delete(name);
      return { success: true, output: { deleted: name } };
    }

    return { success: false, output: null, error: `Unknown action: ${action}` };
  },
);

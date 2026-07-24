// Environment variable management tools — add, set, edit, delete, list env vars.
// These let the AI manage its own sandbox environment variables at runtime.
import { registerTool } from "./registry";
import type { ToolResult } from "@/types";
import { settingsService } from "@/lib/services";

registerTool(
  "list_env_vars",
  "List all environment variables set for the sandbox. Returns name-value pairs (secrets masked).",
  {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  async (_args, ctx): Promise<ToolResult> => {
    const vars = await settingsService.getDecryptedEnvVars(ctx.userId);
    if (!vars || Object.keys(vars).length === 0) {
      return { success: true, output: { vars: [], message: "No env vars set" } };
    }
    const list = Object.entries(vars).map(([name, value]) => ({
      name,
      value: value.length > 50 ? value.slice(0, 50) + "…" : value,
      length: value.length,
    }));
    return { success: true, output: { vars: list, total: list.length } };
  },
);

registerTool(
  "add_env_var",
  "Add a new environment variable to the sandbox. If a var with the same name exists, it will be overwritten.",
  {
    type: "object",
    properties: {
      name: { type: "string", description: "Environment variable name (e.g., API_KEY, DATABASE_URL)" },
      value: { type: "string", description: "The value to set" },
    },
    required: ["name", "value"],
    additionalProperties: false,
  },
  async (args, ctx): Promise<ToolResult> => {
    const name = args.name as string;
    const value = args.value as string;
    if (!name) return { success: false, output: null, error: "name is required" };
    const vars = (await settingsService.getDecryptedEnvVars(ctx.userId)) || {};
    vars[name] = value;
    await settingsService.setEnvVars(ctx.userId, vars);
    return { success: true, output: { added: name, total_vars: Object.keys(vars).length } };
  },
);

registerTool(
  "set_env_var",
  "Set an environment variable (alias for add_env_var). Creates or updates the variable.",
  {
    type: "object",
    properties: {
      name: { type: "string", description: "Environment variable name" },
      value: { type: "string", description: "The value to set" },
    },
    required: ["name", "value"],
    additionalProperties: false,
  },
  async (args, ctx): Promise<ToolResult> => {
    const name = args.name as string;
    const value = args.value as string;
    if (!name) return { success: false, output: null, error: "name is required" };
    const vars = (await settingsService.getDecryptedEnvVars(ctx.userId)) || {};
    vars[name] = value;
    await settingsService.setEnvVars(ctx.userId, vars);
    return { success: true, output: { set: name, total_vars: Object.keys(vars).length } };
  },
);

registerTool(
  "edit_env_var",
  "Edit an existing environment variable's value.",
  {
    type: "object",
    properties: {
      name: { type: "string", description: "Name of the env var to edit" },
      value: { type: "string", description: "New value" },
    },
    required: ["name", "value"],
    additionalProperties: false,
  },
  async (args, ctx): Promise<ToolResult> => {
    const name = args.name as string;
    const value = args.value as string;
    const vars = (await settingsService.getDecryptedEnvVars(ctx.userId)) || {};
    if (!(name in vars)) {
      return { success: false, output: null, error: `Env var '${name}' not found` };
    }
    vars[name] = value;
    await settingsService.setEnvVars(ctx.userId, vars);
    return { success: true, output: { edited: name } };
  },
);

registerTool(
  "delete_env_var",
  "Delete an environment variable by name.",
  {
    type: "object",
    properties: {
      name: { type: "string", description: "Name of the env var to delete" },
    },
    required: ["name"],
    additionalProperties: false,
  },
  async (args, ctx): Promise<ToolResult> => {
    const name = args.name as string;
    const vars = (await settingsService.getDecryptedEnvVars(ctx.userId)) || {};
    if (!(name in vars)) {
      return { success: false, output: null, error: `Env var '${name}' not found` };
    }
    delete vars[name];
    await settingsService.setEnvVars(ctx.userId, vars);
    return { success: true, output: { deleted: name, remaining: Object.keys(vars).length } };
  },
);

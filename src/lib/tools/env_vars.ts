// Environment variable management tools — add, set, edit, delete, list env vars.
// These let the AI manage its own sandbox environment variables at runtime.
import { registerTool } from "./registry";
import type { ToolResult } from "@/types";
import { settingsService } from "@/lib/services";

// PRESERVE SECRET FLAG (PRD §14): the AI's own write tools previously
// hardcoded `is_secret: false`, silently downgrading encrypted secrets to
// plaintext on every write. Preserve each entry's existing flag; treat
// secret-looking names as secrets on first write.
function looksSecret(name: string): boolean {
  return /key|token|secret|password|passphrase|credential|auth/i.test(name);
}

async function saveEnvVars(
  userId: string,
  vars: Record<string, string>,
): Promise<void> {
  // Look up the current secret flags so a re-save doesn't strip them.
  let flags: Record<string, boolean> = {};
  try {
    const settings = await settingsService.get(userId);
    const raw = settings.env_vars;
    if (Array.isArray(raw)) {
      flags = Object.fromEntries(raw.map((v) => [v.name, !!v.is_secret]));
    }
  } catch {
    // fall back to the heuristic below
  }
  await settingsService.setEnvVars(
    userId,
    Object.fromEntries(
      Object.entries(vars).map(([k, v]) => [
        k,
        { value: v, is_secret: flags[k] ?? looksSecret(k) },
      ]),
    ),
  );
}

registerTool(
  "list_env_vars",
  "List all environment variables set for the sandbox. Returns each variable's name and value length — values themselves are NOT included. Use get_env_var to resolve a specific variable's actual value when you need it.",
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
    // NAMES + lengths only — never bulk-dump values into the transcript.
    const list = Object.entries(vars).map(([name, value]) => ({
      name,
      value_length: value.length,
    }));
    return {
      success: true,
      output: {
        vars: list,
        total: list.length,
        hint: "Use get_env_var(name) to read a specific value.",
      },
    };
  },
);

registerTool(
  "get_env_var",
  "Read the ACTUAL VALUE of one environment variable by name. Use this when you need the variable's real value — or simply reference $NAME / os.environ['NAME'] inside run_terminal / run_python, which automatically receive all env var values.",
  {
    type: "object",
    properties: {
      name: { type: "string", description: "Environment variable name to resolve" },
    },
    required: ["name"],
    additionalProperties: false,
  },
  async (args, ctx): Promise<ToolResult> => {
    const name = args.name as string;
    if (!name) return { success: false, output: null, error: "name is required" };
    // Live turn context first (freshest), persisted settings as fallback.
    const fromCtx = ctx.envVars?.[name];
    const value =
      fromCtx !== undefined
        ? fromCtx
        : ((await settingsService.getDecryptedEnvVars(ctx.userId)) ?? {})[name];
    if (value === undefined) {
      return { success: false, output: null, error: `Env var '${name}' not found` };
    }
    return { success: true, output: { name, value } };
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
    await saveEnvVars(ctx.userId, vars);
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
    await saveEnvVars(ctx.userId, vars);
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
    await saveEnvVars(ctx.userId, vars);
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
    await saveEnvVars(ctx.userId, vars);
    return { success: true, output: { deleted: name, remaining: Object.keys(vars).length } };
  },
);

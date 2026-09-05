// Environment variable management — ONE multi-function tool.
//
// MERGE NOTE (tool-count cap): the model provider errors when more than ~62
// tools are exposed, so the six former env-var tools
// (list_env_vars / get_env_var / add_env_var / set_env_var / edit_env_var /
// delete_env_var) were merged into this single `manage_env_var` tool with an
// `action` parameter. Each action preserves the EXACT result shape of the
// tool it replaced, so stored transcripts and UI renderers are unaffected.
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

const MANAGE_ENV_VAR_DESCRIPTION = `Manage the sandbox's environment variables — one tool for every env-var operation. Pass \`action\` plus the fields that action needs:

- action "list": list all env vars (names + value lengths only — values are NOT returned). No other fields.
- action "get": read the ACTUAL VALUE of one var. Requires \`name\`. (You can also reference $NAME / os.environ['NAME'] inside run_terminal / run_python — they receive all env vars automatically.)
- action "add": add a new env var (existing name is overwritten). Requires \`name\` + \`value\`.
- action "set": set (create or update) an env var — same as add. Requires \`name\` + \`value\`.
- action "edit": edit an existing var's value (fails if the var doesn't exist). Requires \`name\` + \`value\`.
- action "delete": delete an env var by name. Requires \`name\`.`;

registerTool(
  "manage_env_var",
  MANAGE_ENV_VAR_DESCRIPTION,
  {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "get", "add", "set", "edit", "delete"],
        description: "Which env-var operation to perform.",
      },
      name: { type: "string", description: "Environment variable name (e.g., API_KEY, DATABASE_URL)." },
      value: { type: "string", description: "The variable's value (for add/set/edit)." },
    },
    required: ["action"],
    additionalProperties: false,
  },
  async (args, ctx): Promise<ToolResult> => {
    const action = String(args.action ?? "");
    const name = args.name as string | undefined;
    const value = args.value as string | undefined;

    // ---- action: list (was list_env_vars) ----
    if (action === "list") {
      const vars = await settingsService.getDecryptedEnvVars(ctx.userId);
      if (!vars || Object.keys(vars).length === 0) {
        return { success: true, output: { vars: [], message: "No env vars set" } };
      }
      // NAMES + lengths only — never bulk-dump values into the transcript.
      const list = Object.entries(vars).map(([n, v]) => ({
        name: n,
        value_length: v.length,
      }));
      return {
        success: true,
        output: {
          vars: list,
          total: list.length,
          hint: "Use manage_env_var(action='get', name=...) to read a specific value.",
        },
      };
    }

    // ---- action: get (was get_env_var) ----
    if (action === "get") {
      if (!name) return { success: false, output: null, error: "name is required for action 'get'" };
      // Live turn context first (freshest), persisted settings as fallback.
      const fromCtx = ctx.envVars?.[name];
      const val =
        fromCtx !== undefined
          ? fromCtx
          : ((await settingsService.getDecryptedEnvVars(ctx.userId)) ?? {})[name];
      if (val === undefined) {
        return { success: false, output: null, error: `Env var '${name}' not found` };
      }
      return { success: true, output: { name, value: val } };
    }

    // ---- action: add / set / edit ----
    if (action === "add" || action === "set" || action === "edit") {
      if (!name) return { success: false, output: null, error: "name is required for action '" + action + "'" };
      if (value === undefined) return { success: false, output: null, error: "value is required for action '" + action + "'" };
      const vars = (await settingsService.getDecryptedEnvVars(ctx.userId)) || {};
      if (action === "edit" && !(name in vars)) {
        return { success: false, output: null, error: `Env var '${name}' not found` };
      }
      vars[name] = value;
      await saveEnvVars(ctx.userId, vars);
      if (action === "add") {
        return { success: true, output: { added: name, total_vars: Object.keys(vars).length } };
      }
      if (action === "set") {
        return { success: true, output: { set: name, total_vars: Object.keys(vars).length } };
      }
      return { success: true, output: { edited: name } };
    }

    // ---- action: delete ----
    if (action === "delete") {
      if (!name) return { success: false, output: null, error: "name is required for action 'delete'" };
      const vars = (await settingsService.getDecryptedEnvVars(ctx.userId)) || {};
      if (!(name in vars)) {
        return { success: false, output: null, error: `Env var '${name}' not found` };
      }
      delete vars[name];
      await saveEnvVars(ctx.userId, vars);
      return { success: true, output: { deleted: name, remaining: Object.keys(vars).length } };
    }

    return { success: false, output: null, error: `Unknown action: ${action}` };
  },
  false,
  "general",
);

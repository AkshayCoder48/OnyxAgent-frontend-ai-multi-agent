"use client";

import { registerTool } from "./registry";
import { chatSandboxForCtx } from "@/lib/e2b/sandbox-rotation";
import { bumpWorkspaceVersion } from "./workspace-snapshot";

// E2B Python sandbox — modules available in the code-interpreter template.
const PYTHON_NOTE =
  "The sandbox has a 60-second timeout. Returns stdout, stderr, and the exit code.";

/**
 * Code execution tools — `run_python` and `run_terminal`.
 *
 * Executions run in the user-level SHARED sandbox (`chatSandboxForCtx`) —
 * the same filesystem the file tools operate on, so files written anywhere
 * in the workspace are visible to subsequent executions.
 *
 * Auto-rotation: `chatSandboxForCtx(ctx)` is called before every execution.
 * If the sandbox is >50 min old it's rotated (backup → kill → create →
 * restore) transparently.
 */

const NO_KEY_ERROR =
  "Python execution requires an E2B Sandbox API key. Add one in Settings → Config → E2B Sandbox.";

registerTool(
  "run_python",
  `Run Python 3 source code in a sandboxed E2B environment. ${PYTHON_NOTE} Output streams in real time. Files in the workspace are already in the sandbox — no upload step needed.`,
  {
    type: "object",
    properties: {
      code: { type: "string", description: "Python 3 source code to execute." },
    },
    required: ["code"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const code = args.code as string;
    if (!code || !code.trim()) {
      return { error: "No code provided" };
    }
    const sbx = await chatSandboxForCtx(ctx);
    if (!sbx) {
      return {
        error: NO_KEY_ERROR,
        exit_code: -1,
        stdout: "",
        stderr: "E2B Sandbox API key not configured. The key may be set but the vault is locked — try refreshing the page.",
      };
    }

    try {
      const client = sbx.client;
      const onOutput = ctx.onToolOutput;

      // ENV INJECTION (PRD §14): pass the user's env-var VALUES into the
      // sandbox execution — `os.environ["KEY"]` resolves to the actual
      // secret value instead of the variable name being echoed.
      const envs =
        ctx.envVars && Object.keys(ctx.envVars).length > 0 ? ctx.envVars : undefined;

      // runPythonStream is an async generator. Iterate it and pipe chunks.
      let stdout = "";
      let stderr = "";
      let exitCode = 0;

      for await (const chunk of client.runPythonStream(code, { timeout: 60, envs })) {
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

      // No reverse sync — files created/modified by the Python code are
      // already in the sandbox (the single source of truth). The file
      // tools will see them on the next read/list call.
      // The command MAY have written files (attribution is impossible), so
      // invalidate the analyze_workspace snapshot cache (PRD §22).
      bumpWorkspaceVersion();
      return { exit_code: exitCode, stdout, stderr };
    } catch (e) {
      bumpWorkspaceVersion(); // the run may still have written files
      return {
        error: e instanceof Error ? e.message : String(e),
        exit_code: -1,
        stdout: "",
        stderr: e instanceof Error ? e.message : String(e),
      };
    }
  },
  false,
  "exec",
);

registerTool(
  "run_terminal",
  "Run a shell command in the E2B sandbox. Supports shell operators (|, &&, ;, >). 120-second timeout, 256 KB output cap. Output streams in real time. Files in the workspace are already in the sandbox — no upload step needed.",
  {
    type: "object",
    properties: {
      command: { type: "string", description: "Command line to execute." },
      cwd: {
        type: "string",
        description: "Working directory (relative to workspace root). Defaults to root.",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const command = args.command as string;
    const cwd = (args.cwd as string) ?? "/home/user";
    if (!command || !command.trim()) {
      return { error: "No command provided" };
    }
    const sbx = await chatSandboxForCtx(ctx);
    if (!sbx) {
      return {
        error: NO_KEY_ERROR,
        exit_code: -1,
        stdout: "",
        stderr: "E2B Sandbox API key not configured",
      };
    }

    try {
      const client = sbx.client;
      const onOutput = ctx.onToolOutput;

      // ENV INJECTION (PRD §14): pass the user's env-var VALUES so `$VAR`
      // references in the command resolve to real values (previously the
      // NAME string was what the model echoed, since nothing injected it).
      const envs =
        ctx.envVars && Object.keys(ctx.envVars).length > 0 ? ctx.envVars : undefined;

      let stdout = "";
      let stderr = "";
      let exitCode = 0;

      for await (const chunk of client.runCommandStream(command, { cwd, timeout: 120, envs })) {
        if (chunk.type === "stdout" && chunk.data) {
          stdout += chunk.data;
          if (onOutput) onOutput("", chunk.data, "stdout");
        } else if (chunk.type === "stderr" && chunk.data) {
          stderr += chunk.data;
          if (onOutput) onOutput("", chunk.data, "stderr");
        } else if (chunk.type === "prompt" && chunk.prompt) {
          // Interactive prompt detected (e.g. "Ok to proceed? (y)").
          // Emit as a tool_output with type "prompt" so the UI can show
          // an input field. The response is sent via sendStdin.
          if (onOutput) onOutput("", chunk.prompt, "prompt" as "stdout");
        } else if (chunk.type === "result") {
          exitCode = chunk.exit_code ?? 0;
        }
      }

      // Cap output at 256 KB
      if (stdout.length > 256 * 1024) stdout = stdout.slice(0, 256 * 1024) + "\n... (truncated)";
      if (stderr.length > 256 * 1024) stderr = stderr.slice(0, 256 * 1024) + "\n... (truncated)";

      // No reverse sync — files created/modified by the command are
      // already in the sandbox (the single source of truth).
      // The command MAY have written files (attribution is impossible), so
      // invalidate the analyze_workspace snapshot cache (PRD §22).
      bumpWorkspaceVersion();
      return { exit_code: exitCode, stdout, stderr };
    } catch (e) {
      bumpWorkspaceVersion(); // the command may still have written files
      return {
        error: e instanceof Error ? e.message : String(e),
        exit_code: -1,
        stdout: "",
        stderr: e instanceof Error ? e.message : String(e),
      };
    }
  },
  false,
  "exec",
);

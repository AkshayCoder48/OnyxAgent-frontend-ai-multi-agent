"use client";

import { registerTool } from "./registry";
import { getHopxClient } from "@/lib/hopx/client";

// E2B Python sandbox — modules available in the code-interpreter template.
const PYTHON_NOTE =
  "The sandbox has a 60-second timeout. Returns stdout, stderr, and the exit code.";

registerTool(
  "run_python",
  `Run Python 3 source code in a sandboxed E2B environment. ${PYTHON_NOTE} Output streams in real time.`,
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
    const apiKey = ctx.hopxApiKey ?? ctx.sandboxApiKey;
    if (!apiKey) {
      return {
        error:
          "Python execution requires an E2B Sandbox API key. Add one in Settings → Config → E2B Sandbox.",
        exit_code: -1,
        stdout: "",
        stderr: "E2B Sandbox API key not configured",
      };
    }

    try {
      const client = getHopxClient(apiKey, ctx.conversationId, ctx.sandboxMode ?? "shared");
      const onOutput = ctx.onToolOutput;

      // runPythonStream is an async generator. Iterate it and pipe chunks.
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

      return { exit_code: exitCode, stdout, stderr };
    } catch (e) {
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
  "Run a shell command in the E2B sandbox. Supports shell operators (|, &&, ;, >). 120-second timeout, 256 KB output cap. Output streams in real time.",
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
    const apiKey = ctx.hopxApiKey ?? ctx.sandboxApiKey;
    if (!apiKey) {
      return {
        error:
          "Terminal execution requires an E2B Sandbox API key. Add one in Settings → Config → E2B Sandbox.",
        exit_code: -1,
        stdout: "",
        stderr: "E2B Sandbox API key not configured",
      };
    }

    try {
      const client = getHopxClient(apiKey, ctx.conversationId, ctx.sandboxMode ?? "shared");
      const onOutput = ctx.onToolOutput;

      let stdout = "";
      let stderr = "";
      let exitCode = 0;

      for await (const chunk of client.runCommandStream(command, { cwd, timeout: 120 })) {
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

      // Cap output at 256 KB
      if (stdout.length > 256 * 1024) stdout = stdout.slice(0, 256 * 1024) + "\n... (truncated)";
      if (stderr.length > 256 * 1024) stderr = stderr.slice(0, 256 * 1024) + "\n... (truncated)";

      return { exit_code: exitCode, stdout, stderr };
    } catch (e) {
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

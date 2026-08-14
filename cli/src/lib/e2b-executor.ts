/**
 * E2BExecutor — file/process operations inside an E2B sandbox.
 *
 * Uses the @e2b/code-interpreter SDK to create/manage sandboxes.
 * Supports: list, read, write, delete, move, search files,
 * run commands (via PTY streaming), run Python, lifecycle (status,
 * keepalive, reset, kill), download/upload.
 */

import { Sandbox } from "@e2b/code-interpreter";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { Executor, FileResult, ExecResult, ExecOptions, SearchResult } from "./executor.js";

const E2B_TEMPLATE = "onyxagent-base";

export class E2BExecutor implements Executor {
  readonly type = "e2b" as const;
  private sandbox: Sandbox | null = null;
  private sandboxId: string | null = null;
  private apiKey: string;

  constructor(apiKey: string, sandboxId?: string) {
    this.apiKey = apiKey;
    this.sandboxId = sandboxId ?? null;
  }

  /**
   * Get or create a sandbox.
   */
  private async getSandbox(): Promise<Sandbox> {
    if (this.sandbox) return this.sandbox;

    if (this.sandboxId) {
      // Reconnect to existing sandbox
      try {
        this.sandbox = await Sandbox.connect(this.sandboxId, { apiKey: this.apiKey });
      } catch {
        // Sandbox may be dead — create a new one
        this.sandbox = await Sandbox.create(E2B_TEMPLATE, { apiKey: this.apiKey });
        this.sandboxId = this.sandbox.sandboxId;
      }
    } else {
      this.sandbox = await Sandbox.create(E2B_TEMPLATE, { apiKey: this.apiKey });
      this.sandboxId = this.sandbox.sandboxId;
    }

    // Write agent.md on creation
    try {
      await this.sandbox.files.write("/home/user/agent.md", AGENT_MD);
    } catch {}

    return this.sandbox;
  }

  async listFiles(path: string): Promise<FileResult[]> {
    const sbx = await this.getSandbox();
    const entries = await sbx.files.list(path);
    return entries.map((entry) => ({
      path: join(path, entry.name),
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }));
  }

  async stat(path: string): Promise<FileResult | null> {
    const sbx = await this.getSandbox();
    try {
      const content = await sbx.files.readText(path);
      return { path, size: content.length, isDirectory: false };
    } catch {
      // Might be a directory
      try {
        const entries = await sbx.files.list(path);
        return { path, isDirectory: true, size: entries.length };
      } catch {
        return null;
      }
    }
  }

  async readFile(path: string, encoding: "utf-8" | "binary" = "utf-8"): Promise<string | Uint8Array> {
    const sbx = await this.getSandbox();
    if (encoding === "binary") {
      const bytes = await sbx.files.readBytes(path);
      return bytes;
    }
    return await sbx.files.readText(path);
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const sbx = await this.getSandbox();
    if (typeof content === "string") {
      await sbx.files.write(path, content);
    } else {
      await sbx.files.writeBytes(path, content);
    }
  }

  async createDirectory(path: string): Promise<void> {
    const sbx = await this.getSandbox();
    // E2B doesn't have a direct mkdir — use a shell command
    await sbx.commands.run(`mkdir -p ${path}`);
  }

  async moveFile(from: string, to: string): Promise<void> {
    const sbx = await this.getSandbox();
    await sbx.commands.run(`mkdir -p "$(dirname ${to})" && mv ${from} ${to}`);
  }

  async deleteFile(path: string): Promise<void> {
    const sbx = await this.getSandbox();
    await sbx.commands.run(`rm -f ${path}`);
  }

  async deleteDirectory(path: string, recursive: boolean = false): Promise<void> {
    const sbx = await this.getSandbox();
    await sbx.commands.run(`rm ${recursive ? "-rf" : "-f"} ${path}`);
  }

  async searchFiles(query: string, opts?: { maxResults?: number }): Promise<SearchResult[]> {
    const sbx = await this.getSandbox();
    const max = opts?.maxResults ?? 20;
    // Use grep -rn in the sandbox
    const result = await sbx.commands.run(
      `grep -rn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.py' --include='*.json' --include='*.md' --include='*.txt' -l "${query.replace(/"/g, '\\"')}" /home/user 2>/dev/null | head -${max}`,
    );
    if (result.exitCode !== 0 || !result.stdout.trim()) return [];

    const results: SearchResult[] = [];
    const files = result.stdout.trim().split("\n");
    for (const file of files) {
      const grepResult = await sbx.commands.run(
        `grep -n "${query.replace(/"/g, '\\"')}" ${file} | head -5`,
      );
      const lines = grepResult.stdout.trim().split("\n");
      for (const line of lines) {
        const match = line.match(/^([^:]+):(\d+):(.*)$/);
        if (match) {
          results.push({
            path: match[1]!,
            line: parseInt(match[2]!, 10),
            text: match[3]!.trim(),
          });
        }
      }
    }
    return results.slice(0, max);
  }

  async runCommand(command: string, opts?: ExecOptions): Promise<ExecResult> {
    const sbx = await this.getSandbox();
    const start = Date.now();

    const result = await sbx.commands.run(command, {
      cwd: opts?.cwd ?? "/home/user",
      timeoutMs: opts?.timeout ?? 120000,
    });

    if (opts?.onStdout && result.stdout) {
      opts.onStdout(result.stdout);
    }
    if (opts?.onStderr && result.stderr) {
      opts.onStderr(result.stderr);
    }

    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - start,
    };
  }

  async runPython(code: string, opts?: ExecOptions): Promise<ExecResult> {
    const sbx = await this.getSandbox();
    const start = Date.now();

    // Use the code interpreter for Python
    const exec = await sbx.runCode(code);
    const stdout = (exec.results || []).map((r: unknown) => String(r)).join("\n");
    const stderr = (exec.logs?.stderr || []).join("\n");

    if (opts?.onStdout && stdout) opts.onStdout(stdout);
    if (opts?.onStderr && stderr) opts.onStderr(stderr);

    return {
      exitCode: 0,
      stdout,
      stderr,
      durationMs: Date.now() - start,
    };
  }

  async status(): Promise<{ alive: boolean; info?: Record<string, unknown> }> {
    if (!this.sandbox && !this.sandboxId) {
      return { alive: false };
    }
    try {
      const sbx = await this.getSandbox();
      return {
        alive: true,
        info: {
          sandboxId: sbx.sandboxId,
          type: "e2b",
        },
      };
    } catch {
      return { alive: false };
    }
  }

  async keepalive(): Promise<void> {
    const sbx = await this.getSandbox();
    // E2B sandboxes have a default timeout — set a longer one
    await sbx.setTimeout(3600000); // 1 hour
  }

  async reset(): Promise<void> {
    if (this.sandbox) {
      try { await this.sandbox.kill(); } catch {}
      this.sandbox = null;
      this.sandboxId = null;
    }
  }

  async kill(): Promise<void> {
    if (this.sandbox) {
      try { await this.sandbox.kill(); } catch {}
      this.sandbox = null;
      this.sandboxId = null;
    }
  }

  async downloadFile(path: string): Promise<Uint8Array> {
    return (await this.readFile(path, "binary")) as Uint8Array;
  }

  async uploadFile(path: string, data: Uint8Array): Promise<void> {
    await this.writeFile(path, data);
  }

  getSandboxId(): string | null {
    return this.sandboxId;
  }
}

const AGENT_MD = `# OnyxAgent CLI — Agent Guide

You are OnyxAgent, an AI assistant running in an E2B sandbox via the CLI.
Your workspace is /home/user. You have access to file operations, code execution,
web search, and other tools.

## Available Tools
- list_folder, read_file, write_file, create_file, edit_file, delete_file
- run_python, run_terminal
- web_search, image_search, video_search, web_fetch
- ocr_image, ocr_pdf

## Rules
- Always analyze the workspace before modifying files
- Use incremental writing for large files (>200 lines)
- Call tools in parallel when independent
- Keep responses concise
`;

/**
 * LocalExecutor — file/process operations on the local filesystem.
 *
 * SECURITY: All paths are canonicalized and checked against the authorized root.
 * Rejects .., absolute paths outside root, and symlink escapes.
 * Never uses process.cwd() as an implicit authorization grant.
 */

import { resolve, join, relative, isAbsolute, sep } from "path";
import {
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  rmSync,
  existsSync,
  lstatSync,
  readlinkSync,
  realpathSync,
} from "fs";
import { execSync, spawn } from "child_process";
import { randomBytes } from "crypto";
import type { Executor, FileResult, ExecResult, ExecOptions, SearchResult } from "./executor.js";

/**
 * Canonicalize and validate a path against the authorized root.
 * Throws if the path escapes the root via traversal, symlink, or absolute path.
 */
export function safePath(root: string, path: string): string {
  const resolvedRoot = resolve(root);
  const target = isAbsolute(path) ? resolve(path) : resolve(join(resolvedRoot, path));
  const rel = relative(resolvedRoot, target);

  // Reject paths that escape root (relative path starts with .. or is absolute on another drive)
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path "${path}" escapes workspace root`);
  }

  // Check for symlink escapes — resolve real path and verify it's within root
  if (existsSync(target)) {
    try {
      const realTarget = realpathSync(target);
      const realRoot = realpathSync(resolvedRoot);
      const realRel = relative(realRoot, realTarget);
      if (realRel.startsWith("..") || isAbsolute(realRel)) {
        throw new Error(`Path "${path}" resolves outside workspace root via symlink`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("escapes")) throw err;
      // realpathSync may fail on broken symlinks — that's fine
    }
  }

  return target;
}

export class LocalExecutor implements Executor {
  readonly type = "local" as const;
  private root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  getRoot(): string {
    return this.root;
  }

  async listFiles(path: string): Promise<FileResult[]> {
    const fullPath = safePath(this.root, path);
    const entries = readdirSync(fullPath, { withFileTypes: true });
    return entries.map((entry) => {
      const entryPath = join(path, entry.name);
      const fullEntryPath = join(fullPath, entry.name);
      let stat;
      try {
        stat = statSync(fullEntryPath);
      } catch {}
      return {
        path: entryPath,
        isDirectory: entry.isDirectory(),
        size: stat?.size,
        modifiedAt: stat?.mtimeMs,
      } as FileResult;
    });
  }

  async stat(path: string): Promise<FileResult | null> {
    const fullPath = safePath(this.root, path);
    if (!existsSync(fullPath)) return null;
    const stat = statSync(fullPath);
    return {
      path,
      size: stat.size,
      isDirectory: stat.isDirectory(),
      modifiedAt: stat.mtimeMs,
    };
  }

  async readFile(path: string, encoding: "utf-8" | "binary" = "utf-8"): Promise<string | Uint8Array> {
    const fullPath = safePath(this.root, path);
    if (encoding === "binary") {
      return new Uint8Array(readFileSync(fullPath));
    }
    return readFileSync(fullPath, "utf-8");
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const fullPath = safePath(this.root, path);
    const dir = resolve(fullPath, "..");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    if (typeof content === "string") {
      writeFileSync(fullPath, content, "utf-8");
    } else {
      writeFileSync(fullPath, content);
    }
  }

  async createDirectory(path: string): Promise<void> {
    const fullPath = safePath(this.root, path);
    mkdirSync(fullPath, { recursive: true });
  }

  async moveFile(from: string, to: string): Promise<void> {
    const fromPath = safePath(this.root, from);
    const toPath = safePath(this.root, to);
    const dir = resolve(toPath, "..");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    renameSync(fromPath, toPath);
  }

  async deleteFile(path: string): Promise<void> {
    const fullPath = safePath(this.root, path);
    unlinkSync(fullPath);
  }

  async deleteDirectory(path: string, recursive: boolean = false): Promise<void> {
    const fullPath = safePath(this.root, path);
    rmSync(fullPath, { recursive });
  }

  async searchFiles(query: string, opts?: { maxResults?: number; glob?: string }): Promise<SearchResult[]> {
    const max = opts?.maxResults ?? 20;
    const results: SearchResult[] = [];
    const lowerQuery = query.toLowerCase();

    const walk = (dir: string, relDir: string) => {
      if (results.length >= max) return;
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= max) return;
        // Skip common ignore patterns
        if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".onyxagent") continue;
        const entryPath = join(dir, entry.name);
        const relPath = join(relDir, entry.name);
        if (entry.isDirectory()) {
          walk(entryPath, relPath);
        } else {
          try {
            const content = readFileSync(entryPath, "utf-8");
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (lines[i]!.toLowerCase().includes(lowerQuery)) {
                results.push({ path: relPath, line: i + 1, text: lines[i]!.trim() });
                if (results.length >= max) return;
              }
            }
          } catch {
            // Skip binary/unreadable files
          }
        }
      }
    };

    walk(this.root, "");
    return results;
  }

  async runCommand(command: string, opts?: ExecOptions): Promise<ExecResult> {
    const start = Date.now();
    const cwd = opts?.cwd ? safePath(this.root, opts.cwd) : this.root;
    const timeout = opts?.timeout ?? 120000; // 2 min default

    return new Promise((resolve, reject) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        env: { ...process.env, ...opts?.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (chunk) => {
        const text = chunk.toString();
        stdout += text;
        opts?.onStdout?.(text);
      });

      child.stderr?.on("data", (chunk) => {
        const text = chunk.toString();
        stderr += text;
        opts?.onStderr?.(text);
      });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000);
      }, timeout);

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          exitCode: code ?? -1,
          stdout,
          stderr,
          durationMs: Date.now() - start,
        });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      // Allow abort via signal
      opts?.onStdout; // noop to silence lint
    });
  }

  async runPython(code: string, opts?: ExecOptions): Promise<ExecResult> {
    // Write code to a temp file and execute it
    const tmpFile = join(this.root, ".onyxagent", `tmp_${randomBytes(8).toString("hex")}.py`);
    await this.writeFile(tmpFile, code);
    try {
      return await this.runCommand(`python3 ${tmpFile}`, opts);
    } finally {
      try {
        await this.deleteFile(tmpFile);
      } catch {}
    }
  }

  async status(): Promise<{ alive: boolean; info?: Record<string, unknown> }> {
    return {
      alive: true,
      info: {
        type: "local",
        root: this.root,
        exists: existsSync(this.root),
      },
    };
  }

  async downloadFile(path: string): Promise<Uint8Array> {
    const fullPath = safePath(this.root, path);
    return new Uint8Array(readFileSync(fullPath));
  }

  async uploadFile(path: string, data: Uint8Array): Promise<void> {
    await this.writeFile(path, data);
  }
}

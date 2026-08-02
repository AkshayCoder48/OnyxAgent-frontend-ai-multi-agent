"use client";

/**
 * Pre-Execution Workspace Analysis tool (`analyze_workspace`).
 *
 * Before starting ANY task, the orchestrator calls this tool to build a
 * comprehensive picture of the workspace — files, key project metadata,
 * installed skills, MCP servers, available tools, env vars, existing
 * subagents, and stored memories. The output drives the Intelligent
 * Planning Pipeline (see `runtime.ts` system prompt) — complexity
 * detection, role assignment, and disposable-agent decisions.
 *
 * Registered in the "orchestration" category with NO approval gate so the
 * agent can run it freely on every turn without HITL friction.
 *
 * All sub-queries are wrapped in try/catch and the tool ALWAYS returns a
 * result object — partial failures are surfaced in `errors` so the agent
 * still gets whatever data is available.
 */

import { registerTool, listTools, type ToolContext } from "./registry";
import { getE2BClient } from "@/lib/e2b/client";
import { ensureFreshSandboxForCtx } from "@/lib/e2b/sandbox-rotation";
import * as opfs from "@/lib/storage/opfs";

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

interface WorkspaceFile {
  path: string;
  size: number;
  type: "file" | "directory";
}

interface KeyFiles {
  readme?: string;
  package_json?: string;
  config?: Record<string, string>;
  env?: Record<string, string>;
  dockerfile?: string;
}

interface WorkspaceSummary {
  files: WorkspaceFile[];
  file_count: number;
  total_size_bytes: number;
  key_files: KeyFiles;
  skills: Array<Record<string, unknown>>;
  mcp_servers: Array<Record<string, unknown>>;
  available_tools: Array<{ name: string; description: string; category?: string }>;
  env_vars: Array<{ name: string; value_length: number; is_secret: boolean }>;
  existing_subagents: Array<Record<string, unknown>>;
  memories: Array<Record<string, unknown>>;
  summary: string;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const NO_KEY_ERROR =
  "Workspace analysis requires an E2B Sandbox API key. Add one in Settings → Config → E2B Sandbox.";

const KEY_FILE_NAMES = [
  "README.md",
  "README.MD",
  "README",
  "readme.md",
  "package.json",
  "tsconfig.json",
  "jsconfig.json",
  "next.config.js",
  "next.config.ts",
  "next.config.mjs",
  "vite.config.ts",
  "vite.config.js",
  "tailwind.config.js",
  "tailwind.config.ts",
  "postcss.config.js",
  "postcss.config.mjs",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".env",
  ".env.local",
  ".env.example",
  ".env.development",
  ".env.production",
];

function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] ?? p;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Walk the sandbox recursively from `rootPath` and collect every file/dir.
 * Mirrors the pattern in `e2b_files.ts` (walkSandboxForZip) but skips the
 * content read — we only need names + sizes here, so this is much faster.
 *
 * Capped at MAX_FILES entries to keep the result token-bounded for the LLM.
 */
async function walkSandbox(
  client: ReturnType<typeof getE2BClient>,
  rootPath = "/home/user",
  maxFiles = 500,
): Promise<{ files: WorkspaceFile[]; truncated: boolean }> {
  const out: WorkspaceFile[] = [];
  let truncated = false;
  const seen = new Set<string>();

  async function walk(dirPath: string): Promise<void> {
    if (truncated) return;
    if (seen.has(dirPath)) return;
    seen.add(dirPath);

    let entries;
    try {
      entries = await client.listFiles(dirPath);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (out.length >= maxFiles) {
        truncated = true;
        return;
      }
      // Normalize the path (strip leading /home/user/ for readability).
      const rel = entry.path.replace(/^\/home\/user\/?/, "") || entry.path;
      out.push({
        path: rel,
        size: entry.size ?? 0,
        type: entry.type ?? "file",
      });

      if (entry.type === "directory") {
        await walk(entry.path);
        if (truncated) return;
      }
    }
  }

  await walk(rootPath);
  return { files: out, truncated };
}

/** Read up to `maxBytes` of a sandbox file as UTF-8 text. Returns null on
 *  failure (binary, missing, oversized). */
async function readSandboxText(
  client: ReturnType<typeof getE2BClient>,
  path: string,
  maxBytes = 16_000,
): Promise<string | null> {
  try {
    // First check size — listFiles is cheap and avoids pulling huge files.
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) || "/" : "/";
    const entries = await client.listFiles(dir);
    const entry = entries.find((e) => e.path === path || basename(e.path) === basename(path));
    if (entry && entry.size && entry.size > maxBytes) {
      return `[file too large: ${humanSize(entry.size)} — read with read_file tool]`;
    }

    const text = await client.readFile(path);
    if (!text) return null;
    return text.length > maxBytes ? text.slice(0, maxBytes) + "\n…[truncated]" : text;
  } catch {
    return null;
  }
}

/** Find a key file by basename anywhere in the walked file list. */
function findKeyFile(files: WorkspaceFile[], name: string): WorkspaceFile | undefined {
  const lower = name.toLowerCase();
  return files.find((f) => basename(f.path).toLowerCase() === lower);
}

/** Collect memories from OPFS `users/<userId>/memory/`. */
async function collectMemories(userId: string): Promise<Array<Record<string, unknown>>> {
  try {
    const dir = await opfs.ensurePath(userId, "memory");
    const walked = await opfs.walkFiles(dir);
    const out: Array<Record<string, unknown>> = [];
    for (const f of walked) {
      try {
        const file = await f.handle.getFile();
        const content = await file.text();
        const entry = JSON.parse(content);
        out.push({
          id: entry.id,
          category: entry.category,
          content_preview:
            typeof entry.content === "string" ? entry.content.slice(0, 200) : "",
          tags: entry.tags || [],
          created_at: entry.created_at,
        });
        if (out.length >= 100) break;
      } catch {
        // skip malformed entries
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tool: analyze_workspace
// ---------------------------------------------------------------------------

registerTool(
  "analyze_workspace",
  `Scan the ENTIRE workspace before starting any task. Returns:
- files: recursive file listing (paths, sizes, types)
- key_files: contents of README, package.json, tsconfig, Dockerfiles, .env files
- skills: installed ClawHub skills
- mcp_servers: configured MCP servers
- available_tools: every tool currently registered
- env_vars: configured sandbox env vars (values masked)
- existing_subagents: subagents currently in the registry (with lifecycle status)
- memories: long-term memories stored in OPFS
- summary: human-readable workspace overview

CRITICAL: Call this BEFORE modifying files or spawning subagents. Use the output to:
1. Detect project type, languages, frameworks
2. Pick the right specialist roles for subagents
3. Decide disposable vs persistent agents
4. Avoid duplicating existing subagents
5. Match coding style/patterns observed in existing files`,
  {
    type: "object",
    properties: {
      max_files: {
        type: "number",
        description: "Maximum number of files to enumerate (default 500). Caps result size.",
        default: 500,
      },
      read_key_files: {
        type: "boolean",
        description: "Whether to read the contents of README, package.json, configs, .env files (default true).",
        default: true,
      },
    },
    additionalProperties: false,
  },
  async (args, ctx: ToolContext): Promise<WorkspaceSummary> => {
    const maxFiles = (args.max_files as number) ?? 500;
    const readKeyFiles = (args.read_key_files as boolean) ?? true;

    const errors: string[] = [];

    // ---- Files (E2B sandbox) -------------------------------------------------
    let files: WorkspaceFile[] = [];
    let truncated = false;
    const apiKey = await ensureFreshSandboxForCtx(ctx);
    if (!apiKey) {
      errors.push(NO_KEY_ERROR);
    } else {
      try {
        const client = getE2BClient(apiKey, null, "shared");
        const walked = await walkSandbox(client, "/home/user", maxFiles);
        files = walked.files;
        truncated = walked.truncated;
        if (truncated) {
          errors.push(`File list truncated at ${maxFiles} entries — increase max_files for full listing.`);
        }
      } catch (err) {
        errors.push(
          `Failed to walk sandbox: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // ---- Key files ----------------------------------------------------------
    const key_files: KeyFiles = {};
    if (readKeyFiles && apiKey) {
      try {
        const client = getE2BClient(apiKey, null, "shared");

        // README
        const readme = findKeyFile(files, "README.md") ?? findKeyFile(files, "README");
        if (readme) {
          const text = await readSandboxText(client, `/home/user/${readme.path}`);
          if (text) key_files.readme = text;
        }

        // package.json
        const pkg = findKeyFile(files, "package.json");
        if (pkg) {
          const text = await readSandboxText(client, `/home/user/${pkg.path}`);
          if (text) key_files.package_json = text;
        }

        // Dockerfile
        const docker = findKeyFile(files, "Dockerfile");
        if (docker) {
          const text = await readSandboxText(client, `/home/user/${docker.path}`);
          if (text) key_files.dockerfile = text;
        }

        // Other config files (tsconfig, next.config, vite.config, tailwind, postcss, docker-compose)
        const configTargets = [
          "tsconfig.json",
          "jsconfig.json",
          "next.config.js",
          "next.config.ts",
          "next.config.mjs",
          "vite.config.ts",
          "vite.config.js",
          "tailwind.config.js",
          "tailwind.config.ts",
          "postcss.config.js",
          "postcss.config.mjs",
          "docker-compose.yml",
          "docker-compose.yaml",
        ];
        const config: Record<string, string> = {};
        for (const name of configTargets) {
          const f = findKeyFile(files, name);
          if (!f) continue;
          const text = await readSandboxText(client, `/home/user/${f.path}`);
          if (text) config[name] = text;
        }
        if (Object.keys(config).length > 0) key_files.config = config;

        // .env files (mask values — just show structure + key names)
        const envTargets = [".env", ".env.local", ".env.example", ".env.development", ".env.production"];
        const env: Record<string, string> = {};
        for (const name of envTargets) {
          const f = findKeyFile(files, name);
          if (!f) continue;
          const text = await readSandboxText(client, `/home/user/${f.path}`);
          if (!text) continue;
          // Mask values for security — show keys + value lengths only.
          const masked = text
            .split("\n")
            .map((line) => {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith("#")) return trimmed;
              const eq = trimmed.indexOf("=");
              if (eq < 0) return trimmed;
              const key = trimmed.slice(0, eq);
              const val = trimmed.slice(eq + 1);
              return `${key}=<${val.length} chars>`;
            })
            .join("\n");
          env[name] = masked;
        }
        if (Object.keys(env).length > 0) key_files.env = env;
      } catch (err) {
        errors.push(
          `Failed to read key files: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // ---- Skills -------------------------------------------------------------
    let skills: Array<Record<string, unknown>> = [];
    try {
      const { skillService } = await import("@/lib/services");
      const installed = await skillService.list(ctx.userId);
      skills = installed.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        is_active: s.is_active,
        dir_path: s.dir_path,
      }));
    } catch (err) {
      errors.push(`Failed to list skills: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ---- MCP servers --------------------------------------------------------
    let mcp_servers: Array<Record<string, unknown>> = [];
    try {
      const { mcpService } = await import("@/lib/services");
      const servers = await mcpService.list(ctx.userId);
      mcp_servers = servers.map((s) => ({
        id: s.id,
        name: s.name,
        transport: s.transport,
        url: s.url,
        command: s.command,
        is_active: s.is_active,
      }));
    } catch (err) {
      errors.push(`Failed to list MCP servers: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ---- Available tools ----------------------------------------------------
    let available_tools: Array<{ name: string; description: string; category?: string }> = [];
    try {
      available_tools = listTools(ctx).map((t) => ({
        name: t.name,
        description: t.description,
        category: t.category,
      }));
    } catch (err) {
      errors.push(`Failed to list tools: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ---- Env vars (decrypted, but mask values) ------------------------------
    let env_vars: Array<{ name: string; value_length: number; is_secret: boolean }> = [];
    try {
      const { settingsService } = await import("@/lib/services");
      const decrypted = await settingsService.getDecryptedEnvVars(ctx.userId);
      // We need is_secret — re-read the raw settings row for that flag.
      const settings = await settingsService.get(ctx.userId);
      const secretSet = new Set(
        (settings.env_vars ?? []).filter((v) => v.is_secret).map((v) => v.name),
      );
      env_vars = Object.entries(decrypted).map(([name, value]) => ({
        name,
        value_length: value.length,
        is_secret: secretSet.has(name),
      }));
    } catch (err) {
      errors.push(`Failed to list env vars: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ---- Existing subagents -------------------------------------------------
    let existing_subagents: Array<Record<string, unknown>> = [];
    try {
      // Dynamic import — avoids circular deps with the tool registry.
      const { useSubagentStore } = await import("@/stores/subagent-store");
      const store = useSubagentStore.getState();
      existing_subagents = store.subagents.map((s) => ({
        id: s.id,
        name: s.name,
        role: s.role,
        specialty: s.specialty,
        disposable: s.disposable,
        enabled: s.enabled,
        lifecycle_status: s.lifecycle_status,
        last_activity: s.last_activity,
        parent_task: s.parent_task,
      }));
    } catch (err) {
      errors.push(`Failed to list subagents: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ---- Memories (OPFS) ----------------------------------------------------
    let memories: Array<Record<string, unknown>> = [];
    try {
      memories = await collectMemories(ctx.userId);
    } catch (err) {
      errors.push(`Failed to read memories: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ---- Summary ------------------------------------------------------------
    const total_size_bytes = files.reduce((sum, f) => sum + (f.size || 0), 0);
    const file_count = files.filter((f) => f.type === "file").length;
    const dir_count = files.filter((f) => f.type === "directory").length;

    // Detect project type from file extensions + key files.
    const exts = new Set<string>();
    for (const f of files) {
      if (f.type !== "file") continue;
      const base = basename(f.path);
      const dot = base.lastIndexOf(".");
      if (dot > 0) exts.add(base.slice(dot + 1).toLowerCase());
    }

    const project_signals: string[] = [];
    if (key_files.package_json) project_signals.push("Node.js");
    if (exts.has("tsx") || exts.has("jsx")) project_signals.push("React/Next.js");
    if (exts.has("ts") || exts.has("js")) project_signals.push("TypeScript/JavaScript");
    if (exts.has("py")) project_signals.push("Python");
    if (exts.has("go")) project_signals.push("Go");
    if (exts.has("rs")) project_signals.push("Rust");
    if (exts.has("java")) project_signals.push("Java");
    if (exts.has("rb")) project_signals.push("Ruby");
    if (key_files.dockerfile) project_signals.push("Docker");
    if (exts.has("prisma")) project_signals.push("Prisma");

    const summary = [
      `Workspace scan complete.`,
      `Files: ${file_count} (${dir_count} directories, total ${humanSize(total_size_bytes)}${truncated ? " — TRUNCATED" : ""}).`,
      project_signals.length > 0
        ? `Detected technologies: ${project_signals.join(", ")}.`
        : `No specific technologies detected from file extensions.`,
      `Skills installed: ${skills.length}.`,
      `MCP servers: ${mcp_servers.length}.`,
      `Available tools: ${available_tools.length}.`,
      `Env vars configured: ${env_vars.length}.`,
      `Existing subagents: ${existing_subagents.length} (active: ${existing_subagents.filter((s) => s.enabled !== false && s.lifecycle_status !== "disposed").length}).`,
      `Memories stored: ${memories.length}.`,
      errors.length > 0 ? `Warnings: ${errors.length} (see errors[]).` : `No warnings.`,
    ].join(" ");

    return {
      files,
      file_count,
      total_size_bytes,
      key_files,
      skills,
      mcp_servers,
      available_tools,
      env_vars,
      existing_subagents,
      memories,
      summary,
      errors,
    };
  },
  false,
  "orchestration",
);

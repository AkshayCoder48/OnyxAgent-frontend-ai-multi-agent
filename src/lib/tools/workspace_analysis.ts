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
 * PERF (PRD §22): all heavy lifting lives in `workspace-snapshot.ts` —
 * ONE exec round trip for the whole tree, ONE batched round trip for key
 * files, local scans in parallel, a 60s TTL cache + tree-digest reuse,
 * and NO sandbox rotation trigger. The old per-directory walk + per-file
 * reads (dozens of sequential round trips, 30–60s) are gone.
 *
 * All sub-queries are wrapped in try/catch and the tool ALWAYS returns a
 * result object — partial failures are surfaced in `errors` so the agent
 * still gets whatever data is available. The output shape is identical to
 * the legacy version plus a small `meta` block (cache/latency telemetry).
 */

import { registerTool, listTools, type ToolContext } from "./registry";
import {
  getWorkspaceSnapshot,
  type EnvVarInfo,
  type KeyFiles,
  type LocalScanResult,
  type WorkspaceFile,
} from "./workspace-snapshot";

// ---------------------------------------------------------------------------
// Types (output shape — kept EXACTLY compatible with the legacy contract).
// ---------------------------------------------------------------------------

interface WorkspaceSummary {
  files: WorkspaceFile[];
  file_count: number;
  total_size_bytes: number;
  key_files: KeyFiles;
  skills: Array<Record<string, unknown>>;
  mcp_servers: Array<Record<string, unknown>>;
  available_tools: Array<{ name: string; description: string; category?: string }>;
  env_vars: EnvVarInfo[];
  existing_subagents: Array<Record<string, unknown>>;
  memories: Array<Record<string, unknown>>;
  summary: string;
  errors: string[];
  /** Superset telemetry — never consumed by logic, safe to ignore. */
  meta?: { cached: boolean; scan_ms: number; tree_digest: string };
}

const EMPTY_LOCAL: LocalScanResult = {
  skills: [],
  mcp_servers: [],
  env_vars: [],
  existing_subagents: [],
  memories: [],
  errors: [],
};

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

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
    const startedAt = Date.now();
    const maxFiles = Math.max(1, Math.floor((args.max_files as number) ?? 500));
    const readKeyFiles = (args.read_key_files as boolean) ?? true;

    // ── Snapshot: cached fast path or 1–2 round trips (see workspace-snapshot) ──
    const snap = await getWorkspaceSnapshot(ctx, { readKeyFiles });

    const errors: string[] = [...snap.errors];

    // Slice the cached full tree down to the per-call budget.
    const files: WorkspaceFile[] = snap.files.slice(0, maxFiles);
    const truncated = snap.treeTruncated || snap.files.length > files.length;
    if (truncated) {
      errors.push(`File list truncated at ${maxFiles} entries — increase max_files for full listing.`);
    }

    const key_files: KeyFiles = snap.keyFiles ?? {};
    const local = snap.localScan ?? EMPTY_LOCAL;
    const { skills, mcp_servers, env_vars, existing_subagents, memories } = local;

    // ---- Available tools (always fresh — an in-memory registry read) -------
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
      meta: {
        cached: snap.fromCache,
        scan_ms: Date.now() - startedAt,
        tree_digest: snap.treeDigest,
      },
    };
  },
  false,
  "orchestration",
);

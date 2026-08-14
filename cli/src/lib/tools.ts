/**
 * Tool registry — CLI-compatible tool definitions and execution.
 *
 * This module defines the tools available to the CLI agent loop.
 * Tools are executor-aware: file/code tools route through the active executor
 * (local or E2B), while web/OCR tools call external APIs directly.
 */

import type { Executor, ExecOptions } from "./executor.js";
import { loadConfig } from "./config.js";
import { getSecret } from "./vault.js";

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  category: string;
  requiresApproval?: boolean;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ToolResult {
  success: boolean;
  output: unknown;
  error?: string;
}

export interface ToolContext {
  executor: Executor;
  onToolOutput?: (toolCallId: string, output: string, type: "stdout" | "stderr") => void;
}

const tools: Map<string, ToolDef> = new Map();

export function registerTool(tool: ToolDef): void {
  tools.set(tool.name, tool);
}

export function getTool(name: string): ToolDef | undefined {
  return tools.get(name);
}

export function listAllTools(): ToolDef[] {
  return Array.from(tools.values());
}

export function getToolSchemas(): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return listAllTools().map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// --- Register built-in tools ---

// list_folder
registerTool({
  name: "list_folder",
  description: "List files and directories in a given path.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Directory path to list" } },
    required: ["path"],
  },
  category: "filesystem",
  async execute(args, ctx) {
    const path = args.path as string;
    const files = await ctx.executor.listFiles(path);
    return { success: true, output: { path, files, count: files.length } };
  },
});

// read_file
registerTool({
  name: "read_file",
  description: "Read the content of a text file.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "File path to read" } },
    required: ["path"],
  },
  category: "filesystem",
  async execute(args, ctx) {
    const path = args.path as string;
    const content = await ctx.executor.readFile(path, "utf-8");
    return { success: true, output: { path, content: content as string } };
  },
});

// write_file
registerTool({
  name: "write_file",
  description: "Write content to a file (overwrites if exists).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to write" },
      content: { type: "string", description: "File content" },
    },
    required: ["path", "content"],
  },
  category: "filesystem",
  async execute(args, ctx) {
    const { path, content } = args as { path: string; content: string };
    await ctx.executor.writeFile(path, content);
    return { success: true, output: { path, bytes: content.length } };
  },
});

// edit_file
registerTool({
  name: "edit_file",
  description: "Edit a file by finding and replacing text.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path" },
      find: { type: "string", description: "Text to find" },
      replace: { type: "string", description: "Replacement text" },
    },
    required: ["path", "find", "replace"],
  },
  category: "filesystem",
  async execute(args, ctx) {
    const { path, find, replace } = args as { path: string; find: string; replace: string };
    const content = (await ctx.executor.readFile(path, "utf-8")) as string;
    if (!content.includes(find)) {
      return { success: false, output: null, error: `Text not found in ${path}` };
    }
    const newContent = content.replace(find, replace);
    await ctx.executor.writeFile(path, newContent);
    return { success: true, output: { path, replaced: true } };
  },
});

// delete_file
registerTool({
  name: "delete_file",
  description: "Delete a file.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "File path to delete" } },
    required: ["path"],
  },
  category: "filesystem",
  requiresApproval: true,
  async execute(args, ctx) {
    await ctx.executor.deleteFile(args.path as string);
    return { success: true, output: { path: args.path, deleted: true } };
  },
});

// create_folder
registerTool({
  name: "create_folder",
  description: "Create a directory.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Directory path" } },
    required: ["path"],
  },
  category: "filesystem",
  async execute(args, ctx) {
    await ctx.executor.createDirectory(args.path as string);
    return { success: true, output: { path: args.path, created: true } };
  },
});

// run_terminal
registerTool({
  name: "run_terminal",
  description: "Execute a shell command. Returns stdout, stderr, and exit code.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      cwd: { type: "string", description: "Working directory (optional)" },
      timeout: { type: "number", description: "Timeout in ms (default: 120000)" },
    },
    required: ["command"],
  },
  category: "execution",
  requiresApproval: true,
  async execute(args, ctx) {
    const command = args.command as string;
    const opts: ExecOptions = {};
    if (args.cwd) opts.cwd = args.cwd as string;
    if (args.timeout) opts.timeout = args.timeout as number;
    const result = await ctx.executor.runCommand(command, opts);
    return {
      success: result.exitCode === 0,
      output: {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      },
    };
  },
});

// run_python
registerTool({
  name: "run_python",
  description: "Execute Python 3 code. Returns stdout, stderr, and exit code.",
  parameters: {
    type: "object",
    properties: {
      code: { type: "string", description: "Python code to execute" },
    },
    required: ["code"],
  },
  category: "execution",
  requiresApproval: true,
  async execute(args, ctx) {
    const result = await ctx.executor.runPython(args.code as string);
    return {
      success: result.exitCode === 0,
      output: {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      },
    };
  },
});

// search_files
registerTool({
  name: "search_files",
  description: "Search file contents in the workspace.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      maxResults: { type: "number", description: "Max results (default: 20)" },
    },
    required: ["query"],
  },
  category: "filesystem",
  async execute(args, ctx) {
    const results = await ctx.executor.searchFiles(args.query as string, {
      maxResults: (args.maxResults as number) ?? 20,
    });
    return { success: true, output: { results, count: results.length } };
  },
});

// web_search (uses Miklium API — no key needed)
registerTool({
  name: "web_search",
  description: "Search the web for information. Returns titles, URLs, and snippets.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      limit: { type: "number", description: "Max results (default: 10)" },
    },
    required: ["query"],
  },
  category: "search",
  async execute(args) {
    const query = args.query as string;
    const limit = (args.limit as number) ?? 10;
    try {
      const res = await fetch("https://miklium.vercel.app/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          search: [query],
          type: "default",
          maxSmallSnippets: Math.min(limit, 10),
          maxLargeSnippets: 0,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Search failed");
      // Group by URL
      const byUrl = new Map<string, { url: string; snippet: string; domain: string }>();
      for (const item of data.results || []) {
        const url = item.url;
        if (!byUrl.has(url)) {
          const domain = url?.split("/")[2]?.replace(/^www\./, "") || url;
          byUrl.set(url, { url, snippet: item.snippet || "", domain });
        }
      }
      const results = Array.from(byUrl.values()).slice(0, limit);
      return { success: true, output: { query, results, count: results.length } };
    } catch (e) {
      return { success: false, output: null, error: e instanceof Error ? e.message : String(e) };
    }
  },
});

// image_search
registerTool({
  name: "image_search",
  description: "Search for images. Returns image URLs, titles, and dimensions.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Image search query" },
      limit: { type: "number", description: "Max results (default: 10)" },
    },
    required: ["query"],
  },
  category: "search",
  async execute(args) {
    const query = args.query as string;
    const limit = (args.limit as number) ?? 10;
    try {
      const res = await fetch("https://miklium.vercel.app/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ search: [query], type: "images", maxResults: limit }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const results = (data.results || []).map((r: { imageUrl: string; title: string; size?: { width?: number; height?: number }; referenceUrl: string }) => ({
        imageUrl: r.imageUrl,
        title: r.title,
        width: r.size?.width,
        height: r.size?.height,
        source: r.referenceUrl,
      }));
      return { success: true, output: { query, results, count: results.length } };
    } catch (e) {
      return { success: false, output: null, error: e instanceof Error ? e.message : String(e) };
    }
  },
});

// video_search
registerTool({
  name: "video_search",
  description: "Search for videos. Returns video URLs, thumbnails, durations, and channel info.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Video search query" },
      limit: { type: "number", description: "Max results (default: 10)" },
    },
    required: ["query"],
  },
  category: "search",
  async execute(args) {
    const query = args.query as string;
    const limit = (args.limit as number) ?? 10;
    try {
      const res = await fetch("https://miklium.vercel.app/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ search: [query], type: "videos", maxResults: limit, includeAdditionalData: true }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const results = (data.results || []).map((r: { videoUrl: string; thumbUrl: string; title: string; description: string; duration: string; additionalData?: { channelTitle?: string; statistics?: { viewCount?: string; likeCount?: string } } }) => ({
        videoUrl: r.videoUrl,
        thumbnail: r.thumbUrl,
        title: r.title,
        description: r.description,
        duration: r.duration,
        channel: r.additionalData?.channelTitle,
        views: r.additionalData?.statistics?.viewCount,
        likes: r.additionalData?.statistics?.likeCount,
      }));
      return { success: true, output: { query, results, count: results.length } };
    } catch (e) {
      return { success: false, output: null, error: e instanceof Error ? e.message : String(e) };
    }
  },
});

// web_fetch
registerTool({
  name: "web_fetch",
  description: "Read the full content of a web page URL.",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "URL to fetch" } },
    required: ["url"],
  },
  category: "search",
  async execute(args) {
    const url = args.url as string;
    try {
      const res = await fetch(url, { headers: { "User-Agent": "OnyxAgent-CLI/1.0" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      // Basic HTML to text conversion
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 10000); // Cap at 10K chars
      return { success: true, output: { url, text, length: text.length } };
    } catch (e) {
      return { success: false, output: null, error: e instanceof Error ? e.message : String(e) };
    }
  },
});

// ocr_image
registerTool({
  name: "ocr_image",
  description: "Extract text from an image using OCR.",
  parameters: {
    type: "object",
    properties: {
      image_url: { type: "string", description: "URL of the image" },
      image_base64: { type: "string", description: "Base64 data URI" },
    },
  },
  category: "ocr",
  async execute(args) {
    const imageUrl = args.image_url as string | undefined;
    const imageBase64 = args.image_base64 as string | undefined;
    if (!imageUrl && !imageBase64) {
      return { success: false, output: null, error: "Provide image_url or image_base64" };
    }
    try {
      let res: Response;
      if (imageUrl) {
        res = await fetch("https://freeocr.ai/api/v1/ocr", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image_url: imageUrl }),
        });
      } else {
        const base64Match = imageBase64!.match(/^data:([^;]+);base64,(.+)$/);
        if (!base64Match) throw new Error("Invalid base64 data URI");
        const mimeType = base64Match[1]!;
        const base64 = base64Match[2]!;
        const binary = Buffer.from(base64, "base64");
        const blob = new Blob([binary], { type: mimeType });
        const formData = new FormData();
        formData.append("image", blob);
        res = await fetch("https://freeocr.ai/api/v1/ocr", {
          method: "POST",
          body: formData,
        });
      }
      if (!res.ok) throw new Error(`OCR HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      return { success: true, output: { text: data.text || "", charCount: (data.text || "").length } };
    } catch (e) {
      return { success: false, output: null, error: e instanceof Error ? e.message : String(e) };
    }
  },
});

// analyze_workspace
registerTool({
  name: "analyze_workspace",
  description: "Analyze the workspace structure, technologies, and key files.",
  parameters: {
    type: "object",
    properties: {},
  },
  category: "workspace",
  async execute(_args, ctx) {
    const root = ctx.executor.type === "local"
      ? (ctx.executor as unknown as { getRoot(): string }).getRoot()
      : "/home/user";
    const files = await ctx.executor.listFiles(".");
    const fileTypes = new Set<string>();
    let hasPackageJson = false;
    let hasPyproject = false;
    let hasGit = false;
    for (const f of files) {
      if (f.path === "package.json") hasPackageJson = true;
      if (f.path === "pyproject.toml" || f.path === "setup.py") hasPyproject = true;
      if (f.path === ".git") hasGit = true;
      const ext = f.path.split(".").pop();
      if (ext) fileTypes.add(ext);
    }
    return {
      success: true,
      output: {
        root,
        files: files.map((f) => f.path),
        fileCount: files.length,
        technologies: Array.from(fileTypes),
        hasPackageJson,
        hasPyproject,
        hasGit,
      },
    };
  },
});

// current_datetime
registerTool({
  name: "current_datetime",
  description: "Get the current date and time.",
  parameters: { type: "object", properties: {} },
  category: "utility",
  async execute() {
    return {
      success: true,
      output: { datetime: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    };
  },
});

// create_file (alias for write_file with overwrite protection)
registerTool({
  name: "create_file",
  description: "Create a new file. Refuses to overwrite unless overwrite: true.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
      overwrite: { type: "boolean" },
    },
    required: ["path", "content"],
  },
  category: "filesystem",
  async execute(args, ctx) {
    const { path, content, overwrite } = args as { path: string; content: string; overwrite?: boolean };
    const stat = await ctx.executor.stat(path);
    if (stat && !overwrite) {
      return { success: false, output: null, error: `File already exists: ${path}. Use overwrite: true to replace.` };
    }
    await ctx.executor.writeFile(path, content);
    return { success: true, output: { path, bytes: content.length, created: !stat } };
  },
});

// move_file
registerTool({
  name: "move_file",
  description: "Move or rename a file.",
  parameters: {
    type: "object",
    properties: {
      from: { type: "string" },
      to: { type: "string" },
    },
    required: ["from", "to"],
  },
  category: "filesystem",
  async execute(args, ctx) {
    await ctx.executor.moveFile(args.from as string, args.to as string);
    return { success: true, output: { from: args.from, to: args.to } };
  },
});

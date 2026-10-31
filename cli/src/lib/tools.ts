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
import { imageSearch } from "@mudbill/duckduckgo-images-api";

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

// DuckDuckGo search tools — web (HTML SERP), images (@mudbill package),
// videos (vqd token + v.js JSON endpoint). All keyless — no third-party
// search service, no API keys.
//
// "No results" handling: DuckDuckGo legitimately answers with an empty
// result set when nothing matched. That is a SUCCESS with an empty list so
// the agent says "nothing found" instead of dumping a raw backend error at
// the user. Real failures are sanitized: provider names / raw JSON bodies
// never surface in the CLI output.

const DDG_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const DDG_HEADERS: Record<string, string> = {
  "User-Agent": DDG_UA,
  Accept: "*/*",
  "Accept-Language": "en",
  Referer: "https://duckduckgo.com/",
};

/** Race any promise against an 8s ceiling (fetch has no default timeout). */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      (t as { unref?: () => void }).unref?.();
    }),
  ]);
}

function searchLabel(type: "web" | "image" | "video"): string {
  return type === "web" ? "Web search" : type === "image" ? "Image search" : "Video search";
}

function sanitizedSearchError(type: "web" | "image" | "video", e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  // "miklium" stays in the blocklist on purpose: it is the provider whose
  // raw errors once leaked into the chat — if any stale/regressed upstream
  // ever emits it again, it gets scrubbed here.
  const cleaned = raw
    .replace(/miklium|duckduckgo|langsearch/gi, "search backend")
    .replace(/\{[\s\S]*\}/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned && cleaned !== raw
    ? `${searchLabel(type)} failed: ${cleaned}`
    : `${searchLabel(type)} is temporarily unavailable. Please try again in a moment.`;
}

/** Resolve DDG's click-redirect links (/l/?uddg=<encoded>) to real URLs. */
function unwrapDDGUrl(href: string): string {
  if (!href) return "";
  // Only absolute / protocol-relative / root-relative hrefs are resolvable;
  // anything else passes through so the http(s) filter drops it.
  if (!/^(https?:)?\/\//i.test(href) && !href.startsWith("/")) return href;
  try {
    const abs = href.startsWith("//") ? `https:${href}` : href;
    const u = new URL(abs, "https://duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    if (u.pathname === "/l/" && uddg) return uddg;
    return u.toString();
  } catch {
    return href;
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** DuckDuckGo web search via the HTML SERP endpoint — no key, no token. */
async function ddgWebSearch(
  query: string,
  limit: number,
): Promise<Array<{ url: string; title: string; snippet: string; domain: string }>> {
  const body = new URLSearchParams({ q: query, kl: "wt-wt" });
  const res = await withTimeout(
    fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": DDG_UA,
        Accept: "text/html",
      },
      body: body.toString(),
    }),
    8_000,
    "DuckDuckGo web search",
  );
  const html = await res.text().catch(() => "");
  if (res.status === 202 || res.status === 403 || /anomaly|ratelimit|rate limit/i.test(html.slice(0, 2000))) {
    throw new Error("DuckDuckGo web search is rate-limited right now");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const anchors = html.match(/<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*>[\s\S]*?<\/a>/gi) || [];
  const snippets = html.match(/<a[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>[\s\S]*?<\/a>/gi) || [];

  const seen = new Set<string>();
  const rows: Array<{ url: string; title: string; snippet: string; domain: string }> = [];
  for (const anchor of anchors) {
    const href = anchor.match(/href="([^"]*)"/)?.[1] || "";
    // Ad rows click through duckduckgo.com/y.js trackers — skip them.
    if (/duckduckgo\.com\/y\.js/i.test(href)) continue;
    const url = unwrapDDGUrl(href);
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    const title = decodeEntities(anchor.replace(/<[^>]+>/g, " "));
    if (!title) continue;
    seen.add(url);
    rows.push({ url, title, snippet: "", domain: domainOf(url) });
    if (rows.length >= limit) break;
  }
  snippets.slice(0, rows.length).forEach((snip, i) => {
    rows[i].snippet = decodeEntities(snip.replace(/<[^>]+>/g, " "));
  });
  return rows;
}

/** Derive a YouTube thumbnail from a watch/shorts link (keyless, stable). */
function youtubeThumbFor(url: string): string {
  const m = url.match(
    /(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/,
  );
  return m ? `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` : "";
}

/** Format a duration: seconds (325) → "5:25"; "5:25" passes through. */
function formatDDGDuration(duration: string | number | undefined): string {
  if (duration === undefined || duration === null) return "";
  if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
    const s = Math.round(duration);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
      : `${m}:${String(sec).padStart(2, "0")}`;
  }
  const text = String(duration).trim();
  return /^\d+(:\d{1,2}){1,2}$/.test(text) ? text : "";
}

interface DDGVideoRow {
  url?: string;
  title?: string;
  description?: string;
  content?: string;
  duration?: string | number;
  publisher?: string;
  statistics?: { viewCount?: number | string; likeCount?: number | string };
}

/** DuckDuckGo video search — vqd token handshake + v.js JSON endpoint. */
async function ddgVideoSearch(
  query: string,
  limit: number,
): Promise<
  Array<{
    videoUrl: string;
    thumbnail: string;
    title: string;
    description: string;
    duration: string;
    channel?: string;
    views?: string;
    likes?: string;
  }>
> {
  // 1) vqd session token from duckduckgo.com's HTML (same handshake the
  //    image search package uses for i.js).
  const tokenRes = await withTimeout(
    fetch(`https://duckduckgo.com/?q=${encodeURIComponent(query)}`, { headers: DDG_HEADERS }),
    8_000,
    "DuckDuckGo token request",
  );
  if (!tokenRes.ok) throw new Error(`HTTP ${tokenRes.status}`);
  const tokenHtml = await tokenRes.text().catch(() => "");
  const vqd = tokenHtml.match(/vqd=([\d-]+)/)?.[1] || "";
  if (!vqd) throw new Error("DuckDuckGo token unavailable");

  // 2) v.js results — the way duckduckgo.com's own videos tab fetches them.
  const params = new URLSearchParams({ o: "json", q: query, l: "us-en", vqd, f: ",,,,", p: "1" });
  const res = await withTimeout(
    fetch(`https://duckduckgo.com/v.js?${params.toString()}`, { headers: DDG_HEADERS }),
    8_000,
    "DuckDuckGo video search",
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json().catch(() => null)) as { results?: DDGVideoRow[] } | null;
  const rows = Array.isArray(data?.results) ? (data!.results as DDGVideoRow[]) : [];

  const seen = new Set<string>();
  const out: Array<{
    videoUrl: string;
    thumbnail: string;
    title: string;
    description: string;
    duration: string;
    channel?: string;
    views?: string;
    likes?: string;
  }> = [];
  for (const r of rows) {
    const videoUrl = typeof r.url === "string" ? r.url : "";
    if (!videoUrl || !/^https?:\/\//i.test(videoUrl) || seen.has(videoUrl)) continue;
    seen.add(videoUrl);
    const content = typeof r.content === "string" ? r.content : "";
    const thumbnail = /^https?:\/\//i.test(content) ? content : youtubeThumbFor(videoUrl);
    const channel = typeof r.publisher === "string" ? r.publisher : undefined;
    out.push({
      videoUrl,
      thumbnail,
      title: typeof r.title === "string" ? r.title : "",
      description: typeof r.description === "string" ? r.description : "",
      duration: formatDDGDuration(r.duration),
      ...(channel ? { channel } : {}),
      ...(r.statistics?.viewCount !== undefined && r.statistics?.viewCount !== null
        ? { views: String(r.statistics.viewCount) }
        : {}),
      ...(r.statistics?.likeCount !== undefined && r.statistics?.likeCount !== null
        ? { likes: String(r.statistics.likeCount) }
        : {}),
    });
    if (out.length >= limit) break;
  }
  return out;
}

registerTool({
  name: "web_search",
  description: "Search the web for information using DuckDuckGo. Returns titles, URLs, and snippets.",
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
      const rows = await ddgWebSearch(query, limit);
      if (rows.length === 0) {
        return { success: true, output: { query, results: [], count: 0, provider: "ddg", message: `No web results found for "${query}". Try different or more general keywords.` } };
      }
      return { success: true, output: { query, results: rows, count: rows.length, provider: "ddg" } };
    } catch (e) {
      return { success: false, output: null, error: sanitizedSearchError("web", e) };
    }
  },
});

// image_search
// DuckDuckGo only (via @mudbill/duckduckgo-images-api — no key, no
// billing, real thumbnails + dimensions). Output shape:
// { imageUrl, title, width, height, source (reference page) }.
registerTool({
  name: "image_search",
  description: "Search for images using DuckDuckGo. Returns image URLs, titles, and dimensions.",
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
      // Race an 8s ceiling: the package has no abort support and a
      // dropped-SYN egress path hangs ~2min in Node's TCP retries.
      const raw = await Promise.race([
        imageSearch({
          query,
          safe: true, // filter adult content
          retries: 2,
          iterations: 1, // one pass = up to 100 rows; sliced to `limit`
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("DuckDuckGo image search timed out after 8000ms")),
            8_000,
          ),
        ),
      ]);
      const seen = new Set<string>();
      const results = (raw ?? [])
        .filter((r) => r?.image && !seen.has(r.image) && seen.add(r.image))
        .slice(0, limit)
        .map((r) => ({
          imageUrl: r.image,
          thumbnail: r.thumbnail || r.image,
          title: r.title,
          width: r.width,
          height: r.height,
          source: r.url || r.image, // reference page
        }));
      // DuckDuckGo answered but nothing matched (or per-request fetches
      // failed after retries) — still a success, with a graceful notice
      // instead of an empty/misleading payload.
      if (results.length === 0) {
        return { success: true, output: { query, results: [], count: 0, provider: "ddg", message: `No images found for "${query}". Try different or more general keywords.` } };
      }
      return { success: true, output: { query, results, count: results.length, provider: "ddg" } };
    } catch (e) {
      return { success: false, output: null, error: sanitizedSearchError("image", e) };
    }
  },
});

// video_search
// DuckDuckGo videos — vqd token handshake + v.js JSON endpoint (the way
// duckduckgo.com's own videos tab fetches results). No API key needed.
registerTool({
  name: "video_search",
  description: "Search for videos using DuckDuckGo. Returns video URLs, thumbnails, durations, and channel info.",
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
      const results = await ddgVideoSearch(query, limit);
      if (results.length === 0) {
        return { success: true, output: { query, results: [], count: 0, provider: "ddg", message: `No videos found for "${query}". Try different or more general keywords.` } };
      }
      return { success: true, output: { query, results, count: results.length, provider: "ddg" } };
    } catch (e) {
      return { success: false, output: null, error: sanitizedSearchError("video", e) };
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
      const data = await res.json() as any;
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

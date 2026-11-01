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

// Search tools (USER DIRECTIVE 2026-11-01: "I want duck duck go for image
// and video search"):
//   - web_search: Miklium (Yahoo-powered, https://miklium.vercel.app) with
//     the keyless DuckDuckGo HTML SERP as the automatic fallback.
//   - image_search: DuckDuckGo PRIMARY (in-house vqd + i.js client — no key,
//     no billing, no third-party package; the @mudbill package was dropped:
//     it sent no headers on its token bootstrap and its regex missed DDG's
//     quoted `vqd="…"` form). When DDG refuses the connection — its WAF
//     hard-blocks shared datacenter egress IPs (cloud shells, CI, some
//     VPNs) — Miklium's keyless images endpoint rescues the query so the
//     user always gets results instead of a "busy" notice.
//   - video_search: same shape — DDG vqd + v.js primary, Miklium videos
//     rescue.
//
// "No results" handling: every engine legitimately answers with an empty
// result set when nothing matched. That is a SUCCESS with an empty list so
// the agent says "nothing found" instead of dumping a raw backend error at
// the user. Real failures degrade the same way — a friendly "busy, try
// again" notice — so a {"success":false,...,"error":...} blob is NEVER
// emitted (the reported bug), and provider names / raw JSON bodies never
// surface in the output.

const DDG_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Headers for DDG's HTML token page — a top-level document navigation
 *  (Node's default undici UA is an instant bot tell). */
const DDG_HTML_HEADERS: Record<string, string> = {
  "User-Agent": DDG_UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "upgrade-insecure-requests": "1",
};

/** Headers for DDG's i.js / v.js JSON endpoints — a same-origin XHR. */
const DDG_XHR_HEADERS: Record<string, string> = {
  "User-Agent": DDG_UA,
  Accept: "application/json, text/javascript, */*; q=0.01",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://duckduckgo.com/",
  "X-Requested-With": "XMLHttpRequest",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
};

/** Extract the `vqd` session token from a DDG HTML page. Two shapes appear
 *  in the wild: the quoted attribute form `vqd="4-264…"` and the
 *  query-string form `…&vqd=4-320…&s=50…`. (The @mudbill package only
 *  matched the second — one of the reasons it failed.) */
function extractVqd(html: string): string {
  if (!html) return "";
  const quoted = html.match(/vqd\s*=\s*"([0-9-]+)"/);
  if (quoted?.[1]) return quoted[1];
  return html.match(/vqd=([0-9-]+)/)?.[1] ?? "";
}

/** Detect DDG's anti-bot soft block: HTTP 202 (the "anomaly" page), HTTP
 *  403, or a challenge/rate-limit body. A blocked response must be retried
 *  with a FRESH token after backoff — never misread as "no results". */
function isDDGBlocked(status: number, body: string): boolean {
  if (status === 202 || status === 403) return true;
  return /anomaly|ratelimit|rate limit|challenge/i.test(body.slice(0, 2000));
}

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

function searchPlural(type: "web" | "image" | "video"): string {
  return type === "web" ? "web results" : type === "image" ? "images" : "videos";
}

/** Graceful "engine unreachable" output — the failure path for every
 *  search tool returns this INSTEAD of an error blob, mirroring the app's
 *  /api/ddg-search route (user directive: fix in ALL searches). No upstream
 *  text is embedded, so nothing can leak. */
function busySearchOutput(query: string, type: "web" | "image" | "video") {
  return {
    success: true as const,
    output: {
      query,
      results: [],
      count: 0,
      provider: type === "web" ? "miklium" : "ddg",
      message: `${searchLabel(type)} couldn't be reached just now — no ${searchPlural(type)} came back for "${query}". Please try again in a moment.`,
    },
  };
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

/** Miklium web search (Yahoo-powered) — the web engine, restored.
 *  Answers 404 {"success":false,"error":"No results found"} when a query
 *  matches nothing: that is an EMPTY list here, never an error (the
 *  original bug). Rows are normalized to the same {url,title,snippet,domain}
 *  shape ddgWebSearch emits, grouped by URL, longest snippet per page. */
async function mikliumWebSearch(
  query: string,
  limit: number,
): Promise<Array<{ url: string; title: string; snippet: string; domain: string }>> {
  const res = await withTimeout(
    fetch("https://miklium.vercel.app/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        search: [query],
        type: "default",
        // Short snippets only — long ones are full-page scrapes (4500+ chars,
        // far too slow for a result card).
        maxSmallSnippets: Math.min(limit, 10),
        maxLargeSnippets: 0,
      }),
    }),
    9_000,
    "Miklium web search",
  );
  const bodyText = await res.text().catch(() => "");

  // 404 "No results found" is a legitimate empty outcome, not a failure.
  if (res.status === 404 && /no results/i.test(bodyText)) return [];
  if (/"error"\s*:\s*"[^"]*no results[^"]*"/i.test(bodyText)) return [];
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  let data: { success?: boolean; error?: string; results?: Array<Record<string, unknown>> };
  try {
    data = JSON.parse(bodyText) as typeof data;
  } catch {
    throw new Error("invalid JSON");
  }
  if (data?.success === false) {
    if (data.error && /no results/i.test(String(data.error))) return [];
    throw new Error(String(data.error ?? "unknown error"));
  }

  const byUrl = new Map<string, { url: string; title: string; snippet: string; domain: string }>();
  for (const item of data?.results ?? []) {
    const url = String(item?.url ?? "");
    if (!url) continue;
    const snippet = String(item?.snippet ?? "");
    const domain = domainOf(url);
    const existing = byUrl.get(url);
    if (!existing) {
      byUrl.set(url, { url, title: domain || url, snippet, domain });
    } else if (snippet.length > existing.snippet.length) {
      existing.snippet = snippet;
    }
  }
  return Array.from(byUrl.values()).slice(0, limit);
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
  // 1) vqd session token from duckduckgo.com's HTML (browser-grade
  //    headers — Node's default UA is a bot tell).
  const tokenRes = await withTimeout(
    fetch(`https://duckduckgo.com/?q=${encodeURIComponent(query)}`, { headers: DDG_HTML_HEADERS }),
    8_000,
    "DuckDuckGo token request",
  );
  if (!tokenRes.ok) throw new Error(`HTTP ${tokenRes.status}`);
  const tokenHtml = await tokenRes.text().catch(() => "");
  const vqd = extractVqd(tokenHtml);
  if (!vqd) throw new Error("DuckDuckGo token unavailable");

  // 2) v.js results — the way duckduckgo.com's own videos tab fetches them.
  const params = new URLSearchParams({ o: "json", q: query, l: "us-en", vqd, f: ",,,,", p: "1" });
  const res = await withTimeout(
    fetch(`https://duckduckgo.com/v.js?${params.toString()}`, { headers: DDG_XHR_HEADERS }),
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

/** DuckDuckGo image search — in-house vqd + i.js client (the way
 *  duckduckgo.com's own images tab fetches them). One full retry with a
 *  FRESH token when DDG's anti-bot soft-blocks a request. No key, no
 *  package. */
async function ddgImageSearch(
  query: string,
  limit: number,
): Promise<
  Array<{
    imageUrl: string;
    thumbnail: string;
    title: string;
    width: number;
    height: number;
    source: string; // reference page
  }>
> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    // 1) vqd session token (fresh on every attempt — a blocked token stays
    //    blocked; the retry exists to re-bootstrap the session).
    const tokenRes = await withTimeout(
      fetch(`https://duckduckgo.com/?q=${encodeURIComponent(query)}`, { headers: DDG_HTML_HEADERS }),
      8_000,
      "DuckDuckGo token request",
    );
    const tokenHtml = await tokenRes.text().catch(() => "");
    if (isDDGBlocked(tokenRes.status, tokenHtml)) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 350));
        continue;
      }
      throw new Error("DuckDuckGo image search unavailable");
    }
    const vqd = extractVqd(tokenHtml);
    if (!vqd) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 350));
        continue;
      }
      throw new Error("DuckDuckGo token unavailable");
    }

    // 2) i.js results.
    const params = new URLSearchParams({ o: "json", q: query, l: "us-en", vqd, f: ",,,", p: "1" });
    const res = await withTimeout(
      fetch(`https://duckduckgo.com/i.js?${params.toString()}`, { headers: DDG_XHR_HEADERS }),
      8_000,
      "DuckDuckGo image search",
    );
    const body = await res.text().catch(() => "");
    if (isDDGBlocked(res.status, body)) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 350));
        continue;
      }
      throw new Error("DuckDuckGo image search unavailable");
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json().catch(() => null)) as
      | { results?: Array<{ image?: string; thumbnail?: string; title?: string; width?: number; height?: number; url?: string }> }
      | null;
    const rows = Array.isArray(data?.results) ? data!.results : [];

    const seen = new Set<string>();
    const out: Array<{
      imageUrl: string;
      thumbnail: string;
      title: string;
      width: number;
      height: number;
      source: string;
    }> = [];
    for (const r of rows) {
      const image = typeof r?.image === "string" ? r.image : "";
      if (!image || !/^https?:\/\//i.test(image) || seen.has(image)) continue;
      seen.add(image);
      out.push({
        imageUrl: image,
        thumbnail: typeof r.thumbnail === "string" && r.thumbnail ? r.thumbnail : image,
        title: typeof r.title === "string" ? r.title : "",
        width: typeof r.width === "number" ? r.width : 0,
        height: typeof r.height === "number" ? r.height : 0,
        source: typeof r.url === "string" && r.url ? r.url : image, // reference page
      });
      if (out.length >= limit) break;
    }
    return out;
  }
  throw new Error("DuckDuckGo image search unavailable");
}

/** Miklium media search (Yahoo-powered, keyless) — the RESCUE engine when
 *  DDG refuses the connection (datacenter egress). "No results" is an
 *  empty list, never an error; hard failures throw. */
async function mikliumMediaSearch(
  query: string,
  type: "images" | "videos",
  limit: number,
): Promise<
  Array<{
    imageUrl: string;
    thumbnail: string;
    title: string;
    width: number;
    height: number;
    source: string;
    videoUrl?: string;
    description?: string;
    duration?: string;
  }>
> {
  const res = await withTimeout(
    fetch("https://miklium.vercel.app/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      // Always pull the full 50-row pool (mr > 50 is rejected with HTTP
      // 400, and the image index serves ~50% duplicate image URLs — the
      // pool dedupes to ~25 unique rows; slicing to `limit` happens after
      // dedupe).
      body: JSON.stringify({ search: [query], type, maxResults: 50 }),
    }),
    9_000,
    "Miklium media search",
  );
  const bodyText = await res.text().catch(() => "");

  // 404 "No results found" is a legitimate empty outcome, not a failure.
  if (res.status === 404 && /no results/i.test(bodyText)) return [];
  if (/"error"\s*:\s*"[^"]*no results[^"]*"/i.test(bodyText)) return [];
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  let data: { success?: boolean; error?: string; results?: Array<Record<string, unknown>> };
  try {
    data = JSON.parse(bodyText) as typeof data;
  } catch {
    throw new Error("invalid JSON");
  }
  if (data?.success === false) {
    if (data.error && /no results/i.test(String(data.error))) return [];
    throw new Error(String(data.error ?? "unknown error"));
  }

  const out: Array<{
    imageUrl: string;
    thumbnail: string;
    title: string;
    width: number;
    height: number;
    source: string;
    videoUrl?: string;
    description?: string;
    duration?: string;
  }> = [];
  const seen = new Set<string>();
  for (const item of data?.results ?? []) {
    if (type === "images") {
      const imageUrl = String(item?.imageUrl ?? "");
      if (!imageUrl || !/^https?:\/\//i.test(imageUrl) || seen.has(imageUrl)) continue;
      seen.add(imageUrl);
      const size = (item?.size ?? {}) as { width?: unknown; height?: unknown };
      out.push({
        imageUrl,
        thumbnail: imageUrl,
        title: String(item?.title ?? ""),
        width: typeof size.width === "number" ? size.width : 0,
        height: typeof size.height === "number" ? size.height : 0,
        source: String(item?.referenceUrl ?? imageUrl), // reference page
      });
    } else {
      const videoUrl = String(item?.videoUrl ?? "");
      if (!videoUrl || !/^https?:\/\//i.test(videoUrl) || seen.has(videoUrl)) continue;
      seen.add(videoUrl);
      const thumb = String(item?.thumbUrl ?? "");
      out.push({
        imageUrl: thumb,
        thumbnail: thumb,
        title: String(item?.title ?? ""),
        width: 0,
        height: 0,
        source: videoUrl,
        videoUrl,
        description: String(item?.description ?? ""),
        duration: String(item?.duration ?? ""),
      });
    }
    if (out.length >= limit) break;
  }
  return out;
}

registerTool({
  name: "web_search",
  description:
    "Search the web for information using Miklium, with DuckDuckGo as fallback. Returns titles, URLs, and snippets.",
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
      // Miklium is the web engine (restored); DuckDuckGo is the automatic
      // fallback when Miklium fails or finds nothing — mirrors the app's
      // /api/ddg-search cascade.
      let rows = await mikliumWebSearch(query, limit).catch(() => [] as Array<{ url: string; title: string; snippet: string; domain: string }>);
      let provider = "miklium";
      if (rows.length === 0) {
        rows = await ddgWebSearch(query, limit);
        provider = "ddg";
      }
      if (rows.length === 0) {
        return { success: true, output: { query, results: [], count: 0, provider, message: `No web results found for "${query}". Try different or more general keywords.` } };
      }
      return { success: true, output: { query, results: rows, count: rows.length, provider } };
    } catch {
      // Both engines failed — friendly busy notice, never an error blob.
      return busySearchOutput(query, "web");
    }
  },
});

// image_search
// DuckDuckGo PRIMARY (in-house vqd + i.js client — no key, no billing, no
// package). Output shape: { imageUrl, title, width, height, source (the
// reference page) }. When DDG refuses the connection (datacenter egress
// IPs — cloud shells, CI, hosted runners), Miklium's keyless images
// endpoint rescues the query so the user always gets results.
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
    // DDG first (user directive: "I want duck duck go for image and video
    // search"); the Miklium rescue only fires when DDG is unreachable.
    let rows: Awaited<ReturnType<typeof ddgImageSearch>> = [];
    let provider = "ddg";
    let ddgUnreachable = false;
    try {
      rows = await ddgImageSearch(query, limit);
    } catch {
      ddgUnreachable = true;
    }
    if (rows.length === 0) {
      provider = "miklium";
      try {
        rows = await mikliumMediaSearch(query, "images", limit);
      } catch (err) {
        if (ddgUnreachable) {
          // BOTH engines unreachable — friendly busy notice, never an
          // error blob.
          return busySearchOutput(query, "image");
        }
        provider = "ddg";
        rows = [];
        void err;
      }
    }
    if (rows.length === 0) {
      // The reachable engine simply finds nothing for this query.
      return { success: true, output: { query, results: [], count: 0, provider, message: `No images found for "${query}". Try different or more general keywords.` } };
    }
    return { success: true, output: { query, results: rows, count: rows.length, provider } };
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
    // DDG first; Miklium videos rescue the query when DDG is unreachable
    // (datacenter egress) — mirrors the image tool and the app route.
    let rows: Awaited<ReturnType<typeof ddgVideoSearch>> = [];
    let provider = "ddg";
    let ddgUnreachable = false;
    try {
      rows = await ddgVideoSearch(query, limit);
    } catch {
      ddgUnreachable = true;
    }
    if (rows.length === 0) {
      provider = "miklium";
      try {
        const mkRows = await mikliumMediaSearch(query, "videos", limit);
        rows = mkRows.map((r) => ({
          videoUrl: r.videoUrl ?? "",
          thumbnail: r.thumbnail,
          title: r.title,
          description: r.description ?? "",
          duration: r.duration ?? "",
        }));
      } catch (err) {
        if (ddgUnreachable) {
          // BOTH engines unreachable — friendly busy notice, never an
          // error blob.
          return busySearchOutput(query, "video");
        }
        provider = "ddg";
        rows = [];
        void err;
      }
    }
    if (rows.length === 0) {
      return { success: true, output: { query, results: [], count: 0, provider, message: `No videos found for "${query}". Try different or more general keywords.` } };
    }
    return { success: true, output: { query, results: rows, count: rows.length, provider } };
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

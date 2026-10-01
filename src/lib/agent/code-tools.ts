/**
 * OnyxCode tool registry — the code-mode agent's hands.
 *
 * Tools are executed SERVER-SIDE inside the background turn job (never in the
 * browser), so they keep running no matter what the tab does — same guarantee
 * as the model stream itself. Results flow back as replayable job events.
 *
 * Tool surface (one tool per concern, `action` where a tool is multi-modal):
 *  - create_app       scaffold a project into the workspace
 *  - manage_files     list / read / write / delete workspace files
 *  - start_preview    serve the workspace as a live preview URL
 *  - manage_preview   list / stop / check preview sessions
 *  - start_web_session open a real headless-browser session (navigate,
 *                      screenshot) against the preview or any URL
 *  - manage_database  CRUD the workspace's Database-tab records
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "@/lib/db";
import { getZai } from "./zai";
import { FRAMEWORKS, scaffoldApp, slugify } from "./code-scaffolds";
import {
  getWorkspace,
  replaceWorkspace,
  writeAssets,
  writeFiles,
  deleteFile,
  workspaceSummary,
  type Workspace,
  type WorkspaceAsset,
} from "./code-workspace";

export const PREVIEW_PORT = 3212;
const PREVIEW_BRIDGE = `http://localhost:${PREVIEW_PORT}`;
const SHOT_DIR = join(process.cwd(), "db", "web-sessions");

export interface ToolContext {
  workspaceId: string;
  signal: AbortSignal;
  /** The user's latest prompt — lets tools recover names the model forgot. */
  lastUserMessage?: string;
}

export interface ToolExecutionResult {
  ok: boolean;
  /** One-line human summary for the tool card. */
  subtitle: string;
  /** Full result text for the model (and the expanded card). */
  text: string;
  /** Rich card payload for the UI. */
  resultData?: { kind: string; payload: Record<string, unknown> };
}

type Args = Record<string, unknown>;

function str(args: Args, key: string, fallback = ""): string {
  const value = args[key];
  return typeof value === "string" ? value : fallback;
}

function id(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/* ------------------------------------------------------------------ */
/* Tool documentation (injected into the code-mode system prompt)      */
/* ------------------------------------------------------------------ */

export function codeToolDocs(): string {
  return `TOOLS — you can operate the user's workspace by ending your reply with ONE fenced tool block:

\`\`\`onyxtool
{"tool": "create_app", "args": {"framework": "static", "name": "my-site", "description": "A warm landing page"}}
\`\`\`

Tool reference:
- create_app — scaffold a fresh project. args: framework (nextjs | vite-react | fastapi | node | static | cli), name (required, from the user's request), description. The scaffold ships GENERIC PLACEHOLDER pages — after scaffolding you MUST replace the placeholder with the actual site the user asked for (manage_files write) before starting the preview. Never show the placeholder as the finished result.
- manage_files — edit the workspace. args: action (list | read | write | delete), path, content (for write). For STATIC sites write the real requested page to index.html at the WORKSPACE ROOT (the live preview serves exactly that file). For app frameworks (nextjs, vite-react) keep preview/index.html a self-contained mirror of the page (inline CSS, no external assets) and update it whenever the page design changes. Writing base64 (or a data: URL) as the content of an image path (.png/.jpg/.webp/.gif/.svg) stores it as a viewable workspace image asset — it works in previews and inspect_image can see it. Running previews pick up file changes automatically.
- start_preview — serve the workspace as its live preview. args: name (optional). There is exactly ONE preview project per app (re-calling it refreshes the same preview with the latest files). Returns the public URL; tell the user to open the Preview tab.
- manage_preview — args: action (list | stop | check), sessionId (for stop/check).
- start_web_session — open a real headless browser against a URL (defaults to the live preview). args: url (optional), screenshot (boolean — captures a PNG into the workspace where inspect_image can view it).
- inspect_image — actually LOOK at an image with vision (workspace images, written image assets, or captured screenshots). args: path (a workspace image path like images/hero.png or screenshots/ws-xxx.png, or "screenshot:<webSessionId>"), question (optional focus, e.g. "does the hero layout look right?"). Use it to verify how a page/screenshot actually looks instead of guessing. With no path it lists every available image.
- manage_database — read/write the workspace database (also shown in the Database tab). args: action (list | get | set | delete), key, data (any JSON, for set).

Tool protocol rules — FOLLOW THESE EXACTLY:
1. End tool work with ONE fenced onyxtool block as the LAST thing you write. The block holds either a single call {"tool": …, "args": …} or a JSON ARRAY of calls executed in order — e.g. the page write AND start_preview together: [{"tool": "manage_files", …}, {"tool": "start_preview", …}]. Stop right after the block — results come back as TOOL RESULT messages and you continue then.
2. The block content must be valid JSON. No prose inside the fence. ALWAYS fill in the args (never leave them empty when the tool takes a name/framework/path).
3. NEVER announce or describe a tool action in prose without emitting its block in the SAME reply. Writing "I'll start the preview now" or "I've updated the file" without the matching block is a protocol violation — the action will not happen.
4. NEVER invent, predict or quote a tool result. Results only ever arrive as [TOOL RESULT] messages after you emit a block. If you have not emitted the block, nothing has happened — do not claim it has. This includes images: never say you "can see" an image unless inspect_image returned a real description of it.
5. When no more tool work is needed, write your final answer with NO tool block — and never promise future tool actions in it.`;
}

export function workspaceContextText(workspaceId: string): Promise<string> {
  return getWorkspace(workspaceId).then((workspace) => workspaceSummary(workspace));
}

/* ------------------------------------------------------------------ */
/* Preview bridge (mini-service on :3212)                              */
/* ------------------------------------------------------------------ */

async function bridgeRegister(
  sessionId: string,
  name: string,
  files: Record<string, string>,
  entry: string,
  assets: Record<string, WorkspaceAsset> = {},
): Promise<string | null> {
  try {
    const response = await fetch(`${PREVIEW_BRIDGE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: sessionId, name, files, entry, assets }),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { url?: string };
    return typeof data.url === "string" ? data.url : null;
  } catch {
    return null;
  }
}

async function bridgeStop(sessionId: string): Promise<void> {
  try {
    await fetch(`${PREVIEW_BRIDGE}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: sessionId }),
    });
  } catch {
    // Service down — the DB row still flips to stopped.
  }
}

async function previewSessionsFor(workspaceId: string) {
  return db.previewSession.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
  });
}

/** Scaffold placeholder markers — pages OnyxCode itself generated, not the
 *  user's real content. Used to prefer real pages for the preview entry. */
const PLACEHOLDER_RE = /scaffolded by onyxcode|warm editorial starting point|live static preview of the project/i;

/** True when the file at `path` is still the generic scaffold placeholder. */
function isPlaceholderFile(workspace: Workspace, path: string): boolean {
  return PLACEHOLDER_RE.test(workspace.files[path] ?? "");
}

/** Does the workspace hold a REAL page worth previewing (not the scaffold
 *  placeholder)? Drives auto-start: no fake preview of generic content. */
export function hasRealPreviewContent(workspace: Workspace): boolean {
  const entry = pickPreviewEntry(workspace);
  if (!entry) return false;
  return !isPlaceholderFile(workspace, entry);
}

/**
 * Pick the file a preview session should serve — always the REAL page the
 * agent wrote, never the generic scaffold placeholder.
 *
 * 1. The framework's canonical entry when it holds real content
 *    (static: index.html — the site itself; apps: preview/index.html — the
 *    self-contained mirror).
 * 2. Otherwise any non-placeholder HTML page (models sometimes write the
 *    real site into a subfolder like my-app/index.html) — shallowest path
 *    wins.
 * 3. Otherwise the canonical entry / any HTML, placeholder or not.
 */
export function pickPreviewEntry(workspace: Workspace): string | null {
  const files = workspace.files;
  const htmlFiles = Object.keys(files)
    .filter((p) => /\.html?$/i.test(p))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  const isPlaceholder = (p: string) => isPlaceholderFile(workspace, p);
  const preferred =
    workspace.appMeta.framework === "static"
      ? ["index.html", "preview/index.html"]
      : ["preview/index.html", "index.html"];

  for (const p of preferred) {
    if (files[p] && !isPlaceholder(p)) return p;
  }
  const real = htmlFiles.filter((p) => !isPlaceholder(p));
  if (real.length > 0) return real[0];
  for (const p of preferred) {
    if (files[p]) return p;
  }
  return htmlFiles[0] ?? null;
}

/**
 * Push the CURRENT workspace files into every running preview session of
 * this workspace. Called after any file change (scaffold / write / delete)
 * so a live preview actually serves what the agent built — the browser
 * just needs a refresh, never a new session.
 */
async function syncRunningPreviews(workspaceId: string): Promise<void> {
  let rows;
  try {
    rows = await db.previewSession.findMany({ where: { workspaceId, status: "running" } });
  } catch {
    return;
  }
  if (rows.length === 0) return;
  const workspace = await getWorkspace(workspaceId);
  const entry = pickPreviewEntry(workspace);
  for (const row of rows) {
    if (!entry) {
      await bridgeStop(row.id);
      try {
        await db.previewSession.update({ where: { id: row.id }, data: { status: "stopped" } });
      } catch {
        // Row vanished mid-sync — nothing to do.
      }
      continue;
    }
    const url = await bridgeRegister(row.id, row.name, workspace.files, entry, workspace.assets);
    if (url) {
      try {
        await db.previewSession.update({ where: { id: row.id }, data: { url, entry } });
      } catch {
        // Row vanished mid-sync — the service copy is already correct.
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Preview session orchestration (shared with /api/code/preview)       */
/* ------------------------------------------------------------------ */

export interface PreviewSessionView {
  sessionId: string;
  name: string;
  url: string;
  status: string;
  entry: string;
  createdAt: number;
}

export async function listPreviewSessions(workspaceId: string): Promise<PreviewSessionView[]> {
  const rows = await previewSessionsFor(workspaceId);
  // Live info from the preview service (status + revision) when reachable —
  // revision bumps whenever the agent re-publishes a session's files.
  const live = new Map<string, { status: string; revision: number }>();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(`${PREVIEW_BRIDGE}/list`, { signal: controller.signal });
    clearTimeout(timer);
    if (response.ok) {
      const data = (await response.json()) as {
        sessions?: { id: string; status: string; revision: number }[];
      };
      for (const s of data.sessions ?? []) {
        live.set(s.id, { status: s.status, revision: s.revision });
      }
    }
  } catch {
    // Service unreachable — the DB rows still list (status may be stale).
  }
  return rows.map((r) => {
    const info = live.get(r.id);
    return {
      sessionId: r.id,
      name: r.name,
      url: r.url,
      status: info?.status ?? r.status,
      entry: r.entry,
      createdAt: r.createdAt.getTime(),
      revision: info?.revision ?? 0,
    };
  });
}

/**
 * ONE CHAT = ONE APP PROJECT = ONE PREVIEW SESSION.
 *
 * The session id is deterministic per workspace (`pv-<workspaceId>`), so
 * re-starting a preview never spawns a second project — it refreshes the
 * same one (revision bumps, the embedded iframe live-reloads). There is no
 * user-facing "which project?" concept anywhere in the UI.
 */
export function previewSessionIdFor(workspaceId: string): string {
  return `pv-${workspaceId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 60)}`;
}

export async function startPreviewSession(
  workspaceId: string,
  name?: string,
): Promise<{ ok: true; sessionId: string; url: string } | { ok: false; error: string }> {
  const workspace = await getWorkspace(workspaceId);
  const sessionName = name || workspace.appMeta.name || "Preview";
  const entry = pickPreviewEntry(workspace);
  if (!entry) {
    return {
      ok: false,
      error: "The workspace has no preview/index.html (or index.html) to serve. Ask OnyxCode to scaffold an app first.",
    };
  }
  // Deterministic id — the same chat always maps to the same preview project.
  const sessionId = previewSessionIdFor(workspaceId);
  // One project, one live session: stop any OTHER running rows for this
  // workspace first (covers legacy rows from before the stable-id scheme).
  try {
    const others = await db.previewSession.findMany({
      where: { workspaceId, status: "running", NOT: { id: sessionId } },
    });
    for (const row of others) {
      await bridgeStop(row.id);
      try {
        await db.previewSession.update({ where: { id: row.id }, data: { status: "stopped" } });
      } catch {
        // Row already gone.
      }
    }
  } catch {
    // Best-effort cleanup only.
  }
  const url = await bridgeRegister(sessionId, sessionName, workspace.files, entry, workspace.assets);
  if (!url) {
    return { ok: false, error: "The preview service did not respond. Try again in a moment." };
  }
  await db.previewSession.upsert({
    where: { id: sessionId },
    create: { id: sessionId, workspaceId, name: sessionName, url, status: "running", entry },
    update: { status: "running", name: sessionName, url, entry },
  });
  return { ok: true, sessionId, url };
}

/**
 * Rehydration for returning to a Code chat: adopt a running session if one
 * exists; otherwise start the runtime from the persisted workspace files —
 * but ONLY when there is a real page to serve (never a fake preview of the
 * generic scaffold placeholder, and no noise for empty workspaces).
 */
export async function ensurePreviewSession(
  workspaceId: string,
): Promise<
  { ok: true; sessionId: string; url: string; started: boolean } | { ok: false; silent: true; reason: string }
> {
  // Live status first (the DB row can be stale after a service hiccup).
  const sessions = await listPreviewSessions(workspaceId);
  const running = sessions.find((s) => s.status === "running");
  if (running) {
    if (running.sessionId === previewSessionIdFor(workspaceId)) {
      return { ok: true, sessionId: running.sessionId, url: running.url, started: false };
    }
    // Legacy multi-session rows from before the one-project scheme —
    // migrate onto the single stable id (this also stops the strays).
    const migrated = await startPreviewSession(workspaceId);
    if (migrated.ok) {
      return { ok: true, sessionId: migrated.sessionId, url: migrated.url, started: true };
    }
    // Migration failed — keep serving the existing session over nothing.
    return { ok: true, sessionId: running.sessionId, url: running.url, started: false };
  }
  const workspace = await getWorkspace(workspaceId);
  const entry = pickPreviewEntry(workspace);
  const hadSession = sessions.length > 0; // this app was live before — bring it back
  if (!entry || (!hasRealPreviewContent(workspace) && !hadSession)) {
    return {
      ok: false,
      silent: true,
      reason: !entry
        ? "No previewable page yet."
        : "Only the generic scaffold placeholder exists — nothing real to preview.",
    };
  }
  const outcome = await startPreviewSession(workspaceId);
  if (!outcome.ok) return { ok: false, silent: true, reason: outcome.error };
  return { ok: true, sessionId: outcome.sessionId, url: outcome.url, started: true };
}

/**
 * Leaving the Code workspace (exit or chat switch): destroy the RUNTIME —
 * stop every running preview session of this workspace. Source files, assets
 * and records are preserved untouched; returning re-creates the runtime.
 */
export async function stopWorkspacePreviews(workspaceId: string): Promise<void> {
  let rows;
  try {
    rows = await db.previewSession.findMany({ where: { workspaceId } });
  } catch {
    return;
  }
  for (const row of rows) {
    await bridgeStop(row.id);
    try {
      await db.previewSession.update({ where: { id: row.id }, data: { status: "stopped" } });
    } catch {
      // Row already gone.
    }
  }
}

export async function stopPreviewSession(
  workspaceId: string,
  sessionId: string,
): Promise<{ ok: boolean; error?: string }> {
  const row = await db.previewSession.findUnique({ where: { id: sessionId } });
  if (!row || row.workspaceId !== workspaceId) {
    return { ok: false, error: "Preview session not found in this workspace." };
  }
  await bridgeStop(sessionId);
  await db.previewSession.update({ where: { id: sessionId }, data: { status: "stopped" } });
  return { ok: true };
}

export async function checkPreviewSession(
  workspaceId: string,
  sessionId: string,
): Promise<{ ok: boolean; status?: number; title?: string; error?: string }> {
  const row = await db.previewSession.findUnique({ where: { id: sessionId } });
  if (!row || row.workspaceId !== workspaceId) {
    return { ok: false, error: "Preview session not found in this workspace." };
  }
  const { html, status } = await fetchPage(`${PREVIEW_BRIDGE}${row.url.split("?")[0]}`);
  return { ok: status === 200, status: status ?? undefined, title: extractTitle(html) || undefined };
}

/* ------------------------------------------------------------------ */
/* Web sessions (real headless browser via agent-browser CLI)          */
/* ------------------------------------------------------------------ */

interface WebSessionRecord {
  id: string;
  url: string;
  title: string;
  status: number | null;
  excerpt: string;
  links: string[];
  createdAt: number;
  screenshotUrl?: string;
}

const webSessions = new Map<string, WebSessionRecord>();

const AGENT_BROWSER = existsSync("/usr/local/bin/agent-browser")
  ? "/usr/local/bin/agent-browser"
  : "agent-browser";

/** One browser, one operation at a time — sessions never interleave. */
let browserQueue: Promise<unknown> = Promise.resolve();
function queueBrowser<T>(operation: () => Promise<T>): Promise<T> {
  const run = browserQueue.then(operation, operation);
  browserQueue = run.catch(() => undefined);
  return run;
}

/**
 * Dedicated agent-browser session — never collides with other browser
 * automation (the CLI keeps one default instance; sharing it would let a
 * tool navigation hijack an unrelated browser window).
 */
const BROWSER_SESSION = "onyxcode-web-session";

function execBrowser(args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      AGENT_BROWSER,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, AGENT_BROWSER_SESSION: BROWSER_SESSION },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || error.message).slice(0, 300)));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

function textExcerpt(html: string, length = 700): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > length ? `${stripped.slice(0, length)}…` : stripped;
}

function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? match[1].trim().slice(0, 120) : "";
}

function extractLinks(html: string, limit = 8): string[] {
  const links: string[] = [];
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null && links.length < limit) {
    const href = match[1];
    if (href.startsWith("#") || href.startsWith("javascript:")) continue;
    links.push(href);
  }
  return links;
}

async function fetchPage(url: string): Promise<{ html: string; status: number | null }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const html = await response.text();
    return { html: html.slice(0, 400_000), status: response.status };
  } catch {
    return { html: "", status: null };
  }
}

/* ------------------------------------------------------------------ */
/* Images — MIME sniffing, asset parsing, vision inspection            */
/* ------------------------------------------------------------------ */

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i;

/** Magic-byte MIME sniffing — never trust only the file extension. */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
  return null;
}

function base64ToBytes(data: string): Uint8Array | null {
  try {
    const buf = Buffer.from(data, "base64");
    if (buf.length === 0) return null;
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

/**
 * Turn written content for an image path into a workspace asset. Accepts a
 * data: URL, raw base64, or an SVG document; returns null when the content
 * is not decodable image data (the caller then stores it as a plain text
 * file so nothing is silently lost).
 */
export function parseImageContent(path: string, content: string): WorkspaceAsset | null {
  const trimmed = content.trim();
  if (/\.svg$/i.test(path)) {
    if (trimmed.startsWith("<") || trimmed.includes("<svg")) {
      return { mime: "image/svg+xml", data: Buffer.from(content, "utf8").toString("base64") };
    }
    return null;
  }
  let mime: string | null = null;
  let data = trimmed;
  const dataUrl = /^data:([\w/+.-]+);base64,([\s\S]+)$/.exec(trimmed);
  if (dataUrl) {
    mime = dataUrl[1];
    data = dataUrl[2];
  } else if (!/^[A-Za-z0-9+/=\r\n]+$/.test(data)) {
    return null; // not base64 — keep it as a text file
  }
  const bytes = base64ToBytes(data);
  if (!bytes) return null;
  const sniffed = sniffImageMime(bytes);
  if (!sniffed) return null; // decodes but isn't a real image
  return { mime: mime && mime.startsWith("image/") ? mime : sniffed, data };
}

/* ------------------------------------------------------------------ */
/* Tool implementations                                                */
/* ------------------------------------------------------------------ */

async function toolCreateApp(args: Args, ctx: ToolContext): Promise<ToolExecutionResult> {
  const framework = str(args, "framework", "static");
  let name = str(args, "name").trim();
  const description = str(args, "description");
  if (!name && ctx.lastUserMessage) {
    const prompt = ctx.lastUserMessage;
    const named =
      /\b(?:named|called|name it|named it)\s+["']?([a-zA-Z0-9][a-zA-Z0-9-_ ]{1,30}?)["']?(?=\s+(?:with|and|then|that|to|from|,|\.|;|$)|["']|$)/i.exec(
        prompt,
      );
    if (named) name = named[1].trim();
  }
  if (!name) name = "onyxcode-app";
  if (!FRAMEWORKS.some((f) => f.id === framework)) {
    return {
      ok: false,
      subtitle: `Unknown framework "${framework}"`,
      text: `Unknown framework "${framework}". Supported: ${FRAMEWORKS.map((f) => f.id).join(", ")}.`,
    };
  }
  const scaffold = scaffoldApp(framework, name, description);
  const workspace = await replaceWorkspace(ctx.workspaceId, scaffold.files, {
    framework: scaffold.framework,
    name: slugify(name),
    description: scaffold.appMeta.description,
  });
  await syncRunningPreviews(ctx.workspaceId);
  const paths = Object.keys(workspace.files).sort();
  return {
    ok: true,
    subtitle: `Scaffolded ${FRAMEWORKS.find((f) => f.id === framework)?.label} · ${paths.length} files`,
    text: `Project "${slugify(name)}" (${framework}) scaffolded into the workspace. Files:\n${paths.map((p) => `- ${p}`).join("\n")}\n\nIMPORTANT: these scaffold pages are a generic placeholder. Next step: use manage_files to write the ACTUAL site the user asked for (${framework === "static" ? "the real page content goes to index.html — the preview serves it directly" : "put a self-contained mirror of the real page at preview/index.html with inline CSS"}), then call start_preview. Never present the placeholder as the finished site.`,
    resultData: {
      kind: "create_app",
      payload: {
        framework,
        name: slugify(name),
        description: scaffold.appMeta.description ?? "",
        fileCount: paths.length,
        files: paths.slice(0, 30),
      },
    },
  };
}

async function toolManageFiles(args: Args, ctx: ToolContext): Promise<ToolExecutionResult> {
  const action = str(args, "action", "list");
  const path = str(args, "path");
  const workspace = await getWorkspace(ctx.workspaceId);

  if (action === "list") {
    const paths = Object.keys(workspace.files).sort();
    const assetPaths = Object.keys(workspace.assets).sort();
    const lines = paths.map((p) => `- ${p} (${workspace.files[p].length} bytes)`);
    const assetLines = assetPaths.map(
      (p) => `- ${p} (image ${workspace.assets[p].mime}, ${Math.round((workspace.assets[p].data.length * 3) / 4 / 1024)} KB — view with inspect_image)`,
    );
    return {
      ok: true,
      subtitle: `${paths.length + assetPaths.length} file${paths.length + assetPaths.length === 1 ? "" : "s"} in workspace`,
      text:
        paths.length + assetPaths.length === 0
          ? "The workspace is empty."
          : `Workspace files:\n${[...lines, ...assetLines].join("\n")}`,
      resultData: {
        kind: "files",
        payload: { action, files: [...paths, ...assetPaths].slice(0, 40), fileCount: paths.length + assetPaths.length },
      },
    };
  }
  if (action === "read") {
    if (!path) return { ok: false, subtitle: "Missing path", text: "read needs a path argument." };
    const asset = workspace.assets[path];
    if (asset) {
      return {
        ok: true,
        subtitle: `Read ${path} (image)`,
        text: `${path} is a binary image asset (${asset.mime}, ${Math.round((asset.data.length * 3) / 4 / 1024)} KB). Use inspect_image to actually view its contents.`,
        resultData: { kind: "files", payload: { action, path, image: true } },
      };
    }
    const content = workspace.files[path];
    if (content === undefined) {
      return { ok: false, subtitle: `${path} not found`, text: `No file at "${path}". Use action list to see the workspace.` };
    }
    return {
      ok: true,
      subtitle: `Read ${path} (${content.length} bytes)`,
      text: `${path} (${content.length} bytes):\n\n${content.slice(0, 8000)}${content.length > 8000 ? "\n… (truncated)" : ""}`,
      resultData: { kind: "files", payload: { action, path, bytes: content.length } },
    };
  }
  if (action === "write") {
    if (!path) return { ok: false, subtitle: "Missing path", text: "write needs a path argument." };
    const content = str(args, "content");
    if (!content) return { ok: false, subtitle: "Missing content", text: "write needs the content argument." };
    // Image paths with decodable image content become binary workspace
    // assets — previewable in the app and viewable by inspect_image.
    if (IMAGE_EXT_RE.test(path)) {
      const asset = parseImageContent(path, content);
      if (asset) {
        await writeAssets(ctx.workspaceId, { [path]: asset });
        // Drop any stale text-file twin of the same path.
        if (path in workspace.files) await deleteFile(ctx.workspaceId, path);
        await syncRunningPreviews(ctx.workspaceId);
        const kb = Math.round((asset.data.length * 3) / 4 / 1024);
        return {
          ok: true,
          subtitle: `Wrote ${path}`,
          text: `Stored image ${path} (${asset.mime}, ${kb} KB) as a workspace asset. It is viewable in previews and inspect_image can analyze it.`,
          resultData: { kind: "files", payload: { action, path, image: true } },
        };
      }
      // Not decodable image data — fall through to a plain text write so
      // nothing is silently dropped.
    }
    const updatedWorkspace = await writeFiles(ctx.workspaceId, { [path]: content });
    await syncRunningPreviews(ctx.workspaceId);
    const entry = pickPreviewEntry(updatedWorkspace);
    const entryNote =
      /\.html?$/i.test(path) && entry && entry !== path
        ? ` Note: the live preview serves "${entry}" — write the real page there (workspace root, not a subfolder) so the user sees it.`
        : "";
    return {
      ok: true,
      subtitle: `Wrote ${path}`,
      text: `Wrote ${content.length} bytes to ${path}. Running previews now serve the latest workspace files — the user just refreshes the Preview tab to see them.${entryNote}`,
      resultData: { kind: "files", payload: { action, path, bytes: content.length } },
    };
  }
  if (action === "delete") {
    if (!path) return { ok: false, subtitle: "Missing path", text: "delete needs a path argument." };
    const removed = await deleteFile(ctx.workspaceId, path);
    if (removed) await syncRunningPreviews(ctx.workspaceId);
    return removed
      ? { ok: true, subtitle: `Deleted ${path}`, text: `Deleted ${path}. Running previews were updated to the new workspace state.` }
      : { ok: false, subtitle: `${path} not found`, text: `No file at "${path}".` };
  }
  return { ok: false, subtitle: `Unknown action "${action}"`, text: `Unknown action "${action}". Use list | read | write | delete.` };
}

async function toolStartPreview(args: Args, ctx: ToolContext): Promise<ToolExecutionResult> {
  const name = str(args, "name") || undefined;
  const outcome = await startPreviewSession(ctx.workspaceId, name);
  if (!outcome.ok) {
    return { ok: false, subtitle: "Could not start preview", text: outcome.error };
  }
  const sessionName = name || "Preview";
  return {
    ok: true,
    subtitle: `Preview running · ${sessionName}`,
    text: `Live preview is running at ${outcome.url} (session ${outcome.sessionId}). This app has exactly one preview project — re-calling start_preview refreshes it with the latest files. Tell the user they can open the Preview tab — the page is embedded there and can be opened in a new tab.`,
    resultData: { kind: "preview", payload: { sessionId: outcome.sessionId, name: sessionName, url: outcome.url, status: "running" } },
  };
}

async function toolManagePreview(args: Args, ctx: ToolContext): Promise<ToolExecutionResult> {
  const action = str(args, "action", "list");
  const sessionId = str(args, "sessionId");

  if (action === "list") {
    const sessions = await listPreviewSessions(ctx.workspaceId);
    return {
      ok: true,
      subtitle: `${sessions.length} preview session${sessions.length === 1 ? "" : "s"}`,
      text: sessions.length === 0 ? "No preview sessions yet." : sessions.map((s) => `- ${s.sessionId} · ${s.name} · ${s.status} · ${s.url}`).join("\n"),
      resultData: {
        kind: "preview_list",
        payload: { sessions: sessions.slice(0, 10).map((s) => ({ sessionId: s.sessionId, name: s.name, url: s.url, status: s.status })) },
      },
    };
  }
  if (action === "stop") {
    if (!sessionId) return { ok: false, subtitle: "Missing sessionId", text: "stop needs the sessionId argument." };
    const outcome = await stopPreviewSession(ctx.workspaceId, sessionId);
    return outcome.ok
      ? { ok: true, subtitle: `Stopped ${sessionId}`, text: `Preview session ${sessionId} stopped.` }
      : { ok: false, subtitle: "Stop failed", text: outcome.error ?? "Stop failed." };
  }
  if (action === "check") {
    if (!sessionId) return { ok: false, subtitle: "Missing sessionId", text: "check needs the sessionId argument." };
    const outcome = await checkPreviewSession(ctx.workspaceId, sessionId);
    if (!outcome.ok && outcome.error) {
      return { ok: false, subtitle: "Check failed", text: outcome.error };
    }
    return {
      ok: outcome.ok,
      subtitle: outcome.status === 200 ? `Healthy (200)${outcome.title ? ` · ${outcome.title}` : ""}` : `HTTP ${outcome.status ?? "unreachable"}`,
      text: `Preview ${sessionId} responded ${outcome.status ?? "unreachable"}.${outcome.title ? ` Title: "${outcome.title}".` : ""}`,
    };
  }
  return { ok: false, subtitle: `Unknown action "${action}"`, text: `Unknown action "${action}". Use list | stop | check.` };
}

async function toolStartWebSession(args: Args, ctx: ToolContext): Promise<ToolExecutionResult> {
  let url = str(args, "url");
  const wantScreenshot = args.screenshot === true || args.screenshot === "true";

  if (!url) {
    const rows = await previewSessionsFor(ctx.workspaceId);
    const running = rows.find((r) => r.status === "running");
    url = running ? `${PREVIEW_BRIDGE}${running.url.split("?")[0]}` : "";
  } else if (!/^https?:\/\//i.test(url)) {
    // The model often copies the gateway-relative preview path
    // ("/preview/<sid>/…?XTransformPort=3212"). Resolve it against the
    // preview service so the headless browser gets a real URL.
    const path = url.startsWith("/") ? url : `/${url}`;
    url = `${PREVIEW_BRIDGE}${path.split("?")[0]}`;
  }
  if (!url) {
    return {
      ok: false,
      subtitle: "No URL to open",
      text: "Provide a url argument, or start a preview first (the session defaults to the latest running preview).",
    };
  }

  const sessionId = `ws-${id()}`;
  const record: WebSessionRecord = {
    id: sessionId,
    url,
    title: "",
    status: null,
    excerpt: "",
    links: [],
    createdAt: Date.now(),
  };
  webSessions.set(sessionId, record);
  if (webSessions.size > 30) {
    // Keep the newest 30 sessions.
    const oldest = [...webSessions.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) webSessions.delete(oldest.id);
  }

  try {
    const { html, status } = await fetchPage(url);
    record.status = status;
    record.title = extractTitle(html);
    record.excerpt = textExcerpt(html);
    record.links = extractLinks(html);

    if (wantScreenshot) {
      await queueBrowser(async () => {
        if (ctx.signal.aborted) return;
        mkdirSync(SHOT_DIR, { recursive: true });
        await execBrowser(["set", "viewport", "1280", "800"], 15_000).catch(() => undefined);
        await execBrowser(["open", url], 30_000);
        const shotPath = join(SHOT_DIR, `${sessionId}.png`);
        await execBrowser(["screenshot", shotPath], 30_000);
        record.screenshotUrl = `/api/code/asset?id=${sessionId}`;
        await execBrowser(["close"], 10_000).catch(() => undefined);
        // Register the capture into the workspace as an image asset so the
        // model can actually VIEW it (inspect_image) and previews can serve it.
        try {
          const bytes = readFileSync(shotPath);
          const sniffed = sniffImageMime(new Uint8Array(bytes)) ?? "image/png";
          await writeAssets(ctx.workspaceId, {
            [`screenshots/${sessionId}.png`]: { mime: sniffed, data: bytes.toString("base64") },
          });
          await syncRunningPreviews(ctx.workspaceId);
        } catch {
          // The screenshot file itself is still served by the asset route.
        }
      });
    }

    const summary = [
      `Web session ${sessionId} opened ${url}`,
      `HTTP status: ${record.status ?? "unreachable"}`,
      record.title ? `Page title: "${record.title}"` : "",
      record.excerpt ? `Text snapshot: ${record.excerpt}` : "",
      record.links.length > 0 ? `Links (${record.links.length}): ${record.links.slice(0, 8).join(", ")}` : "",
      record.screenshotUrl ? `Screenshot captured: ${record.screenshotUrl} — view it yourself with inspect_image (path "screenshots/${sessionId}.png").` : "",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      ok: record.status !== null && record.status < 400,
      subtitle: record.title ? `Session · "${record.title}"` : `Session · ${record.status ?? "no response"}`,
      text: summary,
      resultData: {
        kind: "web_session",
        payload: {
          sessionId,
          url,
          status: record.status,
          title: record.title,
          excerpt: record.excerpt.slice(0, 400),
          screenshotUrl: record.screenshotUrl ?? null,
          links: record.links.slice(0, 6),
        },
      },
    };
  } catch (error) {
    return {
      ok: false,
      subtitle: "Web session failed",
      text: `Web session failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function toolManageDatabase(args: Args, ctx: ToolContext): Promise<ToolExecutionResult> {
  const action = str(args, "action", "list");
  const key = str(args, "key");

  if (action === "list") {
    const rows = await db.codeRecord.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: { updatedAt: "desc" },
    });
    return {
      ok: true,
      subtitle: `${rows.length} record${rows.length === 1 ? "" : "s"}`,
      text: rows.length === 0 ? "No records yet." : rows.map((r) => `- ${r.key} (${r.kind}, updated ${r.updatedAt.toISOString()})`).join("\n"),
      resultData: {
        kind: "database",
        payload: { action, keys: rows.slice(0, 20).map((r) => r.key) },
      },
    };
  }
  if (action === "get") {
    if (!key) return { ok: false, subtitle: "Missing key", text: "get needs the key argument." };
    const row = await db.codeRecord.findUnique({ where: { workspaceId_key: { workspaceId: ctx.workspaceId, key } } });
    if (!row) return { ok: false, subtitle: `${key} not found`, text: `No record at key "${key}".` };
    return {
      ok: true,
      subtitle: `Read ${key}`,
      text: `${key} = ${row.data}`.slice(0, 6000),
      resultData: { kind: "database", payload: { action, key, data: row.data.slice(0, 2000) } },
    };
  }
  if (action === "set") {
    if (!key) return { ok: false, subtitle: "Missing key", text: "set needs the key argument." };
    const hasData = "data" in args;
    if (!hasData) return { ok: false, subtitle: "Missing data", text: "set needs the data argument (any JSON value)." };
    const serialized = JSON.stringify(args.data ?? null);
    if (serialized.length > 60_000) {
      return { ok: false, subtitle: "Record too large", text: "Records are capped at 60KB." };
    }
    await db.codeRecord.upsert({
      where: { workspaceId_key: { workspaceId: ctx.workspaceId, key } },
      create: { workspaceId: ctx.workspaceId, key, kind: "document", data: serialized },
      update: { data: serialized },
    });
    return {
      ok: true,
      subtitle: `Saved ${key}`,
      text: `Record "${key}" saved. It is visible in the workspace Database tab.`,
      resultData: { kind: "database", payload: { action, key } },
    };
  }
  if (action === "delete") {
    if (!key) return { ok: false, subtitle: "Missing key", text: "delete needs the key argument." };
    try {
      await db.codeRecord.delete({ where: { workspaceId_key: { workspaceId: ctx.workspaceId, key } } });
      return { ok: true, subtitle: `Deleted ${key}`, text: `Record "${key}" deleted.` };
    } catch {
      return { ok: false, subtitle: `${key} not found`, text: `No record at key "${key}".` };
    }
  }
  return { ok: false, subtitle: `Unknown action "${action}"`, text: `Unknown action "${action}". Use list | get | set | delete.` };
}

/* ------------------------------------------------------------------ */
/* inspect_image — real vision on workspace / disk images              */
/* ------------------------------------------------------------------ */

/** Hard cap for what we hand to the vision API (~6 MB decoded). */
const IMAGE_MAX_BYTES = 6 * 1024 * 1024;

/** Where SVGs are rasterized through the headless browser before vision. */
const VISION_TMP_DIR = join(process.cwd(), "db", "vision-tmp");

/**
 * Vision APIs reject SVG data URLs — rasterize the SVG through the shared
 * headless browser so the vision model receives real PNG pixels. Returns
 * null when rasterization fails (the caller then reports an honest error).
 */
async function rasterizeSvg(svgText: string): Promise<Uint8Array | null> {
  const width = clampDim(/<svg[^>]*\bwidth\s*=\s*["'](\d+)/i.exec(svgText)?.[1]);
  const height = clampDim(/<svg[^>]*\bheight\s*=\s*["'](\d+)/i.exec(svgText)?.[1]);
  const id = `svg-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(VISION_TMP_DIR, { recursive: true });
  const htmlPath = join(VISION_TMP_DIR, `${id}.html`);
  const pngPath = join(VISION_TMP_DIR, `${id}.png`);
  try {
    writeFileSync(
      htmlPath,
      `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;overflow:hidden;background:#fff}svg{display:block}</style>${svgText}`,
      "utf8",
    );
    await queueBrowser(async () => {
      await execBrowser(["set", "viewport", String(width), String(height)], 15_000).catch(
        () => undefined,
      );
      await execBrowser(["open", `file://${htmlPath}`], 30_000);
      await execBrowser(["screenshot", pngPath], 30_000);
      await execBrowser(["close"], 10_000).catch(() => undefined);
    });
    if (!existsSync(pngPath)) return null;
    const bytes = new Uint8Array(readFileSync(pngPath));
    return sniffImageMime(bytes) ? bytes : null;
  } catch {
    return null;
  } finally {
    try {
      rmSync(htmlPath, { force: true });
      rmSync(pngPath, { force: true });
    } catch {
      // Temp cleanup is best-effort.
    }
  }
}

function clampDim(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? "512", 10);
  if (!Number.isFinite(n) || n <= 0) return 512;
  return Math.min(Math.max(n, 32), 1024);
}

interface ResolvedImage {
  bytes: Uint8Array;
  mime: string;
  /** Display path for the card + messages. */
  label: string;
  /** Browsable src for the tool card thumbnail. */
  src: string | null;
}

/**
 * Resolve an image reference the agent may use:
 *  - "screenshots/<webSessionId>.png" or any workspace asset path
 *  - "screenshot:<webSessionId>" (disk capture, not yet an asset)
 *  - a workspace text file that holds base64/data-URL image data
 * Everything is strictly workspace-scoped — no arbitrary host paths.
 */
async function resolveWorkspaceImage(
  workspaceId: string,
  rawPath: string,
): Promise<ResolvedImage | { error: string }> {
  const workspace = await getWorkspace(workspaceId);
  const trimmed = rawPath.trim().replace(/^(\.\/)+/, "");

  // 1. Explicit screenshot reference (disk).
  const shotRef = /^screenshot:([a-zA-Z0-9_-]{1,64})$/.exec(trimmed);
  if (shotRef) {
    const shotId = shotRef[1];
    const shotPath = join(SHOT_DIR, `${shotId}.png`);
    if (!shotPath.startsWith(SHOT_DIR) || !existsSync(shotPath)) {
      return { error: `no screenshot "${shotId}" exists (check the web-session id)` };
    }
    const bytes = new Uint8Array(readFileSync(shotPath));
    return {
      bytes,
      mime: sniffImageMime(bytes) ?? "image/png",
      label: `screenshot:${shotId}`,
      src: `/api/code/asset?id=${shotId}`,
    };
  }

  // Path normalization — workspace boundary is absolute (no ../ escapes,
  // no absolute host paths).
  const path = trimmed.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!path || path.startsWith("..") || path.includes("/../")) {
    return { error: `"${rawPath}" escapes the workspace — only workspace image paths are allowed` };
  }

  // 2. A stored binary asset.
  const asset = workspace.assets[path];
  if (asset) {
    const bytes = base64ToBytes(asset.data);
    if (bytes) {
      return {
        bytes,
        mime: asset.mime,
        label: path,
        src: `/api/code/asset?workspace=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(path)}`,
      };
    }
  }

  // 3. A text file whose content IS image data (base64 / data URL).
  const fileContent = workspace.files[path];
  if (typeof fileContent === "string") {
    const parsed = parseImageContent(path, fileContent);
    if (parsed) {
      const bytes = base64ToBytes(parsed.data);
      if (bytes) {
        return {
          bytes,
          mime: parsed.mime,
          label: path,
          src: `/api/code/asset?workspace=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(path)}`,
        };
      }
    }
    return { error: `"${path}" exists but is not image data` };
  }

  // 4. Maybe it's a screenshot basename or a screenshots/ path on disk.
  const shotBase = /(?:^|\/)([a-zA-Z0-9_-]{1,64})\.png$/.exec(path);
  if (shotBase && (path.startsWith("screenshots/") || path.startsWith("web-sessions/"))) {
    const shotPath = join(SHOT_DIR, `${shotBase[1]}.png`);
    if (existsSync(shotPath)) {
      const bytes = new Uint8Array(readFileSync(shotPath));
      return {
        bytes,
        mime: sniffImageMime(bytes) ?? "image/png",
        label: path,
        src: `/api/code/asset?id=${shotBase[1]}`,
      };
    }
  }

  return { error: `no image at "${path}" in this workspace` };
}

/** Every image the agent could ask to see right now (workspace assets +
 *  captured screenshots) — powers the no-path listing. */
async function listAvailableImages(workspaceId: string): Promise<string[]> {
  const workspace = await getWorkspace(workspaceId);
  const lines: string[] = [];
  for (const p of Object.keys(workspace.assets).sort()) {
    const a = workspace.assets[p];
    lines.push(`- ${p} (${a.mime}, ${Math.round((a.data.length * 3) / 4 / 1024)} KB)`);
  }
  try {
    const shots = readdirSync(SHOT_DIR)
      .filter((f) => f.endsWith(".png"))
      .sort()
      .slice(-8)
      .reverse();
    for (const s of shots) lines.push(`- screenshot:${s.replace(/\.png$/, "")} (captured web-session screenshot)`);
  } catch {
    // No screenshots dir yet.
  }
  return lines;
}

async function toolInspectImage(args: Args, ctx: ToolContext): Promise<ToolExecutionResult> {
  const rawPath = str(args, "path").trim();
  const question =
    str(args, "question").trim() ||
    "Describe this image precisely: overall layout, visible text, colors, and anything notable.";

  // No path → list what can be inspected.
  if (!rawPath) {
    const lines = await listAvailableImages(ctx.workspaceId);
    return {
      ok: true,
      subtitle: `${lines.length} image${lines.length === 1 ? "" : "s"} available`,
      text:
        lines.length === 0
          ? "No images are available yet. Images land here when one is written to the workspace (manage_files write of base64 to an image path) or captured via start_web_session with screenshot: true."
          : `Images available to inspect:\n${lines.join("\n")}\n\nCall inspect_image again with one of these paths.`,
      resultData: { kind: "image_list", payload: { count: lines.length } },
    };
  }

  // Resolve the actual bytes — the model must never "see" an image that
  // could not be loaded.
  const resolved = await resolveWorkspaceImage(ctx.workspaceId, rawPath);
  if ("error" in resolved) {
    return {
      ok: false,
      subtitle: `Image unavailable — ${rawPath}`,
      text: `Image unavailable.\nPath: ${rawPath}\nReason: ${resolved.error}.\nNothing was analyzed — do not claim you can see this image. Call inspect_image with no path to list what exists.`,
    };
  }
  if (resolved.bytes.length > IMAGE_MAX_BYTES) {
    const kb = Math.round(resolved.bytes.length / 1024);
    return {
      ok: false,
      subtitle: `Image too large — ${rawPath}`,
      text: `Image "${rawPath}" is ${kb} KB — over the ${Math.round(IMAGE_MAX_BYTES / 1024)} KB inspection limit. Write a smaller version (or a downscaled copy) and try again. Nothing was analyzed.`,
    };
  }

  // Actual vision call — the image content truly reaches the model. SVGs
  // are rasterized to PNG first (vision APIs reject vector data URLs).
  try {
    const zai = await getZai();
    let visionBytes = resolved.bytes;
    let visionMime = resolved.mime;
    if (resolved.mime === "image/svg+xml") {
      const raster = await rasterizeSvg(Buffer.from(resolved.bytes).toString("utf8"));
      if (!raster) {
        return {
          ok: false,
          subtitle: `Rasterization failed — ${rawPath}`,
          text: `Image "${rawPath}" is an SVG and could not be rasterized for vision analysis. Nothing was seen — do not describe it. (The SVG itself still works in previews.)`,
        };
      }
      visionBytes = raster;
      visionMime = "image/png";
    }
    const dataUrl = `data:${visionMime};base64,${Buffer.from(visionBytes).toString("base64")}`;
    const response = await zai.chat.completions.createVision({
      model: "glm-4.6v",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `You are the eyes of a coding agent. ${question} Be factual and specific — if asked about layout or design, describe exactly what is visible. If the image is blank, corrupt or unreadable, say so explicitly.`,
            },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      thinking: { type: "disabled" },
    });
    const description =
      response.choices?.[0]?.message?.content?.trim() ??
      "(the vision model returned no description)";
    const kb = Math.round(resolved.bytes.length / 1024);
    return {
      ok: true,
      subtitle: `Analyzed ${resolved.label}`,
      text: `Image ${resolved.label} (${resolved.mime}${visionMime !== resolved.mime ? ` → ${visionMime} for vision` : ""}, ${kb} KB) — vision analysis:\n\n${description}\n\n(You have now genuinely seen this image; describe it to the user in your own words as needed.)`,
      resultData: {
        kind: "image",
        payload: {
          path: resolved.label,
          mime: resolved.mime,
          bytes: resolved.bytes.length,
          src: resolved.src,
          question,
        },
      },
    };
  } catch (error) {
    return {
      ok: false,
      subtitle: `Vision failed — ${rawPath}`,
      text: `Image "${rawPath}" was found (${resolved.mime}) but the vision model could not analyze it: ${
        error instanceof Error ? error.message : String(error)
      }. Nothing was seen — do not describe the image.`,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export const CODE_TOOLS: Record<string, (args: Args, ctx: ToolContext) => Promise<ToolExecutionResult>> = {
  create_app: toolCreateApp,
  manage_files: toolManageFiles,
  start_preview: toolStartPreview,
  manage_preview: toolManagePreview,
  start_web_session: toolStartWebSession,
  inspect_image: toolInspectImage,
  manage_database: toolManageDatabase,
};

export async function executeCodeTool(
  name: string,
  args: Args,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const handler = CODE_TOOLS[name];
  if (!handler) {
    return {
      ok: false,
      subtitle: `Unknown tool "${name}"`,
      text: `Unknown tool "${name}". Available tools: ${Object.keys(CODE_TOOLS).join(", ")}.`,
    };
  }
  try {
    if (ctx.signal.aborted) {
      return { ok: false, subtitle: "Cancelled", text: "The turn was cancelled before this tool ran." };
    }
    return await handler(args, ctx);
  } catch (error) {
    return {
      ok: false,
      subtitle: `${name} failed`,
      text: `Tool ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function getWebSession(sessionId: string): WebSessionRecord | undefined {
  return webSessions.get(sessionId);
}

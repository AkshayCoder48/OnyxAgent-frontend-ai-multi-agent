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
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { db } from "@/lib/db";
import { FRAMEWORKS, scaffoldApp, slugify } from "./code-scaffolds";
import {
  getWorkspace,
  replaceWorkspace,
  writeFiles,
  deleteFile,
  workspaceSummary,
  type Workspace,
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
- manage_files — edit the workspace. args: action (list | read | write | delete), path, content (for write). For STATIC sites write the real requested page to index.html at the WORKSPACE ROOT (the live preview serves exactly that file). For app frameworks (nextjs, vite-react) keep preview/index.html a self-contained mirror of the page (inline CSS, no external assets) and update it whenever the page design changes. Running previews pick up file changes automatically.
- start_preview — serve the workspace as a live preview URL. args: name (optional). Returns the public URL; tell the user to open the Preview tab.
- manage_preview — args: action (list | stop | check), sessionId (for stop/check).
- start_web_session — open a real headless browser against a URL (defaults to the latest preview). args: url (optional — an absolute URL or the preview path from a start_preview result), screenshot (boolean, optional — takes a PNG).
- manage_database — read/write the workspace database (also shown in the Database tab). args: action (list | get | set | delete), key, data (any JSON, for set).

Tool protocol rules — FOLLOW THESE EXACTLY:
1. End tool work with ONE fenced onyxtool block as the LAST thing you write. The block holds either a single call {"tool": …, "args": …} or a JSON ARRAY of calls executed in order — e.g. the page write AND start_preview together: [{"tool": "manage_files", …}, {"tool": "start_preview", …}]. Stop right after the block — results come back as TOOL RESULT messages and you continue then.
2. The block content must be valid JSON. No prose inside the fence. ALWAYS fill in the args (never leave them empty when the tool takes a name/framework/path).
3. NEVER announce or describe a tool action in prose without emitting its block in the SAME reply. Writing "I'll start the preview now" or "I've updated the file" without the matching block is a protocol violation — the action will not happen.
4. NEVER invent, predict or quote a tool result. Results only ever arrive as [TOOL RESULT] messages after you emit a block. If you have not emitted the block, nothing has happened — do not claim it has.
5. When no more tool work is needed, write your final answer with NO tool block — and never promise future tool actions in it.`;
}

export function workspaceContextText(workspaceId: string): Promise<string> {
  return getWorkspace(workspaceId).then((workspace) => workspaceSummary(workspace));
}

/* ------------------------------------------------------------------ */
/* Preview bridge (mini-service on :3212)                              */
/* ------------------------------------------------------------------ */

async function bridgeRegister(sessionId: string, name: string, files: Record<string, string>, entry: string): Promise<string | null> {
  try {
    const response = await fetch(`${PREVIEW_BRIDGE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: sessionId, name, files, entry }),
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
  const isPlaceholder = (p: string) => PLACEHOLDER_RE.test(files[p] ?? "");
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
    const url = await bridgeRegister(row.id, row.name, workspace.files, entry);
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
  const sessionId = `pv-${id()}`;
  const url = await bridgeRegister(sessionId, sessionName, workspace.files, entry);
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
    return {
      ok: true,
      subtitle: `${paths.length} file${paths.length === 1 ? "" : "s"} in workspace`,
      text: paths.length === 0 ? "The workspace is empty." : `Workspace files:\n${paths.map((p) => `- ${p} (${workspace.files[p].length} bytes)`).join("\n")}`,
      resultData: { kind: "files", payload: { action, files: paths.slice(0, 40), fileCount: paths.length } },
    };
  }
  if (action === "read") {
    if (!path) return { ok: false, subtitle: "Missing path", text: "read needs a path argument." };
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
    const workspace = await writeFiles(ctx.workspaceId, { [path]: content });
    await syncRunningPreviews(ctx.workspaceId);
    const entry = pickPreviewEntry(workspace);
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
    text: `Live preview is running at ${outcome.url} (session ${outcome.sessionId}). Tell the user they can open the Preview tab — the page is embedded there and can be opened in a new tab.`,
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
      });
    }

    const summary = [
      `Web session ${sessionId} opened ${url}`,
      `HTTP status: ${record.status ?? "unreachable"}`,
      record.title ? `Page title: "${record.title}"` : "",
      record.excerpt ? `Text snapshot: ${record.excerpt}` : "",
      record.links.length > 0 ? `Links (${record.links.length}): ${record.links.slice(0, 8).join(", ")}` : "",
      record.screenshotUrl ? `Screenshot captured: ${record.screenshotUrl}` : "",
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
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export const CODE_TOOLS: Record<string, (args: Args, ctx: ToolContext) => Promise<ToolExecutionResult>> = {
  create_app: toolCreateApp,
  manage_files: toolManageFiles,
  start_preview: toolStartPreview,
  manage_preview: toolManagePreview,
  start_web_session: toolStartWebSession,
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

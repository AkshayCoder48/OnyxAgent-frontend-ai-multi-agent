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
- create_app — scaffold a fresh project. args: framework (nextjs | vite-react | fastapi | node | static | cli), name (required, from the user's request), description.
- manage_files — edit the workspace. args: action (list | read | write | delete), path, content (for write). ALWAYS write preview/index.html (self-contained HTML, inline CSS) so the preview stays alive.
- start_preview — serve the workspace as a live preview URL. args: name (optional). Returns the public URL; tell the user to open the Preview tab.
- manage_preview — args: action (list | stop | check), sessionId (for stop/check).
- start_web_session — open a real headless browser against a URL (defaults to the latest preview). args: url (optional — an absolute URL or the preview path from a start_preview result), screenshot (boolean, optional — takes a PNG).
- manage_database — read/write the workspace database (also shown in the Database tab). args: action (list | get | set | delete), key, data (any JSON, for set).

Tool protocol rules — FOLLOW THESE EXACTLY:
1. AT MOST ONE tool block per reply, and it must be the LAST thing you write. Stop right after the block — the result comes back to you as a TOOL RESULT message and you continue then.
2. The block content must be valid JSON. No prose inside the fence. ALWAYS fill in the args (never leave them empty when the tool takes a name/framework/path).
3. NEVER announce a tool action in prose without emitting its block in the SAME reply. Writing "I'll start the preview now" without the \`\`\`onyxtool block is a protocol violation — the action will not happen. Either emit the block, or don't mention the action.
4. Never invent tool results. Wait for the real ones.
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
  return rows.map((r) => ({
    sessionId: r.id,
    name: r.name,
    url: r.url,
    status: r.status,
    entry: r.entry,
    createdAt: r.createdAt.getTime(),
  }));
}

export async function startPreviewSession(
  workspaceId: string,
  name?: string,
): Promise<{ ok: true; sessionId: string; url: string } | { ok: false; error: string }> {
  const workspace = await getWorkspace(workspaceId);
  const sessionName = name || workspace.appMeta.name || "Preview";
  const entry = workspace.files["preview/index.html"]
    ? "preview/index.html"
    : workspace.files["index.html"]
      ? "index.html"
      : null;
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
  const paths = Object.keys(workspace.files).sort();
  return {
    ok: true,
    subtitle: `Scaffolded ${FRAMEWORKS.find((f) => f.id === framework)?.label} · ${paths.length} files`,
    text: `Project "${slugify(name)}" (${framework}) scaffolded into the workspace. Files:\n${paths.map((p) => `- ${p}`).join("\n")}\n\nA self-contained preview page ships at preview/index.html. Next step: call start_preview to get a live URL for the user.`,
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
    await writeFiles(ctx.workspaceId, { [path]: content });
    return {
      ok: true,
      subtitle: `Wrote ${path}`,
      text: `Wrote ${content.length} bytes to ${path}. The live preview serves the latest workspace state — refresh it to see the change.`,
      resultData: { kind: "files", payload: { action, path, bytes: content.length } },
    };
  }
  if (action === "delete") {
    if (!path) return { ok: false, subtitle: "Missing path", text: "delete needs a path argument." };
    const removed = await deleteFile(ctx.workspaceId, path);
    return removed
      ? { ok: true, subtitle: `Deleted ${path}`, text: `Deleted ${path}.` }
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

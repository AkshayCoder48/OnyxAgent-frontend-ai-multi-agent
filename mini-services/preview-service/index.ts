/**
 * OnyxCode preview service — serves live preview sessions for scaffolded apps.
 *
 * The Next.js app (chat tools + Preview tab UI) registers a session here with
 * the workspace's files; this service serves them at
 * `/preview/{sessionId}/{path}?XTransformPort=3212` so the browser reaches it
 * through the sandbox gateway (single exposed port). HTML/CSS references are
 * rewritten so every sub-resource request also carries the gateway query.
 *
 * Sessions persist to sessions.json (write-through) so a service restart
 * keeps previews alive.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve as resolvePath, normalize, sep } from "node:path";

const PORT = 3212;
const DATA_DIR = import.meta.dir;
const SESSIONS_FILE = join(DATA_DIR, "sessions.json");

interface Asset {
  mime: string;
  /** base64-encoded bytes. */
  data: string;
}

interface Session {
  id: string;
  name: string;
  files: Record<string, string>;
  /** Binary images (workspace assets) served at their paths. */
  assets: Record<string, Asset>;
  entry: string;
  status: "running" | "stopped";
  createdAt: number;
  /** Bumped on every (re-)register — clients live-reload on change. */
  revision: number;
}

/** id -> session */
const sessions = new Map<string, Session>();

function loadSessions(): void {
  try {
    if (!existsSync(SESSIONS_FILE)) return;
    const raw = JSON.parse(readFileSync(SESSIONS_FILE, "utf8")) as Session[];
    if (!Array.isArray(raw)) return;
    for (const s of raw) {
      if (!s?.id || typeof s.files !== "object" || s.files === null) continue;
      sessions.set(s.id, {
        id: s.id,
        name: typeof s.name === "string" ? s.name : s.id,
        files: s.files,
        assets:
          typeof s.assets === "object" && s.assets !== null && !Array.isArray(s.assets)
            ? (s.assets as Record<string, Asset>)
            : {},
        entry: typeof s.entry === "string" && s.entry.length > 0 ? s.entry : "preview/index.html",
        status: s.status === "stopped" ? "stopped" : "running",
        createdAt: typeof s.createdAt === "number" ? s.createdAt : Date.now(),
        revision: typeof s.revision === "number" ? s.revision : 1,
      });
    }
  } catch {
    // Corrupt store — start fresh rather than crash-loop.
  }
}

function persistSessions(): void {
  try {
    writeFileSync(SESSIONS_FILE, JSON.stringify([...sessions.values()]), "utf8");
  } catch {
    // Disk issues never take the server down.
  }
}

loadSessions();

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  map: "application/json",
  wasm: "application/wasm",
  csv: "text/csv",
  xml: "application/xml",
};

function contentType(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

const GATEWAY_QUERY = `XTransformPort=${PORT}`;

function isExternal(url: string): boolean {
  return (
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url.startsWith("//") ||
    url.startsWith("data:") ||
    url.startsWith("blob:") ||
    url.startsWith("mailto:") ||
    url.startsWith("tel:") ||
    url.startsWith("javascript:") ||
    url.startsWith("#")
  );
}

/** Resolve a reference (relative or absolute-path) against the current file. */
function resolveRef(currentFile: string, ref: string): string | null {
  try {
    const baseDir = currentFile.includes("/") ? currentFile.slice(0, currentFile.lastIndexOf("/") + 1) : "";
    const resolved = normalize(baseDir ? baseDir + ref : ref);
    const clean = resolved.replace(/\\/g, "/").replace(/^\.\//, "");
    if (clean.startsWith("..") || clean.includes("/../") || clean.startsWith("/")) {
      // Absolute paths are app-root-relative — allowed inside the session.
      const trimmed = clean.replace(/^\/+/, "");
      if (trimmed.includes("..")) return null;
      return trimmed;
    }
    return clean;
  } catch {
    return null;
  }
}

function withGatewayQuery(resolved: string): string {
  return `/preview/__SID__/${resolved}?${GATEWAY_QUERY}`;
}

/**
 * Rewrite src/href/poster/srcset attributes + CSS url(...) references so
 * every internal request carries the gateway port query. External URLs,
 * data: URIs and pure anchors are left untouched.
 */
function rewriteHtml(html: string, sessionId: string, currentFile: string): string {
  const rewrite = (ref: string): string => {
    if (!ref || isExternal(ref)) return ref;
    const hashless = ref.split("#")[0].split("?")[0];
    if (!hashless) return ref;
    const resolved = resolveRef(currentFile, hashless);
    if (!resolved) return ref;
    return `/preview/${sessionId}/${resolved}?${GATEWAY_QUERY}`;
  };

  return html
    .replace(/\s(src|href|poster|data-src)\s*=\s*"([^"]*)"/gi, (match, attr: string, value: string) => {
      return ` ${attr}="${rewrite(value)}"`;
    })
    .replace(/\s(src|href|poster|data-src)\s*=\s*'([^']*)'/gi, (match, attr: string, value: string) => {
      return ` ${attr}='${rewrite(value)}'`;
    })
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote: string, value: string) => {
      return `url(${quote}${rewrite(value)}${quote})`;
    });
}

function rewriteCss(css: string, sessionId: string, currentFile: string): string {
  const rewrite = (ref: string): string => {
    if (!ref || isExternal(ref)) return ref;
    const resolved = resolveRef(currentFile, ref.split("#")[0].split("?")[0]);
    if (!resolved) return ref;
    return `/preview/${sessionId}/${resolved}?${GATEWAY_QUERY}`;
  };
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote: string, value: string) => {
    return `url(${quote}${rewrite(value)}${quote})`;
  });
}

function pageHtml(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font-family: Georgia, 'Times New Roman', serif; background: #FAF6F0; color: #1A1A1A; }
  .card { max-width: 460px; padding: 40px 36px; text-align: center;
          background: #FFFDF9; border: 1px solid #E7DCCC; border-radius: 16px; }
  h1 { font-size: 22px; margin: 0 0 10px; }
  p { font-size: 14px; line-height: 1.6; color: #666666; margin: 0; }
  code { font-family: 'JetBrains Mono', monospace; font-size: 12px; background: #F4ECE1;
         padding: 2px 6px; border-radius: 6px; color: #A8421F; }
</style>
</head>
<body><div class="card"><h1>${title}</h1><p>${body}</p></div></body>
</html>`;
}

const notFound = (message: string) =>
  new Response(pageHtml("Preview", message), { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

const server = Bun.serve({
  port: PORT,
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);

    /* -------------------- control API (Next.js bridge) -------------- */

    if (request.method === "GET" && path === "/health") {
      return Response.json({ ok: true, sessions: sessions.size, port: PORT });
    }

    if (request.method === "GET" && path === "/list") {
      return Response.json({
        sessions: [...sessions.values()].map((s) => ({
          id: s.id,
          name: s.name,
          entry: s.entry,
          status: s.status,
          createdAt: s.createdAt,
          revision: s.revision,
        })),
      });
    }

    if (request.method === "POST" && (path === "/register" || path === "/stop")) {
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return Response.json({ error: "Invalid JSON body." }, { status: 400 });
      }
      const id = typeof body.id === "string" ? body.id.trim() : "";
      if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
        return Response.json({ error: "A valid session id is required." }, { status: 400 });
      }
      if (path === "/stop") {
        const session = sessions.get(id);
        if (session) {
          session.status = "stopped";
          persistSessions();
        }
        return Response.json({ ok: true, stopped: Boolean(session) });
      }
      const files =
        typeof body.files === "object" && body.files !== null && !Array.isArray(body.files)
          ? (body.files as Record<string, unknown>)
          : null;
      if (!files) {
        return Response.json({ error: "A files map is required." }, { status: 400 });
      }
      const cleanFiles: Record<string, string> = {};
      for (const [p, content] of Object.entries(files)) {
        if (typeof content !== "string") continue;
        const clean = p.replace(/\\/g, "/").replace(/^\/+/, "");
        if (!clean || clean.startsWith("..") || clean.includes("/../")) continue;
        cleanFiles[clean] = content;
      }
      const rawAssets =
        typeof body.assets === "object" && body.assets !== null && !Array.isArray(body.assets)
          ? (body.assets as Record<string, unknown>)
          : null;
      const cleanAssets: Record<string, Asset> = {};
      if (rawAssets) {
        for (const [p, asset] of Object.entries(rawAssets)) {
          const a = asset as { mime?: unknown; data?: unknown };
          if (typeof a?.mime !== "string" || typeof a?.data !== "string") continue;
          const clean = p.replace(/\\/g, "/").replace(/^\/+/, "");
          if (!clean || clean.startsWith("..") || clean.includes("/../")) continue;
          cleanAssets[clean] = { mime: a.mime, data: a.data };
        }
      }
      const entry =
        typeof body.entry === "string" && body.entry.length > 0
          ? body.entry.replace(/\\/g, "/").replace(/^\/+/, "")
          : cleanFiles["preview/index.html"]
            ? "preview/index.html"
            : "index.html";
      const existing = sessions.get(id);
      sessions.set(id, {
        id,
        name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : existing?.name ?? id,
        files: cleanFiles,
        assets: cleanAssets,
        entry,
        status: "running",
        createdAt: existing?.createdAt ?? Date.now(),
        revision: (existing?.revision ?? 0) + 1,
      });
      persistSessions();
      return Response.json({ ok: true, id, entry, url: `/preview/${id}/${entry}?${GATEWAY_QUERY}` });
    }

    /* -------------------- static serving ---------------------------- */

    const previewMatch = /^\/preview\/([a-zA-Z0-9_-]+)(\/.*)?$/.exec(path);
    if (previewMatch) {
      const [, sessionId, rest = ""] = previewMatch;
      const session = sessions.get(sessionId);
      if (!session) {
        return notFound("This preview session does not exist (it may have expired). Ask OnyxCode to start a new preview.");
      }
      if (session.status !== "running") {
        return new Response(pageHtml("Preview stopped", `The session <code>${sessionId}</code> was stopped. Ask OnyxCode to start it again.`), {
          status: 503,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      let rel = rest.replace(/^\/+/, "");
      if (!rel) {
        return Response.redirect(new URL(`/preview/${sessionId}/${session.entry}?${GATEWAY_QUERY}`, url.origin).toString(), 302);
      }
      rel = normalize(rel).replace(/\\/g, "/");
      if (rel.startsWith("..") || rel.includes("/../")) {
        return notFound("Path escapes the preview root.");
      }
      // Binary image assets — decoded bytes with their stored MIME type so
      // workspace images (screenshots, written images) work inside previews.
      const asset = session.assets[rel];
      if (asset) {
        const bytes = Buffer.from(asset.data, "base64");
        return new Response(new Uint8Array(bytes), {
          status: 200,
          headers: { "Content-Type": asset.mime, "Cache-Control": "no-store" },
        });
      }
      const file = session.files[rel] ?? (rel === session.entry ? session.files["preview/index.html"] : undefined);
      if (file === undefined) {
        return notFound(`No file <code>${rel}</code> in this preview. Ask OnyxCode to check the workspace.`);
      }
      const type = contentType(rel);
      let body = file;
      if (type.startsWith("text/html")) {
        body = rewriteHtml(file, sessionId, rel);
      } else if (type.startsWith("text/css")) {
        body = rewriteCss(file, sessionId, rel);
      }
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": type, "Cache-Control": "no-store" },
      });
    }

    return notFound("This is the OnyxCode preview service. Previews live under /preview/{sessionId}/…");
  },
});

console.log(`[preview-service] listening on http://localhost:${server.port}`);

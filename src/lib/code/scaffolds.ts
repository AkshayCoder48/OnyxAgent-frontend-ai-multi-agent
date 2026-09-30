"use client";

/**
 * OnyxCode app scaffolds (OnyxCode PRD §6 — `create_app`).
 *
 * Real, runnable project files for the priority frameworks. Each scaffold:
 *  - writes into /home/user/projects/<app-name> in the E2B sandbox,
 *  - has an optional install command (run foreground by start_preview),
 *  - has a server command that binds 0.0.0.0 (required for the public
 *    https://{sandboxId}-{port}.e2b.dev preview URL),
 *  - renders a polished, framework-native landing page titled with the
 *    app name so the live preview immediately looks like a real app.
 */

export interface ScaffoldFile {
  path: string;
  content: string;
}

export interface CodeScaffold {
  key: string;
  label: string;
  description: string;
  port: number;
  /** Run before the server (null = no install step). */
  installCommand: string | null;
  /** The dev-server command (must bind 0.0.0.0). null = no preview server. */
  serverCommand: ((appName: string, port: number) => string) | null;
  /** Working directory for install/server (relative to /home/user). */
  cwd: (appName: string) => string;
  files: (appName: string, description?: string) => ScaffoldFile[];
}

export const SCAFFOLD_KEYS = ["nextjs", "vite-react", "fastapi", "node", "static", "cli"] as const;
export type ScaffoldKey = (typeof SCAFFOLD_KEYS)[number];

/** Normalize a user/model-provided app name into a safe folder/package name. */
export function normalizeAppName(raw: string | undefined | null): string {
  const base = (raw || "my-app")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "my-app";
}

export function projectDir(appName: string): string {
  return `/home/user/projects/${appName}`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* ------------------------------------------------------------------ */
/* Shared page shell (warm editorial look, framework-accented)          */
/* ------------------------------------------------------------------ */

function heroTitle(appName: string): string {
  // "my-cool-app" → "My Cool App"
  return appName
    .split("-")
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

function htmlPage(opts: {
  appName: string;
  framework: string;
  accent: string;
  accentSoft: string;
  bg: string;
  fg: string;
  description?: string;
  extra?: string;
}): string {
  const title = heroTitle(opts.appName);
  const sub =
    opts.description?.trim() ||
    `A ${opts.framework} app scaffolded by OnyxCode — edit the files in the sandbox and the preview updates live.`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: ${opts.bg}; color: ${opts.fg};
    min-height: 100vh; display: flex; flex-direction: column; align-items: center;
  }
  .wrap { width: 100%; max-width: 880px; padding: 72px 24px 64px; }
  .badge {
    display: inline-flex; align-items: center; gap: 8px;
    background: ${opts.accentSoft}; color: ${opts.accent};
    border: 1px solid ${opts.accent}33; border-radius: 999px;
    padding: 6px 14px; font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
  }
  h1 { font-size: clamp(34px, 6vw, 56px); line-height: 1.05; letter-spacing: -0.03em; margin: 22px 0 14px; font-weight: 800; }
  h1 span { color: ${opts.accent}; }
  p.sub { font-size: 17px; line-height: 1.6; opacity: .78; max-width: 560px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-top: 40px; }
  .card { background: ${opts.fg}0d; border: 1px solid ${opts.fg}1a; border-radius: 14px; padding: 18px 18px 20px; }
  .card h3 { font-size: 14px; margin-bottom: 6px; display: flex; align-items: center; gap: 8px; }
  .card h3 .dot { width: 8px; height: 8px; border-radius: 50%; background: ${opts.accent}; }
  .card p { font-size: 13px; line-height: 1.55; opacity: .68; }
  .cta { margin-top: 40px; display: flex; gap: 12px; flex-wrap: wrap; }
  .cta a, .cta span.btn {
    display: inline-flex; align-items: center; gap: 8px; padding: 11px 20px; border-radius: 10px;
    font-size: 14px; font-weight: 600; text-decoration: none; cursor: default;
  }
  .cta .primary { background: ${opts.accent}; color: #fff; }
  .cta .ghost { border: 1px solid ${opts.fg}26; color: ${opts.fg}; opacity: .85; }
  footer { margin-top: auto; padding: 20px; font-size: 12px; opacity: .45; }
  code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: .9em; background: ${opts.fg}12; padding: 2px 7px; border-radius: 6px; }
</style>
</head>
<body>
  <main class="wrap">
    <span class="badge">${esc(opts.framework)} · OnyxCode</span>
    <h1>${esc(title)} <span>is live.</span></h1>
    <p class="sub">${esc(sub)}</p>
    <div class="cards">
      <div class="card"><h3><span class="dot"></span>Hot reload</h3><p>Edit the project files in the sandbox — the dev server picks up changes instantly.</p></div>
      <div class="card"><h3><span class="dot"></span>Sandboxed</h3><p>Running inside your E2B sandbox, served at a public preview URL.</p></div>
      <div class="card"><h3><span class="dot"></span>Agent-native</h3><p>Ask OnyxCode to add pages, styles, or API routes and watch them appear here.</p></div>
    </div>
    <div class="cta">
      <span class="btn primary">npm-ready project</span>
      <span class="btn ghost">served on port ${opts.extra ?? ""}</span>
    </div>
  </main>
  <footer>Scaffolded by OnyxCode (Beta) · <code>projects/${esc(opts.appName)}</code></footer>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ */
/* Scaffolds                                                           */
/* ------------------------------------------------------------------ */

const nextjs: CodeScaffold = {
  key: "nextjs",
  label: "Next.js",
  description: "Next.js 15 App Router project (React 19).",
  port: 3000,
  installCommand: "npm install --no-audit --no-fund --loglevel=error",
  serverCommand: (_n, port) => `npx next dev -p ${port} -H 0.0.0.0`,
  cwd: (appName) => projectDir(appName),
  files: (appName, description) => [
    {
      path: "package.json",
      content: JSON.stringify(
        {
          name: appName,
          private: true,
          version: "0.1.0",
          scripts: { dev: "next dev", build: "next build", start: "next start" },
          dependencies: { next: "^15.1.0", react: "^19.0.0", "react-dom": "^19.0.0" },
        },
        null,
        2,
      ),
    },
    { path: "next.config.mjs", content: `const nextConfig = {};\nexport default nextConfig;\n` },
    {
      path: "app/layout.tsx",
      content: `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: ${JSON.stringify(heroTitle(appName))}, description: "Scaffolded by OnyxCode" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
    },
    {
      path: "app/page.tsx",
      content: `export default function Home() {
  return (
    <main className="wrap">
      <span className="badge">Next.js · OnyxCode</span>
      <h1>${heroTitle(appName)} <span>is live.</span></h1>
      <p className="sub">${(description || "A Next.js app scaffolded by OnyxCode — edit files in the sandbox and this page updates live.").replace(/"/g, "&quot;")}</p>
      <div className="cards">
        <div className="card"><h3><span className="dot" />App Router</h3><p>Add routes under app/ and they appear instantly.</p></div>
        <div className="card"><h3><span className="dot" />React 19</h3><p>Server components, streaming, the works.</p></div>
        <div className="card"><h3><span className="dot" />Live preview</h3><p>Served from your E2B sandbox at a public URL.</p></div>
      </div>
    </main>
  );
}
`,
    },
    {
      path: "app/globals.css",
      content: `* { box-sizing: border-box; margin: 0; padding: 0; }
:root { color-scheme: dark; }
body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: #0b0d10; color: #f3f5f7; min-height: 100vh; display: flex; flex-direction: column; align-items: center; }
.wrap { width: 100%; max-width: 880px; padding: 72px 24px 64px; }
.badge { display: inline-flex; align-items: center; gap: 8px; background: #ffffff14; color: #fff; border: 1px solid #ffffff26; border-radius: 999px; padding: 6px 14px; font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
h1 { font-size: clamp(34px, 6vw, 56px); line-height: 1.05; letter-spacing: -0.03em; margin: 22px 0 14px; font-weight: 800; }
h1 span { color: #fff; }
.sub { font-size: 17px; line-height: 1.6; opacity: .78; max-width: 560px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-top: 40px; }
.card { background: #ffffff0d; border: 1px solid #ffffff1a; border-radius: 14px; padding: 18px 18px 20px; }
.card h3 { font-size: 14px; margin-bottom: 6px; display: flex; align-items: center; gap: 8px; }
.card .dot { width: 8px; height: 8px; border-radius: 50%; background: #fff; }
.card p { font-size: 13px; line-height: 1.55; opacity: .68; }
`,
    },
    {
      path: "README.md",
      content: `# ${heroTitle(appName)}\n\nNext.js app scaffolded by OnyxCode.\n\n- \`npm run dev\` — start the dev server\n- \`npm run build\` — production build\n`,
    },
  ],
};

const viteReact: CodeScaffold = {
  key: "vite-react",
  label: "React + Vite",
  description: "React 18 + Vite 6 SPA.",
  port: 3000,
  installCommand: "npm install --no-audit --no-fund --loglevel=error",
  serverCommand: (_n, port) => `npx vite --port ${port} --host 0.0.0.0 --strictPort`,
  cwd: (appName) => projectDir(appName),
  files: (appName, description) => [
    {
      path: "package.json",
      content: JSON.stringify(
        {
          name: appName,
          private: true,
          version: "0.1.0",
          type: "module",
          scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
          dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" },
          devDependencies: { "@vitejs/plugin-react": "^4.3.4", vite: "^6.0.0" },
        },
        null,
        2,
      ),
    },
    { path: "vite.config.js", content: `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({ plugins: [react()], server: { host: true } });\n` },
    {
      path: "index.html",
      content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${esc(heroTitle(appName))}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`,
    },
    { path: "src/main.jsx", content: `import React from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App.jsx";\nimport "./styles.css";\n\ncreateRoot(document.getElementById("root")).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>,\n);\n` },
    {
      path: "src/App.jsx",
      content: `export default function App() {
  return (
    <main className="wrap">
      <span className="badge">React + Vite · OnyxCode</span>
      <h1>${heroTitle(appName)} <span>is live.</span></h1>
      <p className="sub">${(description || "A React + Vite app scaffolded by OnyxCode — edit src/ in the sandbox and Vite hot-reloads this page.").replace(/"/g, "&quot;")}</p>
      <div className="cards">
        <div className="card"><h3><span className="dot" />Instant HMR</h3><p>Vite updates the browser in milliseconds.</p></div>
        <div className="card"><h3><span className="dot" />Component-based</h3><p>Everything lives in src/App.jsx.</p></div>
        <div className="card"><h3><span className="dot" />Live preview</h3><p>Served from your E2B sandbox.</p></div>
      </div>
    </main>
  );
}
`,
    },
    {
      path: "src/styles.css",
      content: `* { box-sizing: border-box; margin: 0; padding: 0; }
:root { color-scheme: dark; }
body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: #0d1117; color: #f0f6fc; min-height: 100vh; display: flex; flex-direction: column; align-items: center; }
.wrap { width: 100%; max-width: 880px; padding: 72px 24px 64px; }
.badge { display: inline-flex; align-items: center; gap: 8px; background: #f7ff4214; color: #f7ff42; border: 1px solid #f7ff4233; border-radius: 999px; padding: 6px 14px; font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
h1 { font-size: clamp(34px, 6vw, 56px); line-height: 1.05; letter-spacing: -0.03em; margin: 22px 0 14px; font-weight: 800; }
h1 span { color: #f7ff42; }
.sub { font-size: 17px; line-height: 1.6; opacity: .78; max-width: 560px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-top: 40px; }
.card { background: #ffffff0d; border: 1px solid #ffffff1a; border-radius: 14px; padding: 18px 18px 20px; }
.card h3 { font-size: 14px; margin-bottom: 6px; display: flex; align-items: center; gap: 8px; }
.card .dot { width: 8px; height: 8px; border-radius: 50%; background: #f7ff42; }
.card p { font-size: 13px; line-height: 1.55; opacity: .68; }
`,
    },
    { path: "README.md", content: `# ${heroTitle(appName)}\n\nReact + Vite app scaffolded by OnyxCode.\n\n- \`npm run dev\` — start the dev server\n- \`npm run build\` — production build\n` },
  ],
};

const fastapi: CodeScaffold = {
  key: "fastapi",
  label: "Python FastAPI",
  description: "FastAPI service with a JSON API + HTML landing page.",
  port: 3000,
  installCommand: "pip install -q fastapi uvicorn",
  serverCommand: (_n, port) => `python3 -m uvicorn main:app --host 0.0.0.0 --port ${port}`,
  cwd: (appName) => projectDir(appName),
  files: (appName, description) => [
    {
      path: "requirements.txt",
      content: `fastapi>=0.115.0\nuvicorn>=0.34.0\n`,
    },
    {
      path: "main.py",
      content: `"""${heroTitle(appName)} — FastAPI service scaffolded by OnyxCode."""
from fastapi import FastAPI
from fastapi.responses import HTMLResponse

app = FastAPI(title="${heroTitle(appName).replace(/"/g, "")}")

ITEMS: dict[str, dict] = {
    "1": {"id": "1", "title": "First item", "done": False},
    "2": {"id": "2", "title": "Second item", "done": True},
}


@app.get("/", response_class=HTMLResponse)
def home() -> str:
    return PAGE


@app.get("/health")
def health() -> dict:
    return {"ok": True, "app": "${appName}"}


@app.get("/items")
def list_items() -> list[dict]:
    return list(ITEMS.values())


@app.post("/items/{item_id}/toggle")
def toggle(item_id: str) -> dict:
    item = ITEMS.get(item_id)
    if item is None:
        return {"error": "not found"}
    item["done"] = not item["done"]
    return item


PAGE = """${htmlPage({ appName, framework: "FastAPI", accent: "#5ee6c4", accentSoft: "#5ee6c41f", bg: "#0a1210", fg: "#eefcf7", description })}"""
`,
    },
    { path: "README.md", content: `# ${heroTitle(appName)}\n\nFastAPI service scaffolded by OnyxCode.\n\n- \`uvicorn main:app --reload\` — dev server\n- \`GET /health\`, \`GET /items\`, \`POST /items/{id}/toggle\` — API\n` },
  ],
};

const node: CodeScaffold = {
  key: "node",
  label: "Node.js",
  description: "Node.js + Express web server.",
  port: 3000,
  installCommand: "npm install --no-audit --no-fund --loglevel=error",
  serverCommand: (_n, port) => `PORT=${port} node server.js`,
  cwd: (appName) => projectDir(appName),
  files: (appName, description) => [
    {
      path: "package.json",
      content: JSON.stringify(
        {
          name: appName,
          private: true,
          version: "0.1.0",
          type: "commonjs",
          scripts: { start: "node server.js" },
          dependencies: { express: "^4.21.2" },
        },
        null,
        2,
      ),
    },
    {
      path: "server.js",
      content: `// ${heroTitle(appName)} — Express server scaffolded by OnyxCode.
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const items = [
  { id: "1", title: "First item", done: false },
  { id: "2", title: "Second item", done: true },
];

app.use(express.json());
app.get("/api/health", (_req, res) => res.json({ ok: true, app: ${JSON.stringify(appName)} }));
app.get("/api/items", (_req, res) => res.json(items));
app.post("/api/items/:id/toggle", (req, res) => {
  const item = items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: "not found" });
  item.done = !item.done;
  res.json(item);
});
app.use(express.static(__dirname));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.listen(PORT, "0.0.0.0", () => {
  console.log(\`${appName} listening on port \${PORT}\`);
});
`,
    },
    {
      path: "index.html",
      content: htmlPage({ appName, framework: "Node.js + Express", accent: "#8ee98b", accentSoft: "#8ee98b1f", bg: "#0b100d", fg: "#f0fbef", description }),
    },
    { path: "README.md", content: `# ${heroTitle(appName)}\n\nNode.js + Express server scaffolded by OnyxCode.\n\n- \`npm start\` — run the server\n- \`GET /api/health\`, \`GET /api/items\` — API\n` },
  ],
};

const staticSite: CodeScaffold = {
  key: "static",
  label: "Static site",
  description: "Plain HTML/CSS site — zero build step.",
  port: 3000,
  installCommand: null,
  serverCommand: (_n, port) => `python3 -m http.server ${port} --bind 0.0.0.0`,
  cwd: (appName) => projectDir(appName),
  files: (appName, description) => [
    {
      path: "index.html",
      content: htmlPage({ appName, framework: "Static site", accent: "#e8825f", accentSoft: "#e8825f1f", bg: "#14100d", fg: "#faf5f0", description }),
    },
    {
      path: "README.md",
      content: `# ${heroTitle(appName)}\n\nStatic site scaffolded by OnyxCode. Serve it with any static file server:\n\n\`\`\`\npython3 -m http.server 3000\n\`\`\`\n`,
    },
  ],
};

const cliTool: CodeScaffold = {
  key: "cli",
  label: "CLI tool",
  description: "Node.js CLI tool (no preview server — run it with run_terminal).",
  port: 3000,
  installCommand: null,
  serverCommand: null, // CLI tools have no dev server.
  cwd: (appName) => projectDir(appName),
  files: (appName, description) => [
    {
      path: "package.json",
      content: JSON.stringify(
        {
          name: appName,
          private: true,
          version: "0.1.0",
          type: "module",
          bin: { [appName]: "./cli.js" },
        },
        null,
        2,
      ),
    },
    {
      path: "cli.js",
      content: `#!/usr/bin/env node
// ${heroTitle(appName)} — CLI tool scaffolded by OnyxCode.
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const root = process.argv[2] || ".";

async function walk(dir, depth = 0) {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const full = join(dir, e.name);
    const pad = "  ".repeat(depth);
    if (e.isDirectory()) {
      console.log(\`\${pad}\${e.name}/\`);
      await walk(full, depth + 1);
    } else {
      const s = await stat(full);
      const kb = (s.size / 1024).toFixed(1);
      console.log(\`\${pad}\${e.name}  (\${kb} KB)\`);
    }
  }
}

console.log(\`# ${appName} — file tree (\${root})\`);
walk(root).catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
`,
    },
    {
      path: "README.md",
      content: `# ${heroTitle(appName)}\n\nCLI tool scaffolded by OnyxCode.\n\n\`\`\`bash\nnode cli.js .\n\`\`\`\n\n${description ? description + "\n" : ""}`,
    },
  ],
};

export const SCAFFOLDS: Record<ScaffoldKey, CodeScaffold> = {
  nextjs,
  "vite-react": viteReact,
  fastapi,
  node,
  static: staticSite,
  cli: cliTool,
};

export function getScaffold(key: string | undefined | null): CodeScaffold | null {
  if (!key) return null;
  const normalized = key.toLowerCase().trim();
  if (normalized in SCAFFOLDS) return SCAFFOLDS[normalized as ScaffoldKey];
  // Fuzzy fallbacks for model-provided keys.
  if (/react/.test(normalized) && /vite/.test(normalized)) return viteReact;
  if (/next/.test(normalized)) return nextjs;
  if (/python|fastapi|flask|uvicorn/.test(normalized)) return fastapi;
  if (/express|node/.test(normalized)) return node;
  if (/html|static|site/.test(normalized)) return staticSite;
  if (/cli|script|command/.test(normalized)) return cliTool;
  return null;
}

export function scaffoldKeysDescription(): string {
  return SCAFFOLD_KEYS.map((k) => `"${k}" (${SCAFFOLDS[k].label})`).join(", ");
}

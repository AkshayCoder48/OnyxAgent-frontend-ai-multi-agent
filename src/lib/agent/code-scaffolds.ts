/**
 * OnyxCode app scaffolds — real file sets for the supported frameworks.
 *
 * Every scaffold ships:
 *  - the actual project files for its framework (runnable where the user
 *    takes them), and
 *  - a self-contained `preview/index.html` (inline CSS, no external assets)
 *    so `start_preview` always has a live page to serve immediately.
 */

export type FrameworkId = "nextjs" | "vite-react" | "fastapi" | "node" | "static" | "cli";

export interface ScaffoldApp {
  framework: FrameworkId;
  name: string;
  description: string;
}

export const FRAMEWORKS: { id: FrameworkId; label: string; hint: string }[] = [
  { id: "nextjs", label: "Next.js", hint: "App Router, React 19, Tailwind-ready" },
  { id: "vite-react", label: "React + Vite", hint: "Fast SPA tooling" },
  { id: "fastapi", label: "Python FastAPI", hint: "Modern async API" },
  { id: "node", label: "Node.js service", hint: "Express-style HTTP server" },
  { id: "static", label: "Static site", hint: "HTML + CSS + JS, zero build" },
  { id: "cli", label: "CLI tool", hint: "Node command-line app" },
];

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "onyxcode-app";
}

export function titleCase(value: string): string {
  return value
    .split(/[-\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/* ------------------------------------------------------------------ */
/* Preview page (self-contained, served by the preview service)        */
/* ------------------------------------------------------------------ */

function previewPage(app: ScaffoldApp): string {
  const title = titleCase(app.name);
  const framework = FRAMEWORKS.find((f) => f.id === app.framework)?.label ?? app.framework;
  const badge = framework.toUpperCase();

  if (app.framework === "cli" || app.framework === "node") {
    const isCli = app.framework === "cli";
    const cmd = isCli ? `./${slugify(app.name)} --help` : `npm run dev`;
    const sample = isCli
      ? `$ ${cmd}
${title} v1.0.0 — ${app.description}

Usage:
  ${slugify(app.name)} greet [name]   Print a warm greeting
  ${slugify(app.name)} --version      Show version`
      : `$ ${cmd}
  ${title} listening on http://localhost:3000

  GET  /        → ${app.description}
  GET  /health  → { "ok": true }`;

    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title} — ${badge}</title>
<style>
  body{margin:0;min-height:100vh;background:#262019;color:#F4ECE1;font-family:'JetBrains Mono','SF Mono',Menlo,monospace;display:flex;align-items:center;justify-content:center;padding:32px}
  .term{width:100%;max-width:720px;background:#1F1A15;border:1px solid #3A3128;border-radius:12px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.45)}
  .bar{display:flex;gap:6px;padding:12px 14px;border-bottom:1px solid #3A3128}
  .dot{width:11px;height:11px;border-radius:50%}
  .r{background:#C4552F}.y{background:#C9B78E}.g{background:#7A8B5A}
  .bar span{margin-left:10px;font-size:11px;color:#8A7E6C;letter-spacing:.08em}
  pre{margin:0;padding:20px 22px;font-size:13px;line-height:1.75;white-space:pre-wrap;color:#EAD9BE}
  pre b{color:#E39B6E;font-weight:600}
  .foot{padding:12px 22px;border-top:1px solid #3A3128;font-size:11px;color:#8A7E6C}
</style></head>
<body><div class="term">
  <div class="bar"><i class="dot r"></i><i class="dot y"></i><i class="dot g"></i><span>${badge} · PREVIEW</span></div>
  <pre><b>$</b> ${cmd}
${sample.replace(/^\$ [^\n]*\n/, "")}</pre>
  <div class="foot">${title} · scaffolded by OnyxCode · live static preview of the project</div>
</div></body></html>`;
  }

  if (app.framework === "fastapi") {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title} — API</title>
<style>
  body{margin:0;min-height:100vh;background:#FAF6F0;color:#1A1A1A;font-family:Georgia,'Times New Roman',serif;padding:48px 24px}
  .wrap{max-width:720px;margin:0 auto}
  .k{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.12em;color:#A8421F;text-transform:uppercase}
  h1{font-size:30px;margin:10px 0 6px}
  p.sub{color:#666;margin:0 0 28px;font-size:15px}
  .ep{display:flex;gap:14px;align-items:baseline;background:#FFFDF9;border:1px solid #E7DCCC;border-radius:10px;padding:14px 18px;margin-bottom:10px}
  .m{font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:700;color:#FFFDF9;background:#C4552F;border-radius:6px;padding:3px 8px}
  .p{font-family:'JetBrains Mono',monospace;font-size:14px;color:#1A1A1A}
  .d{color:#666;font-size:13px;margin-left:auto;text-align:right}
  .foot{margin-top:26px;font-size:12px;color:#8A7E6C}
</style></head>
<body><div class="wrap">
  <div class="k">${badge} · FastAPI</div>
  <h1>${title}</h1>
  <p class="sub">${app.description}</p>
  <div class="ep"><span class="m">GET</span><span class="p">/</span><span class="d">Service info & health</span></div>
  <div class="ep"><span class="m">GET</span><span class="p">/items</span><span class="d">List items</span></div>
  <div class="ep"><span class="m">POST</span><span class="p">/items</span><span class="d">Create an item</span></div>
  <div class="ep"><span class="m">GET</span><span class="p">/health</span><span class="d">Liveness probe</span></div>
  <div class="foot">Scaffolded by OnyxCode · live static preview · run the project locally with uvicorn main:app --reload</div>
</div></body></html>`;
  }

  // Web apps: nextjs / vite-react / static — warm editorial landing page.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title}</title>
<style>
  :root{--ink:#1A1A1A;--cream:#FAF6F0;--terra:#C4552F;--paper:#F4ECE1;--line:#E7DCCC;--muted:#666}
  *{box-sizing:border-box}
  body{margin:0;background:var(--cream);color:var(--ink);font-family:Georgia,'Times New Roman',serif;line-height:1.6}
  header{padding:26px 32px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--line)}
  .mark{width:30px;height:30px;border-radius:50%;background:var(--terra);color:#fff;display:grid;place-items:center;font-size:15px}
  .brand{font-weight:700;font-size:18px}
  .beta{background:#000;color:#fff;border-radius:5px;padding:2px 7px;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-family:system-ui,sans-serif}
  main{max-width:880px;margin:0 auto;padding:72px 24px 88px;text-align:center}
  .eyebrow{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.16em;color:var(--terra);text-transform:uppercase}
  h1{font-size:clamp(34px,6vw,54px);line-height:1.12;margin:14px 0 18px;font-weight:600}
  .lede{color:var(--muted);font-size:18px;max-width:560px;margin:0 auto 34px}
  .cta{display:inline-block;background:var(--terra);color:#fff;text-decoration:none;padding:13px 30px;border-radius:12px;font-family:system-ui,sans-serif;font-size:15px;font-weight:600;box-shadow:0 2px 10px rgba(166,63,26,.35)}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-top:64px;text-align:left}
  .card{background:#FFFDF9;border:1px solid var(--line);border-radius:14px;padding:22px}
  .card h3{margin:0 0 6px;font-size:17px}
  .card p{margin:0;color:var(--muted);font-size:14px}
  .card .n{font-family:'JetBrains Mono',monospace;color:var(--terra);font-size:12px}
  footer{border-top:1px solid var(--line);padding:22px 32px;color:#8A7E6C;font-size:12px;text-align:center}
</style></head>
<body>
<header><span class="mark">◆</span><span class="brand">${title}</span><span class="beta">${badge}</span></header>
<main>
  <div class="eyebrow">${framework} · scaffolded by OnyxCode</div>
  <h1>${app.description}</h1>
  <p class="lede">A warm editorial starting point — edit the workspace files and refresh this preview to see your changes live.</p>
  <a class="cta" href="#features">Get started</a>
  <div class="grid" id="features">
    <div class="card"><div class="n">01</div><h3>Ready to run</h3><p>Real project files for ${framework}, wired and documented.</p></div>
    <div class="card"><div class="n">02</div><h3>Live preview</h3><p>This page is served straight from your workspace.</p></div>
    <div class="card"><div class="n">03</div><h3>Ask for changes</h3><p>Chat with OnyxCode to edit files, data and previews.</p></div>
  </div>
</main>
<footer>${title} · ${slugify(app.name)} · OnyxCode Beta</footer>
</body></html>`;
}

/* ------------------------------------------------------------------ */
/* Framework file sets                                                 */
/* ------------------------------------------------------------------ */

function readme(app: ScaffoldApp): string {
  const framework = FRAMEWORKS.find((f) => f.id === app.framework)?.label ?? app.framework;
  return `# ${titleCase(app.name)}

> ${app.description}

Scaffolded by **OnyxCode** (${framework}).

## Run it

See the commands below; every file is in this workspace — ask OnyxCode to edit
anything, start a live preview, or store project data in the Database tab.
`;
}

export function scaffoldApp(framework: string, name: string, description: string): {
  framework: FrameworkId;
  files: Record<string, string>;
  appMeta: { framework: FrameworkId; name: string; description: string };
} {
  const fw = (FRAMEWORKS.some((f) => f.id === framework) ? framework : "static") as FrameworkId;
  const app: ScaffoldApp = {
    framework: fw,
    name: slugify(name),
    description: description.trim() || `A ${FRAMEWORKS.find((f) => f.id === fw)?.label} app built with OnyxCode.`,
  };
  const pkg = slugify(app.name);
  const files: Record<string, string> = {};
  const preview = previewPage(app);

  switch (fw) {
    case "static": {
      files["index.html"] = preview; // the site itself is the preview page content
      files["styles.css"] = `/* ${app.name} — styles */\nbody{margin:0;background:#FAF6F0;color:#1A1A1A;font-family:Georgia,serif}\n`;
      files["app.js"] = `// ${app.name} — client logic\nconsole.log("${app.name} ready");\n`;
      files["preview/index.html"] = preview;
      break;
    }
    case "vite-react": {
      files["package.json"] = JSON.stringify(
        {
          name: pkg,
          private: true,
          version: "0.1.0",
          type: "module",
          scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
          dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
          devDependencies: { vite: "^6.0.0", "@vitejs/plugin-react": "^4.3.0" },
        },
        null,
        2,
      );
      files["vite.config.js"] = `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({ plugins: [react()] });\n`;
      files["index.html"] = `<!doctype html>\n<html lang="en">\n  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${titleCase(app.name)}</title></head>\n  <body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body>\n</html>\n`;
      files["src/main.jsx"] = `import React from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App.jsx";\nimport "./App.css";\n\ncreateRoot(document.getElementById("root")).render(<App />);\n`;
      files["src/App.jsx"] = `export default function App() {\n  return (\n    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#FAF6F0", fontFamily: "Georgia, serif" }}>\n      <div style={{ textAlign: "center" }}>\n        <p style={{ letterSpacing: "0.16em", textTransform: "uppercase", fontSize: 11, color: "#C4552F" }}>\n          React + Vite · OnyxCode\n        </p>\n        <h1 style={{ fontSize: 44, margin: "8px 0" }}>${titleCase(app.name)}</h1>\n        <p style={{ color: "#666" }}>${app.description}</p>\n      </div>\n    </main>\n  );\n}\n`;
      files["src/App.css"] = `:root { color-scheme: light; }\n`;
      files["preview/index.html"] = preview;
      break;
    }
    case "nextjs": {
      files["package.json"] = JSON.stringify(
        {
          name: pkg,
          private: true,
          version: "0.1.0",
          scripts: { dev: "next dev", build: "next build", start: "next start" },
          dependencies: { next: "^16.0.0", react: "^19.0.0", "react-dom": "^19.0.0" },
        },
        null,
        2,
      );
      files["next.config.mjs"] = `/** @type {import('next').NextConfig} */\nconst nextConfig = {};\n\nexport default nextConfig;\n`;
      files["jsconfig.json"] = JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } }, null, 2);
      files["app/layout.jsx"] = `import "./globals.css";\n\nexport const metadata = { title: "${titleCase(app.name)}", description: "${app.description.replace(/"/g, "'")}" };\n\nexport default function RootLayout({ children }) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n`;
      files["app/page.jsx"] = `export default function Home() {\n  return (\n    <main className="home">\n      <p className="eyebrow">Next.js · App Router · OnyxCode</p>\n      <h1>${titleCase(app.name)}</h1>\n      <p className="lede">${app.description}</p>\n    </main>\n  );\n}\n`;
      files["app/globals.css"] = `:root { color-scheme: light; }\nbody { margin: 0; background: #FAF6F0; color: #1A1A1A; font-family: Georgia, serif; }\n.home { min-height: 100vh; display: grid; place-content: center; text-align: center; gap: 12px; padding: 32px; }\n.eyebrow { font-family: "JetBrains Mono", monospace; font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: #C4552F; margin: 0; }\n.home h1 { font-size: 48px; margin: 0; }\n.lede { color: #666; margin: 0; }\n`;
      files["preview/index.html"] = preview;
      break;
    }
    case "fastapi": {
      files["main.py"] = `"""${titleCase(app.name)} — ${app.description}"""\nfrom fastapi import FastAPI\n\napp = FastAPI(title="${titleCase(app.name)}")\n\n\n@app.get("/")\nasync def root():\n    return {"app": "${pkg}", "status": "ok"}\n\n\n@app.get("/items")\nasync def list_items():\n    return [{"id": 1, "name": "First item"}]\n\n\n@app.post("/items")\nasync def create_item(name: str):\n    return {"id": 2, "name": name}\n\n\n@app.get("/health")\nasync def health():\n    return {"ok": True}\n`;
      files["requirements.txt"] = `fastapi>=0.115\nuvicorn[standard]>=0.30\n`;
      files["preview/index.html"] = preview;
      break;
    }
    case "node": {
      files["package.json"] = JSON.stringify(
        {
          name: pkg,
          private: true,
          version: "0.1.0",
          type: "module",
          scripts: { dev: "node src/index.js" },
        },
        null,
        2,
      );
      files["src/index.js"] = `// ${app.name} — ${app.description}\nimport { createServer } from "node:http";\n\nconst port = process.env.PORT || 3000;\n\ncreateServer((req, res) => {\n  if (req.url === "/health") {\n    res.writeHead(200, { "content-type": "application/json" });\n    return res.end(JSON.stringify({ ok: true }));\n  }\n  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });\n  res.end("${titleCase(app.name)} — ${app.description}");\n}).listen(port, () => {\n  console.log(\`${titleCase(app.name)} listening on http://localhost:\${port}\`);\n});\n`;
      files["preview/index.html"] = preview;
      break;
    }
    case "cli": {
      files["package.json"] = JSON.stringify(
        {
          name: pkg,
          private: true,
          version: "0.1.0",
          type: "module",
          bin: { [pkg]: "bin/cli.js" },
          scripts: { start: "node bin/cli.js" },
        },
        null,
        2,
      );
      files["bin/cli.js"] = `#!/usr/bin/env node\n// ${app.name} — ${app.description}\nimport { parseArgs } from "node:util";\n\nconst { positionals } = parseArgs({ allowPositionals: true });\nconst [command = "greet"] = positionals;\n\nif (command === "greet") {\n  const name = positionals[1] ?? "world";\n  console.log(\`Hello, \${name}! 👋\`);\n} else if (command === "--version" || command === "version") {\n  console.log("${pkg} v0.1.0");\n} else {\n  console.log("Usage: ${pkg} greet [name] | --version");\n}\n`;
      files["preview/index.html"] = preview;
      break;
    }
  }

  files["README.md"] = readme(app);
  return { framework: fw, files, appMeta: { framework: fw, name: app.name, description: app.description } };
}

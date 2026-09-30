<div align="center">

<img src="public/logo.svg" alt="OnyxAgent" width="220" onerror="this.style.display='none'">

### Frontend-First AI Multi-Agent Chat Application — with **OnyxCode (Beta)**

A multi-agent AI assistant with 50+ tools, subagent orchestration, real-time streaming, sandbox code execution, live app previews, an OnyxBase-backed database browser, and a glassmorphic UI.

[![Framework](https://img.shields.io/badge/Next.js-16-000000?style=for-the-badge&logo=next.js)](https://nextjs.org)
[![Language](https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript)](https://typescriptlang.org)
[![Styling](https://img.shields.io/badge/Tailwind-CSS4-06B6D4?style=for-the-badge&logo=tailwindcss)](https://tailwindcss.com)

</div>

---

## ✨ OnyxCode — Code Mode (Beta)

A dedicated app-building experience layered on the exact same agent runtime
(providers, models, settings, tools, skills, MCP, memory, sub-agents,
background execution — nothing is forked).

**Routes**

| Route            | Purpose                                             |
| ---------------- | --------------------------------------------------- |
| `/`              | Terra agent chat (unchanged)                        |
| `/code`          | OnyxCode — chat / large creation prompt             |
| `/code/database` | OnyxBase browser for the active workspace           |
| `/code/preview`  | Live preview sessions (iframe + controls)           |

**What's inside**

- **Code Mode entry** — a `Code Mode` button right below *New conversation*
  in the sidebar (OnyxAgent logo + black **Beta** badge). Code Mode keeps its
  own, separate conversations (`mode: "code"`), synced like everything else.
- **"What do you want to create?"** — a large creation surface replaces the
  chat empty state: big auto-growing prompt, file tagging, uploads, model
  selector, and quick-start chips (Next.js app, React + Vite, Python
  FastAPI, static site, CLI tool).
- **`create_app`** — scaffolds a project for 6 frameworks straight into the
  workspace, then offers one-click *Start preview*.
- **Preview tab** — the agent's `start_preview` tool installs deps, starts a
  server and returns a live URL; sessions are listed with Open / Refresh /
  Copy URL / Stop and survive reloads.
- **Database tab** — browse / search / edit the OnyxBase tables and KV data
  the agent writes for the current workspace.
- **Web sessions** — `start_web_session` drives a real headless browser
  (screenshots, click/type/assert actions) with rich tool cards.
- **Skip wait** — any running tool card (in *both* modes) offers
  *Continue while this runs*: the tool detaches to the shared background
  job engine, the agent keeps planning, and the late result lands in the
  same message.

## 🚀 Getting started

```bash
bun install
bun run db:push        # create the SQLite database (db/custom.db)

# terminal 1 — the app
bun run dev

# terminal 2 — the OnyxCode preview service (live app previews)
cd mini-services/preview-service
bun install
bun run dev
```

Then open <http://localhost:3000>. Code Mode is the **Code Mode** button in
the sidebar (or visit `/code` directly).

> The preview service listens on `:3212`. The app proxies `/preview/*` to it
> (see the rewrite in `next.config.ts`), so live previews work on a single
> origin in development.

## 🧱 Stack

- **Next.js 16** (App Router) · **TypeScript 5** · **Tailwind CSS 4**
- **Zustand** for state · **Prisma** (SQLite) for cloud-synced records
- **OnyxBase** workspace storage · E2B sandbox execution
- shadcn/ui-flavoured glass primitives, light/dark themes

## 📁 Project layout

```
src/app/                    routes — / (Terra) and /code/* (OnyxCode)
src/components/terra/       the agent chat experience
src/components/code/        OnyxCode shell, header, creation prompt, panels
src/lib/agent/              agent runtime, tools, scaffolds, turn jobs
mini-services/preview-service  live preview server (:3212)
prisma/                     schema — conversations, workspaces, previews
```

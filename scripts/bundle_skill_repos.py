#!/usr/bin/env python3
"""
Bundle skill repositories + the MCP-Market catalog as LOCAL FILES (user request
2026-10-18: "Don't add them as repo links — add them as files, downloaded
directly").

Produce:
  public/skill-repos/<repo-id>/manifest.json     — per-repo skill index
  public/skill-repos/<repo-id>/skills/<dir>/…    — the actual skill files
  public/mcp-market/index.json                    — MCPMarket servers with
                                                    REAL connection configs
                                                    (extracted from each
                                                    server's repo README +
                                                    the marketplace pages)

The runtime (src/lib/skills/repo-browser.ts + catalog-registry.ts +
tools/mcp_management.ts) reads these bundled files FIRST — same-origin static
fetches, no GitHub API, no jsDelivr, no rate limits — and only falls back to
the live transports (jsDelivr → codeload) for repos that aren't bundled or for
files that a partial bundle omits (e.g. mengto-skills bundles SKILL.md only).

Re-run:  python3 scripts/bundle_skill_repos.py --source /tmp/skill-dl
         (expects the repos cloned + Skills.zip extracted + marketplace pages
          fetched — see README.md in public/skill-repos/)
"""

import argparse
import json
import os
import re
import shutil
import sys
import zipfile
from datetime import date

# ---------------------------------------------------------------------------
# Caps — mirror the runtime installer limits (repo-browser.ts). Bundled
# installs get slightly relaxed caps (60 files / 3 MB) because the files are
# already local: no network cost, just OPFS writes.
# ---------------------------------------------------------------------------

MAX_FILE_BYTES = 256 * 1024
MAX_FILES_PER_SKILL = 60
MAX_TOTAL_PER_SKILL = 3 * 1024 * 1024

TEXT_EXTENSIONS = {
    "md", "txt", "markdown", "json", "yaml", "yml", "toml", "xml", "html", "css",
    "scss", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java",
    "sh", "bash", "env", "cfg", "ini", "csv", "svg", "graphql", "sql",
}

SKIP_DIRS = {".git", "node_modules", ".github", "__pycache__", ".DS_Store"}
SKIP_FILES = {"package-lock.json", "bun.lock", ".gitignore", ".gitattributes"}


def is_text_path(path: str) -> bool:
    dot = path.rfind(".")
    if dot < 0:
        return True
    return path[dot + 1:].lower() in TEXT_EXTENSIONS


def sanitize_name(name: str, fallback: str) -> str:
    cleaned = re.sub(r"[^a-z0-9._-]+", "-", name.strip().lower()).strip("-")
    return cleaned or fallback


def parse_frontmatter(text: str) -> dict:
    m = re.match(r"^---\s*\n(.*?)\n---", text, re.S)
    if not m:
        return {}
    out = {}
    for line in m.group(1).splitlines():
        mm = re.match(r"^([A-Za-z_][\w-]*)\s*:\s*(.+)$", line.strip())
        if mm:
            out[mm.group(1).lower()] = mm.group(2).strip().strip("\"'")
    return out


# ---------------------------------------------------------------------------
# Skill collection from a directory tree.
# ---------------------------------------------------------------------------

def collect_skill(src_root: str, skill_rel_dir: str, strip_prefix: str) -> dict | None:
    """Collect ONE skill (a dir containing SKILL.md) from src_root."""
    skill_dir = os.path.join(src_root, skill_rel_dir) if skill_rel_dir else src_root
    skill_md = os.path.join(skill_dir, "SKILL.md")
    if not os.path.isfile(skill_md):
        return None
    try:
        skill_md_text = open(skill_md, encoding="utf-8", errors="replace").read()
    except OSError:
        return None
    fm = parse_frontmatter(skill_md_text)
    fallback = os.path.basename(skill_rel_dir.rstrip("/")) or "skill"
    name = sanitize_name(fm.get("name", ""), fallback)
    description = (fm.get("description", "") or "").strip()[:300]

    files = []
    total = 0
    for dirpath, dirnames, filenames in os.walk(skill_dir):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for fn in sorted(filenames):
            if fn in SKIP_FILES or fn.startswith("."):
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, skill_dir).replace(os.sep, "/")
            if not is_text_path(rel):
                continue
            size = os.path.getsize(full)
            if size > MAX_FILE_BYTES:
                continue
            if len(files) >= MAX_FILES_PER_SKILL or total + size > MAX_TOTAL_PER_SKILL:
                continue
            files.append({"path": rel, "size": size})
            total += size
    if not any(f["path"] == "SKILL.md" for f in files):
        files.insert(0, {"path": "SKILL.md", "size": os.path.getsize(skill_md)})

    return {
        "name": name,
        "description": description,
        "dir": skill_rel_dir,
        "files": files,
    }


def copy_skill_files(out_root: str, src_root: str, skill: dict) -> int:
    """Copy a skill's collected files into the bundle. Returns bytes copied."""
    dest_dir = os.path.join(out_root, "skills", skill["dir"]) if skill["dir"] else os.path.join(out_root, "skills")
    os.makedirs(dest_dir, exist_ok=True)
    copied = 0
    src_dir = os.path.join(src_root, skill["dir"]) if skill["dir"] else src_root
    for f in skill["files"]:
        # "src" (absolute, collection-time) wins — extra files pulled from
        # elsewhere in the repo carry it; regular files are dir-relative.
        src = f.get("src") or os.path.join(src_dir, f["path"])
        dst = os.path.join(dest_dir, f["path"])
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(src, dst)
        copied += f["size"]
    return copied


def bundle_repo(out_base: str, repo_id: str, repo_name: str, source_url: str,
                skills: list[dict], partial: bool = False, note: str | None = None) -> None:
    out_root = os.path.join(out_base, repo_id)
    if os.path.isdir(out_root):
        shutil.rmtree(out_root)
    # Dedup skill NAMES (keep the first, suffix later dups: name-2, name-3 …)
    # — the runtime resolves skills by name, so duplicates would collide.
    seen: dict[str, int] = {}
    deduped = []
    for s in skills:
        base = s["name"]
        n = seen.get(base, 0)
        seen[base] = n + 1
        if n > 0:
            s = {**s, "name": f"{base}-{n + 1}"}
        deduped.append(s)
    skills = deduped
    for s in skills:
        # `filesrc` carries the ABSOLUTE source dir (removed from the manifest).
        src_root = s.pop("filesrc")
        copy_skill_files(out_root, src_root, s)
    manifest = {
        "id": repo_id,
        "name": repo_name,
        "source_url": source_url,
        "bundled_at": date.today().isoformat(),
        "partial": partial,
        **({"note": note} if note else {}),
        "skills": [
            {**s, "files": [{k: v for k, v in f.items() if k != "src"} for f in s["files"]]}
            for s in sorted(skills, key=lambda s: s["name"])
        ],
    }
    os.makedirs(out_root, exist_ok=True)
    with open(os.path.join(out_root, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=1)
    n_files = sum(len(s["files"]) for s in skills)
    print(f"  {repo_id}: {len(skills)} skills, {n_files} files")


# ---------------------------------------------------------------------------
# Repo-specific collectors.
# ---------------------------------------------------------------------------

def collect_dir_skills(src_root: str, subpath: str = "") -> list[dict]:
    """Every dir under src_root/subpath that contains SKILL.md = one skill."""
    base = os.path.join(src_root, subpath) if subpath else src_root
    skills = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        if "SKILL.md" not in filenames:
            continue
        rel = os.path.relpath(dirpath, base).replace(os.sep, "/")
        if rel == ".":
            rel = ""
        skill = collect_skill(src_root, os.path.join(subpath, rel) if subpath else rel, "")
        if skill:
            skill["filesrc"] = src_root
            skills.append(skill)
        # don't descend into a skill dir looking for more SKILL.mds
        dirnames[:] = []
    return skills


def collect_mengto(src_root: str) -> list[dict]:
    """MengTo: 177 skills — bundle SKILL.md ONLY (partial bundle; supporting
    files stay on GitHub and are live-fetched on install)."""
    base = os.path.join(src_root, "agent-skills")
    skills = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        if "SKILL.md" not in filenames:
            continue
        rel = os.path.relpath(dirpath, base).replace(os.sep, "/")
        skill_md = os.path.join(dirpath, "SKILL.md")
        text = open(skill_md, encoding="utf-8", errors="replace").read()
        fm = parse_frontmatter(text)
        name = sanitize_name(fm.get("name", ""), os.path.basename(rel))
        skills.append({
            "name": name,
            "description": (fm.get("description", "") or "").strip()[:300],
            "dir": rel,
            "files": [{"path": "SKILL.md", "size": os.path.getsize(skill_md)}],
            "filesrc": base,
        })
        dirnames[:] = []
    return skills


def collect_with_extra_files(src_root: str, skill_subpath: str, extra_globs: list[str]) -> dict | None:
    """One skill + extra supporting files from elsewhere in the repo
    (api-anything: the sites/*.md service-reference docs)."""
    skill = collect_skill(src_root, skill_subpath, "")
    if not skill:
        return None
    skill["filesrc"] = src_root
    for pattern in extra_globs:
        folder = os.path.join(src_root, pattern)
        if not os.path.isdir(folder):
            continue
        for dirpath, dirnames, filenames in os.walk(folder):
            dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
            for fn in sorted(filenames):
                if fn in SKIP_FILES or not is_text_path(fn):
                    continue
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, src_root)
                size = os.path.getsize(full)
                if size > MAX_FILE_BYTES or len(skill["files"]) >= MAX_FILES_PER_SKILL:
                    continue
                skill["files"].append({"path": rel, "size": size, "src": full})
    return skill


def collect_uploaded_skills(zip_dir: str) -> list[dict]:
    """The user's uploaded Skills.zip — a zip-of-zips; each inner zip is one
    skill (SKILL.md at root or one level down). Staged under its front-matter
    NAME (numeric suffix on collisions) so each skill gets a unique dir."""
    tmp = os.path.join(zip_dir, "_extracted")
    os.makedirs(tmp, exist_ok=True)
    stage_parent = os.path.join(tmp, "_stage")
    skills = []
    used_names: set[str] = set()
    for fn in sorted(os.listdir(zip_dir)):
        if not fn.endswith(".zip"):
            continue
        inner = os.path.join(tmp, fn[:-4])
        try:
            with zipfile.ZipFile(os.path.join(zip_dir, fn)) as zf:
                zf.extractall(inner)
        except (zipfile.BadZipFile, OSError) as e:
            print(f"  ! skipping {fn}: {e}", file=sys.stderr)
            continue
        # find SKILL.md (root or one level down)
        skill_root = None
        if os.path.isfile(os.path.join(inner, "SKILL.md")):
            skill_root = inner
        else:
            for d in sorted(os.listdir(inner)):
                if os.path.isfile(os.path.join(inner, d, "SKILL.md")):
                    skill_root = os.path.join(inner, d)
                    break
        if not skill_root:
            continue
        # stage dir = front-matter name (unique) so every skill gets its own dir
        fm = parse_frontmatter(open(os.path.join(skill_root, "SKILL.md"), encoding="utf-8", errors="replace").read())
        base = sanitize_name(fm.get("name", ""), re.sub(r"[^a-z0-9._-]+", "-", fn[:-4].lower()))
        name, n = base, 1
        while name in used_names:
            n += 1
            name = f"{base}-{n}"
        used_names.add(name)
        stage = os.path.join(stage_parent, name)
        os.makedirs(stage, exist_ok=True)
        for item in os.listdir(skill_root):
            src = os.path.join(skill_root, item)
            dst = os.path.join(stage, item)
            if os.path.isdir(src):
                shutil.copytree(src, dst, dirs_exist_ok=True,
                                ignore=shutil.ignore_patterns(*SKIP_DIRS))
            else:
                shutil.copyfile(src, dst)
        skill = collect_skill(stage_parent, name, "")
        if skill:
            skill["filesrc"] = stage_parent
            skills.append(skill)
    return skills


# ---------------------------------------------------------------------------
# MCP Market — real connection configs (extracted 2026-10-18 from each
# server's marketplace page + its GitHub repo README).
# ---------------------------------------------------------------------------

def build_mcp_market(src: str) -> dict:
    tools_cd = []
    tp = os.path.join(src, "mcpmarket", "chrome-devtools-tools.json")
    if os.path.isfile(tp):
        tools_cd = [{"name": t["name"], "description": t["description"]}
                    for t in json.load(open(tp, encoding="utf-8"))]
    tools_2ools = [
        "create_public_preview", "build_from_conversation", "refine_project", "get_build",
        "cancel_build", "compare_versions", "list_build_systems", "list_projects", "get_project",
        "get_project_context", "render_project_preview", "get_project_activity",
        "wait_for_project_activity", "list_approval_requests", "approve_version",
        "reject_version", "list_project_feedback", "add_project_feedback",
        "resolve_project_feedback", "list_project_pins", "add_project_pin", "remove_project_pin",
        "prepare_version_export", "get_version_share_link", "create_version_share_link",
        "revoke_version_share_link", "list_artifacts", "get_artifact", "prepare_artifact_upload",
        "prepare_artifact_download", "list_artifact_approval_requests",
        "approve_artifact_version", "reject_artifact_version", "list_project_agents", "get_agent",
        "run_project_agent", "cancel_agent_run", "list_work_assignments",
        "create_work_assignment", "claim_work_assignment", "heartbeat_work_session",
        "submit_work_session", "decide_work_assignment",
    ]
    return {
        "bundled_at": date.today().isoformat(),
        "source": "Extracted from mcpmarket.com listing pages + each server's GitHub README (bundled locally — no live fetch needed).",
        "servers": [
            {
                "id": "chrome-devtools",
                "name": "Chrome DevTools",
                "url": "https://mcpmarket.com/server/chrome-devtools-1",
                "github": "https://github.com/ChromeDevTools/chrome-devtools-mcp",
                "npm": "https://www.npmjs.com/package/chrome-devtools-mcp",
                "description": "Drive Chrome via CDP: navigate, screenshot, read console + network, capture performance traces.",
                "transport": "stdio-npm",
                "stdio": {"command": "npx", "args": ["-y", "chrome-devtools-mcp"]},
                "sandbox": "Run inside the E2B sandbox: npx -y chrome-devtools-mcp (needs a Chrome/Chromium in the sandbox, or connect it to a headless Chrome the sandbox starts).",
                "tools": tools_cd,
            },
            {
                "id": "serena",
                "name": "Serena",
                "url": "https://mcpmarket.com/server/serena",
                "github": "https://github.com/oraios/serena",
                "description": "Semantic code intelligence: LSP-powered symbols, references, edits and refactors over codebases.",
                "transport": "stdio-python",
                "stdio": {"command": "serena", "args": ["start-mcp-server", "--context", "codex"]},
                "sandbox": "Inside the E2B sandbox: install uv, then `uv tool install -p 3.13 serena-agent` and run `serena start-mcp-server --context codex`. IMPORTANT (upstream README): do NOT use marketplace/plugin-manager install commands — they are outdated.",
                "note": "Project must be on disk (workspace files) for Serena to index it.",
            },
            {
                "id": "2ools",
                "name": "2ools",
                "url": "https://mcpmarket.com/server/2ools",
                "github": "https://github.com/2ools/mcp-server",
                "description": "Build, version, review and export websites, web apps and games from inside chat. Free tool: create_public_preview turns an HTML doc into a viewable URL.",
                "transport": "remote-http",
                "remote": {
                    "url": "https://2ools.app/mcp",
                    "transport": "streamable_http",
                    "auth": "OAuth — sign in + Authorize once in a browser. Retrieve https://2ools.app/start non-visually (HTTP fetch, not the in-app browser) and follow its 'For your AI' steps.",
                },
                "tools": [{"name": t, "description": ""} for t in tools_2ools],
                "register_hint": "manage_mcp action 'create' with transport streamable_http, url https://2ools.app/mcp — then complete OAuth in the app browser when the agent opens it.",
            },
            {
                "id": "superpowers",
                "name": "Superpowers",
                "url": "https://mcpmarket.com/server/superpowers",
                "github": "https://github.com/obra/superpowers",
                "npm": "https://www.npmjs.com/package/superpowers",
                "description": "Extended agent-capabilities toolkit (brainstorming, writing-plans, executing-plans, dispatching-parallel-agents, using-git-worktrees …).",
                "transport": "plugin",
                "sandbox": "Distribution is per-harness plugins (Claude Code: /plugin install superpowers@claude-plugins-official; other harnesses per its README). An npm package 'superpowers' also exists — check its usage on npmjs before running it blind.",
                "note": "NOT an MCP stdio server — it is a skills/hook plugin collection. In the E2B sandbox, read its README and use the CLI/plugin path it documents.",
            },
            {
                "id": "tubealfred-youtube",
                "name": "TubeAlfred YouTube",
                "url": "https://mcpmarket.com/server/tubealfred-youtube",
                "github": "https://github.com/tubealfred/mcp",
                "npm": "https://www.npmjs.com/package/@tubealfred/mcp",
                "description": "YouTube automation through TubeAlfred (search, playlists, channel actions).",
                "transport": "stdio-npm",
                "stdio": {"command": "npx", "args": ["-y", "@tubealfred/mcp"]},
                "sandbox": "Run inside the E2B sandbox: npx -y @tubealfred/mcp (an MCP client script with @modelcontextprotocol/sdk spawns it and lists/calls its tools).",
            },
            {
                "id": "chatgpt-redis",
                "name": "ChatGPT Redis",
                "url": "https://mcpmarket.com/server/chatgpt-redis",
                "github": "https://github.com/freebase-cloud/chatgpt-redis-mcp",
                "description": "Redis-backed memory/context store for conversational agents (memory_query, memory_store, memory_list_tables, memory_annotate_table).",
                "transport": "remote-http",
                "remote": {
                    "url": "https://freebase.cloud/api/mcp/YOUR_TOKEN",
                    "transport": "streamable_http",
                    "auth": "Free signup at https://freebase.cloud → Settings → MCP → New Token → copy the token URL (the token IS the path; no auth header).",
                },
                "register_hint": "manage_mcp action 'create' with transport streamable_http and the token URL from freebase.cloud.",
            },
            {
                "id": "youtube-search-download",
                "name": "YouTube Search & Download",
                "url": "https://mcpmarket.com/server/youtube-search-download",
                "github": "https://github.com/easyhak/youtube-search-mcp",
                "description": "Search YouTube and download videos/audio programmatically.",
                "transport": "stdio-python",
                "stdio": {"command": "uvx", "args": ["youtube-search-mcp"]},
                "sandbox": "Inside the E2B sandbox: `uvx youtube-search-mcp` (or pip install youtube-search-mcp then run `youtube-search-mcp`). Needs yt-dlp + a YouTube cookie/header config for some requests.",
            },
            {
                "id": "pdf-generator",
                "name": "PDF Generator",
                "url": "https://mcpmarket.com/server/pdf-generator-1",
                "github": "https://github.com/rumblingb/pdf-generator-mcp",
                "description": "Generate PDF documents from HTML, plain text, or any URL.",
                "transport": "stdio-python",
                "stdio": {"command": "python3", "args": ["server.py"]},
                "sandbox": "Inside the E2B sandbox: git clone https://github.com/rumblingb/pdf-generator-mcp && cd pdf-generator-mcp && pip install -r requirements.txt && python3 server.py",
                "tools": [
                    {"name": "pdf_generate_from_html", "description": "Generate PDF from HTML content"},
                    {"name": "pdf_generate_from_text", "description": "Generate PDF from plain text"},
                    {"name": "pdf_generate_from_url", "description": "Fetch a URL and convert to PDF"},
                ],
                "note": "Free tier: 50 PDFs/month; hosted/paid tier exists.",
            },
            {
                "id": "free-proxy-list",
                "name": "Free Proxy List",
                "url": "https://mcpmarket.com/server/free-proxy-list",
                "github": "https://github.com/hproxy-com/free-proxy-list",
                "description": "Fetch rotating lists of free proxy servers.",
                "transport": "remote-http",
                "remote": {"url": "https://mcp.hproxy.com/mcp", "transport": "streamable_http", "auth": "none"},
                "register_hint": "manage_mcp action 'create' with transport streamable_http, url https://mcp.hproxy.com/mcp — no auth needed.",
            },
            {
                "id": "site-shot",
                "name": "Site Shot",
                "url": "https://mcpmarket.com/server/site-shot",
                "github": "https://github.com/site-shot/site-shot-mcp",
                "npm": "https://www.npmjs.com/package/site-shot-mcp",
                "description": "Capture website screenshots on demand.",
                "transport": "stdio-npm",
                "stdio": {"command": "npx", "args": ["-y", "site-shot-mcp@1.2.0"]},
                "env_required": {"SITESHOT_API_KEY": "Sign up at site-shot.com for the API key"},
                "sandbox": "Run inside the E2B sandbox: SITESHOT_API_KEY=<key> npx -y site-shot-mcp@1.2.0 (the API key is REQUIRED).",
            },
        ],
    }


# ---------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="/tmp/skill-dl", help="dir with cloned repos + Skills.zip_x + mcpmarket/")
    ap.add_argument("--out", default=None, help="project root (default: parent of this script's dir)")
    args = ap.parse_args()

    src = args.source
    project = args.out or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_base = os.path.join(project, "public", "skill-repos")
    os.makedirs(out_base, exist_ok=True)

    def p(name):
        return os.path.join(src, name)

    print("Bundling skill repositories as local files…")

    # 1. ECC (affaan-m/ecc) — the 4 user-requested skills.
    ecc_all = collect_dir_skills(p("ecc"), "skills")
    wanted = {"remotion-video-creation", "make-interfaces-feel-better", "frontend-slides", "liquid-glass-design"}
    ecc = [s for s in ecc_all if s["name"] in wanted]
    bundle_repo(out_base, "ecc", "ECC Skills", "https://github.com/affaan-m/ecc", ecc)

    # 2. Silk Design — whole repo is one skill.
    silk = [s for s in collect_dir_skills(p("bendrape1-byte_silk-design")) if s["dir"] == ""]
    bundle_repo(out_base, "silk-design", "Silk Design",
                "https://github.com/bendrape1-byte/silk-design", silk)

    # 3. Addhumanity — 10 skills.
    bundle_repo(out_base, "addhumanity", "Addhumanity",
                "https://github.com/olivierlesnicki/addhumanity",
                collect_dir_skills(p("olivierlesnicki_addhumanity"), "skills"))

    # 4. Three.js Game Skills — 9 skills.
    bundle_repo(out_base, "threejs-game-skills", "Three.js Game Skills",
                "https://github.com/majidmanzarpour/threejs-game-skills",
                collect_dir_skills(p("majidmanzarpour_threejs-game-skills"), "skills"))

    # 5. MengTo — 177 skills, SKILL.md only (partial).
    bundle_repo(out_base, "mengto-skills", "MengTo Agent Skills",
                "https://github.com/MengTo/Skills/tree/main/agent-skills",
                collect_mengto(p("MengTo_Skills")), partial=True,
                note="Bundled SKILL.md metadata+bodies only — supporting files are fetched live from GitHub on install.")

    # 6. API Anything — skill + the sites/ service-reference docs.
    api_any = collect_with_extra_files(p("goodnight000_api-anything"), "skills/api-anything", ["sites"])
    if api_any:
        bundle_repo(out_base, "api-anything", "API Anything",
                    "https://github.com/goodnight000/api-anything", [api_any])

    # 7. Everything AI — skill.
    eai = collect_with_extra_files(p("mitunmanav_everything-ai"), "skills/everything-ai", [])
    if eai:
        bundle_repo(out_base, "everything-ai", "Everything AI",
                    "https://github.com/mitunmanav/everything-ai", [eai])

    # 8. Uploaded Skills.zip — zip-of-zips.
    up = collect_uploaded_skills(os.path.join(src, "Skills.zip_x"))
    bundle_repo(out_base, "uploaded-skills", "Uploaded Skills (Skills.zip)",
                "(user upload — see upload/Skills.zip)", up)

    # 9. MCP Market index.
    mcp_out = os.path.join(project, "public", "mcp-market")
    os.makedirs(mcp_out, exist_ok=True)
    with open(os.path.join(mcp_out, "index.json"), "w", encoding="utf-8") as fh:
        json.dump(build_mcp_market(src), fh, ensure_ascii=False, indent=1)
    print(f"  mcp-market: {len(build_mcp_market(src)['servers'])} servers with full connection configs")

    print("Done.")


if __name__ == "__main__":
    main()

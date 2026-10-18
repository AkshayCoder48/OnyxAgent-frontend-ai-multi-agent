#!/usr/bin/env python3
"""
Build the Onyx MASTER SKILL LIBRARY bundle (user request 2026-10-19).

Replaces the per-repository bundles (public/skill-repos/**, minus MCP market)
with ONE master bundle that is attached to EVERY E2B sandbox at startup:

    public/master-skill/onyx-skills.zip     <- <skill-name>/… + MASTER-INDEX.md
    public/master-skill/index.json          <- machine-readable index
    src/lib/agent/master-skills.ts          <- client-safe index module
    src/lib/agent/master-skills-zip.ts      <- server-only zip payload (base64)

Sources (first wins on front-matter `name` collisions — MengTo REMOVED per
user request; the 9 threejs-* skills MERGED into one `threejs-game-webdev`
skill = 9 game domains + 1 authored web-development guide; the anthropics
`claude-api` skill EXCLUDED per user request — OnyxAgent is provider-agnostic):

    1. anthropics/skills        (official skills minus claude-api)  anthropics_skills/skills/*
    2. scrapegraphai/just-scrape (just-scrape)             scrapegraphai_just-scrape/skills/just-scrape
    3. affaan-m/ecc             (4 skills)                 ecc/skills/*
    4. goodnight000/api-anything (+ sites/*.md|json refs)  goodnight000_api-anything
    5. bendrape1-byte/silk-design (whole repo, one skill)  bendrape1-byte_silk-design
    6. mitunmanav/everything-ai (one skill)                mitunmanav_everything-ai/skills/everything-ai
    7. olivierlesnicki/addhumanity (10 skills)             olivierlesnicki_addhumanity/skills/*
    8. majidmanzarpour/threejs-game-skills (9 → 1 merged + web-dev guide)
                                                            majidmanzarpour_threejs-game-skills/skills/*
    9. user's uploaded Skills.zip (21 skills)              staged bundle:
                                       public/skill-repos/uploaded-skills/skills/*

Caps (mirrors the runtime zip guard): 256KB/file, 120 files/skill,
2.5MB/skill raw. Binary/media/font files are EXCLUDED (text-only bundle
keeps the startup zip small; fonts are downloadable at runtime when a task
really needs them).

Usage: python3 scripts/build_master_skill.py [--source /tmp/skill-dl]
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import json
import os
import posixpath
import re
import shutil
import sys
import zipfile

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE_ROOT_DEFAULT = "/tmp/skill-dl"

PER_FILE_CAP = 256 * 1024          # 256 KB
PER_SKILL_FILES_CAP = 120
PER_SKILL_BYTES_CAP = 2_500_000    # 2.5 MB raw

# Text-only bundle: exclude fonts, media, archives, binaries, lockfiles.
EXCLUDED_EXTENSIONS = {
    # fonts
    "ttf", "otf", "woff", "woff2",
    # media
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svgz", "ico", "icns",
    "mp4", "mov", "avi", "webm", "mp3", "wav", "ogg", "m4a",
    # archives / binaries
    "zip", "gz", "tgz", "tar", "7z", "rar", "exe", "dll", "so", "dylib",
    "bin", "wasm", "pdf", "psd", "ai", "class", "jar", "pyc", "node",
    # lockfiles / junk
    "lock",
}
EXCLUDED_FILENAMES = {
    ".DS_Store", "Thumbs.db", ".gitignore", ".gitattributes", ".npmrc",
    "package-lock.json", "bun.lock", "bun.lockb", "yarn.lock",
    "pnpm-lock.yaml", ".env", ".env.local",
}
EXCLUDED_DIR_NAMES = {".git", "node_modules", "__pycache__", ".venv", "venv"}

TEXT_EXTENSIONS = {
    "md", "markdown", "txt", "json", "jsonc", "yaml", "yml", "toml",
    "py", "sh", "bash", "zsh", "js", "mjs", "cjs", "ts", "tsx", "jsx",
    "html", "htm", "css", "scss", "less", "xml", "xsd", "svg", "csv",
    "tsv", "ini", "cfg", "conf", "env.example", "r", "rb", "go", "rs",
    "java", "kt", "c", "h", "cpp", "hpp", "cs", "php", "sql", "graphql",
    "proto", "Makefile", "Dockerfile", "gitignore",
}


def file_allowed(relpath: str, size: int) -> bool:
    """Text-only whitelist with an explicit binary blacklist + size cap."""
    base = posixpath.basename(relpath)
    if base in EXCLUDED_FILENAMES:
        return False
    ext = base.rsplit(".", 1)[-1].lower() if "." in base else ""
    if ext in EXCLUDED_EXTENSIONS:
        return False
    if ext and ext not in TEXT_EXTENSIONS:
        # Unknown extension: allow only if it looks textual and is small.
        return size <= 64 * 1024 and ext in {"example", "sample", "gitkeep", "tmpl"}
    if not ext:
        # Extensionless (Makefile, Dockerfile, LICENSE, …) — allow if small.
        return size <= PER_FILE_CAP
    return size <= PER_FILE_CAP


# ---------------------------------------------------------------------------
# Front-matter parsing
# ---------------------------------------------------------------------------

FRONT_MATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n", re.DOTALL)


def _extract_multiline(fm: str, key: str) -> str:
    """Extract a front-matter value, supporting YAML folded (>) / literal (|)
    blocks and indented continuation lines."""
    m = re.search(rf"^{key}:\s*(.*)$", fm, re.MULTILINE)
    if not m:
        return ""
    value = m.group(1).strip()
    if value and value[0] not in ">|":
        # Single-line value (strip surrounding quotes).
        return value.strip("\"'")
    # Multiline block: collect indented lines after the `key: >` marker.
    lines: list[str] = []
    started = False
    for line in fm[m.end():].split("\n"):
        if not line.strip():
            if started:
                lines.append("")
            continue
        if re.match(r"^\s", line):
            started = True
            lines.append(line.strip())
        else:
            break
    text = " ".join(ln for ln in lines if ln)
    return text.strip("\"'")


def parse_skill_md(text: str) -> tuple[str, str, str]:
    """Return (name, description, body-without-front-matter)."""
    name, description = "", ""
    m = FRONT_MATTER_RE.match(text)
    if m:
        fm = m.group(1)
        body = text[m.end():]
        name = _extract_multiline(fm, "name").strip()
        description = _extract_multiline(fm, "description").strip()
    else:
        body = text
    return name, description, body


def kebab(s: str) -> str:
    s = re.sub(r"[^a-z0-9-]+", "-", s.lower()).strip("-")
    return re.sub(r"-{2,}", "-", s)


SAFE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


def safe_name(raw: str, fallback: str) -> str:
    """Skill names are directory names: force kebab-case (front-matter names
    like 'Excel / XLSX' would otherwise create broken nested paths)."""
    candidate = kebab(raw.replace("/", " "))
    if SAFE_NAME_RE.match(candidate) and len(candidate) >= 2:
        return candidate
    return kebab(fallback)


# ---------------------------------------------------------------------------
# Staging
# ---------------------------------------------------------------------------

class Skill:
    def __init__(self, name: str, description: str, category: str):
        self.name = name
        self.description = description
        self.category = category
        self.files: dict[str, bytes] = {}   # relpath -> bytes
        self.skipped: list[str] = []

    def add(self, relpath: str, data: bytes) -> None:
        if len(self.files) >= PER_SKILL_FILES_CAP:
            self.skipped.append(relpath)
            return
        self.files[relpath] = data

    @property
    def bytes(self) -> int:
        return sum(len(v) for v in self.files.values())


def stage_dir(src_root: str, subpath: str, skill: Skill, prefix: str = "") -> None:
    """Recursively stage a directory's text files under `prefix` in the skill."""
    base = os.path.join(src_root, subpath) if subpath else src_root
    if not os.path.isdir(base):
        return
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDED_DIR_NAMES]
        for fn in sorted(filenames):
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, base)
            rel = rel.replace(os.sep, "/")
            dest = f"{prefix}{rel}" if prefix else rel
            try:
                size = os.path.getsize(full)
            except OSError:
                continue
            if not file_allowed(dest, size):
                skill.skipped.append(dest)
                continue
            if skill.bytes + size > PER_SKILL_BYTES_CAP:
                skill.skipped.append(dest)
                continue
            try:
                with open(full, "rb") as f:
                    skill.add(dest, f.read())
            except OSError:
                continue


def load_skill_from_dir(src_root: str, subpath: str, category: str,
                        name_override: str | None = None) -> Skill | None:
    """Load one skill (a dir containing SKILL.md at its root)."""
    skill_dir = os.path.join(src_root, subpath) if subpath else src_root
    md_path = os.path.join(skill_dir, "SKILL.md")
    if not os.path.isfile(md_path):
        return None
    with open(md_path, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()
    name, description, _body = parse_skill_md(text)
    if name_override:
        name = name_override
    fallback = os.path.basename(subpath.rstrip("/")) or "skill"
    name = safe_name(name, fallback) if name else kebab(fallback)
    skill = Skill(name, description or "", category)
    stage_dir(src_root, subpath, skill)
    return skill


# ---------------------------------------------------------------------------
# threejs merge (9 -> 1 + authored web-dev guide)
# ---------------------------------------------------------------------------

# Authored domain guide: the original repo is 100% game-focused; this adds
# the WEB-DEVELOPMENT half (hero sections, product showcases, scroll scenes,
# R3F/Next.js integration, web perf/a11y budgets) so the merged skill covers
# Three.js game + web dev as requested.
WEB_DEV_GUIDE = '''# Three.js Web Development — interactive 3D on real websites

Use this domain when the deliverable is a WEBSITE or a web FEATURE powered by
Three.js — not a game: hero sections, product showcases & configurators,
scroll-driven storytelling, 3D portfolios, data-viz scenes, particle
backgrounds. For gameplay, loops, and score, use the game domains instead.

## 1. Choose the right integration

- Tiny accent (gradient, glow, blob)? CSS/SVG first — Three.js only when it
  is genuinely 3D and interactive.
- One-off hero or product viewer on a plain site → vanilla Three.js module,
  no framework.
- React / Next.js site → `@react-three/fiber` (R3F) + `@react-three/drei`.
- Scroll story → R3F `ScrollControls` or manual scroll mapping + Lenis.
- Full-site 3D app → architect it like a game (see threejs-game-director)
  but keep every route code-split.

## 2. Project setups (pick ONE)

### Vanilla Vite + TypeScript
- `npm create vite@latest` → add `three` + `@types/three`.
- Core: `WebGLRenderer({ antialias: true, alpha: true })`, `ACESFilmicToneMapping`,
  `PerspectiveCamera(fov 45)`, resize via ResizeObserver, rAF loop with
  `clock.getDelta()`.
- Unmount hygiene: dispose geometries, materials, textures, renderer; cancel rAF.

### Next.js + React Three Fiber
- App Router: the `<Canvas>` tree is a client component — `"use client"` on
  every 3D file, `dynamic(() => import(...), { ssr: false })` at the boundary.
- `<Canvas dpr={[1, 2]} camera={{ fov: 45, position: [...] }}
  gl={{ antialias: true, alpha: true }}>`.
- drei workhorses: `Environment` (HDR lighting), `useGLTF` (+ `useGLTF.preload`),
  `ContactShadows`, `Float`, `Html`, `useScroll`/`ScrollControls`, `PerformanceMonitor`.

## 3. Scroll-driven scenes

- Map scroll progress 0..1 to camera path + scene state; LERP every frame —
  never snap.
- R3F: `ScrollControls` + `useScroll()`; vanilla: scroll listener → target
  value consumed inside the rAF loop.
- Keep copy/headings as REAL DOM (overlay divs or drei `<Html>`), not in-canvas
  text — SEO and a11y live in the DOM.
- Long timelines: GSAP ScrollTrigger or Lenis smoothing; pin sections; scrub
  (tie animation time to scroll, not to clock).

## 4. Hero sections & backgrounds

- Budget: ≤ 150k triangles, one material per draw call, ≤ 2-3 texture sets.
- Particle backgrounds: `THREE.Points` + `BufferGeometry` + `ShaderMaterial`;
  cap counts by device (mobile ≈ 40-60% of desktop), animate in the shader.
- Pause rendering when the canvas is offscreen (`IntersectionObserver`) and
  when the tab is hidden (`visibilitychange`).
- `prefers-reduced-motion`: render ONE static frame — no continuous loop.

## 5. Product showcases & configurators

- GLTF assets, DRACO or meshopt compressed; target ≤ 2MB per model on 4G.
- Lighting: drei `Environment` preset or a small HDR (polyhaven) — no baked
  point-light clusters.
- Hotspots: raycast hover/click + drei `<Html>` anchors for labels.
- Variant switching: share the geometry, swap material/color instances —
  never re-load the model per variant.
- `OrbitControls`: `enablePan={false}`, clamp `minDistance`/`maxDistance`/
  `minPolarAngle`/`maxPolarAngle` so users cannot get lost.

## 6. Web performance budget (non-negotiable)

- LCP < 2.5s: ship a poster/placeholder; fade the canvas in when assets are
  ready — the 3D layer must never block first paint.
- Code-split the 3D chunk (dynamic import); lazy-mount below-the-fold canvases.
- Cap `dpr` to [1, 2]; antialias only when dpr ≤ 1.5 (mobile GPUs).
- Compress: DRACO/meshopt for meshes, KTX2/basis for textures.
- Dispose on route change — leaked WebGL contexts kill an SPA.
- Test on throttled mid-tier mobile (CPU 4x slowdown); desktop 60fps is not
  the bar, throttled mobile is.

## 7. Responsive & accessibility

- The canvas fills a CONTAINER div (never the window); ResizeObserver →
  `camera.aspect` + `renderer.setSize`.
- Touch targets ≥ 44px; passive listeners for scroll/touch.
- Fallbacks: poster frame, `prefers-reduced-motion` static frame,
  `<noscript>` message.
- Overlay text must still pass WCAG contrast — the 3D behind it is not an
  excuse; keep overlay UI keyboard-navigable.

## 8. SEO & deployment

- Real DOM carries the content: headings, copy, links are HTML; 3D is the
  enhancement layer.
- Static export or Node server both work; models/textures live in `public/`
  with long-lived cache headers and absolute `/paths`.
- `og:image` = the poster frame, not a canvas capture.

## 9. Web vs game — route the task

- Score, input loops, physics, enemies, levels → the game domains
  (start at threejs-gameplay-systems).
- Marketing site, product page, portfolio, landing → THIS guide.
- Mixed (playable ad, configurator with mini-game) → this guide for the shell,
  game domains for the playable core.

## Ship checklist

- [ ] Poster/placeholder + fade-in on ready
- [ ] 3D chunk code-split; below-fold canvases lazy
- [ ] dpr capped, DRACO/KTX2 compression on
- [ ] Rendering paused offscreen + hidden tab
- [ ] Reduced-motion static frame
- [ ] Resize + throttled-mobile pass
- [ ] Everything disposed on unmount
- [ ] Real-DOM text for SEO; overlays keyboard-navigable
'''


def build_threejs_merged(src_root: str) -> Skill | None:
    """Merge the 9 threejs-* game skills into ONE `threejs-game-webdev` skill
    covering Three.js GAME + WEB development (10 domains: 9 from the repo +
    the authored web-development guide).

    Layout:
      threejs-game-webdev/SKILL.md                     <- front matter + domain map
      threejs-game-webdev/domains/<orig-name>.md       <- each skill's full body
      threejs-game-webdev/domains/threejs-web-development.md  <- authored web guide
      threejs-game-webdev/<orig-name>/references|...   <- supporting files preserved
    """
    base = os.path.join(src_root, "majidmanzarpour_threejs-game-skills", "skills")
    if not os.path.isdir(base):
        return None
    domains = []
    for entry in sorted(os.listdir(base)):
        md_path = os.path.join(base, entry, "SKILL.md")
        if not os.path.isfile(md_path):
            continue
        with open(md_path, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
        name, description, body = parse_skill_md(text)
        if not name:
            name = kebab(entry)
        domains.append({"name": name, "description": description, "body": body})

    if not domains:
        return None

    name = "threejs-game-webdev"
    description = (
        "Complete Three.js GAME + WEB development in one skill — game "
        "direction, gameplay systems, AAA graphics, in-game UI, "
        "debug/profiling, QA & release, procedural 3D/image/audio generation, "
        "PLUS interactive 3D websites: hero sections, product showcases & "
        "configurators, scroll-driven scenes, React/Next.js (R3F) integration, "
        "web performance and accessibility. The SKILL.md domain map routes to "
        "the 10 domain guides in domains/ and their deep references."
    )
    skill = Skill(name, description, "3D, Games & Web")

    lines = [
        "---",
        f"name: {name}",
        f"description: {description}",
        "---",
        "",
        "# Three.js Game + Web Development — the complete production skill",
        "",
        "This ONE skill replaces the former nine separate threejs-* skills and",
        "covers BOTH production lines: browser GAMES (9 domains from the",
        "original repo) and interactive 3D WEB development (the authored",
        "web-development guide). The map below lists every domain; read the",
        "domain guide you need:",
        "`read_file skills/threejs-game-webdev/domains/<domain>.md`.",
        "",
        "## Domain map",
        "",
        "### Games (9 domains)",
        "",
    ]
    for d in domains:
        lines.append(f"### {d['name']}")
        lines.append(f"{d['description'] or ''}".strip())
        lines.append(f"Full guide: `domains/{d['name']}.md` — deep references under `{d['name']}/`.")
        lines.append("")
    lines += [
        "### Web development (authored)",
        "",
        "### threejs-web-development",
        "Interactive 3D on real websites: hero sections, product showcases & "
        "configurators, scroll-driven scenes, particle backgrounds, React/"
        "Next.js (R3F) integration, web performance budgets, responsive "
        "canvases, accessibility and SEO-safe 3D.",
        "Full guide: `domains/threejs-web-development.md`.",
        "",
        "## How to use",
        "1. Route the task: GAME (loops, score, physics, levels) → the game "
        "domains; WEBSITE/WEB FEATURE (landing, product page, portfolio, "
        "scroll story) → `threejs-web-development`.",
        "2. Read the matching domain guide (and its references) BEFORE writing code.",
        "3. Combine domains as needed — a gameplay task usually needs "
        "`threejs-gameplay-systems` + `threejs-debug-profiler`; a product "
        "showcase usually needs `threejs-web-development` + "
        "`threejs-aaa-graphics-builder`.",
        "",
    ]
    skill.add("SKILL.md", ("\n".join(lines)).encode("utf-8"))

    for d in domains:
        skill.add(f"domains/{d['name']}.md", d["body"].encode("utf-8"))
    skill.add("domains/threejs-web-development.md", WEB_DEV_GUIDE.encode("utf-8"))
    # Supporting files (references/scripts/agents) under <orig-name>/…
    for entry in sorted(os.listdir(base)):
        entry_full = os.path.join(base, entry)
        if not os.path.isdir(entry_full):
            continue
        for dirpath, dirnames, filenames in os.walk(entry_full):
            dirnames[:] = [x for x in dirnames if x not in EXCLUDED_DIR_NAMES]
            for fn in sorted(filenames):
                if fn == "SKILL.md":
                    continue
                full = os.path.join(dirpath, fn)
                rel = os.path.relpath(full, entry_full).replace(os.sep, "/")
                dest = f"{entry}/{rel}"
                size = os.path.getsize(full)
                if not file_allowed(dest, size):
                    skill.skipped.append(dest)
                    continue
                if skill.bytes + size > PER_SKILL_BYTES_CAP:
                    skill.skipped.append(dest)
                    continue
                with open(full, "rb") as f:
                    skill.add(dest, f.read())
    return skill


# ---------------------------------------------------------------------------
# MASTER-INDEX.md
# ---------------------------------------------------------------------------

INDEX_HEADER = """# Onyx Master Skill Library

> **FIXED RULE — read this at the start of every task:** this index lists
> EVERY skill in the library by name with a one-line description of what it
> is for. Pick skills BY NAME from the list below, then read the skill
> before applying it:
>
>     read_file  /home/user/skills/<skill-name>/SKILL.md
>
> All skills are ALREADY INSTALLED in this sandbox at `/home/user/skills/` —
> there is nothing to download or install. Never guess a skill's contents;
> never bulk-read skills you don't need; never claim a capability is missing
> before checking this list.
"""


def build_master_index(skills: list[Skill]) -> str:
    out = [INDEX_HEADER]
    by_cat: dict[str, list[Skill]] = {}
    for s in skills:
        by_cat.setdefault(s.category, []).append(s)
    for cat in sorted(by_cat):
        out.append(f"\n## {cat}\n")
        for s in sorted(by_cat[cat], key=lambda x: x.name):
            out.append(f"- **{s.name}** — {s.description}")
    out.append(
        "\n## Your own skills\n"
        "Skills the user installs via the app (Settings → Skills) land in this\n"
        "same `/home/user/skills/` folder — `list_folder /home/user/skills` shows\n"
        "everything available. `manage_skill` (action `list`) tracks the user's\n"
        "app-installed skills; this library ships with OnyxAgent itself.\n"
    )
    return "\n".join(out)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default=SOURCE_ROOT_DEFAULT)
    ap.add_argument("--out", default=REPO_ROOT)
    args = ap.parse_args()
    src = args.source

    skills: list[Skill] = []
    taken: dict[str, str] = {}   # name -> source label
    dedupes: list[tuple[str, str, str]] = []  # (name, winner, loser)

    def add(skill: Skill | None, label: str) -> None:
        if skill is None:
            return
        if skill.name in taken:
            dedupes.append((skill.name, taken[skill.name], label))
            return
        if "SKILL.md" not in skill.files:
            return
        taken[skill.name] = label
        skills.append(skill)

    # 1. anthropics/skills — official skills, EXCLUDING claude-api (user
    #    request 2026-10-19: remove the Claude API skill — OnyxAgent is
    #    provider-agnostic and the 94-file Claude API reference bloats the
    #    startup zip without being usable by the agent).
    ANTHROPICS_EXCLUDED = {"claude-api"}
    ant_root = os.path.join(src, "anthropics_skills", "skills")
    if os.path.isdir(ant_root):
        for entry in sorted(os.listdir(ant_root)):
            if entry in ANTHROPICS_EXCLUDED:
                print(f"  excluded (user request): anthropics/{entry}")
                continue
            if os.path.isdir(os.path.join(ant_root, entry)):
                add(load_skill_from_dir(ant_root, entry, "Anthropic Official"),
                    f"anthropics/{entry}")
    else:
        print(f"!! missing source: {ant_root}", file=sys.stderr)

    # 2. scrapegraphai/just-scrape.
    add(load_skill_from_dir(
        src, "scrapegraphai_just-scrape/skills/just-scrape", "Web & Data"),
        "scrapegraphai/just-scrape")

    # 3. affaan-m/ecc — ONLY the four user-requested skills (the repo ships
    #    311; the user explicitly picked these four via skillfish 2026-10-18).
    ECC_SELECTED = {
        "remotion-video-creation", "make-interfaces-feel-better",
        "frontend-slides", "liquid-glass-design",
    }
    ecc_root = os.path.join(src, "ecc", "skills")
    if os.path.isdir(ecc_root):
        for entry in sorted(ECC_SELECTED):
            if os.path.isdir(os.path.join(ecc_root, entry)):
                add(load_skill_from_dir(ecc_root, entry, "Design, UI & Video"),
                    f"ecc/{entry}")
            else:
                print(f"!! ecc skill missing: {entry}", file=sys.stderr)

    # 4. api-anything — SKILL.md + the sites/*.md|json service references.
    api_skill = load_skill_from_dir(
        src, "goodnight000_api-anything/skills/api-anything", "Web & Data")
    if api_skill:
        sites_dir = os.path.join(src, "goodnight000_api-anything", "sites")
        if os.path.isdir(sites_dir):
            for fn in sorted(os.listdir(sites_dir)):
                if not fn.endswith((".md", ".json")):
                    continue
                full = os.path.join(sites_dir, fn)
                if os.path.getsize(full) > PER_FILE_CAP:
                    continue
                with open(full, "rb") as f:
                    api_skill.add(f"sites/{fn}", f.read())
        add(api_skill, "goodnight000/api-anything")

    # 5. silk-design — whole repo as ONE skill (SKILL.md at repo root).
    add(load_skill_from_dir(src, "bendrape1-byte_silk-design", "Design & UI"),
        "bendrape1-byte/silk-design")

    # 6. everything-ai.
    add(load_skill_from_dir(
        src, "mitunmanav_everything-ai/skills/everything-ai", "Agent Tooling"),
        "mitunmanav/everything-ai")

    # 7. addhumanity (10).
    ah_root = os.path.join(src, "olivierlesnicki_addhumanity", "skills")
    if os.path.isdir(ah_root):
        for entry in sorted(os.listdir(ah_root)):
            if os.path.isdir(os.path.join(ah_root, entry)):
                add(load_skill_from_dir(ah_root, entry, "Mental Wellbeing"),
                    f"addhumanity/{entry}")

    # 8. threejs — the 9 game skills merged into ONE game+webdev skill
    #    (9 repo domains + the authored web-development guide).
    add(build_threejs_merged(src), "threejs-game-skills (merged 9→1 + web-dev guide)")

    # 9. uploaded Skills.zip — staged from the persistent build input
    #    (build-inputs/uploaded-skills — the canonical extracted + deduped
    #    form of the user's Skills.zip).
    uploaded_root = os.path.join(
        args.out, "build-inputs", "uploaded-skills", "skills")
    if os.path.isdir(uploaded_root):
        for entry in sorted(os.listdir(uploaded_root)):
            entry_full = os.path.join(uploaded_root, entry)
            if not os.path.isdir(entry_full):
                continue
            skill = Skill("", "", "Agent Toolbox")
            stage_dir(uploaded_root, entry, skill)
            # Recover name/description from the staged SKILL.md.
            md = skill.files.get("SKILL.md", b"").decode("utf-8", "replace")
            nm, desc, _ = parse_skill_md(md)
            skill.name = safe_name(nm, entry) if nm else kebab(entry)
            skill.description = desc
            add(skill, f"uploaded/{entry}")
    else:
        print(f"!! missing uploaded bundle: {uploaded_root}", file=sys.stderr)

    if not skills:
        print("FATAL: no skills staged", file=sys.stderr)
        return 1

    # ------------------------------------------------------------------
    # Build the outputs.
    # ------------------------------------------------------------------
    skills.sort(key=lambda s: (s.category, s.name))
    master_index = build_master_index(skills)
    version = dt.datetime.now(dt.timezone.utc).strftime("%Y.%m.%d-%H%M")

    zip_path = os.path.join(args.out, "public", "master-skill", "onyx-skills.zip")
    os.makedirs(os.path.dirname(zip_path), exist_ok=True)

    total_raw = 0
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        zf.writestr("MASTER-INDEX.md", master_index)
        for s in skills:
            for rel in sorted(s.files):
                data = s.files[rel]
                total_raw += len(data)
                zf.writestr(f"{s.name}/{rel}", data)
    with open(zip_path, "rb") as f:
        zip_bytes = f.read()
    sha = hashlib.sha256(zip_bytes).hexdigest()

    # index.json
    index_payload = {
        "version": version,
        "sha256": sha,
        "count": len(skills),
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "skills": [
            {
                "name": s.name,
                "description": s.description,
                "category": s.category,
                "files": len(s.files) - (1 if "SKILL.md" in s.files else 0),
                "bytes": s.bytes,
            }
            for s in skills
        ],
    }
    with open(os.path.join(args.out, "public", "master-skill", "index.json"), "w") as f:
        json.dump(index_payload, f, indent=2)

    # src/lib/agent/master-skills.ts (client-safe index module)
    def ts_str(s: str) -> str:
        return json.dumps(s, ensure_ascii=False)

    ts_lines = [
        "// AUTO-GENERATED by scripts/build_master_skill.py — DO NOT EDIT BY HAND.",
        f"// Regenerate with: python3 scripts/build_master_skill.py  (version {version})",
        "/**",
        " * The Onyx MASTER SKILL LIBRARY index (client-safe, no payload).",
        " *",
        " * Every E2B sandbox receives the WHOLE library at startup — the zip",
        " * payload lives in ./master-skills-zip (server-only). This module",
        " * carries the metadata index: every skill by name + one-line",
        " * description, so the model (and the UI) can pick skills BY NAME",
        " * without loading any skill body. The same list ships inside the",
        " * sandbox at /home/user/skills/MASTER-INDEX.md.",
        " */",
        "",
        f"export const MASTER_SKILLS_VERSION = {ts_str(version)};",
        f"export const MASTER_SKILLS_COUNT = {len(skills)};",
        f"export const MASTER_SKILLS_SHA256 = {ts_str(sha)};",
        "",
        "/** Where the library lives inside every E2B sandbox. */",
        'export const MASTER_LIBRARY_PATH = "/home/user/skills";',
        'export const MASTER_INDEX_PATH = "/home/user/skills/MASTER-INDEX.md";',
        "",
        "export interface MasterSkillMeta {",
        "  readonly name: string;",
        "  readonly description: string;",
        "  readonly category: string;",
        "}",
        "",
        "export const MASTER_SKILLS: readonly MasterSkillMeta[] = [",
    ]
    for s in skills:
        ts_lines.append(
            f"  {{ name: {ts_str(s.name)}, description: {ts_str(s.description)},"
            f" category: {ts_str(s.category)} }},"
        )
    ts_lines += [
        "];",
        "",
        "export function findMasterSkill(name: string): MasterSkillMeta | null {",
        "  const needle = name.trim().toLowerCase();",
        "  return MASTER_SKILLS.find((s) => s.name.toLowerCase() === needle) ?? null;",
        "}",
        "",
    ]
    with open(os.path.join(args.out, "src/lib/agent/master-skills.ts"), "w") as f:
        f.write("\n".join(ts_lines))

    # src/lib/agent/master-skills-zip.ts (server-only payload module)
    b64 = base64.b64encode(zip_bytes).decode("ascii")
    with open(os.path.join(args.out, "src/lib/agent/master-skills-zip.ts"), "w") as f:
        f.write(
            "// AUTO-GENERATED by scripts/build_master_skill.py — DO NOT EDIT.\n"
            "// SERVER-ONLY: the master skill library zip payload (base64).\n"
            "// Imported exclusively by server code (sandbox route + scheduler)\n"
            "// that attaches it to every E2B sandbox at startup.\n"
            f"export const MASTER_SKILLS_ZIP_BASE64 =\n"
            f'  "{b64}";\n'
        )

    # public/master-skill/README.md
    with open(os.path.join(args.out, "public", "master-skill", "README.md"), "w") as f:
        f.write(
            "# Onyx Master Skill Library (generated)\n\n"
            "`onyx-skills.zip` + `index.json` are generated by\n"
            "`scripts/build_master_skill.py`. The zip is baked into the app\n"
            "(`src/lib/agent/master-skills-zip.ts`) and attached to EVERY E2B\n"
            "sandbox at startup — extracted to `/home/user/skills/` with\n"
            "`MASTER-INDEX.md` at its root. Sources: anthropics/skills (all\n"
            "official skills except claude-api), scrapegraphai/just-scrape,\n"
            "affaan-m/ecc, api-anything, silk-design, everything-ai, addhumanity,\n"
            "threejs-game-skills (9 game skills merged into 1 game+web-dev skill),\n"
            f"and the user's uploaded Skills.zip. {len(skills)} skills total.\n\n"
            f"Version {version} · sha256 {sha[:16]}…\n"
        )

    # ------------------------------------------------------------------
    # Report.
    # ------------------------------------------------------------------
    print(f"Master skill library: {len(skills)} skills, "
          f"{total_raw/1024:.0f}KB raw → zip {len(zip_bytes)/1024:.0f}KB "
          f"(base64 {len(b64)/1024:.0f}KB)")
    print(f"  version={version} sha256={sha[:16]}…")
    for s in skills:
        flag = f"  [{len(s.skipped)} files skipped]" if s.skipped else ""
        print(f"  - {s.name:38s} {s.bytes/1024:7.1f}KB {len(s.files):3d} files{flag}")
    if dedupes:
        print("\nDeduped (first source wins):")
        for name, winner, loser in dedupes:
            print(f"  - {name}: {winner} kept, {loser} dropped")
    return 0


if __name__ == "__main__":
    sys.exit(main())

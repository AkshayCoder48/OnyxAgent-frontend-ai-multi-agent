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
user request; the 9 threejs-* skills MERGED into one `threejs-game` skill):

    1. anthropics/skills        (ALL 19 official skills)   anthropics_skills/skills/*
    2. scrapegraphai/just-scrape (just-scrape)             scrapegraphai_just-scrape/skills/just-scrape
    3. affaan-m/ecc             (4 skills)                 ecc/skills/*
    4. goodnight000/api-anything (+ sites/*.md|json refs)  goodnight000_api-anything
    5. bendrape1-byte/silk-design (whole repo, one skill)  bendrape1-byte_silk-design
    6. mitunmanav/everything-ai (one skill)                mitunmanav_everything-ai/skills/everything-ai
    7. olivierlesnicki/addhumanity (10 skills)             olivierlesnicki_addhumanity/skills/*
    8. majidmanzarpour/threejs-game-skills (9 → 1 merged)  majidmanzarpour_threejs-game-skills/skills/*
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
# threejs merge (9 -> 1)
# ---------------------------------------------------------------------------

def build_threejs_merged(src_root: str) -> Skill | None:
    """Merge the 9 threejs-* skills into ONE `threejs-game` skill.

    Layout:
      threejs-game/SKILL.md                     <- front matter + domain map
      threejs-game/domains/<orig-name>.md       <- each skill's full body
      threejs-game/<orig-name>/references|...   <- supporting files preserved
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

    name = "threejs-game"
    description = (
        "Complete Three.js game production in one skill — game direction, "
        "gameplay systems, AAA graphics, in-game UI, debug/profiling, QA & "
        "release, procedural 3D generation, image generation and audio. The "
        "SKILL.md domain map routes to the 9 full domain guides in domains/ "
        "and their deep references."
    )
    skill = Skill(name, description, "3D & Games")

    lines = [
        "---",
        f"name: {name}",
        f"description: {description}",
        "---",
        "",
        "# Three.js Game Development — the complete production skill",
        "",
        "This ONE skill replaces the former nine separate threejs-* skills.",
        "It covers the full production pipeline for Three.js games. The map",
        "below lists every domain; read the domain guide you need:",
        "`read_file skills/threejs-game/domains/<domain>.md`.",
        "",
        "## Domain map",
        "",
    ]
    for d in domains:
        lines.append(f"### {d['name']}")
        lines.append(f"{d['description'] or ''}".strip())
        lines.append(f"Full guide: `domains/{d['name']}.md` — deep references under `{d['name']}/`.")
        lines.append("")
    lines.append("## How to use")
    lines.append("1. Identify the production phase of the task (design → systems → graphics → UI → audio → debug → QA → release).")
    lines.append("2. Read the matching domain guide (and its references) BEFORE writing code.")
    lines.append("3. Combine domains as needed — a gameplay task usually needs `threejs-gameplay-systems` + `threejs-debug-profiler`.")
    lines.append("")
    skill.add("SKILL.md", ("\n".join(lines)).encode("utf-8"))

    for d in domains:
        skill.add(f"domains/{d['name']}.md", d["body"].encode("utf-8"))
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

    # 1. anthropics/skills — ALL official skills.
    ant_root = os.path.join(src, "anthropics_skills", "skills")
    if os.path.isdir(ant_root):
        for entry in sorted(os.listdir(ant_root)):
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

    # 8. threejs — the 9 merged into ONE.
    add(build_threejs_merged(src), "threejs-game-skills (merged 9→1)")

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
            "`MASTER-INDEX.md` at its root. Sources: anthropics/skills (all),\n"
            "scrapegraphai/just-scrape, affaan-m/ecc, api-anything, silk-design,\n"
            "everything-ai, addhumanity, threejs-game-skills (9 merged into 1),\n"
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

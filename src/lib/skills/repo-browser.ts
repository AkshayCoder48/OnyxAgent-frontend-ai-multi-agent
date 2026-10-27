"use client";

/**
 * Bundled-first skill-repository browsing + installing.
 *
 * Backs the `manage_skill` actions `browse_repository` and
 * `install_from_repository` (and the Settings → Skills repositories panel).
 *
 * TRANSPORT ORDER (user request 2026-10-18: "add them as files, not repo
 * links — downloaded directly"):
 *
 *   0. BUNDLED FILES (primary) — the default repositories ship AS LOCAL FILES
 *      under `public/skill-repos/<id>/` (manifest.json + skills/…, generated
 *      by scripts/bundle_skill_repos.py). Fetched same-origin: no GitHub API,
 *      no jsDelivr, no rate limits, works offline. `partial` bundles
 *      (mengto-skills: 177 SKILL.md bodies without supporting files) fall
 *      through to the live transports for the missing files only.
 *   1. jsDelivr (live fallback) — data API listing + per-file CDN reads.
 *   2. codeload archives (live fallback) — central-directory names only,
 *      bomb-capped inflation of exactly the requested entries (./zip).
 *
 *   - `fetchRepositoryIndex(repoId)` — METADATA-ONLY index of a repository's
 *     skills (never full skill bodies — the PRD's metadata-first rule).
 *   - `installSkillFromRepository(userId, repoId, skill)` — resolves a skill
 *     in the index, downloads its whole folder (SKILL.md + supporting files,
 *     capped), writes it to OPFS under `users/<userId>/skills/<name>/` and
 *     registers it with source "bundled-repository" / "repository".
 *
 * Live fetches go through the in-app `/api/chat-proxy` GET endpoint (CORS);
 * in-memory caches keep repeat browses/installs cheap (bundled manifests are
 * build-versioned, so they cache for the whole session).
 */

import {
  getSkillRepository,
  type RepoSkillMeta,
  type SkillRepository,
} from "./catalog-registry";
import { parseSkillFrontMatter, uploadSkillToSandbox, type InstalledSkillMeta } from "./installer";
import {
  extractZipEntries,
  parseZipCentralDirectory,
  validateSkillMdText,
  type ZipEntryInfo,
} from "./zip";
import { ensureSkillDir, writeFileAtPath } from "@/lib/storage/opfs";
import { skillService } from "@/lib/services";

// ---------------------------------------------------------------------------
// Limits & cache.
// ---------------------------------------------------------------------------

/** Live-transport cache TTL (bundled manifests cache for the session). */
const CACHE_TTL_MS = 10 * 60 * 1000;
/** Max skills returned from a live listing scan. */
const MAX_LIVE_SKILLS = 60;
/** Max files installed per skill (live transport). */
const MAX_INSTALL_FILES = 30;
/** Max files installed per skill (bundled transport — files already local). */
const MAX_BUNDLED_INSTALL_FILES = 60;
/** Max bytes per installed file. */
const MAX_FILE_BYTES = 256 * 1024;
/** Max total bytes per installed skill (live transport). */
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
/** Max total bytes per installed skill (bundled transport). */
const MAX_BUNDLED_TOTAL_BYTES = 3 * 1024 * 1024;
/** Repo archive (fallback transport) download cap — protects the proxy. */
const MAX_ZIP_BYTES = 20 * 1024 * 1024;
/** Extensions treated as text (anything else is skipped with a warning). */
const TEXT_EXTENSIONS = new Set([
  "md", "txt", "markdown", "json", "yaml", "yml", "toml", "xml", "html", "css",
  "scss", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java",
  "sh", "bash", "env", "cfg", "ini", "csv", "svg", "graphql", "sql",
]);

interface RepoFile {
  path: string;
  size: number;
}

interface RepoArchive {
  entries: ZipEntryInfo[];
  bytes: Uint8Array;
}

interface RepoListing {
  files: RepoFile[];
  /** Which transport produced the listing. */
  via: "bundled" | "jsdelivr" | "archive";
  /** The archive when the fallback transport loaded one (reused for reads). */
  archive?: RepoArchive;
}

const listingCache = new Map<string, { listing: RepoListing; fetchedAt: number }>();
const indexCache = new Map<string, { index: RepositoryIndex; fetchedAt: number }>();

// ---------------------------------------------------------------------------
// Transport 0 (primary): BUNDLED FILES — public/skill-repos/<id>/.
// ---------------------------------------------------------------------------

/** One bundled repository manifest (public/skill-repos/<id>/manifest.json). */
export interface BundledManifest {
  id: string;
  name: string;
  source_url?: string;
  bundled_at?: string;
  /** True when only SOME of each skill's files are bundled (e.g. SKILL.md only). */
  partial?: boolean;
  note?: string;
  skills: Array<RepoSkillMeta & { files?: Array<{ path: string; size: number }> }>;
}

const bundledManifestCache = new Map<string, BundledManifest | null>();

/**
 * Fetch a repository's bundled manifest (same-origin static file — the
 * repositories ship as FILES in this app). Null when the repo isn't bundled
 * or the fetch fails (→ live transports take over).
 */
export async function fetchBundledManifest(repoId: string): Promise<BundledManifest | null> {
  if (bundledManifestCache.has(repoId)) return bundledManifestCache.get(repoId) ?? null;
  let manifest: BundledManifest | null = null;
  try {
    const res = await fetch(`/skill-repos/${encodeURIComponent(repoId)}/manifest.json`, {
      headers: { Accept: "application/json" },
    });
    if (res.ok) {
      const json = (await res.json()) as BundledManifest;
      if (Array.isArray(json?.skills)) manifest = json;
    }
  } catch (err) {
    console.warn(`[repo-browser] bundled manifest fetch failed for ${repoId}:`, err);
  }
  // Bundled manifests are build-versioned → cache for the whole session.
  bundledManifestCache.set(repoId, manifest);
  return manifest;
}

/** Same-origin read of ONE bundled file. */
async function fetchBundledTextFile(repoId: string, dir: string, path: string): Promise<string> {
  const base = `/skill-repos/${encodeURIComponent(repoId)}/skills/`;
  const rel = dir ? `${dir.split("/").map(encodeURIComponent).join("/")}/` : "";
  const res = await fetch(`${base}${rel}${path.split("/").map(encodeURIComponent).join("/")}`, {
    headers: { Accept: "text/plain, */*" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} (bundled file ${path})`);
  return res.text();
}

// ---------------------------------------------------------------------------
// Proxy fetch primitives (live transports).
// ---------------------------------------------------------------------------

async function proxyGetBytes(url: string, accept: string): Promise<Uint8Array> {
  const res = await fetch(`/api/chat-proxy?url=${encodeURIComponent(url)}`, {
    method: "GET",
    headers: { "x-target-url": url, Accept: accept },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function proxyGetText(url: string, accept: string): Promise<string> {
  const bytes = await proxyGetBytes(url, accept);
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

// ---------------------------------------------------------------------------
// Transport 1 (live fallback): jsDelivr — listing + per-file CDN reads.
// ---------------------------------------------------------------------------

/** Branches to try, in order (most repos are on main). */
function branchCandidates(repo: SkillRepository): string[] {
  return repo.branch ? [repo.branch] : ["main", "master"];
}

interface JsDelivrFlat {
  files?: Array<{ name?: string; size?: number }>;
}

async function jsDelivrListing(repo: SkillRepository, branch: string): Promise<RepoFile[]> {
  const url = `https://data.jsdelivr.com/v1/packages/gh/${repo.owner}/${repo.repo}@${encodeURIComponent(branch)}?structure=flat`;
  const text = await proxyGetText(url, "application/json, */*");
  let json: JsDelivrFlat;
  try {
    json = JSON.parse(text) as JsDelivrFlat;
  } catch {
    throw new Error("jsDelivr returned a non-JSON listing");
  }
  return (json.files ?? [])
    .map((f) => ({ path: (f.name ?? "").replace(/^\/+/, ""), size: f.size ?? 0 }))
    .filter((f) => f.path.length > 0);
}

function jsDelivrFileUrl(repo: SkillRepository, branch: string, path: string): string {
  return `https://cdn.jsdelivr.net/gh/${repo.owner}/${repo.repo}@${encodeURIComponent(branch)}/${path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/")}`;
}

// ---------------------------------------------------------------------------
// Transport 2 (live fallback): codeload archive — central-directory names
// only, then bomb-capped inflation of exactly the entries we ask for.
// ---------------------------------------------------------------------------

async function codeloadArchive(repo: SkillRepository): Promise<RepoArchive> {
  let lastErr: unknown = null;
  for (const branch of branchCandidates(repo)) {
    try {
      const bytes = await proxyGetBytes(
        `https://codeload.github.com/${repo.owner}/${repo.repo}/zip/refs/heads/${encodeURIComponent(branch)}`,
        "application/zip, application/octet-stream, */*",
      );
      if (bytes.length > MAX_ZIP_BYTES) {
        throw new Error(`repository archive too large (${(bytes.length / 1048576).toFixed(1)} MB compressed)`);
      }
      const parsed = parseZipCentralDirectory(bytes);
      // Strip the archive's root folder ("{repo}-{branch}/").
      const entries = parsed.entries
        .map((e) => ({ ...e, name: e.name.split("/").slice(1).join("/") }))
        .filter((e) => e.name.length > 0);
      return { entries, bytes };
    } catch (err) {
      lastErr = err;
      // A 404 on the primary branch is worth the next-branch fallback;
      // anything else (network, proxy, format, size) fails fast.
      if (!(err instanceof Error && /HTTP 404|too large/.test(err.message))) break;
    }
  }
  throw new Error(
    `could not load the ${repo.name} repository archive: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

// ---------------------------------------------------------------------------
// Repository listing + file reads (transport-agnostic, cached).
// ---------------------------------------------------------------------------

async function fetchRepoListing(repo: SkillRepository): Promise<RepoListing> {
  const cached = listingCache.get(repo.id);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.listing;

  // Transport 0: bundled files (when present) — instant, offline.
  // PARTIAL bundles (SKILL.md only) do NOT provide a listing here — the live
  // listing enumerates supporting files, and fetchRepoTextFile serves each
  // bundled file it knows about while live-fetching the rest.
  const manifest = await fetchBundledManifest(repo.id);
  if (manifest && !manifest.partial) {
    const listing: RepoListing = {
      via: "bundled",
      files: manifest.skills.flatMap((s) =>
        (s.files ?? [{ path: "SKILL.md", size: 0 }]).map((f) => ({
          path: `${s.dir}${s.dir ? "/" : ""}${f.path}`,
          size: f.size,
        })),
      ),
    };
    listingCache.set(repo.id, { listing, fetchedAt: Date.now() });
    return listing;
  }

  const branches = branchCandidates(repo);
  // Transport 1: jsDelivr listing (works for arbitrarily large repos).
  for (const branch of branches) {
    try {
      const files = await jsDelivrListing(repo, branch);
      const listing: RepoListing = { files, via: "jsdelivr" };
      listingCache.set(repo.id, { listing, fetchedAt: Date.now() });
      return listing;
    } catch (err) {
      if (!(err instanceof Error && /HTTP 40[345]/.test(err.message))) {
        // Transient CDN error → fall through to the archive transport below.
        console.warn(`[repo-browser] jsDelivr listing failed for ${repo.id}:`, err);
        break;
      }
      // 403/404/405 → wrong branch, try the next one.
    }
  }

  // Transport 2: codeload archive, central-directory names only.
  const archive = await codeloadArchive(repo);
  const listing: RepoListing = {
    via: "archive",
    archive,
    files: archive.entries.filter((e) => !e.isDir).map((e) => ({ path: e.name, size: e.uncompSize })),
  };
  listingCache.set(repo.id, { listing, fetchedAt: Date.now() });
  return listing;
}

/**
 * Read ONE text file from the repository.
 * Bundled files first (same-origin); jsDelivr CDN with archive fallback after.
 */
async function fetchRepoTextFile(repo: SkillRepository, path: string): Promise<string> {
  // Bundled read: the path is subpath-relative — the bundle mirrors exactly
  // that layout under skills/ (dir = subpath-relative dir).
  const manifest = await fetchBundledManifest(repo.id);
  if (manifest) {
    const skill = manifest.skills.find((s) => path.startsWith(`${s.dir}${s.dir ? "/" : ""}`));
    const bundledFiles = skill?.files;
    const rel = skill && skill.dir ? path.slice(skill.dir.length + 1) : path;
    const listed = !bundledFiles || bundledFiles.some((f) => f.path === rel);
    // Full bundles serve every file; partial bundles serve only the listed
    // ones (SKILL.md) and defer the rest to the live transports.
    if (skill && (!manifest.partial || listed)) {
      try {
        return await fetchBundledTextFile(repo.id, skill.dir, rel);
      } catch (err) {
        console.warn(`[repo-browser] bundled file read failed for ${repo.id}/${path}:`, err);
        // fall through to the live transports
      }
    }
  }

  const listing = await fetchRepoListing(repo);
  // Primary: CDN per-file read (branch only matters when jsDelivr produced
  // the listing; archive reads are branch-independent).
  if (listing.via === "jsdelivr") {
    for (const branch of branchCandidates(repo)) {
      try {
        return await proxyGetText(jsDelivrFileUrl(repo, branch, path), "text/plain, */*");
      } catch (err) {
        if (!(err instanceof Error && /HTTP 40[345]/.test(err.message))) {
          console.warn(`[repo-browser] jsDelivr file read failed for ${repo.id}/${path}:`, err);
          break;
        }
      }
    }
  }
  // Fallback: inflate the single entry from the archive.
  const archive = listing.archive ?? (await codeloadArchive(repo));
  const entry = archive.entries.find((e) => e.name === path);
  if (!entry) throw new Error(`file not found in the repository: ${path}`);
  const { strFromU8 } = await import("fflate");
  const extracted = extractZipEntries(archive.bytes, [entry]);
  const bytes = extracted.get(path);
  if (!bytes) throw new Error(`could not read ${path} from the repository archive`);
  return strFromU8(bytes);
}

// ---------------------------------------------------------------------------
// Repository index (metadata-only).
// ---------------------------------------------------------------------------

export interface RepositoryIndex {
  repoId: string;
  repoName: string;
  /** "bundled" (local files) | "static" (registry data, no network) | "github" (live-fetched). */
  source: "bundled" | "static" | "github";
  skills: RepoSkillMeta[];
  /** Set when a fetch partially/fully failed — surfaced, never thrown. */
  error?: string;
}

/** Case-insensitive SKILL.md basename match. */
function isSkillMdPath(path: string): boolean {
  return /(^|\/)skill\.md$/i.test(path);
}

/** Last path segment of a (possibly nested) skill dir — the natural skill
 *  name fallback for nested trees like "3d/3d-cloth-material". */
function lastDirSegment(dir: string, repoFallback: string): string {
  const seg = dir.split("/").filter(Boolean).pop() ?? "";
  return seg || repoFallback;
}

/**
 * Build the metadata index for a repository.
 * Bundled manifests return instantly (offline); static entries return without
 * any network; live entries scan the repository file listing for SKILL.md
 * files and read each one's front-matter (name/description ONLY — never full
 * skill bodies).
 */
export async function fetchRepositoryIndex(repoId: string): Promise<RepositoryIndex> {
  const repo = getSkillRepository(repoId);
  if (!repo) {
    return { repoId, repoName: repoId, source: "static", skills: [], error: `Unknown repository '${repoId}'. Use manage_skill catalog for the list.` };
  }

  // Bundled manifest → the index IS the manifest's metadata (offline).
  const manifest = await fetchBundledManifest(repoId);
  if (manifest) {
    return {
      repoId,
      repoName: manifest.name || repo.name,
      source: "bundled",
      skills: manifest.skills.map((s) => ({ name: s.name, description: s.description, dir: s.dir })),
      ...(manifest.partial && manifest.note ? { error: manifest.note } : {}),
    };
  }

  if (repo.kind !== "skill-collection") {
    return {
      repoId,
      repoName: repo.name,
      source: "static",
      skills: [],
      error: `'${repo.name}' is an npm-cli repository, not a SKILL.md collection — install and run it inside the E2B sandbox (see its sandbox_install commands in manage_skill catalog).`,
    };
  }

  // Static index → zero network.
  if (repo.skills.length > 0) {
    return { repoId, repoName: repo.name, source: "static", skills: [...repo.skills] };
  }

  const cached = indexCache.get(repo.id);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.index;

  const prefix = repo.subpath ? `${repo.subpath.replace(/\/+$/, "")}/` : "";
  const paths = (await fetchRepoListing(repo)).files.map((f) => f.path);

  // Subpath root itself is a skill (the whole subpath is one skill folder).
  // dir "" = the subpath root itself (relative to it, like every other entry).
  if (prefix && paths.includes(`${prefix}SKILL.md`)) {
    const meta = await readFrontMatter(repo, `${prefix}SKILL.md`, "").catch(() => null);
    if (meta) {
      const index: RepositoryIndex = { repoId: repo.id, repoName: repo.name, source: "github", skills: [meta] };
      indexCache.set(repo.id, { index, fetchedAt: Date.now() });
      return index;
    }
  }

  // Every directory under the subpath that contains a SKILL.md = one skill.
  // NESTED skill trees are the norm (e.g. MengTo: agent-skills/3d/3d-cloth-
  // material/SKILL.md — category dirs above skill dirs), so depth is not
  // restricted; each dir holding a SKILL.md is indexed by its full relative
  // path and the skill's name falls back to its LAST path segment.
  const skillDirs = new Map<string, string>(); // dir (subpath-relative, no trailing /) → skillMd path
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (!isSkillMdPath(rest)) continue;
    const dir = rest.slice(0, rest.length - "SKILL.md".length).replace(/\/+$/, "");
    skillDirs.set(dir, path);
    if (skillDirs.size >= MAX_LIVE_SKILLS) break;
  }

  // No subpath and nothing deeper → repo root SKILL.md = one skill.
  if (!prefix && skillDirs.size === 0) {
    const rootSkill = paths.find((p) => /^skill\.md$/i.test(p));
    if (rootSkill) skillDirs.set("", rootSkill);
  }

  // Read front-matter for each skill (parallel, capped).
  const dirs = [...skillDirs.entries()].slice(0, MAX_LIVE_SKILLS);
  const metas = await Promise.all(
    dirs.map(async ([dir, skillMdPath]) => {
      try {
        return await readFrontMatter(repo, skillMdPath, dir);
      } catch (err: unknown) {
        return {
          name: lastDirSegment(dir, repo.repo),
          description: `(metadata unavailable: ${err instanceof Error ? err.message : String(err)})`,
          dir,
        } satisfies RepoSkillMeta;
      }
    }),
  );
  const skills = metas.filter((m): m is RepoSkillMeta => !!m);
  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const index: RepositoryIndex = {
    repoId: repo.id,
    repoName: repo.name,
    source: "github",
    skills,
    error: skills.length === 0 ? `No SKILL.md found in ${repo.owner}/${repo.repo}${prefix ? ` (under ${prefix})` : ""}.` : undefined,
  };
  indexCache.set(repo.id, { index, fetchedAt: Date.now() });
  return index;
}

/** Read ONE SKILL.md and keep only its front-matter metadata. */
async function readFrontMatter(
  repo: SkillRepository,
  skillMdPath: string,
  dir: string,
): Promise<RepoSkillMeta> {
  const raw = await fetchRepoTextFile(repo, skillMdPath);
  const fm = parseSkillFrontMatter(raw);
  const fallbackName = lastDirSegment(dir, repo.repo).toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  const name = (fm.name ?? fallbackName).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const description = (fm.description ?? "").trim().slice(0, 200) || `Skill from ${repo.name}`;
  return { name: name || fallbackName, description, dir };
}

// ---------------------------------------------------------------------------
// Install a skill from a repository.
// ---------------------------------------------------------------------------

function isTextPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return true; // extensionless (LICENSE, Dockerfile, …) — treat as text
  return TEXT_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

function sanitizeRepoSkillName(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "unnamed-skill";
}

/**
 * Install a skill from a repository into the user's local skill registry.
 * `skill` may be a skill NAME from the index ("threejs-game-director") or a
 * subpath-relative directory ("threejs-game-director" / "" for root skills).
 * Bundled repositories install entirely offline (local files); partial
 * bundles and unbundled repos use the live transports.
 */
export async function installSkillFromRepository(
  userId: string,
  repoId: string,
  skill: string,
): Promise<InstalledSkillMeta> {
  const repo = getSkillRepository(repoId);
  if (!repo) throw new Error(`Unknown repository '${repoId}'. Use manage_skill catalog for the list.`);
  if (repo.kind !== "skill-collection") {
    throw new Error(
      `'${repo.name}' is an npm-cli repository — it is installed and run inside the E2B sandbox (run_terminal), not via the skill registry. See its sandbox_install commands in manage_skill catalog.`,
    );
  }

  // Resolve the skill entry: bundled manifest → static index → live index.
  const wanted = skill.trim().replace(/^\/+|\/+$/g, "");
  const manifest = await fetchBundledManifest(repoId);
  let entry: RepoSkillMeta | undefined = manifest?.skills.find(
    (s) => s.name === wanted || s.dir === wanted,
  );
  let index: RepositoryIndex | null = null;
  if (!entry) {
    entry = repo.skills.find((s) => s.name === wanted || s.dir === wanted);
  }
  if (!entry) {
    index = await fetchRepositoryIndex(repoId);
    entry = index.skills.find(
      (s) => s.name === wanted || s.dir === wanted || s.dir === wanted.replace(/-/g, "_"),
    );
  }
  if (!entry) {
    const available = (index?.skills ?? manifest?.skills ?? repo.skills).map((s) => s.name).slice(0, 60);
    throw new Error(
      `Skill '${skill}' not found in '${repo.name}'. Available: ${available.length ? available.join(", ") : "(none — browse the repository)"}.`,
    );
  }

  // ---- Bundled install (primary): every listed file is local. Only FULL
  // bundles take this path — partial bundles go through the live flow
  // (which still serves the bundled SKILL.md offline via fetchRepoTextFile
  // and live-fetches only the supporting files). ----
  if (manifest && !manifest.partial) {
    const bundledEntry = manifest.skills.find((s) => s.name === entry!.name || s.dir === entry!.dir);
    if (bundledEntry?.files?.length) {
      const picked = bundledEntry.files
        .filter((f) => isTextPath(f.path) && (f.size ?? 0) <= MAX_FILE_BYTES)
        .slice(0, MAX_BUNDLED_INSTALL_FILES);
      const files: Array<{ rel: string; text: string }> = [];
      let totalBytes = 0;
      let missingAll = true;
      for (const f of picked) {
        try {
          const text = await fetchBundledTextFile(repoId, bundledEntry.dir, f.path);
          missingAll = false;
          totalBytes += text.length;
          if (totalBytes > MAX_BUNDLED_TOTAL_BYTES) break;
          files.push({ rel: f.path, text });
        } catch (err) {
          console.warn(`[repo-browser] bundled file read failed: ${f.path}`, err);
          // A missing file falls back to the live transport below (partial
          // bundles) — collect what we can.
        }
      }
      if (!missingAll) {
        return finalizeInstall(userId, repo, entry, files, "bundled-repository");
      }
      // All bundled reads failed → fall through to the live transports.
    }
  }

  // ---- Live install (fallback): collect the skill's files from the repo. ----
  const listing = await fetchRepoListing(repo);
  const prefix = repo.subpath ? `${repo.subpath.replace(/\/+$/, "")}/` : "";
  const skillDirPrefix = `${prefix}${entry.dir}${entry.dir ? "/" : ""}`;
  const inSkill = listing.files.filter((f) => f.path.startsWith(skillDirPrefix));
  const skillMd = inSkill.find((f) => isSkillMdPath(f.path.slice(skillDirPrefix.length)));
  if (!skillMd) {
    throw new Error(`SKILL.md not found for '${entry.name}' in ${repo.owner}/${repo.repo} (expected under ${skillDirPrefix}).`);
  }
  const supporting = inSkill.filter(
    (f) => f.path !== skillMd.path && isTextPath(f.path) && (f.size ?? 0) <= MAX_FILE_BYTES,
  );
  const picked = [skillMd, ...supporting]
    .slice(0, MAX_INSTALL_FILES)
    .filter((f) => (f.size ?? 0) <= MAX_FILE_BYTES);

  // Download the picked files (bounded concurrency of 5).
  const files: Array<{ rel: string; text: string }> = [];
  let totalBytes = 0;
  outer: for (let i = 0; i < picked.length; i += 5) {
    const batch = picked.slice(i, i + 5);
    const texts = await Promise.all(
      batch.map((f) =>
        fetchRepoTextFile(repo, f.path).catch((err: unknown) => {
          console.warn(`[repo-browser] file read failed: ${f.path}`, err);
          return null;
        }),
      ),
    );
    for (let j = 0; j < batch.length; j++) {
      const text = texts[j];
      if (text == null) continue;
      totalBytes += text.length;
      if (totalBytes > MAX_TOTAL_BYTES) break outer;
      files.push({ rel: batch[j]!.path.slice(skillDirPrefix.length), text });
    }
  }

  return finalizeInstall(userId, repo, entry, files, "repository");
}

/** Shared tail of both install paths: validate → OPFS → IndexedDB → sandbox. */
async function finalizeInstall(
  userId: string,
  repo: SkillRepository,
  entry: RepoSkillMeta,
  files: Array<{ rel: string; text: string }>,
  source: "bundled-repository" | "repository",
): Promise<InstalledSkillMeta> {
  // Validate the SKILL.md like every other install path.
  const skillMdFile = files.find((f) => isSkillMdPath(f.rel));
  if (!skillMdFile) throw new Error("The downloaded skill has no SKILL.md content.");
  const validation = validateSkillMdText(skillMdFile.text, entry.name);
  if (!validation.ok) throw new Error(`Invalid SKILL.md in '${repo.name}/${entry.name}': ${validation.error}`);

  const name = sanitizeRepoSkillName(validation.name || entry.name);
  const description = validation.description || entry.description || null;

  // Write files to OPFS (SKILL.md + supporting files, relative paths kept).
  await ensureSkillDir(userId, name);
  const dirPath = `users/${userId}/skills/${name}`;
  for (const f of files) {
    const segments = f.rel.split("/");
    const filename = segments.pop();
    if (!filename) continue;
    const subdir = segments.length > 0 ? `${dirPath}/${segments.join("/")}` : dirPath;
    await writeFileAtPath(subdir, filename, f.text);
  }

  await skillService.install(userId, name, description, dirPath, {
    source,
    fileCount: files.length,
  });

  // Fire-and-forget sandbox availability (same contract as uploads).
  void uploadSkillToSandbox(userId, name, skillMdFile.text).catch(() => {});

  return { name, description, dirPath, files: files.map((f) => f.rel) };
}

/** Test/refresh escape hatch — clears the caches. */
export function resetRepositoryCaches(): void {
  listingCache.clear();
  indexCache.clear();
  bundledManifestCache.clear();
}

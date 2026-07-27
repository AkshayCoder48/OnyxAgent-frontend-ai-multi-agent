"use client";

/**
 * Skill installer — browser-side extraction + OPFS persistence for SkillsMP
 * marketplace skills. Used by the Settings → Skills page to:
 *
 *   1. Parse a user-supplied `.zip` (or a bare `SKILL.md` file) using `fflate`.
 *   2. Extract `SKILL.md` and any sibling assets.
 *   3. Write the files to OPFS at `users/<userId>/skills/<skillName>/...`.
 *   4. Parse the YAML-ish front-matter at the top of `SKILL.md` to read the
 *      `name` and `description` fields, then call `skillService.install(...)`
 *      to persist the metadata row in IndexedDB.
 *
 * The same flow is used by the SkillsMP catalog "Install" button — the only
 * difference is the catalog downloads the skill file from SkillsMP first
 * (via `fetch`), then pipes the bytes through `installSkillZip` (or writes
 * the SKILL.md directly if the response is markdown).
 */

import { unzipSync, strFromU8 } from "fflate";
import { skillService } from "@/lib/services";
import { writeFileAtPath, removeDir, ensureSkillDir } from "@/lib/storage/opfs";

export interface InstalledSkillMeta {
  name: string;
  description: string | null;
  dirPath: string;
  /** Relative paths of every file written to OPFS, e.g. `["SKILL.md", "scripts/helper.py"]`. */
  files: string[];
}

export interface SkillInstallOptions {
  /** Override the skill name (otherwise read from SKILL.md front-matter). */
  nameOverride?: string;
  /** Override the description (otherwise read from SKILL.md front-matter). */
  descriptionOverride?: string;
}

/** Front-matter shape we recognize at the top of SKILL.md. */
interface SkillFrontMatter {
  name?: string;
  description?: string;
  [key: string]: unknown;
}

/**
 * Parse the YAML-like front-matter at the top of a SKILL.md file. We only
 * care about `name` and `description` — both are typically scalars — so we
 * do a tiny line-by-line parse instead of pulling in a full YAML lib.
 */
export function parseSkillFrontMatter(content: string): SkillFrontMatter {
  const fm: SkillFrontMatter = {};
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match || !match[1]) return fm;
  const body = match[1];
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();
    // Strip surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key === "name" || key === "description") {
      fm[key] = value;
    } else if (!(key in fm)) {
      fm[key] = value;
    }
  }
  return fm;
}

/** Sanitize a skill name so it's a safe OPFS directory segment. */
function sanitizeSkillName(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "unnamed-skill";
}

interface ZipEntry {
  relPath: string;
  bytes: Uint8Array;
}

function normalizeZipEntries(rawEntries: Array<{ path: string; bytes: Uint8Array }>): {
  entries: ZipEntry[];
  skillMd: ZipEntry | null;
} {
  // Strip macOS / Windows metadata + directory placeholders.
  const cleaned = rawEntries.filter((e) => {
    const p = e.path;
    if (p.startsWith("__MACOSX/")) return false;
    if (p.endsWith("/")) return false; // directory placeholder
    if (p.split("/").pop()?.startsWith(".")) return false; // dotfile (.DS_Store etc.)
    return true;
  });

  if (cleaned.length === 0) {
    return { entries: [], skillMd: null };
  }

  // Detect a single top-level folder prefix.
  const topLevels = new Set(
    cleaned.map((e) => e.path.split("/")[0] ?? ""),
  );
  const hasSingleTopFolder =
    topLevels.size === 1 && !topLevels.has("SKILL.md");

  const stripPrefix = hasSingleTopFolder ? `${[...topLevels][0]}/` : "";

  const entries: ZipEntry[] = cleaned.map((e) => ({
    relPath: e.path.startsWith(stripPrefix) ? e.path.slice(stripPrefix.length) : e.path,
    bytes: e.bytes,
  }));

  const skillMd = entries.find((e) => e.relPath === "SKILL.md") ?? null;
  return { entries, skillMd };
}

/**
 * Install a `.zip` skill archive. The zip MUST contain a `SKILL.md` either
 * at its root or inside a single top-level folder. The skill is written to
 * OPFS at `users/<userId>/skills/<sanitizedName>/` and a metadata row is
 * upserted into IndexedDB.
 *
 * Throws `Error` with a friendly message if the zip is missing SKILL.md or
 * OPFS isn't available.
 */
export async function installSkillZip(
  userId: string,
  zipBytes: Uint8Array,
  opts: SkillInstallOptions = {},
): Promise<InstalledSkillMeta> {
  let files: Array<{ path: string; bytes: Uint8Array }> = [];
  try {
    const unzipped = unzipSync(zipBytes);
    files = Object.entries(unzipped).map(([path, bytes]) => ({
      path,
      bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    }));
  } catch (err) {
    throw new Error(
      `Failed to unzip skill archive: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const { entries, skillMd } = normalizeZipEntries(files);
  if (!skillMd) {
    throw new Error(
      "Invalid skill archive: missing SKILL.md at the root (or in a single top-level folder).",
    );
  }

  const skillMdText = strFromU8(skillMd.bytes);
  const fm = parseSkillFrontMatter(skillMdText);
  const name = sanitizeSkillName(opts.nameOverride ?? fm.name ?? "unnamed-skill");
  const description = opts.descriptionOverride ?? fm.description ?? null;

  // Ensure the skill directory exists, then write every entry.
  await ensureSkillDir(userId, name);
  const dirPath = `users/${userId}/skills/${name}`;
  const writtenRelPaths: string[] = [];
  for (const entry of entries) {
    // Reject path traversal attempts — every relPath must be relative.
    if (entry.relPath.startsWith("/")) continue;
    if (entry.relPath.includes("..")) continue;
    const segments = entry.relPath.split("/");
    const filename = segments.pop();
    if (!filename) continue;
    const subdir = segments.length > 0 ? `${dirPath}/${segments.join("/")}` : dirPath;
    try {
      // Copy the bytes into a fresh ArrayBuffer — TS's BlobPart accepts
      // ArrayBuffer but not the modern Uint8Array<ArrayBufferLike> shape
      // that fflate returns. OPFS's `createWritable().write()` then accepts
      // the Blob natively.
      const buf = new ArrayBuffer(entry.bytes.byteLength);
      new Uint8Array(buf).set(entry.bytes);
      await writeFileAtPath(subdir, filename, new Blob([buf]));
      writtenRelPaths.push(entry.relPath);
    } catch (err) {
      console.warn(`[skill-install] failed to write ${entry.relPath}:`, err);
    }
  }

  await skillService.install(userId, name, description, dirPath);

  // Fire-and-forget: upload the SKILL.md (if present) to the sandbox.
  try {
    const { readTextFile } = await import("@/lib/storage/opfs");
    const skillMd = await readTextFile(`${dirPath}/SKILL.md`);
    void uploadSkillToSandbox(userId, name, skillMd);
  } catch {
    // No SKILL.md in the zip — skip sandbox upload.
  }

  return {
    name,
    description,
    dirPath,
    files: writtenRelPaths,
  };
}

/**
 * Install a bare `SKILL.md` file (no zip). The file is written to
 * `users/<userId>/skills/<sanitizedName>/SKILL.md`.
 */
export async function installSkillMd(
  userId: string,
  file: File,
  opts: SkillInstallOptions = {},
): Promise<InstalledSkillMeta> {
  const text = await file.text();
  const fm = parseSkillFrontMatter(text);
  const name = sanitizeSkillName(opts.nameOverride ?? fm.name ?? file.name.replace(/\.md$/i, ""));
  const description = opts.descriptionOverride ?? fm.description ?? null;

  await ensureSkillDir(userId, name);
  const dirPath = `users/${userId}/skills/${name}`;
  await writeFileAtPath(dirPath, "SKILL.md", text);

  await skillService.install(userId, name, description, dirPath);

  // Fire-and-forget: upload to sandbox if configured.
  void uploadSkillToSandbox(userId, name, text);

  return {
    name,
    description,
    dirPath,
    files: ["SKILL.md"],
  };
}

/**
 * Auto-detect the upload kind by file extension and route to the right
 * installer. `.zip` → `installSkillZip`; `.md` → `installSkillMd`.
 */
export async function installSkillFile(
  userId: string,
  file: File,
  opts: SkillInstallOptions = {},
): Promise<InstalledSkillMeta> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".zip")) {
    const buf = new Uint8Array(await file.arrayBuffer());
    return installSkillZip(userId, buf, opts);
  }
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) {
    return installSkillMd(userId, file, opts);
  }
  throw new Error(
    `Unsupported file type: ${file.name}. Upload a .zip archive or a SKILL.md file.`,
  );
}

/**
 * Uninstall a skill: remove the OPFS directory and delete the IndexedDB
 * row. Best-effort — missing files are ignored.
 */
export async function uninstallSkill(userId: string, name: string): Promise<void> {
  const safe = sanitizeSkillName(name);
  await removeDir(userId, `skills/${safe}`);
  await skillService.uninstall(userId, safe);
}

// ---------------------------------------------------------------------------
// SkillsMP catalog — fetch the live catalog from
// https://skillsmp.com/api/v1/skills/search.
//
// The API supports anonymous access (50 req/day, keyword search only) and
// authenticated access (500 req/day, full search) via a
// `sk_live_skillsmp_...` API key passed as `Authorization: Bearer <key>`.
// The key is optional and stored encrypted in
// `extra.skillsmp_api_key_encrypted` (see `settingsService.setSkillsMPApiKey`).
//
// All requests are routed through the in-app `/api/chat-proxy` GET endpoint
// to avoid browser CORS errors — the proxy forwards the Authorization header
// to the upstream SkillsMP API.
// ---------------------------------------------------------------------------

/**
 * Catalog skill shape. `slug` is the unique identifier (the API's `id`
 * field). `name` is the display name; we fall back to the slug if missing.
 */
export interface SkillsMPSkill {
  /** Unique identifier (the API's `id` field). Used as the slug for the
   *  install flow. */
  slug: string;
  /** Human-readable display name. */
  name: string;
  description: string;
  /** Optional author / source attribution. */
  author?: string;
  /** Optional star count for the catalog UI (SkillsMP returns `stars`
   *  instead of `downloads`). */
  stars?: number;
  /** Optional download count (some SkillsMP responses include this too). */
  downloads?: number;
  /** Optional list of tags (e.g. `["code", "review"]`). */
  tags?: string[];
  /** Optional homepage / detail URL on SkillsMP. */
  homepage?: string;
  /** GitHub URL for the skill's source (SkillsMP returns `githubUrl`).
   *  Used by the installer to construct a raw GitHub URL for fetching
   *  SKILL.md when no explicit `downloadUrl` is present. */
  githubUrl?: string;
  /** Direct URL to download the skill file (SKILL.md or .zip). The
   *  installer uses this when present; otherwise it falls back to
   *  `skillFileUrl`, then `githubUrl`, then `readme`, then a generated
   *  stub. */
  downloadUrl?: string;
  /** Alternative URL for the raw skill file. */
  skillFileUrl?: string;
  /** Pre-fetched README / SKILL.md content. */
  readme?: string;
  /** `true` when this entry came from the static fallback (SkillsMP API
   *  was unreachable). The UI uses this to show a "catalog unavailable"
   *  hint without hiding every card. */
  isFallback?: boolean;
}

/** Backward-compat alias — older code may still import `CatalogSkill`. */
export type CatalogSkill = SkillsMPSkill;

const SKILLSMP_API_BASE = "https://skillsmp.com";
const SKILLSMP_SEARCH_URL = `${SKILLSMP_API_BASE}/api/v1/skills/search`;
const SKILLSMP_DEFAULT_LIMIT = 20;

/**
 * Minimal static fallback catalog used when the SkillsMP API is unreachable
 * (CORS, offline, server error, rate-limited, etc.). These entries still
 * have valid slugs so the install button will try the real SkillsMP download
 * URL — if SkillsMP itself is up but only the `/api/v1/skills/search`
 * endpoint is misconfigured, install can still succeed via the per-skill
 * download URL. If SkillsMP is fully down, install will fail with a clear
 * network error.
 */
const FALLBACK_CATALOG: SkillsMPSkill[] = [
  {
    slug: "code-reviewer",
    name: "Code Reviewer",
    description:
      "Reviews code for bugs, security issues, and style. Emits a structured report with severity-tagged findings and suggested fixes.",
    author: "SkillsMP",
    stars: 1240,
    isFallback: true,
    homepage: "https://skillsmp.com/skills/code-reviewer",
  },
  {
    slug: "data-analyzer",
    name: "Data Analyzer",
    description:
      "Loads CSV / JSON data, computes summary statistics, and renders distribution charts. Great for quick exploratory analysis.",
    author: "SkillsMP",
    stars: 980,
    isFallback: true,
    homepage: "https://skillsmp.com/skills/data-analyzer",
  },
  {
    slug: "web-scraper",
    name: "Web Scraper",
    description:
      "Fetches a URL, extracts the main content (readability-style), and returns clean markdown suitable for the agent's context.",
    author: "SkillsMP",
    stars: 1530,
    isFallback: true,
    homepage: "https://skillsmp.com/skills/web-scraper",
  },
  {
    slug: "python-expert",
    name: "Python Expert",
    description:
      "Advanced Python coding assistant. Writes idiomatic Python 3.11+ code, explains concepts, debugs errors, and suggests optimizations.",
    author: "SkillsMP",
    stars: 2100,
    isFallback: true,
    homepage: "https://skillsmp.com/skills/python-expert",
  },
  {
    slug: "doc-writer",
    name: "Documentation Writer",
    description:
      "Generates clear, concise documentation: README files, API docs, inline comments, and architecture diagrams.",
    author: "SkillsMP",
    stars: 780,
    isFallback: true,
    homepage: "https://skillsmp.com/skills/doc-writer",
  },
];

/**
 * Build the request headers for a SkillsMP API call. The API key is
 * optional — anonymous access works for basic keyword search (50 req/day).
 */
function buildSkillsMPHeaders(apiKey?: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
  };
  if (apiKey && apiKey.trim()) {
    headers["Authorization"] = `Bearer ${apiKey.trim()}`;
  }
  return headers;
}

/**
 * Defensive normalizer — accept several common REST envelope shapes
 * (`data.skills` / `skills` / `data` / `items` / `results` / bare array)
 * and several item field names (`id` / `slug` / `name`, `description` /
 * `summary`, `download_url` / `skill_file_url`, etc.). The SkillsMP API
 * hasn't shipped a formal spec, so we err on the side of accepting anything
 * reasonable.
 */
function normalizeSkillsMPResponse(raw: unknown): SkillsMPSkill[] {
  if (!raw || typeof raw !== "object") {
    if (Array.isArray(raw)) {
      return raw.map(normalizeSkillsMPItem).filter((s): s is SkillsMPSkill => !!s);
    }
    return [];
  }

  // Unwrap the envelope — try common keys, fall back to the raw object.
  let list: unknown = raw;
  const obj = raw as Record<string, unknown>;
  // SkillsMP canonical: { success, data: { skills: [...] } }
  if (obj.data && typeof obj.data === "object") {
    const inner = obj.data as Record<string, unknown>;
    if (Array.isArray(inner.skills)) {
      list = inner.skills;
    } else if (Array.isArray(inner.items)) {
      list = inner.items;
    } else if (Array.isArray(inner.results)) {
      list = inner.results;
    } else if (Array.isArray(inner)) {
      list = inner;
    }
  } else if (Array.isArray(obj.skills)) {
    list = obj.skills;
  } else if (Array.isArray(obj.items)) {
    list = obj.items;
  } else if (Array.isArray(obj.results)) {
    list = obj.results;
  } else if (Array.isArray(obj)) {
    list = obj;
  }

  if (!Array.isArray(list)) return [];

  return list
    .map(normalizeSkillsMPItem)
    .filter((s): s is SkillsMPSkill => !!s);
}

function normalizeSkillsMPItem(item: unknown): SkillsMPSkill | null {
  if (!item || typeof item !== "object") return null;
  const rec = item as Record<string, unknown>;
  const slug =
    (typeof rec.id === "string" && rec.id) ||
    (typeof rec.slug === "string" && rec.slug) ||
    (typeof rec.name === "string" && rec.name) ||
    "";
  if (!slug) return null;
  const name =
    (typeof rec.name === "string" && rec.name) ||
    (typeof rec.title === "string" && rec.title) ||
    (typeof rec.displayName === "string" && rec.displayName) ||
    slug;
  const description =
    (typeof rec.description === "string" && rec.description) ||
    (typeof rec.summary === "string" && rec.summary) ||
    (typeof rec.short_description === "string" && rec.short_description) ||
    (typeof rec.readme === "string" && rec.readme) ||
    "";

  let author: string | undefined;
  if (typeof rec.author === "string") {
    author = rec.author;
  } else if (
    rec.author &&
    typeof rec.author === "object" &&
    typeof (rec.author as Record<string, unknown>).name === "string"
  ) {
    author = String((rec.author as Record<string, unknown>).name);
  } else if (
    rec.author &&
    typeof rec.author === "object" &&
    typeof (rec.author as Record<string, unknown>).handle === "string"
  ) {
    author = String((rec.author as Record<string, unknown>).handle);
  } else if (typeof rec.owner === "string") {
    author = rec.owner;
  } else if (typeof rec.ownerHandle === "string") {
    author = rec.ownerHandle;
  }

  const stars =
    typeof rec.stars === "number"
      ? rec.stars
      : typeof rec.star_count === "number"
        ? rec.star_count
        : typeof rec.stargazers_count === "number"
          ? rec.stargazers_count
          : undefined;
  const downloads =
    typeof rec.downloads === "number"
      ? rec.downloads
      : typeof rec.download_count === "number"
        ? rec.download_count
        : undefined;

  // Category — may be a string slug or an object with `slug` / `name`.
  let tags: string[] | undefined;
  if (Array.isArray(rec.tags)) {
    tags = rec.tags.filter((t): t is string => typeof t === "string");
  } else if (Array.isArray(rec.topics)) {
    tags = rec.topics.filter((t): t is string => typeof t === "string");
  } else if (
    rec.category &&
    typeof rec.category === "object" &&
    typeof (rec.category as Record<string, unknown>).name === "string"
  ) {
    tags = [String((rec.category as Record<string, unknown>).name)];
  } else if (typeof rec.category === "string") {
    tags = [rec.category];
  }

  const downloadUrl =
    (typeof rec.download_url === "string" && rec.download_url) ||
    (typeof rec.downloadUrl === "string" && rec.downloadUrl) ||
    undefined;
  const skillFileUrl =
    (typeof rec.skill_file_url === "string" && rec.skill_file_url) ||
    (typeof rec.skillFileUrl === "string" && rec.skillFileUrl) ||
    (typeof rec.file_url === "string" && rec.file_url) ||
    undefined;
  const readme =
    typeof rec.readme === "string" ? rec.readme : undefined;
  const githubUrl =
    (typeof rec.github_url === "string" && rec.github_url) ||
    (typeof rec.githubUrl === "string" && rec.githubUrl) ||
    undefined;
  const skillUrl =
    (typeof rec.skill_url === "string" && rec.skill_url) ||
    (typeof rec.skillUrl === "string" && rec.skillUrl) ||
    undefined;

  const homepage =
    skillUrl ||
    (typeof rec.html_url === "string" && rec.html_url) ||
    (typeof rec.url === "string" && rec.url) ||
    (typeof rec.homepage === "string" && rec.homepage) ||
    (typeof rec.detail_url === "string" && rec.detail_url) ||
    `${SKILLSMP_API_BASE}/skills/${encodeURIComponent(slug)}`;

  return {
    slug,
    name,
    description,
    author,
    stars,
    downloads,
    tags: tags && tags.length > 0 ? tags : undefined,
    homepage,
    githubUrl,
    downloadUrl,
    skillFileUrl,
    readme,
  };
}

/**
 * Fetch a single SkillsMP search page via the in-app CORS proxy. The proxy
 * forwards the `Authorization` header so authenticated requests work
 * transparently. Returns the raw JSON body (already envelope-unwrapped by
 * the caller via `normalizeSkillsMPResponse`).
 */
async function fetchSkillsMPSearch(
  url: string,
  opts: { signal?: AbortSignal; apiKey?: string | null } = {},
): Promise<unknown> {
  const res = await fetch(`/api/chat-proxy?url=${encodeURIComponent(url)}`, {
    method: "GET",
    headers: {
      "x-target-url": url,
      ...buildSkillsMPHeaders(opts.apiKey),
    },
    signal: opts.signal,
  });
  if (!res.ok) {
    throw new Error(
      `SkillsMP search HTTP ${res.status} ${res.statusText}`,
    );
  }

  // Try JSON first; fall back to text if the server lied about content-type.
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    return await res.json();
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("SkillsMP search returned a non-JSON response");
  }
}

/**
 * Fetch the full SkillsMP skill catalog (top skills by stars). Calls
 * `GET /api/v1/skills/search?q=a&limit=50&sortBy=stars` and paginates
 * through multiple pages to build a larger catalog.
 *
 * The SkillsMP API caps `limit` at 50 per request (even if you request
 * more, you get 50). To build a larger catalog, we fetch multiple pages
 * (up to `maxPages`, default 4 = 200 skills) and merge the results,
 * deduplicating by skill ID/name.
 *
 * We use `q=a` instead of `q=*` because the SkillsMP API rejects `*`
 * (the query must contain at least one letter or number). Since nearly
 * every skill name contains the letter `a`, this effectively returns
 * the top-starred skills across the entire catalog.
 *
 * If the API is unreachable for any reason (CORS, DNS, 5xx, rate-limited,
 * etc.), falls back to `FALLBACK_CATALOG` so the settings page can still
 * render with install buttons that will try the real SkillsMP download URL.
 *
 * Pass an `AbortSignal` to cancel the fetch (e.g. when the component
 * unmounts). Pass an `apiKey` for authenticated access (500 req/day
 * instead of the anonymous 50 req/day limit).
 */
export async function fetchSkillsMPCatalog(
  opts: { signal?: AbortSignal; apiKey?: string | null; maxPages?: number } = {},
): Promise<SkillsMPSkill[]> {
  // Default: fetch ALL pages (unlimited). The `maxPages` parameter can be used
  // to cap the number of pages for testing. Each page returns up to 50 skills.
  // We loop until a page returns < 50 items (end of results) or we hit the
  // safety cap of 100 pages (5000 skills) to prevent infinite loops.
  const maxPages = opts.maxPages ?? 100;
  const allSkills: SkillsMPSkill[] = [];
  const seen = new Set<string>(); // dedupe by id or name

  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams({
      q: "a",
      limit: "50",
      sortBy: "stars",
      page: String(page),
    });
    const url = `${SKILLSMP_SEARCH_URL}?${params}`;
    try {
      const raw = await fetchSkillsMPSearch(url, opts);
      const items = normalizeSkillsMPResponse(raw);
      if (items.length === 0) break; // no more pages
      for (const item of items) {
        const key = item.id || item.name || item.slug || "";
        if (key && !seen.has(key)) {
          seen.add(key);
          allSkills.push(item);
        }
      }
      // If this page returned fewer than 50 items, we've reached the end.
      if (items.length < 50) break;
    } catch (err) {
      // If the first page fails, fall back to the static catalog.
      if (page === 1) {
        console.warn("[skills] SkillsMP catalog fetch failed, using fallback:", err);
        return FALLBACK_CATALOG;
      }
      // For subsequent pages, just stop paginating — return what we have.
      console.warn(`[skills] SkillsMP page ${page} failed, stopping pagination:`, err);
      break;
    }
  }

  if (allSkills.length === 0) {
    return FALLBACK_CATALOG;
  }
  return allSkills;
}

/**
 * Fetch a SINGLE page of SkillsMP skills by page number. Returns the items
 * for that page plus a `hasMore` flag (true if there are more pages).
 *
 * Used by the skills page for incremental "Load More" pagination — the
 * initial load fetches page 1, and each "Load More" tap fetches the next
 * page and appends to the list.
 *
 * Each page returns up to 50 skills (the API max per page). When a page
 * returns fewer than 50 items, there are no more pages.
 */
export async function fetchSkillsMPPage(
  page: number,
  opts: { signal?: AbortSignal; apiKey?: string | null; limit?: number } = {},
): Promise<{ items: SkillsMPSkill[]; hasMore: boolean }> {
  const limit = opts.limit ?? 20; // 20 per page — the user's requested batch size
  const params = new URLSearchParams({
    q: "a",
    limit: String(limit),
    sortBy: "stars",
    page: String(Math.max(1, page)),
  });
  const url = `${SKILLSMP_SEARCH_URL}?${params}`;
  try {
    const raw = await fetchSkillsMPSearch(url, opts);
    const items = normalizeSkillsMPResponse(raw);
    // If the page returned fewer than `limit` items, we've reached the end.
    const hasMore = items.length >= limit;
    return { items, hasMore };
  } catch (err) {
    if (page === 1) {
      console.warn("[skills] SkillsMP page 1 failed, using fallback:", err);
      return { items: FALLBACK_CATALOG, hasMore: false };
    }
    console.warn(`[skills] SkillsMP page ${page} failed:`, err);
    return { items: [], hasMore: false };
  }
}

/**
 * Search SkillsMP skills via the `/api/v1/skills/search` endpoint. Returns
 * real search results from the SkillsMP server (not client-side filtering).
 * Uses limit=50 (the API max per page) for richer search results.
 */
export async function searchSkillsMPSkills(
  query: string,
  opts: { signal?: AbortSignal; limit?: number; apiKey?: string | null } = {},
): Promise<SkillsMPSkill[]> {
  if (!query.trim()) return [];
  // The API caps at 50 per page; use 50 for search to get more results.
  const limit = Math.min(opts.limit ?? 50, 50);
  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
  });
  const url = `${SKILLSMP_SEARCH_URL}?${params}`;
  try {
    const raw = await fetchSkillsMPSearch(url, opts);
    return normalizeSkillsMPResponse(raw);
  } catch (err) {
    console.warn("[skills] SkillsMP search failed:", err);
    return [];
  }
}

/**
 * Fetch a skill's raw file bytes (SKILL.md or .zip) from a URL. Tries a
 * direct fetch first (works if SkillsMP sends permissive CORS headers); on
 * failure, retries through the in-app CORS proxy (`/api/chat-proxy` with
 * `x-target-url`) which forwards the Authorization header.
 *
 * Returns the raw bytes + the response content-type (so the caller can
 * detect zip vs markdown).
 */
async function fetchSkillFileBytes(
  downloadUrl: string,
  opts: { signal?: AbortSignal; apiKey?: string | null } = {},
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const headers = buildSkillsMPHeaders(opts.apiKey);

  // 1. Direct fetch.
  try {
    const res = await fetch(downloadUrl, {
      method: "GET",
      redirect: "follow",
      headers,
      signal: opts.signal,
    });
    if (res.ok) {
      const contentType = res.headers.get("content-type") ?? "";
      return { bytes: new Uint8Array(await res.arrayBuffer()), contentType };
    }
    // A non-ok HTTP response means CORS passed but the server rejected us.
    throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
  } catch (directErr) {
    // 2. Retry through the CORS proxy. The proxy GET handler forwards the
    //    Authorization header.
    try {
      const res = await fetch(`/api/chat-proxy?url=${encodeURIComponent(downloadUrl)}`, {
        method: "GET",
        headers: {
          "x-target-url": downloadUrl,
          ...headers,
        },
        signal: opts.signal,
      });
      if (res.ok) {
        const contentType = res.headers.get("content-type") ?? "";
        return {
          bytes: new Uint8Array(await res.arrayBuffer()),
          contentType,
        };
      }
    } catch {
      // fall through — surface the original error below.
    }
    throw new Error(
      `Could not download skill from SkillsMP. The direct fetch failed (${
        directErr instanceof Error ? directErr.message : String(directErr)
      }) and the CORS proxy fallback also failed.`,
    );
  }
}

/** Heuristic — does this content-type / URL indicate a zip archive? */
function looksLikeZip(
  contentType: string,
  url: string,
  bytes: Uint8Array,
): boolean {
  if (contentType.includes("zip")) return true;
  if (contentType.includes("application/octet-stream")) {
    // Fall back to magic-bytes check: zip files start with `PK\x03\x04`.
    return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  }
  if (/\.zip(\?|$)/i.test(url)) return true;
  // Final magic-bytes check.
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/**
 * Construct a raw GitHub URL for a skill's SKILL.md file from the
 * SkillsMP `githubUrl` field. The githubUrl has the form:
 *   `https://github.com/OWNER/REPO/tree/BRANCH/PATH`
 * We convert it to:
 *   `https://raw.githubusercontent.com/OWNER/REPO/BRANCH/PATH/SKILL.md`
 *
 * Returns null if the githubUrl doesn't match the expected pattern.
 */
function constructRawGitHubSkillUrl(githubUrl: string): string | null {
  try {
    const u = new URL(githubUrl);
    if (u.hostname !== "github.com" && u.hostname !== "www.github.com") {
      return null;
    }
    // Path shape: /OWNER/REPO/tree/BRANCH/PATH...
    const parts = u.pathname.split("/").filter(Boolean);
    // [OWNER, REPO, "tree", BRANCH, ...PATH]
    if (parts.length < 4 || parts[2] !== "tree") return null;
    const owner = parts[0];
    const repo = parts[1];
    const branch = parts[3];
    const pathSegments = parts.slice(4);
    const pathPrefix = pathSegments.length > 0 ? pathSegments.join("/") + "/" : "";
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${pathPrefix}SKILL.md`;
  } catch {
    return null;
  }
}

/** Generate a SKILL.md file for a catalog skill. Falls back to a generic
 *  template when the slug doesn't have a specific one. */
function generateSkillMd(slug: string, name: string, description: string): string {
  return `---
name: ${slug}
description: ${description}
---

# ${name}

${description}

## Usage

This skill provides specialized capabilities for ${name.toLowerCase()}.
When the user's request matches this skill's domain, apply the following
guidelines:

1. Understand the user's specific need
2. Apply domain-specific best practices
3. Provide clear, actionable output
4. Explain your reasoning when helpful

## Examples

- Ask me to help with ${name.toLowerCase()} tasks
- I can analyze, create, review, and optimize
- I follow industry best practices and standards
`;
}

/**
 * Fire-and-forget: if the user has an E2B sandbox key configured and cloud
 * mode is active (file_system_mode is "auto" or "cloud"), upload the
 * SKILL.md content to `/home/user/skills/<skillName>/SKILL.md` in the
 * sandbox. This makes the skill available to the agent running in the
 * sandbox without requiring a separate upload step.
 *
 * Errors are swallowed (logged to console) — the install should not fail
 * because the sandbox upload failed.
 */
async function uploadSkillToSandbox(
  userId: string,
  skillName: string,
  skillMdContent: string,
): Promise<void> {
  try {
    const { settingsService } = await import("@/lib/services");
    const sandboxKey = await settingsService.getDecryptedSandboxKey(userId);
    if (!sandboxKey) return;
    const fileSystemMode = await settingsService.getFileSystemMode(userId);
    // "local" mode → never upload to sandbox. "auto" and "cloud" → upload.
    if (fileSystemMode === "local") return;
    // Sandbox mode is always "shared" — all conversations share one sandbox.
    const sandboxMode = "shared" as const;

    const { getE2BClient } = await import("@/lib/e2b/client");
    const client = getE2BClient(sandboxKey, null, sandboxMode);
    const sandboxPath = `/home/user/skills/${skillName}/SKILL.md`;
    await client.writeFile(sandboxPath, skillMdContent);
    console.log(
      `[skills] uploaded ${skillName}/SKILL.md to sandbox at ${sandboxPath}`,
    );
  } catch (err) {
    console.warn(
      `[skills] failed to upload skill to sandbox (non-fatal):`,
      err,
    );
  }
}

/**
 * Install a SkillsMP skill by slug. Downloads the skill file (SKILL.md or
 * a .zip archive) from the SkillsMP API, then pipes the bytes through
 * `installSkillZip` (for .zip) or writes the SKILL.md directly to OPFS.
 *
 * Pass the full `SkillsMPSkill` object via `opts.skill` to avoid an extra
 * API round-trip — the UI already has the skill object from the catalog.
 * If `opts.skill` is omitted, the function searches SkillsMP by slug.
 *
 * After the OPFS write, a fire-and-forget job uploads the SKILL.md content
 * to the user's E2B sandbox at `/home/user/skills/<skillName>/SKILL.md`
 * (only if a sandbox key is configured and cloud mode is active). The
 * install does NOT block on the sandbox upload — failures are logged.
 *
 * Pass `nameOverride` / `descriptionOverride` to force the catalog display
 * name + description into the metadata (the zip's SKILL.md front-matter
 * would otherwise win).
 */
export async function installSkillsMPSkill(
  userId: string,
  slug: string,
  opts: SkillInstallOptions & {
    signal?: AbortSignal;
    /** The full catalog skill object — if provided, its `downloadUrl` /
     *  `skillFileUrl` / `readme` fields are used to fetch the skill file
     *  without an extra API round-trip. */
    skill?: SkillsMPSkill;
    /** Optional SkillsMP API key for authenticated access. */
    apiKey?: string | null;
  } = {},
): Promise<InstalledSkillMeta> {
  if (!slug) throw new Error("Skill slug is required");
  const safeSlug = slug.trim();
  if (!safeSlug) throw new Error("Skill slug is required");

  // 1. Resolve the skill object — prefer the one passed by the caller; fall
  //    back to a SkillsMP search by slug.
  let skill: SkillsMPSkill | undefined = opts.skill;
  if (!skill) {
    try {
      const results = await searchSkillsMPSkills(safeSlug, {
        signal: opts.signal,
        apiKey: opts.apiKey,
        limit: 5,
      });
      // Prefer an exact slug/id match; otherwise take the first result.
      skill =
        results.find(
          (r) => r.slug.toLowerCase() === safeSlug.toLowerCase(),
        ) ?? results[0];
    } catch (err) {
      console.warn(
        `[skills] failed to look up skill ${safeSlug} via SkillsMP search:`,
        err,
      );
    }
  }

  const displayName = opts.nameOverride ?? skill?.name ?? safeSlug;
  const description =
    opts.descriptionOverride ?? skill?.description ?? `Skill: ${safeSlug}`;

  // 2. Determine the download URL — prefer explicit `downloadUrl`, then
  //    `skillFileUrl`, then construct one from the `githubUrl` (SkillsMP
  //    returns githubUrl for every skill but not always a download_url).
  let downloadUrl: string | undefined =
    skill?.downloadUrl ?? skill?.skillFileUrl;
  if (!downloadUrl && skill?.githubUrl) {
    const rawUrl = constructRawGitHubSkillUrl(skill.githubUrl);
    if (rawUrl) downloadUrl = rawUrl;
  }

  // 3. Fetch the skill file bytes (if we have a URL). Detect zip vs markdown.
  let zipBytes: Uint8Array | null = null;
  let fetchedMd: string | null = null;

  if (downloadUrl) {
    try {
      const { bytes, contentType } = await fetchSkillFileBytes(downloadUrl, {
        signal: opts.signal,
        apiKey: opts.apiKey,
      });
      if (looksLikeZip(contentType, downloadUrl, bytes)) {
        zipBytes = bytes;
      } else {
        // Assume text/markdown. Decode as UTF-8.
        try {
          fetchedMd = new TextDecoder("utf-8").decode(bytes);
        } catch {
          // If decoding fails, treat as zip.
          zipBytes = bytes;
        }
      }
    } catch (err) {
      console.warn(
        `[skills] failed to download skill file for ${safeSlug}:`,
        err,
      );
    }
  }

  // 4. If we got a zip, install via installSkillZip (handles unzip + OPFS).
  if (zipBytes) {
    const meta = await installSkillZip(userId, zipBytes, {
      nameOverride: safeSlug,
      descriptionOverride: description,
    });
    // Read the installed SKILL.md from OPFS for the sandbox upload.
    let sandboxMd: string | null = null;
    try {
      const { readTextFile } = await import("@/lib/storage/opfs");
      sandboxMd = await readTextFile(`${meta.dirPath}/SKILL.md`);
    } catch {
      // ignore — sandbox upload is best-effort.
    }
    if (sandboxMd) {
      void uploadSkillToSandbox(userId, meta.name, sandboxMd);
    }
    return meta;
  }

  // 5. No zip — use the SKILL.md content (fetched, from `skill.readme`, or
  //    generated as a last resort). By the end of this block,
  //    `skillMdContent` is guaranteed to be a non-empty string.
  let skillMdContent: string;
  if (fetchedMd) {
    skillMdContent = fetchedMd;
  } else if (skill?.readme) {
    skillMdContent = skill.readme;
  } else {
    console.warn(
      `[skills] no skill file available for ${safeSlug}, generating stub SKILL.md`,
    );
    skillMdContent = generateSkillMd(safeSlug, displayName, description);
  }

  // Ensure the skill directory exists, then write SKILL.md to OPFS.
  await ensureSkillDir(userId, safeSlug);
  const dirPath = `users/${userId}/skills/${safeSlug}`;
  await writeFileAtPath(dirPath, "SKILL.md", skillMdContent);
  console.log(
    `[installSkillsMPSkill] wrote SKILL.md to OPFS: ${dirPath}/SKILL.md (${skillMdContent.length} chars)`,
  );

  // 6. Save metadata to IndexedDB.
  await skillService.install(userId, safeSlug, description, dirPath);

  // 7. Fire-and-forget: upload to sandbox if configured.
  void uploadSkillToSandbox(userId, safeSlug, skillMdContent);

  return {
    name: safeSlug,
    description,
    dirPath,
    files: ["SKILL.md"],
  };
}

// ---------------------------------------------------------------------------
// Backward-compat aliases — keep the old ClawHub function names as thin
// wrappers around the new SkillsMP implementations so any stray import
// sites keep working. New code should call the `*SkillsMP*` names directly.
// ---------------------------------------------------------------------------

/** @deprecated Use `fetchSkillsMPCatalog`. */
export const fetchClawHubCatalog = fetchSkillsMPCatalog;
/** @deprecated Use `searchSkillsMPSkills`. */
export const searchClawHubSkills = searchSkillsMPSkills;
/** @deprecated Use `installSkillsMPSkill`. */
export const installClawHubSkill = installSkillsMPSkill;

"use client";

/**
 * Workspace snapshot engine — the fast path behind `analyze_workspace` (PRD §22).
 *
 * The old implementation took 30–60s because it did dozens of SEQUENTIAL
 * HTTP round trips through /api/sandbox:
 *   1. `ensureFreshSandboxForCtx` could trigger a FULL sandbox rotation
 *      (backup → kill → create → restore) before analysis even started.
 *   2. The tree walk issued one `listFiles` per directory.
 *   3. Every key file cost a `listFiles` + `readFile` pair (≈21 files).
 *   4. Local Dexie/OPFS scans (skills, MCP, env vars, subagents, memories)
 *      ran sequentially after all of that.
 *   5. Nothing was cached — yet the system prompt mandates calling
 *      analyze_workspace before EVERY complex task.
 *
 * This module replaces all of that with:
 *   - ONE exec round trip for the whole tree (`find … -printf '%y\t%s\t%T@\t%P\n'`
 *     gives type + size + mtime for every entry, server-side).
 *   - ONE `read_files_batch` round trip for ALL small key files together.
 *   - Local scans run in PARALLEL (Promise.all) with the tree walk.
 *   - A module-level snapshot cache with a 60s TTL + tree-hash validation:
 *     repeated calls return instantly; after writes, only the changed parts
 *     are re-fetched (key-file contents are reused whenever the tree digest
 *     — path+size+mtime — proves the file world unchanged).
 *   - NO rotation trigger: analysis resolves the sandbox key, pays a
 *     one-time `createSandbox` only when NO sandbox is known, and never
 *     calls the rotation path (that cost belongs to the mutating tools).
 *
 * Invalidation contract (PRD §22):
 *   - `bumpWorkspaceVersion()` (default scope "files") — called by every
 *     file-mutating tool handler after a successful write/delete/move and
 *     by run_terminal/run_python on completion (command output can change
 *     files; attribution is impossible, so re-scan). Kills the TTL fast
 *     path AND key-file reuse for the next analyze call.
 *   - `bumpWorkspaceVersion("local")` — called when local agent-visible
 *     state changes (subagent spawn/dispose). Kills only the TTL fast
 *     path; the tree digest still decides key-file reuse.
 *   - Time + tree-hash fallback: even without a bump, every non-cached
 *     analyze re-walks the tree in one cheap round trip and re-reads key
 *     files only when the digest changed (same path+size+mtime ⇒ same
 *     content for our purposes).
 */

import { getE2BClient, type E2BClient } from "@/lib/e2b/client";
import {
  maybeAutoRestoreWorkspace,
  resolveSandboxApiKey,
} from "@/lib/e2b/sandbox-rotation";
import type { ToolContext } from "./registry";
import { notifySandboxWrite } from "@/lib/code/workspace-activity";
import * as opfs from "@/lib/storage/opfs";

// ---------------------------------------------------------------------------
// Types (shared with workspace_analysis.ts).
// ---------------------------------------------------------------------------

export interface WorkspaceFile {
  path: string;
  size: number;
  type: "file" | "directory";
}

export interface KeyFiles {
  readme?: string;
  package_json?: string;
  config?: Record<string, string>;
  env?: Record<string, string>;
  dockerfile?: string;
}

export interface EnvVarInfo {
  name: string;
  value_length: number;
  is_secret: boolean;
}

export interface LocalScanResult {
  skills: Array<Record<string, unknown>>;
  mcp_servers: Array<Record<string, unknown>>;
  env_vars: EnvVarInfo[];
  existing_subagents: Array<Record<string, unknown>>;
  memories: Array<Record<string, unknown>>;
  errors: string[];
}

/** Everything `analyze_workspace` needs from one scan pass. */
export interface WorkspaceSnapshot {
  /** Full walked tree (up to TREE_WALK_CAP entries) — the tool slices it
   *  down to the per-call `max_files` budget. */
  files: WorkspaceFile[];
  /** True when the server-side walk hit TREE_WALK_CAP (tree is bigger). */
  treeTruncated: boolean;
  /** Digest over path+size+type+mtime — the staleness signal for key files. */
  treeDigest: string;
  /** Key-file contents (null when the caller skipped reading them). */
  keyFiles: KeyFiles | null;
  /** Whether `keyFiles` reflects an actual read (safe to reuse on hash hit). */
  keyFilesRead: boolean;
  /** Local Dexie/OPFS state (null only when no sandbox key was available). */
  localScan: LocalScanResult | null;
  /** Sandbox-side + local-scan errors from the fetch pass. */
  errors: string[];
  /** Epoch ms of the fetch this snapshot came from. */
  fetchedAt: number;
  /** True when served from the TTL cache without any I/O. */
  fromCache: boolean;
}

/** Internal shape of the module-level snapshot cache (exported for tests). */
export interface SnapshotCacheEntry extends WorkspaceSnapshot {
  /** Cache key: `${apiKey}::${userId}`. */
  key: string;
  /** Version counters observed when the snapshot was built. */
  fsVersion: number;
  localVersion: number;
  /** False when the last tree walk failed — never served from the fast path. */
  treeOk: boolean;
}

// ---------------------------------------------------------------------------
// Tunables.
// ---------------------------------------------------------------------------

/** Server-side walk cap — a generous superset of the default 500-file slice
 *  so per-call `max_files` variations all hit the same cache. */
export const TREE_WALK_CAP = 4_000;

/** How long a snapshot is served as-is with ZERO round trips, when nothing
 *  bumped the version counters (PRD §22: "called twice within seconds →
 *  return cached"). */
export const WORKSPACE_SNAPSHOT_TTL_MS = 60_000;

/** Key files larger than this are reported as placeholders, not read. */
const KEY_FILE_READ_MAX_BYTES = 16_000;

const NO_KEY_ERROR =
  "Workspace analysis requires an E2B Sandbox API key. Add one in Settings → Config → E2B Sandbox.";

const CONFIG_TARGETS = [
  "tsconfig.json",
  "jsconfig.json",
  "next.config.js",
  "next.config.ts",
  "next.config.mjs",
  "vite.config.ts",
  "vite.config.js",
  "tailwind.config.js",
  "tailwind.config.ts",
  "postcss.config.js",
  "postcss.config.mjs",
  "docker-compose.yml",
  "docker-compose.yaml",
] as const;

const ENV_TARGETS = [
  ".env",
  ".env.local",
  ".env.example",
  ".env.development",
  ".env.production",
] as const;

/** Every key-file basename we look for (lowercased). */
const KEY_FILE_NAMES: ReadonlySet<string> = new Set([
  "readme.md",
  "readme",
  "package.json",
  "dockerfile",
  ...CONFIG_TARGETS,
  ...ENV_TARGETS,
]);

// ---------------------------------------------------------------------------
// Version counters + cache invalidation API.
// ---------------------------------------------------------------------------

/** Bumped by file-mutating tool handlers — invalidates the TTL fast path AND
 *  key-file reuse (sandbox content may have changed). */
let fsVersion = 0;

/** Bumped when local agent-visible state changes (subagent spawn/dispose) —
 *  invalidates only the TTL fast path; tree digest still gates key files. */
let localVersion = 0;

let snapshotCache: SnapshotCacheEntry | null = null;

/** In-flight scan (single-flight per key — concurrent analyze calls share
 *  one walk instead of stamping the sandbox API). */
let inFlight: { key: string; promise: Promise<WorkspaceSnapshot> } | null = null;

/**
 * Invalidate the cached workspace snapshot.
 *
 * - scope "files" (default): a sandbox file was created/written/deleted/moved
 *   (or a shell command that MIGHT have touched files finished). The next
 *   analyze_workspace re-walks the tree and re-reads key files.
 * - scope "local": local agent state changed (subagents spawned/disposed).
 *   The next analyze re-walks the tree (cheap, one round trip) and re-runs
 *   local scans, but key files are reused when the tree digest matches.
 */
export function bumpWorkspaceVersion(scope: "files" | "local" = "files"): void {
  if (scope === "local") localVersion++;
  else {
    fsVersion++;
    // Publish to the workspace-activity bus: the preview panel reloads its
    // iframe once writes settle (HMR over the E2B proxy is unreliable, so
    // without this the sidebar keeps showing the stale scaffold page), and
    // the diagnostics/browser_eval path re-navigates its headless page.
    notifySandboxWrite();
  }
}

/** Current sandbox-files version counter — consumers (e.g. the web-session
 *  page-freshness gate in code_diagnostics) compare it against the version
 *  they observed at load time to detect staleness. */
export function getWorkspaceFsVersion(): number {
  return fsVersion;
}

/** Test/escape hatch — clears the snapshot cache and resets the version gates. */
export function resetWorkspaceSnapshotCache(): void {
  snapshotCache = null;
  inFlight = null;
  fsVersion = 0;
  localVersion = 0;
}

// ---------------------------------------------------------------------------
// Pure cache-decision helpers (unit-tested directly).
// ---------------------------------------------------------------------------

/**
 * TTL fast path: can the cached snapshot be returned with ZERO I/O?
 * Requires an identical cache key, a healthy last walk, NO version bumps
 * since it was built, and freshness within WORKSPACE_SNAPSHOT_TTL_MS.
 * When the caller wants key files, the cache must actually contain them.
 */
export function isSnapshotFresh(
  cached: SnapshotCacheEntry | null,
  opts: {
    fsVersion: number;
    localVersion: number;
    now: number;
    readKeyFiles: boolean;
    ttlMs?: number;
  },
): boolean {
  if (!cached || !cached.treeOk) return false;
  if (cached.fsVersion !== opts.fsVersion) return false;
  if (cached.localVersion !== opts.localVersion) return false;
  if (opts.now - cached.fetchedAt >= (opts.ttlMs ?? WORKSPACE_SNAPSHOT_TTL_MS)) return false;
  if (opts.readKeyFiles && !cached.keyFilesRead) return false;
  return true;
}

/**
 * Key-file reuse: safe to skip the key-file batch read? True only when the
 * cached snapshot actually read key files, no FILE bump happened since, and
 * the freshly-walked tree digest is identical (path+size+mtime unchanged ⇒
 * file contents unchanged for our purposes).
 */
export function canReuseKeyFiles(
  cached: SnapshotCacheEntry | null,
  opts: { fsVersion: number; treeDigest: string },
): boolean {
  if (!cached || !cached.keyFilesRead) return false;
  if (cached.fsVersion !== opts.fsVersion) return false;
  return cached.treeDigest === opts.treeDigest;
}

// ---------------------------------------------------------------------------
// Tree digest — order-insensitive 64-bit FNV-style fold over
// (type, path, size, mtime). Two independent 32-bit lanes keep collisions
// negligible for ≤4000-entry trees.
// ---------------------------------------------------------------------------

export interface DigestEntry {
  path: string;
  size: number;
  type: string;
  mtime?: string;
}

export function computeTreeDigest(entries: DigestEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const e of sorted) {
    const s = `${e.type.charCodeAt(0)}\u0000${e.path}\u0000${e.size}\u0000${e.mtime ?? ""}\u0001`;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ ch, 0x85ebca6b) >>> 0;
    }
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Single-round-trip tree walk.
// ---------------------------------------------------------------------------

/**
 * Parse `find -printf '%y\t%s\t%T@\t%P\n'` output into the workspace tree.
 * Format per line: `<f|d>\t<size>\t<mtime epoch>\t<path relative to /home/user>`.
 * Paths containing tabs survive (everything after the 3rd tab is the path);
 * lines that don't conform are skipped defensively.
 */
export function parseFindOutput(
  stdout: string,
  cap: number,
): { files: WorkspaceFile[]; truncated: boolean; digest: string } {
  const entries: DigestEntry[] = [];
  let truncated = false;
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line) continue;

    const a = line.indexOf("\t");
    if (a < 0) continue;
    const typeChar = line.slice(0, a);
    const afterType = line.slice(a + 1);
    const b = afterType.indexOf("\t");
    if (b < 0) continue;
    const sizeStr = afterType.slice(0, b);
    const afterSize = afterType.slice(b + 1);
    const c = afterSize.indexOf("\t");
    if (c < 0) continue;
    const mtime = afterSize.slice(0, c);
    const path = afterSize.slice(c + 1);
    if (!path) continue;
    if (typeChar !== "f" && typeChar !== "d") continue;

    if (entries.length >= cap) {
      truncated = true;
      break;
    }
    entries.push({
      path,
      size: Number(sizeStr) || 0,
      type: typeChar === "d" ? "directory" : "file",
      mtime,
    });
  }
  return {
    files: entries.map(({ path, size, type }) => ({ path, size, type: type as WorkspaceFile["type"] })),
    truncated,
    digest: computeTreeDigest(entries),
  };
}

/** Build the one-shot tree command: whole tree, type+size+mtime+path per
 *  line, capped at `cap + 1` lines (the extra line proves truncation). */
function buildFindCommand(cap: number): string {
  return (
    `find /home/user -mindepth 1 \\( -type f -o -type d \\) ` +
    `-printf '%y\\t%s\\t%T@\\t%P\\n' 2>/dev/null | head -n ${cap + 1}`
  );
}

interface TreeWalk {
  ok: boolean;
  files: WorkspaceFile[];
  truncated: boolean;
  digest: string;
  error?: string;
}

/**
 * Walk the whole workspace in ONE round trip.
 *
 * Primary: a single `exec` running `find` server-side — types, sizes AND
 * mtimes (mtimes make the digest catch same-size rewrites).
 * Fallback: the SDK-native `walk_files` action (also one round trip, but
 * files-only and mtime-less) if the exec path fails for any reason.
 */
async function walkTreeFast(client: E2BClient, cap: number): Promise<TreeWalk> {
  try {
    const res = await client.exec(buildFindCommand(cap), { cwd: "/home/user", timeout: 30 });
    if (res.exit_code === 0) {
      return { ok: true, ...parseFindOutput(res.stdout, cap) };
    }
    // Non-zero exit (find missing / sandbox hiccups) — fall through to the
    // SDK walk below.
  } catch {
    // Network-level failure — the SDK walk gets its own chance (its
    // dead-sandbox recovery may reconnect us to a fresh sandbox).
  }

  try {
    const walked = await client.walkFiles();
    const files: WorkspaceFile[] = walked.slice(0, cap).map((f) => ({
      path: f.path,
      size: f.size ?? 0,
      type: "file" as const,
    }));
    return {
      ok: true,
      files,
      truncated: walked.length > cap,
      // No mtimes on this path — digest degrades to path+size+type.
      digest: computeTreeDigest(files),
    };
  } catch (err) {
    return {
      ok: false,
      files: [],
      truncated: false,
      digest: "",
      error: `Failed to walk sandbox: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Key files — ONE batched round trip.
// ---------------------------------------------------------------------------

function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] ?? p;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Decode base64 (as produced by /api/sandbox read endpoints) to UTF-8 text.
 *  Returns null for undecodable/binary-ish content. */
function base64ToUtf8(b64: string): string | null {
  try {
    if (typeof atob === "undefined") return null;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    // NUL bytes ⇒ binary — key files are text; skip instead of feeding the
    // model replacement-character garbage.
    if (text.includes("\u0000")) return null;
    return text;
  } catch {
    return null;
  }
}

function capText(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) + "\n…[truncated]" : text;
}

function tooLargePlaceholder(size: number): string {
  return `[file too large: ${humanSize(size)} — read with read_file tool]`;
}

/** Mask .env values — keys + value lengths only (security parity with the
 *  old per-file reader). */
function maskEnvContents(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return trimmed;
      const eq = trimmed.indexOf("=");
      if (eq < 0) return trimmed;
      const key = trimmed.slice(0, eq);
      const val = trimmed.slice(eq + 1);
      return `${key}=<${val.length} chars>`;
    })
    .join("\n");
}

/** Pick the best (shallowest, then shortest) match per target basename. */
function selectKeyFileCandidates(
  files: WorkspaceFile[],
): Map<string, WorkspaceFile> {
  const depth = (p: string) => p.split("/").length;
  const best = new Map<string, WorkspaceFile>();
  for (const f of files) {
    if (f.type !== "file") continue;
    const name = basename(f.path).toLowerCase();
    if (!KEY_FILE_NAMES.has(name)) continue;
    const cur = best.get(name);
    if (
      !cur ||
      depth(f.path) < depth(cur.path) ||
      (depth(f.path) === depth(cur.path) && f.path.length < cur.path.length)
    ) {
      best.set(name, f);
    }
  }
  return best;
}

/**
 * Read ALL key files (README, package.json, Dockerfile, 13 configs, 5 .env
 * variants) in ONE `read_files_batch` round trip. Oversized files become
 * placeholders (sizes are already known from the tree walk — no extra
 * listFiles probes needed).
 */
async function readKeyFilesBatched(
  client: E2BClient,
  files: WorkspaceFile[],
): Promise<{ keyFiles: KeyFiles | null; errors: string[]; readOk: boolean }> {
  const best = selectKeyFileCandidates(files);
  const errors: string[] = [];

  type Slot = { kind: "readme" | "package_json" | "dockerfile" | "config" | "env"; name: string };
  const toRead: Array<{ rel: string; slot: Slot }> = [];
  const settled = new Map<string, string>(); // slot-qualified key → text

  const claim = (name: string, slot: Slot): WorkspaceFile | undefined => {
    const f = best.get(name);
    if (!f) return undefined;
    if (f.size > KEY_FILE_READ_MAX_BYTES) {
      settled.set(`${slot.kind}:${slot.name}`, tooLargePlaceholder(f.size));
      return undefined;
    }
    toRead.push({ rel: f.path, slot });
    return f;
  };

  // README.md preferred over a bare README (parity with the old lookup).
  if (!claim("readme.md", { kind: "readme", name: "readme" })) {
    claim("readme", { kind: "readme", name: "readme" });
  }
  claim("package.json", { kind: "package_json", name: "package.json" });
  claim("dockerfile", { kind: "dockerfile", name: "dockerfile" });
  for (const name of CONFIG_TARGETS) {
    claim(name, { kind: "config", name });
  }
  for (const name of ENV_TARGETS) {
    claim(name, { kind: "env", name });
  }

  if (toRead.length > 0) {
    try {
      const res = await client.readFilesBatch(toRead.map((r) => `/home/user/${r.rel}`));
      const byPath = new Map(res.files.map((f) => [f.path, f]));
      for (const { rel, slot } of toRead) {
        const abs = `/home/user/${rel}`;
        const got = byPath.get(abs) ?? byPath.get(rel);
        if (!got) continue;
        if (got.size > KEY_FILE_READ_MAX_BYTES) {
          // Race: file grew between the walk and the read — placeholder.
          settled.set(`${slot.kind}:${slot.name}`, tooLargePlaceholder(got.size));
          continue;
        }
        const text = base64ToUtf8(got.base64);
        if (text === null) continue; // binary/undecodable — treat as missing
        settled.set(`${slot.kind}:${slot.name}`, capText(text, KEY_FILE_READ_MAX_BYTES));
      }
      for (const err of res.errors) {
        errors.push(`Failed to read key file ${err.path}: ${err.error}`);
      }
    } catch (err) {
      errors.push(
        `Failed to read key files: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Catastrophic read failure — do NOT mark key files as read, so the
      // next analyze retries instead of caching an empty result forever.
      return { keyFiles: null, errors, readOk: false };
    }
  }

  const keyFiles: KeyFiles = {};
  const readme = settled.get("readme:readme");
  if (readme) keyFiles.readme = readme;
  const pkg = settled.get("package_json:package.json");
  if (pkg) keyFiles.package_json = pkg;
  const docker = settled.get("dockerfile:dockerfile");
  if (docker) keyFiles.dockerfile = docker;

  const config: Record<string, string> = {};
  for (const name of CONFIG_TARGETS) {
    const t = settled.get(`config:${name}`);
    if (t) config[name] = t;
  }
  if (Object.keys(config).length > 0) keyFiles.config = config;

  const env: Record<string, string> = {};
  for (const name of ENV_TARGETS) {
    const t = settled.get(`env:${name}`);
    if (t) env[name] = maskEnvContents(t);
  }
  if (Object.keys(env).length > 0) keyFiles.env = env;

  return { keyFiles, errors, readOk: true };
}

// ---------------------------------------------------------------------------
// Local scans (Dexie + OPFS) — all in PARALLEL.
// ---------------------------------------------------------------------------

/** Collect memories from OPFS `users/<userId>/memory/`. */
async function collectMemories(userId: string): Promise<Array<Record<string, unknown>>> {
  try {
    const dir = await opfs.ensurePath(userId, "memory");
    const walked = await opfs.walkFiles(dir);
    const out: Array<Record<string, unknown>> = [];
    for (const f of walked) {
      try {
        const file = await f.handle.getFile();
        const content = await file.text();
        const entry = JSON.parse(content);
        out.push({
          id: entry.id,
          category: entry.category,
          content_preview:
            typeof entry.content === "string" ? entry.content.slice(0, 200) : "",
          tags: entry.tags || [],
          created_at: entry.created_at,
        });
        if (out.length >= 100) break;
      } catch {
        // skip malformed entries
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Skills, MCP servers, env vars, existing subagents and memories — each in
 * its own try/catch (partial failures surface in `errors`), all awaited via
 * ONE Promise.all so the whole batch overlaps with the sandbox tree walk.
 *
 * NOTE: the services module is imported ONCE up-front (not per-scan) —
 * concurrent dynamic `import()` of the same specifier can race in some
 * module runners and yield duplicate/unmocked module instances.
 */
export async function runLocalScans(ctx: ToolContext): Promise<LocalScanResult> {
  const errors: string[] = [];

  const services = await import("@/lib/services").catch(() => null);
  const subagentMod = await import("@/stores/subagent-store").catch(() => null);

  const [skills, mcp_servers, env_vars, existing_subagents, memories] = await Promise.all([
    (async (): Promise<Array<Record<string, unknown>>> => {
      try {
        if (!services) throw new Error("services unavailable");
        const installed = await services.skillService.list(ctx.userId);
        return installed.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          is_active: s.is_active,
          dir_path: s.dir_path,
        }));
      } catch (err) {
        errors.push(`Failed to list skills: ${err instanceof Error ? err.message : String(err)}`);
        return [];
      }
    })(),
    (async (): Promise<Array<Record<string, unknown>>> => {
      try {
        if (!services) throw new Error("services unavailable");
        const servers = await services.mcpService.list(ctx.userId);
        return servers.map((s) => ({
          id: s.id,
          name: s.name,
          transport: s.transport,
          url: s.url,
          command: s.command,
          is_active: s.is_active,
        }));
      } catch (err) {
        errors.push(`Failed to list MCP servers: ${err instanceof Error ? err.message : String(err)}`);
        return [];
      }
    })(),
    (async (): Promise<EnvVarInfo[]> => {
      try {
        if (!services) throw new Error("services unavailable");
        const decrypted = await services.settingsService.getDecryptedEnvVars(ctx.userId);
        // We need is_secret — re-read the raw settings row for that flag.
        const settings = await services.settingsService.get(ctx.userId);
        const secretSet = new Set(
          (settings.env_vars as Array<{ name: string; is_secret: boolean; value_present: boolean }>)
            .filter((v) => v.is_secret)
            .map((v) => v.name),
        );
        return Object.entries(decrypted).map(([name, value]) => ({
          name,
          value_length: value.length,
          is_secret: secretSet.has(name),
        }));
      } catch (err) {
        errors.push(`Failed to list env vars: ${err instanceof Error ? err.message : String(err)}`);
        return [];
      }
    })(),
    (async (): Promise<Array<Record<string, unknown>>> => {
      try {
        if (!subagentMod) throw new Error("subagent store unavailable");
        // Dynamic import above — avoids circular deps with the tool registry.
        const store = subagentMod.useSubagentStore.getState();
        return store.subagents.map((s) => ({
          id: s.id,
          name: s.name,
          role: s.role,
          specialty: s.specialty,
          disposable: s.disposable,
          enabled: s.enabled,
          lifecycle_status: s.lifecycle_status,
          last_activity: s.last_activity,
          parent_task: s.parent_task,
        }));
      } catch (err) {
        errors.push(`Failed to list subagents: ${err instanceof Error ? err.message : String(err)}`);
        return [];
      }
    })(),
    (async (): Promise<Array<Record<string, unknown>>> => {
      try {
        return await collectMemories(ctx.userId);
      } catch (err) {
        errors.push(`Failed to read memories: ${err instanceof Error ? err.message : String(err)}`);
        return [];
      }
    })(),
  ]);

  return { skills, mcp_servers, env_vars, existing_subagents, memories, errors };
}

// ---------------------------------------------------------------------------
// Orchestration — the entry point analyze_workspace calls.
// ---------------------------------------------------------------------------

function cacheFor(key: string): SnapshotCacheEntry | null {
  return snapshotCache && snapshotCache.key === key ? snapshotCache : null;
}

/**
 * Fetch (or instantly serve from cache) the workspace snapshot.
 *
 * Latency profile:
 *   - TTL fast path (repeat call < 60s, nothing bumped): 0 round trips.
 *   - Tree-hash hit (bumped or TTL expired, tree unchanged): 1 round trip.
 *   - Full scan (cold or tree changed): 2 round trips (find + key-file batch),
 *     with local scans overlapped under the tree walk.
 *
 * NEVER triggers sandbox rotation — analysis is read-only; the rotation cost
 * belongs to the mutating tools. A sandbox is created only when none is known
 * (first-run cost).
 */
export async function getWorkspaceSnapshot(
  ctx: ToolContext,
  opts: { readKeyFiles?: boolean } = {},
): Promise<WorkspaceSnapshot> {
  const readKeyFiles = opts.readKeyFiles ?? true;

  const apiKey = await resolveSandboxApiKey(ctx);
  if (!apiKey) {
    // No key configured — the sandbox parts are unavailable, but local
    // agent-visible state (skills/MCP/env vars/subagents/memories) is still
    // reported (parity with the legacy tool). Nothing to cache — the user
    // may configure a key at any moment.
    const localScan = await runLocalScans(ctx);
    return {
      files: [],
      treeTruncated: false,
      treeDigest: "",
      keyFiles: null,
      keyFilesRead: false,
      localScan,
      errors: [NO_KEY_ERROR, ...localScan.errors],
      fetchedAt: Date.now(),
      fromCache: false,
    };
  }

  const key = `${apiKey}::${ctx.userId ?? ""}`;

  // Single-flight: an in-flight scan for the same key is shared.
  if (inFlight && inFlight.key === key) {
    try {
      return await inFlight.promise;
    } catch {
      // fall through and run our own
    }
  }

  const run = buildSnapshot(ctx, apiKey, key, readKeyFiles);
  inFlight = { key, promise: run };
  try {
    return await run;
  } finally {
    if (inFlight && inFlight.promise === run) inFlight = null;
  }
}

async function buildSnapshot(
  ctx: ToolContext,
  apiKey: string,
  key: string,
  readKeyFiles: boolean,
): Promise<WorkspaceSnapshot> {
  const client = getE2BClient(apiKey, null, "shared");
  const cached = cacheFor(key);

  // ── TTL fast path — zero I/O ────────────────────────────────────────────
  if (
    cached &&
    isSnapshotFresh(cached, {
      fsVersion,
      localVersion,
      now: Date.now(),
      readKeyFiles,
    })
  ) {
    return { ...cached, fromCache: true };
  }

  // ── First-run only: ensure SOME sandbox exists (never rotate) ──────────
  // With a known sandbox id (localStorage or in-memory) we go straight to
  // the tree walk — /api/sandbox reconnects to that id, and its dead-sandbox
  // recovery handles a vanished sandbox transparently.
  if (!client.peekSandboxId()) {
    try {
      await client.createSandbox();
    } catch {
      // best-effort — the walk below retries through its own recovery path
    }
    // Brand-new sandbox: kick the (fire-and-forget) cloud auto-restore so a
    // configured OnyxBase workspace repopulates it. This is a FIRST-RUN cost
    // — never a per-call one (PRD §22: analysis must not trigger restores).
    maybeAutoRestoreWorkspace(apiKey);
  }

  // ── Parallel: ONE-round-trip tree walk ∥ local Dexie/OPFS scans ────────
  const [tree, localScan] = await Promise.all([
    walkTreeFast(client, TREE_WALK_CAP),
    runLocalScans(ctx),
  ]);

  const errors: string[] = [...localScan.errors];
  if (!tree.ok && tree.error) errors.push(tree.error);
  if (tree.truncated) {
    errors.push(
      `Workspace tree capped at ${TREE_WALK_CAP} entries — increase TREE_WALK_CAP for very large trees.`,
    );
  }

  // ── Key files — reuse when the file world is provably unchanged ────────
  let keyFiles: KeyFiles | null = null;
  let keyFilesRead = false;
  if (readKeyFiles) {
    if (canReuseKeyFiles(cached, { fsVersion, treeDigest: tree.digest }) && cached) {
      keyFiles = cached.keyFiles;
      keyFilesRead = true;
    } else {
      const r = await readKeyFilesBatched(client, tree.files);
      keyFiles = r.keyFiles;
      keyFilesRead = r.readOk;
      errors.push(...r.errors);
    }
  } else if (cached) {
    // Caller skipped key files — preserve any previously-read copy so a
    // later read_key_files=true call can still reuse it via the digest.
    keyFiles = cached.keyFiles;
    keyFilesRead = cached.keyFilesRead;
  }

  const snap: WorkspaceSnapshot = {
    files: tree.ok ? tree.files : [],
    treeTruncated: tree.ok ? tree.truncated : false,
    treeDigest: tree.digest,
    keyFiles,
    keyFilesRead,
    localScan,
    errors,
    fetchedAt: Date.now(),
    fromCache: false,
  };

  snapshotCache = {
    ...snap,
    key,
    fsVersion,
    localVersion,
    treeOk: tree.ok,
  };
  return snap;
}

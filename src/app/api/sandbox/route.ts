// ============================================================================
// Sandbox API — server-side E2B SDK wrapper.
//
// The E2B SDK (`e2b` / `@e2b/code-interpreter`) depends on `undici` which
// requires Node.js built-ins (`node:fs`, `node:http2`) that can't be bundled
// for the browser. So we run the SDK here on the server and expose a simple
// POST API that the client calls.
//
// Request body:
//   { apiKey, action, args, conversationId?, sandboxMode? }
//
// The client sends the decrypted E2B API key in the body; we use it to
// create/reuse a Sandbox instance and perform the requested action.
//
// Sandbox caching: we keep a module-level Map of Sandbox instances keyed by
// (apiKey, conversationId, mode) so repeated calls reuse the same sandbox
// (24h TTL). The 10-sandbox limit is enforced across all cached instances.
//
// DEAD-SANDBOX RECOVERY: when the SDK throws "Sandbox is probably not running
// anymore" (SandboxNotFoundError), we evict the dead cache entry and retry
// the action ONCE with a fresh Sandbox.create. This is critical because E2B
// sandboxes can die at any time (quota, pause, kill, network) and without
// recovery the user is stuck with a dead sandbox until the 24h TTL expires.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { Sandbox } from "@e2b/code-interpreter";
// FULL Onyx.md (Onyx identity + compressed tool compendium + complete GenUI
// reference) bundled as a module so it ships with the serverless bundle —
// the system prompt tells the AI to read the "Generative UI (GenUI)"
// section from this file, so the sandbox MUST receive the full document,
// not a short stub.
import { ONYX_MD } from "@/lib/agent/onyx-md";
import { MASTER_SKILLS, MASTER_SKILLS_VERSION } from "@/lib/agent/master-skills";
import { attachMasterSkills, ensureMasterSkills } from "@/lib/e2b/attach-master-skills";
// HEADLESS SANDBOX AGENT ("close and resume"): the detached Python
// orchestration loop + its protocol file paths. See
// src/lib/e2b/headless-agent.ts for the full architecture notes.
import {
  HEADLESS_RUNNER_PY,
  HEADLESS_RUNNER_VERSION,
  RUNNER_PATH,
  AGENT_DIR,
  RUN_CONFIG_PATH,
  RUNNER_VERSION_PATH,
  CHAT_HISTORY_PATH,
  AGENT_STATUS_PATH,
  BACKGROUND_LOG_PATH,
  SANDBOX_TODOS_PATH,
  RUNNER_PGREP_PATTERN,
} from "@/lib/e2b/headless-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_CWD = "/home/user";
const SANDBOX_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours — files persist for a full day
// PERSISTENT-AGENT TIMEOUT: 24h (E2B's documented max) so a detached
// headless-agent run keeps working long after the user closes the app. If
// the account's tier rejects the 24h window the create falls back to 1h
// (with onTimeout:"pause" + autoResume, even that never loses state — the
// sandbox freezes at the limit and the next connect resumes in place).
const SANDBOX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const SANDBOX_TIMEOUT_FALLBACK_MS = 60 * 60 * 1000;
// ROTATION: E2B sandboxes have a 24h hard TTL. We rotate at 23h to avoid
// hitting the limit (backup → kill → create → restore). The client-side
// `ensureFreshSandbox` in `src/lib/e2b/sandbox-rotation.ts` is the primary
// trigger; the server-side check in `getSandbox` is a safety net for when
// the client-side rotation didn't run (e.g., user closed the tab for >23h
// but the server instance is still alive with the cached entry).
const ROTATION_AGE_MS = 23 * 60 * 60 * 1000; // 23 hours
// SHARED SANDBOX ARCHITECTURE: ONE sandbox per API key — the E2B sandbox is
// the SINGLE source of truth for files (no OPFS mirror; the OnyxBase cloud
// workspace is the durable backup layer). When the sandbox quota is exceeded
// (e.g. "20/20"), we kill ALL sandboxes on the account, create ONE fresh
// sandbox, and the cloud auto-restore (src/lib/e2b/sandbox-rotation.ts)
// repopulates it from the last OnyxBase snapshot when configured.
//
// FILE-LOSS SAFETY (PRD §9–10): a sandbox is NEVER killed merely because it
// is absent from this instance's in-memory cache — on serverless the cache
// is EMPTY on every cold start, so "unknown to me" says nothing about
// whether a sandbox is abandoned. Only sandboxes that are BOTH unknown to
// the cache AND older than STALE_SANDBOX_KILL_AGE_MS (E2B's 24h hard TTL
// kills them within hours anyway) are reclaimed as stale; explicit kill
// paths are the user-initiated reset/kill actions and quota-error recovery.
//
// We keep MAX_SANDBOXES=3 in the local cache as headroom (the shared one
// + maybe a stale entry during dead-sandbox recovery). Cache-pressure
// eviction drops fresh entries WITHOUT killing them (the client reconnects
// by sandbox ID); stale ones (>20h) are killed to protect the quota.
const MAX_SANDBOXES = 3;

// ── E2B PERSISTENCY METADATA (docs.e2b.dev/sandbox/persistence) ─────────────
// Every Onyx sandbox is TAGGED at creation so it can be found again later
// via `Sandbox.list({ query: { metadata } })` — the documented way to reuse
// the SAME sandbox instance across conversation turns, sessions, and
// devices (when the browser lost its localStorage id). The sandbox itself
// persists through E2B's pause/resume: onTimeout:"pause" + autoResume
// freezes the FULL state (filesystem AND RAM — running processes, open
// connections) and the next Sandbox.connect resumes it in place.
const ONYX_APP_TAG = "onyx";
function onyxSandboxMetadata(
  mode: "shared" | "separate",
  conversationId: string | null,
): Record<string, string> {
  return {
    "onyx-app": ONYX_APP_TAG,
    "onyx-scope": mode,
    "onyx-conversation": mode === "separate" && conversationId ? conversationId : "",
  };
}

/** A sandbox this old is demonstrably stale — E2B's 24h hard TTL kills it
 *  within hours no matter what we do, so reclaiming it (quota protection)
 *  can no longer destroy a workspace that would otherwise have survived.
 *  Anything YOUNGER is never killed just for being unknown to this
 *  instance's cache (it may be a live workspace on a cold-started server). */
const STALE_SANDBOX_KILL_AGE_MS = 20 * 60 * 60 * 1000; // 20 hours

/**
 * Normalize a file path to an absolute path rooted at /home/user (the
 * code-interpreter template's default working directory). The client-side
 * `safePath` helper strips leading slashes, so we receive relative paths
 * like "bcrypt_auth.py" or "subdir/file.txt". The E2B SDK's `files.*`
 * methods require absolute paths, so we prepend /home/user here.
 *
 * Already-absolute paths (starting with /) are passed through unchanged.
 */
function normalizePath(p: string | undefined | null): string {
  if (!p || typeof p !== "string" || p.trim() === "") {
    return DEFAULT_CWD;
  }
  const trimmed = p.trim();
  if (trimmed.startsWith("/")) {
    return trimmed;
  }
  // Relative path — prepend the default working directory.
  return `${DEFAULT_CWD}/${trimmed}`;
}

/** E2B entry type helper — "dir" | "directory" | "FILE_TYPE_DIRECTORY". */
function isDirType(t: string | undefined): boolean {
  return t === "dir" || t === "directory" || t === "FILE_TYPE_DIRECTORY";
}

/** "/home/user/src/app.ts" → "src/app.ts" (workspace-relative path used by
 *  the OnyxBase cloud sync; anything outside /home/user is kept absolute). */
function relFromHome(p: string): string {
  if (p === "/home/user" || p === "/home/user/") return "";
  if (p.startsWith("/home/user/")) return p.slice("/home/user/".length);
  return p;
}

interface CacheEntry {
  sandbox: Sandbox;
  /** API key used to create this sandbox. Stored separately because the
   *  E2B Sandbox type doesn't expose apiKey publicly. */
  apiKey: string;
  createdAt: number;
  key: string;
  /** Set to true after a liveness check has confirmed the sandbox is alive.
   *  Prevents redundant pings on every call. Reset on cache lookup miss. */
  verifiedAliveAt?: number;
  /** Which Onyx.md version this sandbox received. Bump AGENT_MD_VERSION
   *  whenever Onyx.md meaningfully changes — cached/reconnected sandboxes
   *  then get the updated documentation on their next use. */
  agentMdVersion?: number;
  /** Which master skill library version this sandbox received (the zip
   *  attached at startup — see attach-master-skills.ts). Sandboxes adopted
   *  through reconnect paths are re-attached when this drifts. */
  masterSkillsVersion?: string;
}

/** Bump when Onyx.md (→ src/lib/agent/onyx-md.ts) changes meaningfully.
 *  Version 2 = the FULL GenUI reference (previously sandboxes received a
 *  short stub with NO GenUI docs at all — the root cause of malformed
 *  `<<<genui>>>` specs).
 *  Version 3 = rename agent.md → Onyx.md with the Onyx identity + the
 *  compressed 47-tool compendium; stale /home/user/agent.md is purged.
 *  Version 4 = cloud workspace persistence tools + policy (49 tools;
 *  since removed from the manual).
 *  Version 6 = workspace-sync tools + persistent-workspace policy removed
 *  from the manual (61 tools).
 *  Version 7 = MCP reality docs — manage_mcp scope clarified (remote
 *  HTTP/SSE only; sandbox-installed stdio servers need their CLI / an
 *  MCP client there) + digest trimmed back under the 8KB cap.
 *  Version 8 = Skills PRD — manage_skill catalog/browse_repository/
 *  install_from_repository actions, manage_mcp market action,
 *  analyze_workspace skill-repository index + metadata-first policy.
 *  Version 9 = MASTER SKILL LIBRARY — the skill-repository system is
 *  REPLACED by one master library zip attached to every sandbox at
 *  startup (extracted to /home/user/skills/ with MASTER-INDEX.md);
 *  manage_skill trimmed to list/read/create/edit/delete; the fixed
 *  read-Onyx.md-and-MASTER-INDEX rule added.
 *  Version 10 = SKILL DIRECTORY AS THE DEFAULT — manage_skill list shows
 *  the master library (/home/user/skills, 55) BY DEFAULT + new actions
 *  catalog / search_marketplace / install_from_marketplace (live SkillsMP
 *  directory, hundreds of skills); analyze_workspace skill_marketplace. */
const AGENT_MD_VERSION = 10;

/** Where a sandbox records the Onyx.md version it carries (same stamping
 *  pattern as the master-skills version). Cold-start reconnects read this
 *  ~40-byte file instead of blindly rewriting the 44KB Onyx.md on every
 *  serverless instance cold start — that write (plus the agent.md remove)
 *  was paid on EVERY basic command (`ls -la`, `cat …`) whenever the request
 *  landed on a fresh Vercel instance, adding seconds of latency each time. */
const ONYX_MD_STAMP_PATH = "/home/user/.onyx/onyx-md-version";

/** Refresh Onyx.md ONLY when the sandbox's stamp is missing or outdated.
 *  Returns true when the document is current (either it already was, or the
 *  refresh succeeded). Cheap steady-state: one tiny file read. */
async function ensureOnyxMdCurrent(sandbox: Sandbox): Promise<boolean> {
  try {
    const stamped = await sandbox.files.read(ONYX_MD_STAMP_PATH, { format: "text" });
    if (stamped.trim() === String(AGENT_MD_VERSION)) return true;
  } catch {
    // No stamp yet (pre-stamping sandbox or fresh state) — fall through and
    // (re)write the document + stamp. This is the one-time cost path.
  }
  try {
    await sandbox.files.write("/home/user/Onyx.md", ONYX_MD);
    await sandbox.files.write(ONYX_MD_STAMP_PATH, String(AGENT_MD_VERSION));
    try {
      await sandbox.files.remove("/home/user/agent.md");
    } catch {
      // legacy agent.md already gone
    }
    return true;
  } catch {
    return false; // best-effort — the next adoption retries
  }
}

const sharedCache = new Map<string, CacheEntry>();
const separateCache = new Map<string, CacheEntry>();

function cacheKey(
  apiKey: string,
  conversationId: string | null,
  mode: "shared" | "separate",
): string {
  return mode === "separate" && conversationId
    ? `${apiKey}:${conversationId}`
    : apiKey;
}

function getCache(mode: "shared" | "separate"): Map<string, CacheEntry> {
  return mode === "separate" ? separateCache : sharedCache;
}

/** Evict a cache entry by key + mode. Kills the sandbox best-effort. */
function evictCacheEntry(
  mode: "shared" | "separate",
  key: string,
): CacheEntry | null {
  const cache = getCache(mode);
  const entry = cache.get(key);
  if (!entry) return null;
  cache.delete(key);
  void entry.sandbox.kill().catch(() => {});
  return entry;
}

/** Drop cache entries pointing at a sandbox WITHOUT killing it — used by
 *  the `pause` action: the paused sandbox is PRESERVED (full state), we
 *  just release this instance's SDK handle (its websocket dies with the
 *  pause; the next use reconnects via Sandbox.connect which auto-resumes
 *  the sandbox in place). */
function dropCacheEntriesForSandbox(sandboxId: string): void {
  for (const [key, entry] of [...sharedCache]) {
    if (entry.sandbox.sandboxId === sandboxId) sharedCache.delete(key);
  }
  for (const [key, entry] of [...separateCache]) {
    if (entry.sandbox.sandboxId === sandboxId) separateCache.delete(key);
  }
}

/** Detect "sandbox is dead" errors from the E2B SDK. The SDK throws
 *  `SandboxNotFoundError` with message "Sandbox is probably not running
 *  anymore" when envd is unreachable. We also catch a few related variants. */
function isDeadSandboxError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /not running|probably not|no such|not found|sandbox.*not|unavailable|connect error/i.test(msg);
}

/**
 * Liveness check — pings the sandbox with a cheap filesystem operation to
 * verify envd is reachable. Returns true if alive, false if dead (in which
 * case the caller should evict the cache entry and create a new sandbox).
 *
 * Uses `sandbox.files.list("/home/user")` with a 3-second timeout. The
 * timeout is enforced via Promise.race because the SDK doesn't accept a
 * timeoutMs on files.list.
 */
async function isAlive(sandbox: Sandbox): Promise<boolean> {
  try {
    const ping = sandbox.files.list(DEFAULT_CWD);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("ping timeout")), 3000),
    );
    await Promise.race([ping, timeout]);
    return true;
  } catch {
    return false;
  }
}

function lookupCached(
  apiKey: string,
  conversationId: string | null,
  mode: "shared" | "separate",
): CacheEntry | null {
  const key = cacheKey(apiKey, conversationId, mode);
  const entry = getCache(mode).get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > SANDBOX_TTL_MS) {
    evictCacheEntry(mode, key);
    return null;
  }
  return entry;
}

async function enforceLimit(): Promise<void> {
  const all = [
    ...sharedCache.entries(),
    ...separateCache.entries(),
  ];
  if (all.length < MAX_SANDBOXES) return;
  all.sort((a, b) => a[1].createdAt - b[1].createdAt);
  const [oldestKey, oldest] = all[0]!;
  if (sharedCache.has(oldestKey)) sharedCache.delete(oldestKey);
  else separateCache.delete(oldestKey);
  // Cache-pressure eviction KILLS the sandbox only when it is demonstrably
  // stale (>20h — E2B kills it within hours anyway). A fresh sandbox is
  // merely DROPPED from this instance's cache: it keeps running on E2B and
  // its owner's client reconnects to it by sandbox ID on the next request.
  // (The module cache is shared across ALL requests/users on this serverless
  // instance — killing here could destroy another user's live workspace.)
  if (Date.now() - oldest.createdAt > STALE_SANDBOX_KILL_AGE_MS) {
    void oldest.sandbox.kill().catch(() => {});
  }
  // Reclaim stale sandboxes unknown to this instance (previous sessions,
  // dead serverless instances) — never fresh ones (see
  // killOrphanedSandboxes). Best-effort — don't block on it.
  void killOrphanedSandboxes(oldest.apiKey).catch(() => {});
}

/** Age of a listed sandbox in ms. `SandboxInfo.startedAt` is a Date, but be
 *  defensive about SDK shape drift (string ISO timestamps). UNKNOWN age is
 *  reported as 0 — i.e. treated as brand new — so an unreadable start time
 *  can never make us kill a possibly-live sandbox. */
function sandboxAgeMs(s: { startedAt?: unknown }, now: number): number {
  const sa = s.startedAt;
  if (sa instanceof Date) {
    const t = sa.getTime();
    return Number.isFinite(t) ? now - t : 0;
  }
  if (typeof sa === "string") {
    const t = Date.parse(sa);
    return Number.isNaN(t) ? 0 : now - t;
  }
  if (sa && typeof (sa as { getTime?: unknown }).getTime === "function") {
    try {
      const t = (sa as Date).getTime();
      return Number.isFinite(t) ? now - t : 0;
    } catch {
      return 0;
    }
  }
  return 0;
}

/**
 * Reclaim STALE sandboxes on E2B for an API key: running sandboxes that are
 * (a) NOT in this instance's local cache and (b) OLDER than
 * STALE_SANDBOX_KILL_AGE_MS (20h — E2B's 24h hard TTL kills them within
 * hours anyway). This still protects the account
 * from the "20/20 sandbox limit reached" error caused by sandboxes leaking
 * from previous sessions / dead serverless instances.
 *
 * FILE-LOSS SAFETY (PRD §9–10): sandboxes younger than the stale age are
 * NEVER killed, no matter how "orphaned" they look. On serverless, this
 * module's cache is EMPTY on every cold start — the user's LIVE workspace
 * is exactly as "unknown" as a genuinely abandoned sandbox, and the old
 * kill-anything-unknown behavior destroyed live workspaces on page refresh,
 * chat navigation, and every sandbox re-create. Deletion must be explicit
 * (user reset) or forced (quota) — never inferred from an empty cache.
 *
 * Best-effort — never throws.
 *
 * The `knownApiKey` param is the API key of the sandbox that triggered this
 * call (we need it to list sandboxes — E2B's list endpoint requires a key).
 */
async function killOrphanedSandboxes(knownApiKey: string): Promise<void> {
  try {
    const paginator = Sandbox.list({ apiKey: knownApiKey, limit: 50 });
    const page = await paginator.nextItems();
    // Build a set of sandbox IDs we have in our local caches.
    const localIds = new Set<string>();
    for (const [, entry] of sharedCache) localIds.add(entry.sandbox.sandboxId);
    for (const [, entry] of separateCache) localIds.add(entry.sandbox.sandboxId);
    // STALE-ONLY KILL: local-cache absence alone is NOT evidence of
    // abandonment (serverless cold start = empty cache). Only age makes a
    // sandbox demonstrably idle-and-doomed.
    const now = Date.now();
    const toKill = page.filter(
      (s) =>
        (s.state as string) !== "closed" &&
        !localIds.has(s.sandboxId) &&
        sandboxAgeMs(s, now) > STALE_SANDBOX_KILL_AGE_MS,
    );
    await Promise.all(
      toKill.map((s) =>
        Sandbox.kill(s.sandboxId, { apiKey: knownApiKey }).catch(() => {}),
      ),
    );
    if (toKill.length > 0) {
      console.log(`[sandbox] reclaimed ${toKill.length} stale sandbox(es) (>20h, unknown to this instance)`);
    }
  } catch {
    // best-effort — don't fail the operation if listing/killing fails.
  }
}

/** Detect "sandbox quota reached" errors from the E2B SDK. The SDK throws
 *  when you try to create a sandbox but you've hit the plan's concurrent
 *  sandbox limit (e.g. "20/20" on the free plan). */
function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // REGEX HARDENING (user report 2026-10-21): the old pattern also matched
  // ANY bare fraction (\d+/\d+) — a create error like "retry 1/5" was
  // misread as a quota failure and KILLED EVERY SANDBOX ON THE ACCOUNT.
  // Only explicit quota wording counts now.
  return /quota|limit reached|concurrent|too many|20\/20|sandbox limit|maximum number of sandboxes/i.test(msg);
}

/**
 * Kill ALL running sandboxes on the account (E2B's side). Used ONLY when we
 * hit the sandbox quota limit — the shared-sandbox architecture means we
 * only ever need ONE sandbox per API key, so when E2B refuses to create
 * another one we nuke everything and start fresh. This is the explicit,
 * forced kill path (PRD §9: deletion must be explicit or forced, never
 * inferred): the durable workspace lives in the OnyxBase cloud snapshot, so
 * the cloud auto-restore repopulates the fresh sandbox when configured.
 *
 * Best-effort — never throws. Returns the count of killed sandboxes.
 */
async function killAllSandboxesOnAccount(apiKey: string): Promise<number> {
  try {
    const paginator = Sandbox.list({ apiKey, limit: 50 });
    const page = await paginator.nextItems();
    const running = page.filter((s) => (s.state as string) !== "closed");
    await Promise.all(
      running.map((s) =>
        Sandbox.kill(s.sandboxId, { apiKey }).catch(() => {}),
      ),
    );
    if (running.length > 0) {
      console.log(`[sandbox] killed ${running.length} sandbox(es) on account to free quota`);
    }
    return running.length;
  } catch {
    return 0;
  }
}

/** A single file in a rotation backup: raw BYTES as base64. Backing up
 *  EVERY file as base64 (text included) is what makes rotation lossless —
 *  the old text-only backup silently dropped every binary file. */
interface BackupFile {
  path: string;
  base64: string;
}

/** Volatile shell state + template dotfiles. These are NEVER user workspace
 *  content: they are re-created by the sandbox template (a stale copy restored
 *  into a fresh sandbox would be wrong) or are throwaway shell history. Every
 *  OTHER file — binary included, dotfiles included — is backed up. */
const ROTATION_SKIP_FILES = new Set([
  ".bash_history",
  ".bash_logout",
  ".bashrc",
  ".profile",
  ".sudo_as_admin_successful",
  ".wget-hsts",
  ".viminfo",
  ".python_history",
  ".node_repl_history",
  ".lesshst",
]);

/**
 * Recursively walk /home/user in a sandbox and return ALL files (binary
 * included) as base64 { path, base64 } pairs. Used by the `rotate` and
 * `backup_all` actions to migrate files to a new sandbox.
 *
 * BINARY-SAFE (PRD §9–10 file-loss fix): every file is read as bytes and
 * base64-encoded — the previous implementation detected binary files by
 * null bytes in the first 1KB and SKIPPED them, so every rotation silently
 * lost all images, archives, databases, PDFs, etc. There is no size limit:
 * the backup stays in server memory for the duration of the rotation and
 * the response only carries counts, not contents.
 */
async function backupAllFilesFromSandbox(
  sandbox: Sandbox,
): Promise<BackupFile[]> {
  const files: BackupFile[] = [];

  /** Master-library paths that NEVER need a rotation backup: the library
   *  is static and re-attached (version-gated) to every new sandbox at
   *  startup — backing up ~700 files / 7MB per rotation would slow it for
   *  no benefit. USER skills under /home/user/skills/ are still backed up. */
  const MASTER_LIBRARY_PATHS: ReadonlySet<string> = new Set(
    MASTER_SKILLS.flatMap((s) => [
      `/home/user/skills/${s.name}`,
      `/home/user/skills/${s.name}/`,
      "/home/user/skills/MASTER-INDEX.md",
    ]),
  );

  function isMasterLibraryPath(p: string): boolean {
    if (MASTER_LIBRARY_PATHS.has(p)) return true;
    if (!p.startsWith("/home/user/skills/")) return false;
    const rest = p.slice("/home/user/skills/".length);
    const head = rest.split("/", 1)[0];
    return MASTER_SKILLS.some((s) => s.name === head);
  }

  async function walkDir(dirPath: string) {
    let entries;
    try {
      entries = await sandbox.files.list(dirPath);
    } catch {
      return; // can't list this dir — skip
    }
    for (const entry of entries) {
      const fname = entry.name ?? entry.path.split("/").pop() ?? "";
      if (ROTATION_SKIP_FILES.has(fname)) continue;
      if (isMasterLibraryPath(entry.path)) continue; // static — re-attached at startup
      if (isDirType(entry.type as string)) {
        await walkDir(entry.path);
      } else {
        try {
          // Read as raw bytes — preserves binary content exactly.
          const bytes = await sandbox.files.read(entry.path, { format: "bytes" });
          files.push({
            path: entry.path,
            base64: Buffer.from(bytes).toString("base64"),
          });
        } catch {
          // skip unreadable files (permissions, etc.)
        }
      }
    }
  }

  await walkDir(DEFAULT_CWD);
  return files;
}

/** Write a base64 backup entry to a sandbox as raw bytes (binary-safe;
 *  parent directories are created implicitly by the E2B write). */
async function restoreBackupFile(
  sandbox: Sandbox,
  file: BackupFile,
): Promise<boolean> {
  try {
    const bytes = Buffer.from(file.base64, "base64");
    await sandbox.files.write(file.path, new Blob([new Uint8Array(bytes)]));
    return true;
  } catch {
    return false;
  }
}

/** Where the rotation archive is staged inside the sandbox. */
const ROTATION_TAR_PATH = "/tmp/onyx-rotation-backup.tgz";

/** tar --exclude flags mirroring the per-file skip rules (volatile shell
 *  state + the static master skill library — the latter is re-attached
 *  version-gated to every fresh sandbox, so shipping ~700 files / 7MB per
 *  rotation is pure waste). */
function rotationTarExcludeArgs(): string[] {
  const args: string[] = [];
  for (const f of ROTATION_SKIP_FILES) args.push(`--exclude=./${f}`);
  args.push("--exclude=./skills/MASTER-INDEX.md");
  for (const s of MASTER_SKILLS) args.push(`--exclude=./skills/${s.name}`);
  return args;
}

/** FAST ROTATION BACKUP (the "rotation takes 2-5 minutes" fix): ONE tar
 *  command inside the old sandbox + ONE byte read, instead of a recursive
 *  per-directory `files.list` + per-file `files.read` walk (each an SDK
 *  round trip — hundreds of round trips ≈ minutes for a real workspace,
 *  and the rotation runs synchronously in front of a user-visible tool
 *  call). Binary-safe (raw tgz bytes), gz-compressed (smaller than the sum
 *  of files), same skip semantics as the per-file walk. Returns null when
 *  tar is unavailable or fails — the caller falls back to the per-file
 *  walk (identical semantics, just slower). */
async function backupSandboxViaTar(
  sandbox: Sandbox,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; files: number } | null> {
  try {
    const cmd = [
      "cd /home/user",
      `rm -f ${ROTATION_TAR_PATH}`,
      `tar -czf ${ROTATION_TAR_PATH} ${rotationTarExcludeArgs().join(" ")} .`,
      `tar -tzf ${ROTATION_TAR_PATH} | wc -l`,
    ].join(" && ");
    const res = await sandbox.commands.run(cmd, { timeoutMs: 180_000 });
    const files = Number(String(res.stdout ?? "").trim().split(/\s+/).pop() ?? "0");
    if (res.exitCode !== 0 || !Number.isFinite(files) || files <= 0) {
      console.warn(
        `[sandbox] rotation tar backup unavailable (exit ${res.exitCode}) — falling back to per-file backup: ${String(res.stderr ?? "").slice(0, 160)}`,
      );
      return null;
    }
    const bytes = await sandbox.files.read(ROTATION_TAR_PATH, { format: "bytes" });
    await sandbox.commands.run(`rm -f ${ROTATION_TAR_PATH}`).catch(() => {});
    // Standalone ArrayBuffer-backed view (BlobPart-safe — same pattern as
    // attach-master-skills' zipBytes).
    return { bytes: new Uint8Array(bytes), files };
  } catch (err) {
    console.warn(
      `[sandbox] rotation tar backup threw — falling back to per-file backup:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** Restore a tar backup: ONE byte write + ONE extract command (vs one
 *  `files.write` per file). Extracts with cwd=/home/user so the archived
 *  ./relative paths land exactly where the per-file restore put them. */
async function restoreSandboxViaTar(
  sandbox: Sandbox,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  try {
    await sandbox.files.write(ROTATION_TAR_PATH, new Blob([bytes]));
    const res = await sandbox.commands.run(
      `cd /home/user && tar -xzf ${ROTATION_TAR_PATH} && rm -f ${ROTATION_TAR_PATH}`,
      { timeoutMs: 180_000 },
    );
    if (res.exitCode !== 0) {
      console.warn(
        `[sandbox] rotation tar restore failed (exit ${res.exitCode}): ${String(res.stderr ?? "").slice(0, 160)}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.warn(
      `[sandbox] rotation tar restore threw:`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/** Return type of performRotation — `skipped` explains a NO-OP rotation
 *  (the live sandbox was left untouched; the client re-stamps its rotation
 *  clock and retries after the blocking condition clears). */
interface RotationResult {
  sandbox: Sandbox;
  backedUp: number;
  restored: number;
  skipped?: "running-commands";
}

/** True when a running sandbox process must BLOCK a rotation (killing the
 *  sandbox would destroy it) — any in-flight SDK command (an exec from
 *  another tab/client racing this rotation).
 *  Template service processes (the code-interpreter start command —
 *  jupyter — run FOREVER) are ignored so they can never block rotation. */
function isBlockingProcess(c: { cmd?: string; args?: string[] }): boolean {
  const cmdline = `${c.cmd ?? ""} ${(c.args ?? []).join(" ")}`;
  if (/jupyter|start\.sh|envd/i.test(cmdline)) return false;
  return true; // in-flight execs, anything user-started
}

/**
 * Perform an atomic sandbox rotation: backup → kill old → create → restore.
 *
 * Used by:
 *   - The `rotate` action (called by the client-side `ensureFreshSandbox`
 *     rotation loop). The client passes its CURRENT sandbox ID so a
 *     serverless cold start (empty server-side cache) can still find, back
 *     up, and replace the old sandbox — previously a cold rotation created
 *     an empty sandbox and orphaned the old one with all its files.
 *   - The `getSandbox` safety-net check (when the server's cached entry is
 *     >23h old).
 *
 * FILE-LOSS SAFETY: rotation NEVER kills anything except the ONE sandbox it
 * is replacing, and only AFTER its files have been backed up. The old
 * "kill orphaned sandboxes first" step killed the live workspace before the
 * backup ran whenever this instance's cache was cold — catastrophic data
 * loss on every rotation. Stale-sandbox reclaiming stays in
 * createAndCacheSandbox (age-guarded, >20h only).
 *
 * LIVE-PROCESS GUARD: if the old sandbox has LIVE processes (an in-flight
 * exec from any tab/client), the rotation is
 * SKIPPED — killing the sandbox would kill the run mid-flight. Skipping is
 * SAFE: sandboxes are created with lifecycle onTimeout:"pause" +
 * autoResume, so even when the rotation window lapses the sandbox
 * auto-PAUSES (full RAM + filesystem preserved — E2B's documented
 * pause/resume persistence) and the next Sandbox.connect auto-resumes it,
 * continuing the run exactly where it froze.
 *
 * Returns the new sandbox + counts of files backed up and restored, or the
 * LIVE sandbox with skipped:"running-commands" when the guard tripped.
 */
async function performRotation(
  apiKey: string,
  conversationId: string | null,
  mode: "shared" | "separate",
  clientSandboxId?: string | null,
): Promise<RotationResult> {
  const key = cacheKey(apiKey, conversationId, mode);

  // 1. Resolve the OLD sandbox: local cache first (warm instance), then the
  //    client-provided sandbox ID (cold start — the client stores the
  //    current id at `e2b-sandbox-id:<apiKey>` and sends it on every
  //    request). Sandbox.connect also auto-resumes a paused sandbox.
  let oldSandbox: Sandbox | null = null;
  const cached = lookupCached(apiKey, conversationId, mode);
  if (cached) {
    oldSandbox = (await isAlive(cached.sandbox)) ? cached.sandbox : null;
  }
  if (!oldSandbox && clientSandboxId) {
    try {
      oldSandbox = await Sandbox.connect(clientSandboxId, { apiKey });
    } catch {
      // Dead or already gone — nothing to back up.
    }
  }

  // 1.5 LIVE-PROCESS GUARD — a live process on the old sandbox blocks the
  //     rotation (see docblock). Re/adopt the live sandbox and return it
  //     unchanged; the client re-stamps its rotation clock and retries
  //     after the process finishes.
  //
  //     DETACHED-RUNNER + CRON GUARD: commands.list() only sees E2B-tracked
  //     execs — a nohup'd headless runner (started via `commands.run('nohup
  //     … &')`, whose wrapper already exited) and the cron daemon are
  //     INVISIBLE to it. Probing both explicitly: rotation kills the
  //     sandbox, which would kill an active background run / every
  //     installed schedule.
  if (oldSandbox) {
    try {
      const bgProbe = await oldSandbox.commands.run(
        `pgrep -f "${RUNNER_PGREP_PATTERN}" >/dev/null 2>&1 && echo RUNNER; crontab -l 2>/dev/null | grep -q '/home/user' && echo CRON; true`,
        { timeoutMs: 10_000 },
      );
      const bgOut = bgProbe.stdout ?? "";
      if (bgOut.includes("RUNNER") || bgOut.includes("CRON")) {
        console.log(
          `[sandbox] rotation SKIPPED — ${bgOut.includes("RUNNER") ? "detached agent run" : "cron schedules"} active on ${oldSandbox.sandboxId}; the sandbox pauses at the E2B timeout instead and auto-resumes on next use`,
        );
        const liveBg = cached?.sandbox && oldSandbox === cached.sandbox ? cached.sandbox : oldSandbox;
        const bgEntry: CacheEntry = {
          sandbox: liveBg,
          apiKey,
          createdAt: Date.now(),
          key,
          verifiedAliveAt: Date.now(),
          ...(cached?.agentMdVersion ? { agentMdVersion: cached.agentMdVersion } : {}),
          ...(cached?.masterSkillsVersion ? { masterSkillsVersion: cached.masterSkillsVersion } : {}),
        };
        getCache(mode).set(key, bgEntry);
        return { sandbox: liveBg, backedUp: 0, restored: 0, skipped: "running-commands" };
      }
    } catch {
      // FAIL-SAFE: the background-work probe failed — we cannot prove the
      // sandbox is idle, and rotation destroys state. Skip (same contract
      // as the live-process guard below).
      console.warn(
        `[sandbox] rotation SKIPPED — background-work probe unavailable on ${oldSandbox.sandboxId}; the sandbox is left untouched`,
      );
      const liveProbeFail = cached?.sandbox && oldSandbox === cached.sandbox ? cached.sandbox : oldSandbox;
      const probeFailEntry: CacheEntry = {
        sandbox: liveProbeFail,
        apiKey,
        createdAt: Date.now(),
        key,
        verifiedAliveAt: Date.now(),
        ...(cached?.agentMdVersion ? { agentMdVersion: cached.agentMdVersion } : {}),
        ...(cached?.masterSkillsVersion ? { masterSkillsVersion: cached.masterSkillsVersion } : {}),
      };
      getCache(mode).set(key, probeFailEntry);
      return { sandbox: liveProbeFail, backedUp: 0, restored: 0, skipped: "running-commands" };
    }
    try {
      const running = await oldSandbox.commands.list();
      const blocking = running.filter((c) => isBlockingProcess(c));
      if (blocking.length > 0) {
        console.log(
          `[sandbox] rotation SKIPPED — ${blocking.length} live process(es) on ${oldSandbox.sandboxId} (in-flight exec); the sandbox pauses at the E2B timeout instead and auto-resumes on next use`,
        );
        const live = cached?.sandbox && oldSandbox === cached.sandbox ? cached.sandbox : oldSandbox;
        // Adopt the connect()-resolved live sandbox into this instance's
        // cache so subsequent calls reuse it instead of cold-creating.
        const entry: CacheEntry = {
          sandbox: live,
          apiKey,
          createdAt: Date.now(),
          key,
          verifiedAliveAt: Date.now(),
          ...(cached?.agentMdVersion ? { agentMdVersion: cached.agentMdVersion } : {}),
          ...(cached?.masterSkillsVersion ? { masterSkillsVersion: cached.masterSkillsVersion } : {}),
        };
        getCache(mode).set(key, entry);
        return { sandbox: live, backedUp: 0, restored: 0, skipped: "running-commands" };
      }
    } catch {
      // FAIL-SAFE GUARD: commands.list() failed (envd blip / connect
      // flakiness) — the old code PROCEEDED with the rotation in that case,
      // killing sandboxes that could not be inspected. Rotation is an
      // OPTIMIZATION (the E2B 24h TTL is the only hard deadline and the
      // sandbox auto-pauses safely at its 1h timeout); skipping when the
      // liveness check is unavailable can never destroy work. The client
      // re-stamps its rotation clock and retries later.
      console.warn(
        `[sandbox] rotation SKIPPED — live-process guard unavailable (commands.list failed) on ${oldSandbox.sandboxId}; the sandbox is left untouched`,
      );
      const live = cached?.sandbox && oldSandbox === cached.sandbox ? cached.sandbox : oldSandbox;
      const guardEntry: CacheEntry = {
        sandbox: live,
        apiKey,
        createdAt: Date.now(),
        key,
        verifiedAliveAt: Date.now(),
        ...(cached?.agentMdVersion ? { agentMdVersion: cached.agentMdVersion } : {}),
        ...(cached?.masterSkillsVersion ? { masterSkillsVersion: cached.masterSkillsVersion } : {}),
      };
      getCache(mode).set(key, guardEntry);
      return { sandbox: live, backedUp: 0, restored: 0, skipped: "running-commands" };
    }
  }

  // 2. Back up ALL files (binary-safe) from the old sandbox before touching
  //    anything. TAR FAST PATH first (one command + one byte read); the
  //    per-file walk stays as the fallback for sandboxes without tar.
  //    Best-effort — a failed backup logs and continues with an empty one
  //    rather than killing a live workspace we couldn't read.
  let backupFiles: BackupFile[] = [];
  let backupTar: { bytes: Uint8Array<ArrayBuffer>; files: number } | null = null;
  if (oldSandbox) {
    backupTar = await backupSandboxViaTar(oldSandbox);
    if (backupTar) {
      console.log(
        `[sandbox] rotation: tar-backed up ${backupTar.files} entries (${Math.round(backupTar.bytes.byteLength / 1024)}KB gz) from ${oldSandbox.sandboxId}`,
      );
    } else {
      try {
        backupFiles = await backupAllFilesFromSandbox(oldSandbox);
        console.log(`[sandbox] rotation: backed up ${backupFiles.length} files from ${oldSandbox.sandboxId}`);
      } catch (err) {
        // best-effort — if backup fails, continue with empty backup
        console.warn(`[sandbox] rotation: backup failed:`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  // 3. Kill the OLD sandbox only (after the backup). Evicting the cache
  //    entry kills + removes it; a connect()-resolved sandbox is killed
  //    directly.
  if (cached) {
    evictCacheEntry(mode, key);
  } else if (oldSandbox) {
    void oldSandbox.kill().catch(() => {});
  }

  // 4. Create a new sandbox (createAndCacheSandbox handles quota recovery;
  //    its stale-reclaim is age-guarded and cannot touch live sandboxes).
  const sandbox = await createAndCacheSandbox(apiKey, conversationId, mode);

  // 5. Restore the backup (if any) to the new sandbox — tar fast path first,
  //    per-file fallback otherwise.
  let restored = 0;
  if (backupTar) {
    const ok = await restoreSandboxViaTar(sandbox, backupTar.bytes);
    restored = ok ? backupTar.files : 0;
    console.log(
      `[sandbox] rotation: ${ok ? "tar-restored" : "tar-restore FAILED"} ${restored} entries to ${sandbox.sandboxId}`,
    );
    if (!ok && backupFiles.length === 0) {
      // tar restore failed and there is no per-file fallback payload — try a
      // direct per-file restore of nothing is impossible; log honestly.
      console.warn(`[sandbox] rotation: no fallback payload available after tar-restore failure`);
    }
  }
  if (!backupTar && backupFiles.length > 0) {
    for (const f of backupFiles) {
      if (await restoreBackupFile(sandbox, f)) restored++;
    }
    console.log(`[sandbox] rotation: restored ${restored}/${backupFiles.length} files to ${sandbox.sandboxId}`);
  }

  return { sandbox, backedUp: backupTar ? backupTar.files : backupFiles.length, restored };
}

/** Create a fresh sandbox and cache it. Used by getSandbox() and the
 *  dead-sandbox recovery path. Creates predefined folders best-effort.
 *
 *  STALE-RECLAIM: `killOrphanedSandboxes(apiKey)` runs at the start of EVERY
 *  create, but is AGE-GUARDED — it only reclaims sandboxes from previous
 *  sessions / dead serverless instances that are ALSO older than 20h (E2B's
 *  24h TTL kills them within hours anyway). This still prevents the
 *  "20/20 sandbox limit reached" error from leaked sandboxes while never
 *  touching a live workspace that merely happens to be unknown to this
 *  instance's cold cache.
 *
 *  QUOTA RECOVERY: if `Sandbox.create` fails with a quota error (e.g.
 *  "20/20 sandbox limit reached"), we kill ALL sandboxes on the account
 *  (the forced path — see killAllSandboxesOnAccount), clear our local
 *  cache, and retry the create. The OnyxBase cloud auto-restore then
 *  repopulates the fresh sandbox when configured. */
/** Sanitize client-supplied env vars for sandbox injection (PRD §14):
 *  only string→string entries, sane size caps, no empty names. Values are
 *  NEVER logged. */
function sanitizeEnvs(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  let count = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= 100) break;
    if (typeof k !== "string" || !k.trim() || k.length > 256) continue;
    const val = typeof v === "string" ? v : String(v ?? "");
    if (val.length > 32_768) continue;
    out[k] = val;
    count += 1;
  }
  return count > 0 ? out : undefined;
}

/**
 * Deploy the headless-agent runner into a sandbox (version-stamped — a
 * matching stamp skips the rewrite, same pattern as the Onyx.md stamp and
 * the browser driver). Returns true when the script was (re)written.
 */
async function deployHeadlessRunner(sandbox: Sandbox): Promise<boolean> {
  try {
    let current: string | null = null;
    try {
      current = await sandbox.files.read(RUNNER_VERSION_PATH, { format: "text" });
    } catch {
      // not deployed yet
    }
    if (current && current.trim() === String(HEADLESS_RUNNER_VERSION)) {
      return false;
    }
    await sandbox.files.makeDir(AGENT_DIR).catch(() => {});
    await sandbox.files.write(RUNNER_PATH, HEADLESS_RUNNER_PY);
    await sandbox.files.write(RUNNER_VERSION_PATH, String(HEADLESS_RUNNER_VERSION));
    console.log(`[sandbox] deployed headless runner v${HEADLESS_RUNNER_VERSION} to ${RUNNER_PATH}`);
    return true;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to deploy the headless agent runner: ${errMsg}`);
  }
}

/** Read + JSON-parse a small protocol file (null when absent/invalid). */
async function readJsonFile(sandbox: Sandbox, path: string): Promise<unknown> {
  try {
    const text = await sandbox.files.read(path, { format: "text" });
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function createAndCacheSandbox(
  apiKey: string,
  conversationId: string | null,
  mode: "shared" | "separate",
  envs?: Record<string, string>,
): Promise<Sandbox> {
  // Reclaim STALE sandboxes (>20h, unknown to this instance — leaked from
  // previous sessions / dead serverless instances) before creating a new
  // one. Age-guarded inside killOrphanedSandboxes: a live workspace that is
  // merely unknown to this cold instance's cache is NEVER killed.
  await killOrphanedSandboxes(apiKey);

  await enforceLimit();

  // Create with the 24h persistent-agent window; fall back to 1h when the
  // account's tier rejects the larger window (the lifecycle pause/resume
  // still preserves everything either way).
  const createSandbox = async (timeoutMs: number): Promise<Sandbox> => {
    const templateId = process.env.E2B_TEMPLATE_ID?.trim() || undefined;
    if (templateId) {
      console.log(`[sandbox] using custom template: ${templateId}`);
    }
    //
    // LIFECYCLE: onTimeout "pause" + autoResume. Without this E2B's default
    // KILLS the sandbox when its timeout expires — including any in-flight
    // command running inside it. With it, the sandbox auto-PAUSES at timeout
    // (full memory + filesystem preserved, running processes frozen
    // mid-flight — a detached headless-agent run included) and any later
    // Sandbox.connect AUTO-RESUMES it, continuing exactly where it froze.
    return await Sandbox.create({
      apiKey,
      ...(templateId ? { template: templateId } : {}),
      timeoutMs,
      envs,
      metadata: onyxSandboxMetadata(mode, conversationId),
      lifecycle: { onTimeout: "pause", autoResume: true },
    });
  };

  let sandbox: Sandbox;
  try {
    // ENV INJECTION (PRD §14): sandbox-level env vars so interactive shells
    // see them too. Per-execution envs (commands.run / runCode opts) are the
    // always-fresh authoritative source — this create-time set is a
    // best-effort baseline for connected sandboxes.
    //
    // CUSTOM TEMPLATE (CloakBrowser PRD §2.1): when E2B_TEMPLATE_ID is set
    // (the operator built e2b-template/Dockerfile — cloakbrowser + the
    // stealth Chromium binary baked in), sandboxes start from it and the
    // browser tool skips its ~280s runtime pip-install. Unset → the default
    // code-interpreter template, and the browser runtime self-installs on
    // first use (browser-session.ts). Never hardcode the name: a missing
    // template on the E2B account would break ALL sandbox creation.
    sandbox = await createSandbox(SANDBOX_TIMEOUT_MS);
  } catch (createErr) {
    // QUOTA RECOVERY: kill ALL sandboxes on the account and retry.
    // The shared-sandbox architecture means we only ever need ONE sandbox
    // per API key. When quota is exceeded, nuke everything and start fresh.
    if (isQuotaError(createErr)) {
      console.warn(`[sandbox] quota exceeded, killing ALL sandboxes on account and retrying...`);
      await killAllSandboxesOnAccount(apiKey);
      // Clear our local caches (the sandboxes we just killed are dead).
      sharedCache.clear();
      separateCache.clear();
      // Retry the create — should succeed now that the account has 0 sandboxes.
      sandbox = await createSandbox(SANDBOX_TIMEOUT_MS).catch(() =>
        createSandbox(SANDBOX_TIMEOUT_FALLBACK_MS),
      );
    } else {
      // Tier may cap the timeout window (e.g. 1h max continuous runtime) —
      // retry once with the fallback before surfacing the error.
      try {
        sandbox = await createSandbox(SANDBOX_TIMEOUT_FALLBACK_MS);
      } catch (fallbackErr) {
        if (isQuotaError(fallbackErr)) {
          await killAllSandboxesOnAccount(apiKey);
          sharedCache.clear();
          separateCache.clear();
          sandbox = await createSandbox(SANDBOX_TIMEOUT_FALLBACK_MS);
        } else {
          throw fallbackErr;
        }
      }
    }
  }

  // Create predefined folders so the workspace is organized from the start.
  // These folders are created best-effort — if they fail (e.g. sandbox doesn't
  // support makeDir), we continue anyway.
  const predefinedFolders = [
    "/home/user/uploads",    // User-uploaded files
    "/home/user/skills",     // Installed skills
    "/home/user/projects",   // AI-created project files
    "/home/user/output",     // Tool output / generated files
  ];
  for (const folder of predefinedFolders) {
    try {
      await sandbox.files.makeDir(folder);
    } catch {
      // best-effort — folder may already exist or makeDir may fail
    }
  }

  // Write Onyx.md to the sandbox — contains the Onyx identity + the
  // compressed tool compendium AND the full GenUI reference (all 33 node
  // types, custom_html/custom_card deep guide, the common-mistakes table,
  // worked examples). The system prompt promises this documentation — the
  // sandbox must actually receive it, or the model improvises GenUI specs
  // and produces broken markers/JS.
  try {
    await sandbox.files.write("/home/user/Onyx.md", ONYX_MD);
    // Version STAMP (the "every basic command is slow" fix): sandboxes
    // record which Onyx.md they carry so the cold-start reconnect path can
    // skip the 44KB rewrite with a ~40-byte read instead (it used to rewrite
    // the full document on EVERY serverless-cold-instance reconnect —
    // seconds of pure overhead per `ls -la`).
    await sandbox.files.write(ONYX_MD_STAMP_PATH, String(AGENT_MD_VERSION));
  } catch {
    // best-effort — file may already exist or write may fail
  }

  // MASTER SKILL LIBRARY (user request 2026-10-19): attach the whole
  // 55-skill library zip to EVERY fresh sandbox — extracted over
  // /home/user/skills/ with MASTER-INDEX.md at its root. The AI's fixed
  // startup rule (Onyx.md + system prompt) reads that index and picks
  // skills BY NAME. Best-effort: a failed attach logs and continues; the
  // version-gate paths in getSandbox retry on the next use.
  await attachMasterSkills(sandbox);

  const key = cacheKey(apiKey, conversationId, mode);
  const entry: CacheEntry = {
    sandbox,
    apiKey,
    createdAt: Date.now(),
    key,
    verifiedAliveAt: Date.now(),
    agentMdVersion: AGENT_MD_VERSION,
    masterSkillsVersion: MASTER_SKILLS_VERSION,
  };
  getCache(mode).set(key, entry);
  return sandbox;
}

async function getSandbox(
  apiKey: string,
  conversationId: string | null,
  mode: "shared" | "separate",
  clientSandboxId?: string | null,
): Promise<Sandbox> {
  const key = cacheKey(apiKey, conversationId, mode);

  // 1. Check the in-memory cache first.
  const cached = lookupCached(apiKey, conversationId, mode);
  if (cached) {
    // PER-CHAT DIVERGENCE GUARD: every call for a per-chat ("separate"
    // mode) sandbox carries the CLIENT's sandboxId — the authoritative
    // per-chat slot (localStorage e2b-sandbox-id:<key>:<conversationId>)
    // that the per-chat tools resolve through. If this server's cache
    // entry for the same key holds a DIFFERENT live sandbox (a rotation
    // whose kill failed, a replaced entry from another flow), preferring
    // the cache would silently point the call at the WRONG (stale)
    // sandbox. For "separate" (per-chat) sandboxes the CLIENT's id wins;
    // the cache is derived state. If the client's id can't be connected
    // (dead), the cached sandbox remains the fallback.
    if (
      clientSandboxId &&
      mode === "separate" &&
      conversationId &&
      cached.sandbox.sandboxId !== clientSandboxId
    ) {
      try {
        const clientSandbox = await Sandbox.connect(clientSandboxId, { apiKey });
        console.log(
          `[sandbox] divergence guard: cache had ${cached.sandbox.sandboxId} but the chat's client says ${clientSandboxId} — following the client (per-chat slot is authoritative)`,
        );
        const clientEntry: CacheEntry = {
          sandbox: clientSandbox,
          apiKey,
          createdAt: Date.now(),
          key,
          verifiedAliveAt: Date.now(),
        };
        getCache(mode).set(key, clientEntry);
        return clientSandbox;
      } catch {
        // The client's id is dead — keep the cached sandbox (it may be a
        // server-side rotation the client hasn't caught up with).
      }
    }
    // ONYX.MD REFRESH: cached sandboxes created before an Onyx.md update
    // still carry the old documentation. Re-write it (best-effort) when the
    // version differs so the AI always reads the current tool compendium +
    // GenUI reference — and purge the legacy agent.md so only one guide
    // exists in the workspace.
    if (cached.agentMdVersion !== AGENT_MD_VERSION) {
      try {
        await cached.sandbox.files.write("/home/user/Onyx.md", ONYX_MD);
        await cached.sandbox.files.remove("/home/user/agent.md");
        cached.agentMdVersion = AGENT_MD_VERSION;
      } catch {
        // best-effort — a dead sandbox falls through the liveness path
      }
    }
    // MASTER SKILL LIBRARY: re-attach when this cached sandbox predates
    // the current library version (stamp-checked inside the sandbox — one
    // tiny file read when already current, no 2MB write).
    if (cached.masterSkillsVersion !== MASTER_SKILLS_VERSION) {
      const res = await ensureMasterSkills(cached.sandbox);
      if (res.attached) cached.masterSkillsVersion = MASTER_SKILLS_VERSION;
    }
    // ROTATION SAFETY NET: if the cached sandbox is >23h old, rotate it
    // (backup → kill → create → restore) before use. The client-side
    // `ensureFreshSandbox` is the primary trigger; this is a fallback for
    // when the client didn't rotate (e.g., user closed the tab for >23h
    // but the server instance is still alive with the cached entry).
    // Without this, the sandbox would be killed by E2B's 24h hard limit
    // and all files would be lost.
    if (Date.now() - cached.createdAt > ROTATION_AGE_MS) {
      console.log(`[sandbox] getSandbox: cached sandbox ${cached.sandbox.sandboxId} is >23h old, rotating...`);
      const { sandbox: rotated } = await performRotation(apiKey, conversationId, mode, clientSandboxId);
      return rotated;
    }
    // Liveness check — if the cached sandbox is dead, evict + fall through
    // to create a new one. Skip the ping if we verified alive in the last
    // 2 minutes (avoids redundant 3s pings on rapid back-to-back calls —
    // the ping was the #2 cause of slow tool execution after the OPFS
    // getFile() issue). If the sandbox dies between checks, the actual
    // operation will fail and the dead-sandbox recovery handles it.
    if (cached.verifiedAliveAt && Date.now() - cached.verifiedAliveAt < 120_000) {
      return cached.sandbox;
    }
    if (await isAlive(cached.sandbox)) {
      cached.verifiedAliveAt = Date.now();
      return cached.sandbox;
    }
    // Dead — evict and fall through.
    evictCacheEntry(mode, key);
  }

  // 2. If the client provided a sandbox ID, try to reconnect to it.
  //    This is critical for Vercel serverless — the server-side cache is
  //    empty on each cold start, so without reconnecting, every request
  //    creates a new sandbox. We TRUST the client's sandboxId (skip the
  //    liveness check) to avoid the 3s ping delay — if the sandbox is dead,
  //    the actual operation will fail and the dead-sandbox recovery will
  //    handle it.
  if (clientSandboxId) {
    try {
      const sandbox = await Sandbox.connect(clientSandboxId, { apiKey });
      const entry: CacheEntry = {
        sandbox,
        apiKey,
        createdAt: Date.now(),
        key,
        verifiedAliveAt: Date.now(), // trust it's alive
      };
      // Reconnected sandboxes may predate the current Onyx.md — refresh it
      // ONLY when the sandbox's own version stamp says so (a ~40-byte read;
      // the old unconditional 44KB write + agent.md remove on every cold
      // reconnect added seconds to every basic command on a fresh serverless
      // instance). Same for the master skill library (stamp-checked — only
      // sandboxes that predate the current library version pay the write +
      // extract).
      const mdCurrent = await ensureOnyxMdCurrent(sandbox);
      if (mdCurrent) entry.agentMdVersion = AGENT_MD_VERSION;
      const msRes = await ensureMasterSkills(sandbox);
      if (msRes.attached) entry.masterSkillsVersion = MASTER_SKILLS_VERSION;
      getCache(mode).set(key, entry);
      return sandbox;
    } catch {
      // Sandbox is dead or doesn't exist — fall through to create a new one.
    }
  }

  // 2.5 METADATA LOOKUP (E2B persistency — reuse the same sandbox instance
  //     across conversation turns / sessions / devices): when the browser
  //     lost its localStorage id (fresh device, cleared storage, another
  //     browser), find this (apiKey, scope, conversation)'s PREVIOUS
  //     sandbox by its creation metadata and reconnect — instead of
  //     cold-creating an empty workspace. Sandbox.connect auto-RESUMES a
  //     paused sandbox, so a workspace frozen by the E2B timeout pause
  //     picks right back up with its full filesystem + RAM state.
  //     Age-guarded (<20h): older ones are near the 24h hard TTL and are
  //     the stale-reclaim's territory.
  try {
    const paginator = Sandbox.list({
      apiKey,
      limit: 20,
      query: { metadata: onyxSandboxMetadata(mode, conversationId) },
    });
    const page = await paginator.nextItems();
    const now = Date.now();
    const candidates = page
      .filter((s) => (s.state as string) !== "closed" && sandboxAgeMs(s, now) < STALE_SANDBOX_KILL_AGE_MS)
      .sort((a, b) => sandboxAgeMs(b, now) - sandboxAgeMs(a, now)); // newest first
    // Prefer RUNNING sandboxes (instant reconnect), then paused ones
    // (auto-resume on connect — full state restored).
    const running = candidates.find((s) => s.state === "running") ?? candidates[0];
    if (running) {
      const sandbox = await Sandbox.connect(running.sandboxId, { apiKey });
      console.log(`[sandbox] metadata lookup: reconnected to previous ${mode} sandbox ${running.sandboxId} (state=${running.state})`);
      const entry: CacheEntry = {
        sandbox,
        apiKey,
        createdAt: Date.now(),
        key,
        verifiedAliveAt: Date.now(),
      };
      const mdCurrent2 = await ensureOnyxMdCurrent(sandbox);
      if (mdCurrent2) entry.agentMdVersion = AGENT_MD_VERSION;
      const msRes2 = await ensureMasterSkills(sandbox);
      if (msRes2.attached) entry.masterSkillsVersion = MASTER_SKILLS_VERSION;
      getCache(mode).set(key, entry);
      return sandbox;
    }
  } catch {
    // Metadata lookup failed (API blip / SDK list error) — fall through to
    // a fresh create; the previous sandbox is still findable next time.
  }

  // 3. Create a new sandbox.
  return await createAndCacheSandbox(apiKey, conversationId, mode);
}

interface RequestBody {
  apiKey: string;
  action: string;
  args?: Record<string, unknown>;
  conversationId?: string | null;
  sandboxMode?: "shared" | "separate";
  /** Client-provided sandbox ID — if set, the server tries to reconnect
   *  to this sandbox instead of creating a new one. This is critical for
   *  Vercel serverless — each request may hit a different instance with
   *  an empty cache, so without this, every request creates a new sandbox. */
  sandboxId?: string | null;
}

/** Sentinel the client sends when the user has no key stored locally but
 *  the server reported E2B_API_KEY is set in the environment (see GET).
 *  The REAL key never leaves the server — the client only ever holds this
 *  placeholder. */
const ENV_KEY_SENTINEL = "USE_SERVER_ENV";

function resolveApiKey(clientKey: unknown): string {
  const k = typeof clientKey === "string" ? clientKey.trim() : "";
  // Real client-held key (vault/localStorage) wins.
  if (k && k !== ENV_KEY_SENTINEL) return k;
  // Otherwise fall back to the server's env key when configured.
  const envKey = process.env.E2B_API_KEY?.trim();
  if (envKey) return envKey;
  // Neither — return whatever we got so the SDK surfaces a proper error.
  return k;
}

// GET — capability probe: does the server have E2B_API_KEY configured?
// The client uses this to enable sandbox features (file tools) without the
// key ever crossing the wire.
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ hasEnvKey: !!process.env.E2B_API_KEY?.trim() });
}

export async function POST(req: NextRequest) {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { action, args = {}, conversationId = null, sandboxMode = "shared", sandboxId: clientSandboxId } = body;

  // Resolve the E2B key: client-held key → server env fallback.
  const apiKey = resolveApiKey(body.apiKey);

  if (!apiKey) {
    return NextResponse.json({ error: "Missing apiKey" }, { status: 401 });
  }
  if (!action) {
    return NextResponse.json({ error: "Missing action" }, { status: 400 });
  }

  try {
    switch (action) {
      case "list": {
        const paginator = Sandbox.list({ apiKey, limit: 20 });
        const page = await paginator.nextItems();
        return NextResponse.json({
          items: page.map((s) => ({
            sandboxID: s.sandboxId,
            startedAt: s.startedAt ?? new Date().toISOString(),
            status: s.state,
          })),
        });
      }

      case "create": {
        const sandbox = await getSandbox(apiKey, conversationId, sandboxMode, clientSandboxId);
        return NextResponse.json({ sandboxId: sandbox.sandboxId });
      }

      case "exec": {
        const sandbox = await getSandbox(apiKey, conversationId, sandboxMode, clientSandboxId);
        const command = args.command as string;
        const cwd = (args.cwd as string) ?? DEFAULT_CWD;
        const timeout = (args.timeout as number) ?? 120;
        try {
          const result = await sandbox.commands.run(command, {
            cwd,
            timeoutMs: timeout * 1000,
          });
          return NextResponse.json({
            sandboxId: sandbox.sandboxId,
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
            exit_code: result.exitCode ?? 0,
          });
        } catch (execErr) {
          // DEAD-SANDBOX RECOVERY: if the sandbox died mid-command, evict
          // it from the cache, create a fresh one, and retry the command
          // once. This prevents the user from being stuck with a dead
          // sandbox until the 24h TTL expires.
          if (isDeadSandboxError(execErr)) {
            const key = cacheKey(apiKey, conversationId, sandboxMode);
            evictCacheEntry(sandboxMode, key);
            console.warn(`[sandbox] exec: dead sandbox ${sandbox.sandboxId} evicted, retrying with fresh sandbox...`);
            try {
              const fresh = await createAndCacheSandbox(apiKey, conversationId, sandboxMode);
              const result = await fresh.commands.run(command, {
                cwd,
                timeoutMs: timeout * 1000,
              });
              return NextResponse.json({
                sandboxId: fresh.sandboxId,
                stdout: result.stdout ?? "",
                stderr: result.stderr ?? "",
                exit_code: result.exitCode ?? 0,
              });
            } catch (retryErr) {
              const errMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
              return NextResponse.json({
                sandboxId: null,
                stdout: "",
                stderr: errMsg,
                exit_code: -1,
                error: errMsg,
              });
            }
          }
          // Non-dead-sandbox error — return as-is for the client to handle.
          const errMsg = execErr instanceof Error ? execErr.message : String(execErr);
          return NextResponse.json({
            sandboxId: sandbox.sandboxId,
            stdout: "",
            stderr: errMsg,
            exit_code: -1,
            error: errMsg,
          });
        }
      }

      case "exec_stream": {
        // REAL STREAMING via Server-Sent Events (SSE). The E2B SDK supports
        // onStdout/onStderr callbacks that fire as output is produced — we
        // pipe each chunk to the client as an SSE `data:` line. This is what
        // makes `run_terminal` / `run_python` output appear LIVE instead of
        // all-at-once after the command finishes.
        //
        // SSE format:
        //   data: {"type":"stdout","data":"hello\n"}\n\n
        //   data: {"type":"stderr","data":"error!\n"}\n\n
        //   data: {"type":"result","exit_code":0}\n\n
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            let sandbox: Sandbox;
            try {
              sandbox = await getSandbox(apiKey, conversationId, sandboxMode, clientSandboxId);
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: errMsg })}\n\n`));
              controller.close();
              return;
            }
            const command = args.command as string;
            const cwd = (args.cwd as string) ?? DEFAULT_CWD;
            const timeout = (args.timeout as number) ?? 120;
            // ENV INJECTION (PRD §14): pass the user's env-var VALUES so
            // `$VAR` references in shell commands resolve to real values
            // instead of the variable NAME being echoed.
            const envs = sanitizeEnvs(args.envs);
            const send = (obj: Record<string, unknown>) => {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
            };
            // UNIVERSAL STREAMING: Use `script` to create a PTY (pseudo-terminal)
            // wrapper. This forces ALL programs to think they're connected to a
            // terminal → line-buffering → live streaming for EVERY command.
            //
            // `script -qec 'COMMAND' /dev/null` creates a PTY for the ENTIRE
            // command string. All shell operators (|, &&, ;, >, 2>&1) work
            // because the command is passed to $SHELL -c.
            //
            // NOTE: `script` merges stdout+stderr into one PTY stream, so
            // onStderr never fires — all output comes through onStdout. This
            // is fine for display purposes (the live output box shows everything).
            //
            //   -q  = quiet (no start/end messages)
            //   -e  = return the exit code of the command
            //   -c  = run command (passed to $SHELL -c, so operators work)
            //   /dev/null = discard the typescript file
            const escapedCommand = command.replace(/'/g, "'\\''");
            const ptyCommand = `script -qec '${escapedCommand}' /dev/null`;

            // STATEFUL ANSI STRIPPER: Escape sequences can be split across
            // chunks (the PTY emits them in small pieces). A naive per-chunk
            // regex would leave fragments like "[1G" when ESC is in one chunk
            // and "[1G" is in the next. This stateful stripper buffers
            // incomplete escape sequences and only emits clean text.
            let ansiBuffer = "";
            const stripAnsiStream = (s: string): string => {
              ansiBuffer += s;
              // Remove complete ANSI escape sequences:
              // CSI: ESC [ ... letter (e.g. ESC[1G, ESC[0K, ESC[32m)
              // OSC: ESC ] ... BEL or ESC ] ... ESC \
              // Other: ESC =, ESC >, ESC M, etc.
              // Also remove bare ESC characters left over from split sequences.
              ansiBuffer = ansiBuffer
                .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "")   // CSI
                .replace(/\x1b\][^\x07]*\x07/g, "")             // OSC (BEL-terminated)
                .replace(/\x1b\][^\x1b]*\x1b\\/g, "")           // OSC (ST-terminated)
                .replace(/\x1b[=>NMcD]/g, "")                   // Simple escapes
                .replace(/\x1b\([AB0]/g, "")                    // Charset designation
                .replace(/\x1b/g, "");                           // Bare ESC (cleanup)
              return ansiBuffer;
            };

            let promptDetected = false;
            // Detect interactive prompts like "Ok to proceed? (y)",
            // "[Y/n]", "Enter password:", "Continue? (y/N)", etc.
            const PROMPT_RE = /\b(ok to proceed\?\s*\(.*?\)|\(y\/n\)|\(y\/N\)|\(Y\/n\)|\(Y\/N\)|\[y\/n\]|\[Y\/N\]|continue\?\s*\(.*?\)|are you sure\?\s*\(.*?\)|enter password:|username:|>\s*$|:\s*$)/i;

            try {
              await sandbox.commands.run(ptyCommand, {
                cwd,
                envs,
                timeoutMs: timeout * 1000,
                onStdout: (data: string) => {
                  // `script` merges stdout+stderr → all output comes here.
                  const clean = stripAnsiStream(data);
                  if (clean) {
                    send({ type: "stdout", data: clean });
                    if (PROMPT_RE.test(clean) && !promptDetected) {
                      promptDetected = true;
                      send({ type: "prompt", prompt: clean.trim() });
                    }
                  }
                },
                onStderr: (data: string) => {
                  // Rarely fires with `script` (merged into stdout), but
                  // handle it just in case.
                  const clean = stripAnsiStream(data);
                  if (clean) {
                    send({ type: "stderr", data: clean });
                    if (PROMPT_RE.test(clean) && !promptDetected) {
                      promptDetected = true;
                      send({ type: "prompt", prompt: clean.trim() });
                    }
                  }
                },
              });
              // Flush any remaining ANSI buffer.
              if (ansiBuffer) {
                send({ type: "stdout", data: ansiBuffer });
                ansiBuffer = "";
              }
              send({ type: "result", exit_code: 0, sandboxId: sandbox.sandboxId });
            } catch (execErr) {
              if (isDeadSandboxError(execErr)) {
                const key = cacheKey(apiKey, conversationId, sandboxMode);
                evictCacheEntry(sandboxMode, key);
                try {
                  const fresh = await createAndCacheSandbox(apiKey, conversationId, sandboxMode, envs);
                  await fresh.commands.run(ptyCommand, {
                    cwd,
                    envs,
                    timeoutMs: timeout * 1000,
                    onStdout: (data: string) => send({ type: "stdout", data }),
                    onStderr: (data: string) => send({ type: "stderr", data }),
                  });
                  send({ type: "result", exit_code: 0, sandboxId: fresh.sandboxId });
                } catch (retryErr) {
                  const errMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                  send({ type: "error", error: errMsg });
                }
              } else {
                const errMsg = execErr instanceof Error ? execErr.message : String(execErr);
                send({ type: "error", error: errMsg });
              }
            }
            controller.close();
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            // CRITICAL for Vercel: without `x-vercel-no-buffering: 1`, Vercel's
            // serverless platform buffers the entire response and only flushes
            // when the function completes — defeating the point of SSE. This
            // header tells Vercel's proxy to stream chunks as they arrive.
            "x-vercel-no-buffering": "1",
            // Disable Next.js response buffering too.
            "x-accel-buffering": "no",
          },
        });
      }

      case "run_python_stream": {
        // REAL STREAMING for Python via SSE. Uses the code-interpreter's
        // runCode with onStdout/onStderr (if available) or falls back to
        // the shell `python3 -c` with streaming.
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            let sandbox: Sandbox;
            try {
              sandbox = await getSandbox(apiKey, conversationId, sandboxMode, clientSandboxId);
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: errMsg })}\n\n`));
              controller.close();
              return;
            }
            const code = args.code as string;
            const timeout = (args.timeout as number) ?? 60;
            // ENV INJECTION (PRD §14) — same rationale as exec_stream.
            const envs = sanitizeEnvs(args.envs);
            const send = (obj: Record<string, unknown>) => {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
            };
            try {
              // Try the code-interpreter's runCode with streaming callbacks.
              //
              // CRITICAL: The E2B code-interpreter SDK's `runCode` method
              // invokes onStdout/onStderr with an `OutputMessage` OBJECT
              // ({ line: string, timestamp: string, error: boolean }), NOT
              // a plain string. Previously the callback was typed as
              // `(data: string) => void` which lied to TypeScript — at
              // runtime, `data` was the object, and `send({ type: "stdout",
              // data })` serialized it as `{"line":"...","timestamp":"..."}`.
              // The client then did `stdout += chunk.data` which concatenated
              // the object → became `"[object Object]"`. The actual Python
              // output only appeared at the very END via trailing logs
              // (exec.logs.stdout.join), so Python NEVER streamed live — it
              // all appeared at once at completion. This is the root cause
              // of "python 3 isn't getting [streaming]".
              //
              // FIX: Extract `.line` from the OutputMessage object before
              // sending it through the SSE stream.
              const exec = await (sandbox as unknown as {
                runCode: (
                  code: string,
                  opts?: {
                    timeoutMs?: number;
                    envs?: Record<string, string>;
                    onStdout?: (msg: { line: string; timestamp?: string; error?: boolean }) => void;
                    onStderr?: (msg: { line: string; timestamp?: string; error?: boolean }) => void;
                  },
                ) => Promise<{
                  logs: { stdout?: string[]; stderr?: string[] };
                  error?: { value?: string };
                }>;
              }).runCode(code, {
                timeoutMs: timeout * 1000,
                envs,
                onStdout: (msg) => {
                  // Extract the actual output line from the OutputMessage
                  // object. The SDK passes { line, timestamp, error }.
                  // Handle both object and string (for robustness).
                  const line = typeof msg === "string" ? msg : (msg?.line ?? "");
                  if (line) send({ type: "stdout", data: line });
                },
                onStderr: (msg) => {
                  const line = typeof msg === "string" ? msg : (msg?.line ?? "");
                  if (line) send({ type: "stderr", data: line });
                },
              });
              // Send any remaining buffered logs (some templates only emit
              // logs at the end, not via callbacks).
              const trailingStdout = (exec.logs.stdout ?? []).join("\n");
              const trailingStderr = exec.error?.value ?? (exec.logs.stderr ?? []).join("\n");
              if (trailingStdout) send({ type: "stdout", data: trailingStdout });
              if (trailingStderr) send({ type: "stderr", data: trailingStderr });
              send({ type: "result", exit_code: exec.error ? 1 : 0, sandboxId: sandbox.sandboxId });
            } catch (_pyErr) {
              // Fallback: python3 -c with PTY streaming via `script` so
              // print() output flushes immediately (line-buffering).
              try {
                const escaped = code.replace(/'/g, "'\\''");
                await sandbox.commands.run(`script -qec 'python3 -c '\''${escaped}'\''' /dev/null`, {
                  cwd: DEFAULT_CWD,
                  timeoutMs: timeout * 1000,
                  onStdout: (data: string) => send({ type: "stdout", data }),
                  onStderr: (data: string) => send({ type: "stderr", data }),
                });
                send({ type: "result", exit_code: 0, sandboxId: sandbox.sandboxId });
              } catch (fallbackErr) {
                if (isDeadSandboxError(fallbackErr)) {
                  const key = cacheKey(apiKey, conversationId, sandboxMode);
                  evictCacheEntry(sandboxMode, key);
                  try {
                    const fresh = await createAndCacheSandbox(apiKey, conversationId, sandboxMode);
                    const escaped = code.replace(/'/g, "'\\''");
                    await fresh.commands.run(`script -qec 'python3 -c '\''${escaped}'\''' /dev/null`, {
                      cwd: DEFAULT_CWD,
                      timeoutMs: timeout * 1000,
                      onStdout: (data: string) => send({ type: "stdout", data }),
                      onStderr: (data: string) => send({ type: "stderr", data }),
                    });
                    send({ type: "result", exit_code: 0, sandboxId: fresh.sandboxId });
                  } catch (retryErr) {
                    const errMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                    send({ type: "error", error: errMsg });
                  }
                } else {
                  const errMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
                  send({ type: "error", error: errMsg });
                }
              }
            }
            controller.close();
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "x-vercel-no-buffering": "1",
            "x-accel-buffering": "no",
          },
        });
      }

      case "run_python": {
        const sandbox = await getSandbox(apiKey, conversationId, sandboxMode, clientSandboxId);
        const code = args.code as string;
        const timeout = (args.timeout as number) ?? 60;
        try {
          const exec = await (sandbox as unknown as {
            runCode: (
              code: string,
              opts?: { timeoutMs?: number },
            ) => Promise<{
              logs: { stdout?: string[]; stderr?: string[] };
              error?: { value?: string };
            }>;
          }).runCode(code, { timeoutMs: timeout * 1000 });
          const stdout = (exec.logs.stdout ?? []).join("\n");
          const stderr =
            exec.error?.value ?? (exec.logs.stderr ?? []).join("\n");
          return NextResponse.json({
            sandboxId: sandbox.sandboxId,
            stdout,
            stderr,
            exit_code: exec.error ? 1 : 0,
          });
        } catch (_pyErr) {
          // First failure — try python3 -c as fallback (works if the sandbox
          // is alive but runCode's Jupyter kernel crashed).
          try {
            const result = await sandbox.commands.run(
              `python3 -c '${code.replace(/'/g, "'\\''")}'`,
              { cwd: DEFAULT_CWD, timeoutMs: timeout * 1000 },
            );
            return NextResponse.json({
              sandboxId: sandbox.sandboxId,
              stdout: result.stdout ?? "",
              stderr: result.stderr ?? "",
              exit_code: result.exitCode ?? 0,
            });
          } catch (fallbackErr) {
            // DEAD-SANDBOX RECOVERY: both runCode and the shell fallback
            // failed — this is almost certainly a dead sandbox. Evict +
            // create fresh + retry the shell fallback.
            if (isDeadSandboxError(fallbackErr)) {
              const key = cacheKey(apiKey, conversationId, sandboxMode);
              evictCacheEntry(sandboxMode, key);
              console.warn(`[sandbox] run_python: dead sandbox ${sandbox.sandboxId} evicted, retrying with fresh sandbox...`);
              try {
                const fresh = await createAndCacheSandbox(apiKey, conversationId, sandboxMode);
                const result = await fresh.commands.run(
                  `python3 -c '${code.replace(/'/g, "'\\''")}'`,
                  { cwd: DEFAULT_CWD, timeoutMs: timeout * 1000 },
                );
                return NextResponse.json({
                  sandboxId: fresh.sandboxId,
                  stdout: result.stdout ?? "",
                  stderr: result.stderr ?? "",
                  exit_code: result.exitCode ?? 0,
                });
              } catch (retryErr) {
                const errMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                return NextResponse.json({
                  sandboxId: null,
                  stdout: "",
                  stderr: errMsg,
                  exit_code: -1,
                  error: errMsg,
                });
              }
            }
            // Non-dead-sandbox error.
            const errMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
            return NextResponse.json({
              sandboxId: sandbox.sandboxId,
              stdout: "",
              stderr: errMsg,
              exit_code: -1,
              error: errMsg,
            });
          }
        }
      }

      case "list_files": {
        const sandbox = await getSandbox(apiKey, conversationId, sandboxMode, clientSandboxId);
        try {
          const path = normalizePath(args.path as string);
          const entries = await sandbox.files.list(path);
          return NextResponse.json({
            sandboxId: sandbox.sandboxId,
            items: entries.map((e) => ({
              path: e.path,
              // The E2B SDK returns type as "file" or "dir" (lowercase 3-letter).
              // Also handle "directory" and "FILE_TYPE_DIRECTORY" for safety.
              type:
                (e.type as string) === "dir" ||
                (e.type as string) === "directory" ||
                (e.type as string) === "FILE_TYPE_DIRECTORY"
                  ? "directory"
                  : "file",
              name: e.name,
              size: e.size,
            })),
          });
        } catch (err) {
          if (isDeadSandboxError(err)) {
            const key = cacheKey(apiKey, conversationId, sandboxMode);
            evictCacheEntry(sandboxMode, key);
            const fresh = await createAndCacheSandbox(apiKey, conversationId, sandboxMode);
            const path = normalizePath(args.path as string);
            const entries = await fresh.files.list(path);
            return NextResponse.json({
              sandboxId: fresh.sandboxId,
              items: entries.map((e) => ({
                path: e.path,
                type:
                  (e.type as string) === "dir" ||
                  (e.type as string) === "directory" ||
                  (e.type as string) === "FILE_TYPE_DIRECTORY"
                    ? "directory"
                    : "file",
                name: e.name,
                size: e.size,
              })),
            });
          }
          throw err;
        }
      }

      case "read_file": {
        const sandbox = await getSandbox(apiKey, conversationId, sandboxMode, clientSandboxId);
        try {
          const path = normalizePath(args.path as string);
          // Read as bytes to avoid UTF-8 corruption of binary files.
          const bytes = await sandbox.files.read(path, { format: "bytes" });
          // Convert to base64 for JSON transport.
          const base64 = Buffer.from(bytes).toString("base64");
          return NextResponse.json({
            sandboxId: sandbox.sandboxId,
            content: base64,
            isBase64: true,
          });
        } catch (err) {
          if (isDeadSandboxError(err)) {
            const key = cacheKey(apiKey, conversationId, sandboxMode);
            evictCacheEntry(sandboxMode, key);
            const fresh = await createAndCacheSandbox(apiKey, conversationId, sandboxMode);
            const path = normalizePath(args.path as string);
            const bytes = await fresh.files.read(path, { format: "bytes" });
            const base64 = Buffer.from(bytes).toString("base64");
            return NextResponse.json({
              sandboxId: fresh.sandboxId,
              content: base64,
              isBase64: true,
            });
          }
          throw err;
        }
      }

      case "write_file": {
        const sandbox = await getSandbox(apiKey, conversationId, sandboxMode, clientSandboxId);
        try {
          const path = normalizePath(args.path as string);
          const content = args.content as string;
          await sandbox.files.write(path, content);
          return NextResponse.json({ sandboxId: sandbox.sandboxId, ok: true });
        } catch (err) {
          if (isDeadSandboxError(err)) {
            const key = cacheKey(apiKey, conversationId, sandboxMode);
            evictCacheEntry(sandboxMode, key);
            const fresh = await createAndCacheSandbox(apiKey, conversationId, sandboxMode);
            const path = normalizePath(args.path as string);
            const content = args.content as string;
            await fresh.files.write(path, content);
            return NextResponse.json({ sandboxId: fresh.sandboxId, ok: true });
          }
          throw err;
        }
      }

      case "batch_write": {
        // PERF: Write N files in ONE HTTP call instead of N separate calls.
        // This is the critical optimization for syncOpfsToSandbox —
        // previously each file was a separate fetch() to /api/sandbox,
        // and with 20 files that was 20 sequential HTTP round-trips
        // (each potentially cold-starting a Vercel serverless function)
        // = 1-2 minutes of blocking before every run_terminal/run_python.
        // Now: 1 HTTP call, sandbox looked up once, all files written
        // sequentially on the server (the E2B SDK doesn't support parallel
        // writes, but the single HTTP round-trip is the big win).
        const sandbox = await getSandbox(apiKey, conversationId, sandboxMode, clientSandboxId);
        const files = (args.files as Array<{ path: string; content: string }>) ?? [];
        const written: string[] = [];
        const errors: Array<{ path: string; error: string }> = [];
        for (const f of files) {
          try {
            const path = normalizePath(f.path);
            await sandbox.files.write(path, f.content);
            written.push(f.path);
          } catch (err) {
            errors.push({
              path: f.path,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return NextResponse.json({
          sandboxId: sandbox.sandboxId,
          ok: true,
          written: written.length,
          errors,
        });
      }

      // ─────────────────────────────────────────────────────────────────────
      // Workspace cloud-sync actions (OnyxBase KV push/retrieve support).
      // These are TRANSPORT actions only — the OnyxBase API key never comes
      // near this route; all KV traffic happens in the browser.
      // ─────────────────────────────────────────────────────────────────────

      case "walk_files": {
        // Recursive enumeration of the workspace with sizes. One SDK call
        // via depth: 64 (deeper than any real workspace tree).
        const sandbox = await getSandbox(apiKey, conversationId, sandboxMode, clientSandboxId);
        let entries: Array<{ path: string; type?: string; size?: number }>;
        try {
          entries = await sandbox.files.list("/home/user", { depth: 64 });
        } catch (err) {
          if (isDeadSandboxError(err)) {
            const key = cacheKey(apiKey, conversationId, sandboxMode);
            evictCacheEntry(sandboxMode, key);
            const fresh = await createAndCacheSandbox(apiKey, conversationId, sandboxMode);
            entries = await fresh.files.list("/home/user", { depth: 64 });
            return NextResponse.json({
              sandboxId: fresh.sandboxId,
              ok: true,
              files: entries
                .filter((e) => !isDirType(e.type))
                .map((e) => ({ path: relFromHome(e.path), size: e.size ?? 0 })),
            });
          }
          throw err;
        }
        return NextResponse.json({
          sandboxId: sandbox.sandboxId,
          ok: true,
          files: entries
            .filter((e) => !isDirType(e.type))
            .map((e) => ({ path: relFromHome(e.path), size: e.size ?? 0 })),
        });
      }

      case "read_files_batch": {
        // Binary-safe batch read: N files → ONE HTTP round-trip, each file
        // returned as base64. The client keeps request batches small enough
        // that the JSON response stays well under serverless body limits.
        const sandbox = await getSandbox(apiKey, conversationId, sandboxMode, clientSandboxId);
        const paths = (args.paths as string[] | undefined) ?? [];
        const files: Array<{ path: string; base64: string; size: number }> = [];
        const errors: Array<{ path: string; error: string }> = [];
        for (const p of paths.slice(0, 200)) {
          try {
            const abs = normalizePath(p);
            const bytes = await sandbox.files.read(abs, { format: "bytes" });
            const b64 = Buffer.from(bytes).toString("base64");
            files.push({ path: p, base64: b64, size: bytes.length });
          } catch (err) {
            errors.push({ path: p, error: err instanceof Error ? err.message : String(err) });
          }
        }
        return NextResponse.json({
          sandboxId: sandbox.sandboxId,
          ok: errors.length === 0,
          files,
          errors,
        });
      }

      case "browser_live_stream": {
        // REALTIME BROWSER VIEW (PRD §2-§4) — an SSE stream of the sandbox
        // browser driver's live cast: `state` events (cursor, action, url,
        // title, tab, booted/closed flags — live.json, rewritten by the
        // driver's publisher thread within ~100ms of any change) and `frame`
        // events (base64 JPEG screencast frames — live.jpg, ~8fps max from
        // the driver's CDP Page.startScreencast, re-read ONLY when the
        // driver bumps frameSeq, so an idle page costs zero frame reads).
        //
        // One long-lived POST per active browser session — the client reads
        // it with fetch + a stream reader (EventSource cannot POST the apiKey
        // body). Ends on client abort, or after BROWSER_LIVE_MAX_MS with a
        // `bye` (the client reconnects while its session is still running).
        const encoder = new TextEncoder();
        const startedAt = Date.now();
        const BROWSER_LIVE_MAX_MS = 6 * 60_000;
        const BROWSER_LIVE_POLL_MS = 300;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            let closed = false;
            const finish = () => {
              if (closed) return;
              closed = true;
              try {
                controller.close();
              } catch {
                /* already closed */
              }
            };
            const send = (event: string, data: unknown) => {
              if (closed) return;
              try {
                controller.enqueue(
                  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
                );
              } catch {
                closed = true;
              }
            };
            // Client abort → stop immediately (the tick loop checks `closed`).
            req.signal.addEventListener("abort", finish);

            void (async () => {
              let sandbox: Sandbox;
              try {
                sandbox = await getSandbox(apiKey, conversationId, sandboxMode, clientSandboxId);
              } catch (err) {
                send("fatal", {
                  error: err instanceof Error ? err.message : String(err),
                });
                finish();
                return;
              }
              send("hello", { sandboxId: sandbox.sandboxId });
              const LIVE_JSON = "/home/user/.onyx/browser/live.json";
              const LIVE_JPG = "/home/user/.onyx/browser/live.jpg";
              let lastSig = "";
              let lastFrameSeq = -1;
              let missStreak = 0;
              let lastBeat = Date.now();

              const tick = async (): Promise<void> => {
                if (closed) return;
                if (Date.now() - startedAt > BROWSER_LIVE_MAX_MS) {
                  send("bye", { reason: "timeout" });
                  finish();
                  return;
                }
                // Periodic heartbeat comment keeps proxies from idling out.
                if (Date.now() - lastBeat > 15_000) {
                  lastBeat = Date.now();
                  if (!closed) {
                    try {
                      controller.enqueue(encoder.encode(`: keepalive\n\n`));
                    } catch {
                      closed = true;
                    }
                  }
                }
                try {
                  const raw = await sandbox.files
                    .read(LIVE_JSON, { format: "text" })
                    .catch(() => null);
                  if (raw && raw.trim()) {
                    missStreak = 0;
                    let state: Record<string, unknown> | null = null;
                    try {
                      state = JSON.parse(raw) as Record<string, unknown>;
                    } catch {
                      state = null;
                    }
                    if (state) {
                      const c = (state.cursor ?? {}) as { x?: unknown; y?: unknown };
                      const sig = [
                        state.seq,
                        state.frameSeq,
                        state.url,
                        state.title,
                        state.action,
                        state.closed,
                        state.booted,
                        c.x,
                        c.y,
                      ].join("|");
                      if (sig !== lastSig) {
                        lastSig = sig;
                        send("state", state);
                      }
                      const frameSeq = typeof state.frameSeq === "number" ? state.frameSeq : -1;
                      if (frameSeq >= 0 && frameSeq !== lastFrameSeq) {
                        lastFrameSeq = frameSeq;
                        const bytes = await sandbox.files
                          .read(LIVE_JPG, { format: "bytes" })
                          .catch(() => null);
                        if (bytes && bytes.length > 0) {
                          send("frame", {
                            frameSeq,
                            b64: Buffer.from(bytes).toString("base64"),
                          });
                        }
                      }
                    }
                  } else {
                    // No live.json yet — the driver is still booting (first
                    // browser action installs + starts it). Tell the client
                    // periodically so it can show the connecting phase.
                    missStreak++;
                    if (missStreak === 1 || missStreak % 33 === 0) {
                      send("waiting", { ms: Date.now() - startedAt });
                    }
                  }
                } catch {
                  // transient read error — keep ticking
                }
                if (!closed) {
                  setTimeout(() => void tick(), BROWSER_LIVE_POLL_MS);
                }
              };
              void tick();
            })();
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "x-vercel-no-buffering": "1",
            "x-accel-buffering": "no",
          },
        });
      }

      case "batch_write_bytes": {
        // Binary-safe batch write: files as [{ path, base64 }]. Directories
        // are created implicitly by the E2B write. Used by cloud restore.
        const sandbox = await getSandbox(apiKey, conversationId, sandboxMode, clientSandboxId);
        const files = (args.files as Array<{ path: string; base64: string }> | undefined) ?? [];
        let written = 0;
        const errors: Array<{ path: string; error: string }> = [];
        for (const f of files.slice(0, 400)) {
          try {
            const abs = normalizePath(f.path);
            const bytes = Buffer.from(f.base64, "base64");
            await sandbox.files.write(abs, new Blob([new Uint8Array(bytes)]));
            written++;
          } catch (err) {
            errors.push({ path: f.path, error: err instanceof Error ? err.message : String(err) });
          }
        }
        return NextResponse.json({
          sandboxId: sandbox.sandboxId,
          ok: errors.length === 0,
          written,
          errors,
        });
      }

      case "delete_file": {
        const sandbox = await getSandbox(apiKey, conversationId, sandboxMode, clientSandboxId);
        try {
          const path = normalizePath(args.path as string);
          await sandbox.files.remove(path);
          return NextResponse.json({ sandboxId: sandbox.sandboxId, ok: true });
        } catch (err) {
          if (isDeadSandboxError(err)) {
            const key = cacheKey(apiKey, conversationId, sandboxMode);
            evictCacheEntry(sandboxMode, key);
            const fresh = await createAndCacheSandbox(apiKey, conversationId, sandboxMode);
            // On a fresh sandbox, the file doesn't exist — treat as success.
            return NextResponse.json({ sandboxId: fresh.sandboxId, ok: true });
          }
          throw err;
        }
      }

      case "create_folder": {
        const sandbox = await getSandbox(apiKey, conversationId, sandboxMode, clientSandboxId);
        try {
          const path = normalizePath(args.path as string);
          await sandbox.files.makeDir(path);
          return NextResponse.json({ sandboxId: sandbox.sandboxId, ok: true });
        } catch (err) {
          if (isDeadSandboxError(err)) {
            const key = cacheKey(apiKey, conversationId, sandboxMode);
            evictCacheEntry(sandboxMode, key);
            const fresh = await createAndCacheSandbox(apiKey, conversationId, sandboxMode);
            const path = normalizePath(args.path as string);
            await fresh.files.makeDir(path);
            return NextResponse.json({ sandboxId: fresh.sandboxId, ok: true });
          }
          throw err;
        }
      }

      case "search_files": {
        const sandbox = await getSandbox(apiKey, conversationId, sandboxMode, clientSandboxId);
        const query = args.query as string;
        const path = normalizePath(args.path as string);
        try {
          const result = await sandbox.commands.run(
            `grep -rni --include='*' -m 50 '${query.replace(/'/g, "'\\''")}' ${path} 2>/dev/null | head -50`,
            { cwd: DEFAULT_CWD, timeoutMs: 15000 },
          );
          return NextResponse.json({
            sandboxId: sandbox.sandboxId,
            stdout: result.stdout || "(no matches)",
          });
        } catch (err) {
          if (isDeadSandboxError(err)) {
            const key = cacheKey(apiKey, conversationId, sandboxMode);
            evictCacheEntry(sandboxMode, key);
            const fresh = await createAndCacheSandbox(apiKey, conversationId, sandboxMode);
            const result = await fresh.commands.run(
              `grep -rni --include='*' -m 50 '${query.replace(/'/g, "'\\''")}' ${path} 2>/dev/null | head -50`,
              { cwd: DEFAULT_CWD, timeoutMs: 15000 },
            );
            return NextResponse.json({
              sandboxId: fresh.sandboxId,
              stdout: result.stdout || "(no matches)",
            });
          }
          throw err;
        }
      }

      case "kill": {
        const key = cacheKey(apiKey, conversationId, sandboxMode);
        evictCacheEntry(sandboxMode, key);
        return NextResponse.json({ ok: true });
      }

      // ── E2B PERSISTENCY LIFECYCLE (docs.e2b.dev/sandbox/persistence) ──
      // pause/resume freeze and restore the FULL sandbox state — the
      // filesystem AND the RAM (running processes, variables, open
      // connections) — so a workspace survives between sessions with no
      // automatic deletion until it is explicitly killed. Any later
      // Sandbox.connect (resume action, or the next tool call through
      // getSandbox) auto-resumes it in place.

      case "pause": {
        const pauseSandboxId = (args.sandboxId as string) ?? clientSandboxId;
        if (!pauseSandboxId) {
          return NextResponse.json({ error: "Missing sandboxId" }, { status: 400 });
        }
        // Resolve the sandbox first (also auto-resumes a paused one — a
        // no-op here since we're about to pause it).
        let sandbox: Sandbox;
        try {
          sandbox = await Sandbox.connect(pauseSandboxId, { apiKey });
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          return NextResponse.json({ error: `Cannot reach sandbox: ${errMsg}` }, { status: 500 });
        }
        // DETACHED-AGENT GUARD: never pause a sandbox with a live headless
        // agent — the whole point of the detached run is that it keeps
        // working while the user's app is closed. (Second line of defense;
        // the client's pagehide handler already skips flagged sandboxes.)
        try {
          const probe = await sandbox.commands.run(
            `pgrep -f "${RUNNER_PGREP_PATTERN}" >/dev/null 2>&1 && echo RUNNER || echo IDLE`,
            { timeoutMs: 10_000 },
          );
          if ((probe.stdout ?? "").includes("RUNNER")) {
            return NextResponse.json({
              ok: false,
              paused: false,
              reason: "agent-running",
              detail:
                "A detached background agent run is executing in this sandbox — pause skipped so it keeps working while the app is closed.",
            });
          }
        } catch {
          // fall through to the general live-process guard below
        }
        // STARTING-RUN GUARD: the pagehide turn-handoff beacon writes
        // run.json + a "starting" status BEFORE the Python runner boots —
        // pgrep cannot see it yet, and the pause beacon (fired by the same
        // unload) would freeze the run at birth. Skip while the status file
        // says starting/running or the run config is fresh (<3 minutes).
        try {
          const agentState = (await readJsonFile(sandbox, AGENT_STATUS_PATH)) as {
            status?: string;
          } | null;
          const runState = agentState?.status;
          if (runState === "starting" || runState === "running") {
            return NextResponse.json({
              ok: false,
              paused: false,
              reason: "agent-starting",
              detail:
                "A sandbox agent run is starting/running in this sandbox — pause skipped so it can keep working while the app is closed.",
            });
          }
          const ageProbe = await sandbox.commands.run(
            `test -f ${RUN_CONFIG_PATH} && echo $(( $(date +%s) - $(stat -c %Y ${RUN_CONFIG_PATH} 2>/dev/null || echo 0) )) || echo NONE`,
            { timeoutMs: 10_000 },
          );
          const ageSeconds = parseInt((ageProbe.stdout ?? "").trim() || "NaN", 10);
          if (!Number.isNaN(ageSeconds) && ageSeconds >= 0 && ageSeconds < 180) {
            return NextResponse.json({
              ok: false,
              paused: false,
              reason: "run-config-fresh",
              detail:
                "A sandbox agent run was just handed off to this sandbox (config <3min old) — pause skipped so it can start.",
            });
          }
        } catch {
          // fall through — the status probe is best-effort
        }
        // CRON GUARD: scheduled tasks (crontab entries written by
        // schedule_agent_task) must keep firing while the app is closed —
        // pausing the sandbox would freeze the cron daemon and silently kill
        // every schedule. Skip pause whenever Onyx-managed cron entries exist.
        try {
          const cronProbe = await sandbox.commands.run(
            `crontab -l 2>/dev/null | grep -c '/home/user' || true`,
            { timeoutMs: 10_000 },
          );
          const cronEntries = parseInt((cronProbe.stdout ?? "0").trim() || "0", 10);
          if (cronEntries > 0) {
            return NextResponse.json({
              ok: false,
              paused: false,
              reason: "cron-scheduled",
              detail:
                `${cronEntries} scheduled task entry(ies) are installed in this sandbox — pause skipped so the cron daemon keeps firing while the app is closed (sandbox runs up to its 24h window).`,
            });
          }
        } catch {
          // fall through — the cron probe is best-effort
        }
        // LIVE-RUN GUARD: never pause a sandbox with running processes —
        // an in-flight exec would freeze mid-flight. (The E2B timeout
        // pause still applies to it naturally.)
        try {
          const running = await sandbox.commands.list();
          const blocking = running.filter((c) => isBlockingProcess(c));
          if (blocking.length > 0) {
            return NextResponse.json({
              ok: false,
              paused: false,
              reason: "running-commands",
              detail: `${blocking.length} live process(es) on the sandbox — pause skipped so in-flight work keeps going`,
            });
          }
        } catch {
          // FAIL-SAFE (same class as the rotation guard): the live-process
          // check failed, so we CANNOT prove the sandbox is idle — pausing
          // blind could freeze an in-flight command mid-flight. The pause
          // is an optimization (the E2B 1h timeout pause still applies
          // naturally); skipping it when unsure can never destroy work.
          return NextResponse.json({
            ok: false,
            paused: false,
            reason: "guard-unavailable",
            detail: "Could not verify the sandbox is idle (live-process check failed) — pause skipped so possible in-flight work keeps going. The E2B timeout pause still applies.",
          });
        }
        try {
          // keepMemory: true (the default, explicit here) — the FULL memory
          // snapshot is persisted, so resume restores running processes and
          // open connections exactly where they froze.
          const paused = await Sandbox.pause(pauseSandboxId, { apiKey, keepMemory: true });
          // Release this instance's handle (the paused sandbox is
          // preserved server-side; the next connect auto-resumes it).
          dropCacheEntriesForSandbox(pauseSandboxId);
          console.log(`[sandbox] paused ${pauseSandboxId} (full state preserved: filesystem + RAM)`);
          return NextResponse.json({ ok: true, paused, sandboxId: pauseSandboxId });
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          return NextResponse.json({ error: `Pause failed: ${errMsg}` }, { status: 500 });
        }
      }

      case "resume": {
        const resumeSandboxId = (args.sandboxId as string) ?? clientSandboxId;
        if (!resumeSandboxId) {
          return NextResponse.json({ error: "Missing sandboxId" }, { status: 400 });
        }
        try {
          // Sandbox.connect on a PAUSED sandbox auto-resumes it — the full
          // memory snapshot is restored in place (processes continue where
          // they froze).
          const sandbox = await Sandbox.connect(resumeSandboxId, { apiKey });
          try {
            // Fresh window on resume (the timeout countdown resets after
            // each pause/resume cycle per the E2B lifecycle). Try the 24h
            // persistent-agent window first; tiers that cap lower take the
            // 1h fallback — with pause+autoResume neither loses state.
            try {
              await sandbox.setTimeout(SANDBOX_TIMEOUT_MS);
            } catch {
              await sandbox.setTimeout(SANDBOX_TIMEOUT_FALLBACK_MS).catch(() => {});
            }
          } catch {
            // best-effort
          }
          console.log(`[sandbox] resumed ${resumeSandboxId}`);
          return NextResponse.json({ ok: true, resumed: true, sandboxId: sandbox.sandboxId });
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          return NextResponse.json({ error: `Resume failed: ${errMsg}` }, { status: 500 });
        }
      }

      case "lifecycle_status": {
        // List this account's Onyx sandboxes with their lifecycle state
        // (running | paused) — powers the Settings → E2B lifecycle UI.
        try {
          const paginator = Sandbox.list({ apiKey, limit: 20 });
          const page = await paginator.nextItems();
          const now = Date.now();
          const sandboxes = page
            .filter((s) => (s.state as string) !== "closed")
            .map((s) => {
              const m = s.metadata as Record<string, string> | string | null | undefined;
              let meta: Record<string, string> = {};
              try {
                meta = typeof m === "string" ? (JSON.parse(m) as Record<string, string>) : (m ?? {});
              } catch {
                meta = {};
              }
              return {
                sandboxId: s.sandboxId,
                state: s.state as string,
                startedAt: s.startedAt instanceof Date ? s.startedAt.toISOString() : String(s.startedAt ?? ""),
                ageMs: sandboxAgeMs(s, now),
                scope: typeof meta["onyx-scope"] === "string" ? meta["onyx-scope"] : null,
                conversationId:
                  typeof meta["onyx-conversation"] === "string" && meta["onyx-conversation"]
                    ? meta["onyx-conversation"]
                    : null,
              };
            });
          return NextResponse.json({ ok: true, sandboxes });
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          return NextResponse.json({ error: errMsg }, { status: 500 });
        }
      }

      case "keepalive": {
        // Keepalive ping — touches the sandbox to reset the inactivity
        // timer AND (critically) extends the E2B 1h timeout window via an
        // explicit setTimeout. Without the setTimeout a mere ping does NOT
        // push the pause deadline out, so an interactive session's sandbox
        // still auto-paused at the 1h mark — and the user's next `ls -la`
        // paid a full auto-resume (tens of seconds) before the first byte
        // (the "basic commands take 2-5 minutes" report).
        const sandbox = await getSandbox(apiKey, conversationId, sandboxMode, clientSandboxId);
        // Reset the timeout window (per the E2B lifecycle the explicit
        // setTimeout restarts the countdown; the limit resets after each
        // cycle). 24h persistent-agent window with a 1h tier fallback.
        try {
          await sandbox.setTimeout(SANDBOX_TIMEOUT_MS);
        } catch {
          try {
            await sandbox.setTimeout(SANDBOX_TIMEOUT_FALLBACK_MS);
          } catch {
            // best-effort — the liveness touch below still helps
          }
        }
        // Touch the sandbox by listing /home/user (cheap operation).
        const alive = await isAlive(sandbox);
        if (!alive) {
          // Sandbox is dead — evict + create a fresh one so the next real
          // action doesn't have to pay the recovery cost.
          const key = cacheKey(apiKey, conversationId, sandboxMode);
          evictCacheEntry(sandboxMode, key);
          const fresh = await createAndCacheSandbox(apiKey, conversationId, sandboxMode);
          return NextResponse.json({
            ok: true,
            sandboxId: fresh.sandboxId,
            timestamp: Date.now(),
            recovered: true,
          });
        }
        return NextResponse.json({
          ok: true,
          sandboxId: sandbox.sandboxId,
          timestamp: Date.now(),
        });
      }

      // ── DETACHED SANDBOX AGENT ("close and resume") ──────────────────────
      // The orchestration loop runs INSIDE the sandbox as a nohup-detached
      // Python process (headless_runner.py). The browser only starts it and
      // syncs the results from chat_history.json / agent_status.json when
      // the user returns — closing the app does NOT stop the run (the E2B
      // sandbox keeps executing for up to 24h on E2B's cloud).

      case "agent_deploy": {
        const sandbox = await getSandbox(apiKey, conversationId, sandboxMode, clientSandboxId);
        await deployHeadlessRunner(sandbox);
        return NextResponse.json({
          sandboxId: sandbox.sandboxId,
          deployed: true,
          version: HEADLESS_RUNNER_VERSION,
        });
      }

      case "agent_start": {
        const sandbox = await getSandbox(apiKey, conversationId, sandboxMode, clientSandboxId);
        // 24H WINDOW FROM RUN START — without this the run inherits whatever
        // window remained (a sandbox created hours ago, or a 1h tier cap)
        // and E2B auto-pauses it mid-run while the user is away (the "came
        // back and it was paused" report, 2026-10-22). The E2B lifecycle
        // resets the countdown on each explicit setTimeout.
        try {
          await sandbox.setTimeout(SANDBOX_TIMEOUT_MS);
        } catch {
          await sandbox.setTimeout(SANDBOX_TIMEOUT_FALLBACK_MS).catch(() => {});
        }
        // Config arrives as a pre-serialized JSON string (the client builds
        // it; the server never re-shapes it — one source of truth).
        const configRaw = typeof args.config === "string" ? args.config : JSON.stringify(args.config ?? null);
        let config: Record<string, unknown>;
        try {
          config = JSON.parse(configRaw) as Record<string, unknown>;
        } catch {
          return NextResponse.json({ error: "Run config is not valid JSON" }, { status: 400 });
        }
        if (!config || typeof config.prompt !== "string" || !config.prompt.trim()) {
          return NextResponse.json({ error: "Run config is missing the prompt" }, { status: 400 });
        }
        if (typeof config.chat_url !== "string" || !/^https?:\/\//.test(config.chat_url)) {
          return NextResponse.json({ error: "Run config is missing a valid chat_url" }, { status: 400 });
        }
        // Deploy (version-stamped, cheap when current) BEFORE launching.
        await deployHeadlessRunner(sandbox);
        try {
          await sandbox.files.write(RUN_CONFIG_PATH, configRaw);
          // The config carries the provider API key — keep it private to
          // the sandbox user.
          await sandbox.commands.run(`chmod 600 ${RUN_CONFIG_PATH}`).catch(() => {});
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return NextResponse.json({ error: `Failed to write the run config: ${errMsg}` }, { status: 500 });
        }
        // Initial status so the very first poll (before Python even boots)
        // sees an honest "starting".
        try {
          const starting = {
            status: "starting",
            stage: "starting",
            run_id: typeof config.run_id === "string" ? config.run_id : "",
            last_update: Date.now(),
            started_at: Date.now(),
            finished_at: null,
            error: null,
          };
          await sandbox.files.write(AGENT_STATUS_PATH, JSON.stringify(starting, null, 2));
        } catch {
          // best-effort — the runner overwrites this within a second
        }
        try {
          // DETACHED LAUNCH: nohup + & — the command returns immediately
          // while the runner keeps executing inside the sandbox (proven by
          // the sandbox browser driver, browser-session.ts).
          const result = await sandbox.commands.run(
            `nohup python3 ${RUNNER_PATH} > ${BACKGROUND_LOG_PATH} 2>&1 & echo started`,
            { cwd: DEFAULT_CWD, timeoutMs: 15_000 },
          );
          const started = (result.stdout ?? "").includes("started") && (result.exitCode ?? 0) === 0;
          console.log(`[sandbox] headless agent launched (sandbox=${sandbox.sandboxId}, started=${started})`);
          return NextResponse.json({ sandboxId: sandbox.sandboxId, started });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return NextResponse.json({ error: `Failed to launch the runner: ${errMsg}` }, { status: 500 });
        }
      }

      case "agent_status": {
        const sandbox = await getSandbox(apiKey, conversationId, sandboxMode, clientSandboxId);
        const includeHistory = args.include_history === true;
        const status = await readJsonFile(sandbox, AGENT_STATUS_PATH);
        const history = includeHistory
          ? ((await readJsonFile(sandbox, CHAT_HISTORY_PATH)) as unknown[] | null)
          : null;
        const sandboxTodos = await readJsonFile(sandbox, SANDBOX_TODOS_PATH);
        // Log tail (bounded) for the live strip.
        let logTail: string | null = null;
        try {
          const tail = await sandbox.commands.run(
            `tail -c 4096 ${BACKGROUND_LOG_PATH} 2>/dev/null || true`,
            { cwd: DEFAULT_CWD, timeoutMs: 15_000 },
          );
          logTail = (tail.stdout ?? "").trim() || null;
        } catch {
          // best-effort
        }
        // Runner liveness (bracket pattern never matches the probe itself).
        let runnerAlive = false;
        try {
          const probe = await sandbox.commands.run(
            `pgrep -f "${RUNNER_PGREP_PATTERN}" >/dev/null 2>&1 && echo 1 || echo 0`,
            { cwd: DEFAULT_CWD, timeoutMs: 15_000 },
          );
          runnerAlive = (probe.stdout ?? "").trim() === "1";
        } catch {
          // best-effort
        }
        return NextResponse.json({
          sandboxId: sandbox.sandboxId,
          status,
          history: Array.isArray(history) ? history : null,
          logTail,
          sandboxTodos: Array.isArray(sandboxTodos) ? sandboxTodos : null,
          runnerAlive,
        });
      }

      case "agent_stop": {
        const sandbox = await getSandbox(apiKey, conversationId, sandboxMode, clientSandboxId);
        try {
          await sandbox.commands.run(`pkill -f "${RUNNER_PGREP_PATTERN}" 2>/dev/null; echo done`, {
            cwd: DEFAULT_CWD,
            timeoutMs: 15_000,
          });
        } catch {
          // best-effort — the runner may already be gone
        }
        // Record the stop so a later sync doesn't wait on "running" forever.
        try {
          const stopped = {
            status: "stopped",
            stage: "stopped",
            last_update: Date.now(),
            finished_at: Date.now(),
            error: null,
          };
          await sandbox.files.write(AGENT_STATUS_PATH, JSON.stringify(stopped, null, 2));
        } catch {
          // best-effort
        }
        console.log(`[sandbox] headless agent stopped (sandbox=${sandbox.sandboxId})`);
        return NextResponse.json({ sandboxId: sandbox.sandboxId, ok: true });
      }

      case "backup_files": {
        // Download ALL files from the sandbox at /home/user (recursive) so
        // the client can save them to OPFS as a backup. Returns a JSON
        // object: { files: [{ path, content, isBase64 }] }.
        // NO file size limit — back up ALL files (code, images, etc.).
        // Binary files are returned as base64 to avoid UTF-8 corruption.
        const sandbox = await getSandbox(apiKey, conversationId, sandboxMode, clientSandboxId);
        const files: Array<{ path: string; content: string; isBase64?: boolean }> = [];

        async function walkDir(dirPath: string) {
          try {
            const entries = await sandbox.files.list(dirPath);
            for (const entry of entries) {
              const entryPath = entry.path;
              if ((entry.type as string) === "dir" || (entry.type as string) === "directory" || (entry.type as string) === "FILE_TYPE_DIRECTORY" || (entry.type as string) === "dir") {
                // Recurse into subdirectories
                await walkDir(entryPath);
              } else {
                // Read file content as bytes to avoid UTF-8 corruption.
                try {
                  const bytes = await sandbox.files.read(entryPath, { format: "bytes" });
                  // NO size limit — back up ALL files regardless of size.
                  // Convert to base64 for safe JSON transport.
                  const base64 = Buffer.from(bytes).toString("base64");
                  files.push({ path: entryPath, content: base64, isBase64: true });
                } catch {
                  // skip unreadable files (binary, too large, etc.)
                }
              }
            }
          } catch {
            // directory listing failed — skip
          }
        }

        await walkDir(DEFAULT_CWD);
        return NextResponse.json({ sandboxId: sandbox.sandboxId, files, count: files.length });
      }

      case "backup_all": {
        // Recursively walk /home/user and return ALL files as
        // { path, base64 } pairs (BINARY-SAFE — every file, including
        // images/archives, is base64-encoded; only volatile shell-state
        // dotfiles are skipped).
        //
        // Used by the auto-rotation system to migrate files to a new sandbox.
        const sandbox = await getSandbox(apiKey, conversationId, sandboxMode, clientSandboxId);
        const files = await backupAllFilesFromSandbox(sandbox);
        return NextResponse.json({
          sandboxId: sandbox.sandboxId,
          files,
          count: files.length,
        });
      }

      case "rotate": {
        // Atomic sandbox rotation: backup → kill old → create → restore.
        // Called by the client-side `ensureFreshSandbox` rotation loop
        // (every 50 min — before E2B's 1h timeout window ends).
        //
        // The client sends its CURRENT sandbox ID in `sandboxId`, so a
        // serverless cold start (empty server-side cache) still finds and
        // backs up the old sandbox before replacing it. The rotation is
        // TRANSPARENT — the new sandbox has the SAME files as the old one
        // (ALL files, binary included). Tools don't know it happened; they
        // just see the new sandboxId on the next call.
        //
        // Returns { sandboxId, backedUp, restored, rotated, skipped? } —
        // `skipped: "running-commands"` means a live process (or an
        // in-flight exec) blocked the rotation and the SAME sandbox was
        // returned untouched (it auto-pauses at the E2B timeout and
        // auto-resumes on the next use instead of being killed).
        const { sandbox, backedUp, restored, skipped } = await performRotation(
          apiKey,
          conversationId,
          sandboxMode,
          clientSandboxId,
        );
        return NextResponse.json({
          sandboxId: sandbox.sandboxId,
          backedUp,
          restored,
          rotated: !skipped,
          ...(skipped ? { skipped } : {}),
        });
      }

      case "restore_files": {
        // Upload a backup (from OPFS) to the sandbox. The client sends
        // { files: [{ path, content }] } and we write each file.
        const sandbox = await getSandbox(apiKey, conversationId, sandboxMode, clientSandboxId);
        const backupFiles = (args.files as Array<{ path: string; content: string }>) ?? [];
        let restored = 0;
        for (const f of backupFiles) {
          try {
            await sandbox.files.write(f.path, f.content);
            restored++;
          } catch {
            // skip files that fail to write
          }
        }
        return NextResponse.json({ sandboxId: sandbox.sandboxId, ok: true, restored });
      }

      case "list_sandboxes": {
        // List all running sandboxes on the E2B account (via the SDK paginator).
        const paginator = Sandbox.list({ apiKey, limit: 20 });
        const page = await paginator.nextItems();
        return NextResponse.json({
          sandboxes: page.map((s) => ({
            sandboxID: s.sandboxId,
            startedAt: s.startedAt ?? new Date().toISOString(),
            state: s.state,
            templateID: s.templateId,
          })),
        });
      }

      case "reset": {
        // Kill the current cached sandbox + remove from cache. The next
        // operation will create a fresh sandbox with empty files.
        const key = cacheKey(apiKey, conversationId, sandboxMode);
        const entry = evictCacheEntry(sandboxMode, key);
        if (entry) {
          return NextResponse.json({ ok: true, killed: entry.sandbox.sandboxId });
        }
        return NextResponse.json({ ok: true, killed: null });
      }

      case "restart": {
        // Kill the current cached sandbox, then create a new one immediately.
        // Also restores files from the backup provided in args.backupFiles
        // (if any — the client sends the OPFS backup so files survive restart).
        const key = cacheKey(apiKey, conversationId, sandboxMode);
        evictCacheEntry(sandboxMode, key);
        // Force-create a new sandbox by bypassing the cache lookup.
        const sandbox = await createAndCacheSandbox(apiKey, conversationId, sandboxMode);
        // Restore backup files if provided.
        const backupFiles = (args.backupFiles as Array<{ path: string; content: string }>) ?? [];
        let restored = 0;
        for (const f of backupFiles) {
          try {
            await sandbox.files.write(f.path, f.content);
            restored++;
          } catch {}
        }
        return NextResponse.json({
          ok: true,
          sandboxId: sandbox.sandboxId,
          restored,
        });
      }

      case "kill_all": {
        // Kill ALL cached sandboxes for this API key (both shared + separate).
        // Used when the user switches sandbox allocation mode — the old
        // sandboxes' file systems are lost and fresh ones are created on the
        // next operation in the new mode.
        const killed: string[] = [];
        for (const [k, entry] of sharedCache.entries()) {
          if (k.startsWith(apiKey)) {
            killed.push(entry.sandbox.sandboxId);
            sharedCache.delete(k);
            void entry.sandbox.kill().catch(() => {});
          }
        }
        for (const [k, entry] of separateCache.entries()) {
          if (k.startsWith(apiKey)) {
            killed.push(entry.sandbox.sandboxId);
            separateCache.delete(k);
            void entry.sandbox.kill().catch(() => {});
          }
        }
        return NextResponse.json({ ok: true, killed });
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 },
        );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = /auth|401|403|invalid/i.test(msg) ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

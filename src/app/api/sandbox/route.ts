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
// FULL agent.md (tool guide + complete GenUI reference) bundled as a module
// so it ships with the serverless bundle — the system prompt tells the AI
// to read the "Generative UI (GenUI)" section from this file, so the sandbox
// MUST receive the full document, not a short stub.
import { AGENT_MD } from "@/lib/agent/agent-md";
// Background agent runner (see src/lib/e2b/bg-agent-script.ts) — the
// self-contained script executed INSIDE the sandbox as a background command.
import { BG_AGENT_SCRIPT, BG_SCRIPT_PATH, BG_STATE_PATH, BG_RUNS_PREFIX } from "@/lib/e2b/bg-agent-script";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_CWD = "/home/user";
const SANDBOX_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours — files persist for a full day
// ROTATION: E2B sandboxes have a 24h hard TTL. We rotate at 23h to avoid
// hitting the limit (backup → kill → create → restore). The client-side
// `ensureFreshSandbox` in `src/lib/e2b/sandbox-rotation.ts` is the primary
// trigger; the server-side check in `getSandbox` is a safety net for when
// the client-side rotation didn't run (e.g., user closed the tab for >23h
// but the server instance is still alive with the cached entry).
const ROTATION_AGE_MS = 23 * 60 * 60 * 1000; // 23 hours
// SHARED SANDBOX ARCHITECTURE: ONE sandbox per API key — the E2B sandbox is
// the SINGLE source of truth for files (no OPFS). When the sandbox quota is
// exceeded (e.g. "20/20"), we kill ALL sandboxes on the account, create ONE
// fresh sandbox, and the file tools repopulate it from scratch.
//
// We keep MAX_SANDBOXES=3 in the local cache as headroom (the shared one
// + maybe a stale entry during dead-sandbox recovery). The quota recovery
// path enforces the "one sandbox" rule on E2B's side by killing orphans.
const MAX_SANDBOXES = 3;

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
  /** Which agent.md version this sandbox received. Bump AGENT_MD_VERSION
   *  whenever agent.md meaningfully changes — cached/reconnected sandboxes
   *  then get the updated documentation on their next use. */
  agentMdVersion?: number;
}

/** Bump when agent.md (→ src/lib/agent/agent-md.ts) changes meaningfully.
 *  Version 2 = the FULL GenUI reference (previously sandboxes received a
 *  short stub with NO GenUI docs at all — the root cause of malformed
 *  `<<<genui>>>` specs). */
const AGENT_MD_VERSION = 2;

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
  void oldest.sandbox.kill().catch(() => {});
  // Also try to kill orphaned sandboxes on E2B's side — these accumulate
  // when sandboxes die without being evicted from our local cache (e.g.
  // Vercel serverless cold starts lose the in-memory cache, but the sandbox
  // keeps running on E2B). This is the root cause of the "20/20 sandbox"
  // quota error. Best-effort — don't block on it.
  void killOrphanedSandboxes(oldest.apiKey).catch(() => {});
}

/**
 * List all running sandboxes on E2B for an API key and kill any that aren't
 * in our local cache. This prevents the "20/20 sandbox limit reached" error
 * that happens when sandboxes accumulate from previous sessions / dead
 * serverless instances. Best-effort — never throws.
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
    // SINGLE-SANDBOX RULE: kill ALL running sandboxes that aren't in our
    // local cache. Previously we kept the 3 most recent (headroom for
    // multi-tab users), but with the E2B-as-source-of-truth architecture
    // we enforce ONE sandbox per API key. Files are backed up before
    // rotation, so killing orphans doesn't lose data — the next operation
    // just creates a fresh sandbox.
    const toKill = page
      .filter((s) => (s.state as string) !== "closed" && !localIds.has(s.sandboxId))
      .sort((a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0));
    await Promise.all(
      toKill.map((s) =>
        Sandbox.kill(s.sandboxId, { apiKey: knownApiKey }).catch(() => {}),
      ),
    );
    if (toKill.length > 0) {
      console.log(`[sandbox] killed ${toKill.length} orphaned sandbox(es) to enforce single-sandbox rule`);
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
  return /quota|limit reached|concurrent|too many|maximum|20\/20|\d+\/\d+/i.test(msg);
}

/**
 * Kill ALL running sandboxes on the account (E2B's side). Used when we hit
 * the quota limit — the shared-sandbox architecture means we only ever need
 * ONE sandbox per API key, so when quota is exceeded we nuke everything and
 * start fresh. OPFS is the source of truth, so no files are lost — the next
 * run_python/run_terminal auto-syncs OPFS to the new sandbox.
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

/**
 * Recursively walk /home/user in a sandbox and return all TEXT files as
 * { path, content } pairs. Used by the `rotate` and `backup_all` actions
 * to migrate files to a new sandbox.
 *
 * - Files >500KB are SKIPPED (too large for JSON transport).
 * - Binary files are SKIPPED (can't JSON-serialize — detected by checking
 *   the first 1KB for null bytes).
 * - Shell dotfiles (.bashrc, .profile, etc.) are skipped — they're
 *   sandbox-template-specific and shouldn't be restored.
 */
async function backupAllFilesFromSandbox(
  sandbox: Sandbox,
): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = [];
  // NO file size limit — user requested all files (code, images, etc.) be backed up.
  const SKIP_FILES = new Set([
    ".bash_history", ".bash_logout", ".bashrc", ".profile",
    ".sudo_as_admin_successful", ".wget-hsts",
  ]);

  async function walkDir(dirPath: string) {
    let entries;
    try {
      entries = await sandbox.files.list(dirPath);
    } catch {
      return; // can't list this dir — skip
    }
    for (const entry of entries) {
      const fname = entry.name ?? entry.path.split("/").pop() ?? "";
      if (SKIP_FILES.has(fname)) continue;
      const isDir =
        (entry.type as string) === "dir" ||
        (entry.type as string) === "directory" ||
        (entry.type as string) === "FILE_TYPE_DIRECTORY";
      if (isDir) {
        await walkDir(entry.path);
      } else {
        try {
          const bytes = await sandbox.files.read(entry.path, { format: "bytes" });
          // NO size limit — back up ALL files regardless of size.
          // Skip binary files — detect null bytes in the first 1KB.
          const checkLen = Math.min(bytes.byteLength, 1024);
          let isBinary = false;
          for (let i = 0; i < checkLen; i++) {
            if (bytes[i] === 0) { isBinary = true; break; }
          }
          if (isBinary) continue;
          // Convert to UTF-8 string — safe because we verified it's text.
          const text = Buffer.from(bytes).toString("utf8");
          files.push({ path: entry.path, content: text });
        } catch {
          // skip unreadable files (permissions, etc.)
        }
      }
    }
  }

  await walkDir(DEFAULT_CWD);
  return files;
}

/**
 * Perform an atomic sandbox rotation: killOrphans → backup → kill → create → restore.
 *
 * Used by:
 *   - The `rotate` action (called by the client-side `ensureFreshSandbox`
 *     when the sandbox is >23h old).
 *   - The `getSandbox` safety-net check (when the server's cached entry is
 *     >23h old).
 *
 * Returns the new sandbox + counts of files backed up and restored.
 */
async function performRotation(
  apiKey: string,
  conversationId: string | null,
  mode: "shared" | "separate",
): Promise<{ sandbox: Sandbox; backedUp: number; restored: number }> {
  const key = cacheKey(apiKey, conversationId, mode);

  // 1. Enforce single-sandbox rule — kill ALL orphaned sandboxes on the
  //    account before creating a new one.
  await killOrphanedSandboxes(apiKey);

  // 2. Try to backup files from the current sandbox (if any).
  let backupFiles: Array<{ path: string; content: string }> = [];
  const cached = lookupCached(apiKey, conversationId, mode);
  if (cached) {
    if (await isAlive(cached.sandbox)) {
      try {
        backupFiles = await backupAllFilesFromSandbox(cached.sandbox);
        console.log(`[sandbox] rotation: backed up ${backupFiles.length} files from ${cached.sandbox.sandboxId}`);
      } catch (err) {
        // best-effort — if backup fails, continue with empty backup
        console.warn(`[sandbox] rotation: backup failed:`, err instanceof Error ? err.message : String(err));
      }
    }
    // 3. Kill the old sandbox (evictCacheEntry kills + removes from cache).
    evictCacheEntry(mode, key);
  }

  // 4. Create a new sandbox (createAndCacheSandbox handles quota recovery).
  const sandbox = await createAndCacheSandbox(apiKey, conversationId, mode);

  // 5. Restore the backup (if any) to the new sandbox.
  let restored = 0;
  if (backupFiles.length > 0) {
    for (const f of backupFiles) {
      try {
        await sandbox.files.write(f.path, f.content);
        restored++;
      } catch {
        // skip files that fail to write
      }
    }
    console.log(`[sandbox] rotation: restored ${restored}/${backupFiles.length} files to ${sandbox.sandboxId}`);
  }

  return { sandbox, backedUp: backupFiles.length, restored };
}

/** Create a fresh sandbox and cache it. Used by getSandbox() and the
 *  dead-sandbox recovery path. Creates predefined folders best-effort.
 *
 *  SINGLE-SANDBOX ENFORCEMENT: `killOrphanedSandboxes(apiKey)` runs at the
 *  start of EVERY create to kill orphaned sandboxes from previous sessions /
 *  dead serverless instances. This prevents the "20/20 sandbox limit reached"
 *  error and enforces the "one sandbox per API key" rule.
 *
 *  QUOTA RECOVERY: if `Sandbox.create` fails with a quota error (e.g.
 *  "20/20 sandbox limit reached"), we kill ALL sandboxes on the account
 *  (enforcing the "one shared sandbox" rule), clear our local cache, and
 *  retry the create. */
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

async function createAndCacheSandbox(
  apiKey: string,
  conversationId: string | null,
  mode: "shared" | "separate",
  envs?: Record<string, string>,
): Promise<Sandbox> {
  // Enforce single-sandbox rule — kill ALL orphaned sandboxes on the account
  // before creating a new one. This runs on EVERY create (not just when the
  // cache is full) to handle the case where orphans accumulated from previous
  // serverless instances (Vercel cold starts lose the in-memory cache, but
  // the sandboxes keep running on E2B).
  await killOrphanedSandboxes(apiKey);

  await enforceLimit();

  let sandbox: Sandbox;
  try {
    // ENV INJECTION (PRD §14): sandbox-level env vars so interactive shells
    // see them too. Per-execution envs (commands.run / runCode opts) are the
    // always-fresh authoritative source — this create-time set is a
    // best-effort baseline for connected sandboxes.
    //
    // LIFECYCLE (background-turn critical): onTimeout "pause" + autoResume.
    // Without this E2B's default KILLS the sandbox when its timeout expires —
    // including any background agent job running inside it. With it, the
    // sandbox auto-PAUSES at timeout (full memory + filesystem preserved,
    // background processes frozen mid-flight) and any later Sandbox.connect
    // (e.g. the bg_status poll when the user reopens the app) AUTO-RESUMES it,
    // continuing the job exactly where it froze. Verified live against E2B:
    // a paused sandbox's background pulse process resumed with a single gap
    // covering the pause window. (Hobby plan: 1h max continuous runtime; the
    // limit RESETS after each pause/resume cycle.)
    sandbox = await Sandbox.create({
      apiKey,
      timeoutMs: 3_600_000, // 1 hour (E2B Hobby max continuous runtime)
      envs,
      lifecycle: { onTimeout: "pause", autoResume: true },
    });
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
      sandbox = await Sandbox.create({
        apiKey,
        timeoutMs: 3_600_000,
        envs,
        lifecycle: { onTimeout: "pause", autoResume: true },
      });
    } else {
      throw createErr;
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

  // Write agent.md to the sandbox — contains the complete tool usage guide
  // AND the full GenUI reference (all 33 node types, custom_html/custom_card
  // deep guide, the common-mistakes table, worked examples). The system
  // prompt promises this documentation — the sandbox must actually receive
  // it, or the model improvises GenUI specs and produces broken markers/JS.
  try {
    await sandbox.files.write("/home/user/agent.md", AGENT_MD);
  } catch {
    // best-effort — file may already exist or write may fail
  }

  const key = cacheKey(apiKey, conversationId, mode);
  const entry: CacheEntry = {
    sandbox,
    apiKey,
    createdAt: Date.now(),
    key,
    verifiedAliveAt: Date.now(),
    agentMdVersion: AGENT_MD_VERSION,
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
    // AGENT.MD REFRESH: cached sandboxes created before an agent.md update
    // still carry the old documentation. Re-write it (best-effort) when the
    // version differs so the AI always reads the current GenUI reference.
    if (cached.agentMdVersion !== AGENT_MD_VERSION) {
      try {
        await cached.sandbox.files.write("/home/user/agent.md", AGENT_MD);
        cached.agentMdVersion = AGENT_MD_VERSION;
      } catch {
        // best-effort — a dead sandbox falls through the liveness path
      }
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
      const { sandbox: rotated } = await performRotation(apiKey, conversationId, mode);
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
      // Reconnected sandboxes may predate the current agent.md — refresh it
      // best-effort so the AI's GenUI documentation is always current.
      try {
        await sandbox.files.write("/home/user/agent.md", AGENT_MD);
        entry.agentMdVersion = AGENT_MD_VERSION;
      } catch {
        // best-effort — the next action will surface dead-sandbox errors
      }
      getCache(mode).set(key, entry);
      return sandbox;
    } catch {
      // Sandbox is dead or doesn't exist — fall through to create a new one.
    }
  }

  // 3. Create a new sandbox.
  return await createAndCacheSandbox(apiKey, conversationId, mode);
}

// ── v2 background-run reading helpers ─────────────────────────────────────
// The runner writes an APPEND-ONLY event log per run
// (.onyx/runs/<runId>/events.jsonl, one JSON line per event, every event
// carrying ts + seq) plus a state.json mirror (status/content/error).
// Both bg_status and bg_wait read through this single snapshot helper.

interface BgRunSnapshot {
  status: string;
  events: unknown[];
  content: string;
  error: string | null;
  startedAt: string | null;
  done: boolean;
  /** The highest seq in the returned events (cursor for bg_wait). */
  nextSeq?: number;
}

/** Resolve the run dir: explicit runId → legacy pointer → null. */
async function resolveBgRunDir(
  sandbox: Sandbox,
  args: Record<string, unknown>,
): Promise<string | null> {
  const runId = typeof args.runId === "string" ? args.runId.trim() : "";
  if (runId) return BG_RUNS_PREFIX + runId;
  try {
    const raw = await sandbox.files.read(BG_STATE_PATH);
    const p = JSON.parse(raw) as {
      activeRun?: string;
      runs?: string[];
      status?: string;
      events?: unknown[];
    };
    // v2 pointer shape.
    const id = p.activeRun ?? (Array.isArray(p.runs) && p.runs.length ? p.runs[p.runs.length - 1] : null);
    if (id) return BG_RUNS_PREFIX + id;
    // v1 shape (the whole state lived in bg-state.json with an events
    // array) — handled by the caller via the legacy snapshot path.
    if (Array.isArray(p.events)) return "__legacy__";
  } catch {
    // No pointer file — fall through.
  }
  return null;
}

/** Read a run's snapshot (events after the seq cursor + terminal status).
 *  Tolerates partial mid-append lines (the next poll re-reads them).
 *  `fastPath` (bg_wait): read the event log FIRST and return immediately
 *  when new events exist — skips the state.json round-trip while the stream
 *  is active (halves per-poll latency during streaming; the follow-up idle
 *  poll reads state.json for the authoritative terminal status). */
async function readBackgroundRun(
  sandbox: Sandbox,
  args: Record<string, unknown>,
  afterSeq = 0,
  fastPath = false,
): Promise<BgRunSnapshot> {
  const runDir = await resolveBgRunDir(sandbox, args);
  if (runDir === "__legacy__") {
    // v1 run (started by the pre-streaming bundle): the whole state is in
    // bg-state.json. Return it in the new snapshot shape so old clients
    // and the new pipeline both understand it.
    try {
      const raw = await sandbox.files.read(BG_STATE_PATH);
      const state = JSON.parse(raw) as {
        status?: string;
        events?: Array<{ seq?: number }>;
        content?: string;
        error?: string;
        startedAt?: string;
      };
      const events = (state.events ?? []).filter(
        (ev) => typeof (ev as { seq?: number }).seq !== "number" || (ev as { seq?: number }).seq! > afterSeq,
      );
      const status = state.status ?? "running";
      return {
        status,
        events,
        content: state.content ?? "",
        error: state.error ?? null,
        startedAt: state.startedAt ?? null,
        done: status === "done" || status === "error",
      };
    } catch {
      return { status: "running", events: [], content: "", error: null, startedAt: null, done: false };
    }
  }
  if (!runDir) {
    return { status: "running", events: [], content: "", error: null, startedAt: null, done: false };
  }
  // Read events.jsonl (append-only log) FIRST — during active streaming this
  // single read is all bg_wait needs (fastPath): each token-level delta is
  // delivered the moment it lands, without waiting for a state.json read.
  const events: unknown[] = [];
  let nextSeq = afterSeq;
  try {
    const raw = await sandbox.files.read(runDir + "/events.jsonl");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let ev: { seq?: number };
      try {
        ev = JSON.parse(t) as { seq?: number };
      } catch {
        continue; // partial mid-append line — the next poll re-reads it
      }
      if (typeof ev.seq === "number" && ev.seq > afterSeq) {
        events.push(ev);
        if (ev.seq > nextSeq) nextSeq = ev.seq;
      }
    }
  } catch {
    // events.jsonl not written yet.
  }
  if (fastPath && events.length > 0) {
    return {
      status: "running",
      events,
      content: "",
      error: null,
      startedAt: null,
      done: false,
      nextSeq,
    };
  }
  // Read state.json (status mirror) — needed for the terminal status when
  // no new events exist (and always for bg_status).
  let status = "running";
  let content = "";
  let error: string | null = null;
  let startedAt: string | null = null;
  try {
    const raw = await sandbox.files.read(runDir + "/state.json");
    const st = JSON.parse(raw) as {
      status?: string;
      content?: string;
      error?: string;
      startedAt?: string;
    };
    status = st.status ?? "running";
    content = st.content ?? "";
    error = st.error ?? null;
    startedAt = st.startedAt ?? null;
  } catch {
    // state.json not written yet — the run is booting.
  }
  return {
    status,
    events,
    content,
    error,
    startedAt,
    done: status === "done" || status === "error",
    nextSeq,
  };
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
// The client uses this to enable sandbox features (background turns, file
// tools) without the key ever crossing the wire.
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

      // ── BACKGROUND AGENT (E2B-documented pattern) ──────────────────────
      // Sandboxes are SERVER-SIDE VMs: they keep running after the browser
      // disconnects. We run the agent loop as a BACKGROUND COMMAND inside
      // the sandbox (`commands.run(..., { background: true })`) writing its
      // progress to a state file; the browser can close/minimize/leave and
      // reconnect later ("bg_status" uses Sandbox.connect, which also
      // auto-resumes a paused sandbox). The job keeps the sandbox busy for
      // as long as its timeout window allows (1h max on the Hobby plan).
      case "bg_start": {
        const state = (args.state as Record<string, unknown>) ?? {};
        const maxRounds = (args.maxRounds as number) ?? 30;
        const sandbox = await getSandbox(apiKey, conversationId, sandboxMode, clientSandboxId);
        // Full window for the background run — resets the timeout countdown.
        try {
          await sandbox.setTimeout(3_600_000);
        } catch {
          // best-effort — the default 1h window still applies
        }
        // Write the runner script (idempotent — same script every time).
        await sandbox.files.write(BG_SCRIPT_PATH, BG_AGENT_SCRIPT);
        // v2 STREAMING RUN LAYOUT: each run gets its own directory —
        //   .onyx/runs/<runId>/state.json   (boot state + status + todos +
        //                                    conversation, rewritten per round)
        //   .onyx/runs/<runId>/events.jsonl (APPEND-ONLY event log, O(1)
        //                                    appends, ts+seq on every event)
        //   .onyx/bg-state.json             (pointer for crash-recovery +
        //                                    stale-bundle bg_status)
        // Concurrent turns can no longer clobber each other's state file.
        const runId =
          "run_" + Date.now().toString(36) + "_" +
          Math.random().toString(36).slice(2, 8);
        const runDir = BG_RUNS_PREFIX + runId;
        const initial = {
          ...state,
          maxRounds,
          status: "starting",
          content: "",
          startedAt: new Date().toISOString(),
        };
        await sandbox.files.write(runDir + "/state.json", JSON.stringify(initial));
        await sandbox.files.write(runDir + "/events.jsonl", "");
        await sandbox.files.write(
          BG_STATE_PATH,
          JSON.stringify({ activeRun: runId, runs: [runId], status: "starting", startedAt: initial.startedAt }),
        );
        // Launch as a BACKGROUND command — returns immediately with a pid;
        // the process keeps running inside the sandbox after we (and the
        // browser) disconnect. The runId argument tells the runner which
        // run dir to execute (crash-relaunch reads the pointer fallback).
        const handle = await sandbox.commands.run(
          `node ${BG_SCRIPT_PATH} ${runId} > /home/user/.onyx/bg-agent.log 2>&1`,
          { background: true, timeoutMs: 0, cwd: DEFAULT_CWD },
        );
        return NextResponse.json({
          sandboxId: sandbox.sandboxId,
          pid: handle.pid,
          runId,
        });
      }

      case "bg_status": {
        const bgSandboxId = (args.sandboxId as string) ?? clientSandboxId;
        if (!bgSandboxId) {
          return NextResponse.json({ error: "Missing sandboxId" }, { status: 400 });
        }
        // Reconnect — works from ANY serverless instance, and auto-resumes
        // a paused sandbox (per the E2B docs any SDK call wakes it).
        let sandbox: Sandbox;
        try {
          sandbox = await Sandbox.connect(bgSandboxId, { apiKey });
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          return NextResponse.json({
            sandboxId: bgSandboxId,
            status: "unreachable",
            error: `Background sandbox unreachable: ${errMsg}`,
          });
        }
        // Activity extends the window while the user watches (per docs the
        // explicit setTimeout resets the countdown to the new value).
        try {
          await sandbox.setTimeout(3_600_000);
        } catch {
          // best-effort
        }
        const snap = await readBackgroundRun(sandbox, args);
        return NextResponse.json({
          sandboxId: bgSandboxId,
          ...snap,
        });
      }

      // ── v2.1 SERVER-PUSH SSE DELIVERY ─────────────────────────────────
      // bg_wait — STREAMING SSE: the server holds ONE connection open for
      // the segment, watching the run's events.jsonl (60ms while events
      // flow, 150ms idle; the fast-path read skips the state.json round
      // trip until the stream goes idle) and PUSHING each new batch of
      // token-level events as a data frame the moment it lands. The client
      // reads the stream incrementally — no per-batch HTTP round trip, so
      // word-level deltas reach the UI at the server's read cadence
      // (~60-150ms) instead of a full request-response cycle (~400-800ms).
      // A ~2.5s keep-alive frame covers idle stretches; the segment cap
      // (maxWaitMs, default 11s) is far under maxDuration=300.
      case "bg_wait": {
        const bgSandboxId = (args.sandboxId as string) ?? clientSandboxId;
        if (!bgSandboxId) {
          return NextResponse.json({ error: "Missing sandboxId" }, { status: 400 });
        }
        const afterSeq0 = Number(args.afterSeq ?? 0) || 0;
        const maxWaitMs = Math.min(Math.max(Number(args.maxWaitMs ?? 11_000) || 11_000, 1_000), 25_000);
        let sandbox: Sandbox;
        try {
          sandbox = await Sandbox.connect(bgSandboxId, { apiKey });
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          return NextResponse.json({
            sandboxId: bgSandboxId,
            status: "unreachable",
            error: `Background sandbox unreachable: ${errMsg}`,
            events: [],
            done: false,
            afterSeq: afterSeq0,
          });
        }
        try {
          await sandbox.setTimeout(3_600_000);
        } catch {
          // best-effort
        }
        // ── v2.1 SERVER-PUSH SSE DELIVERY ─────────────────────────────────
        // The old long-poll returned ONE JSON snapshot per HTTP request, so
        // every event batch paid a full browser↔server round trip (~2-4 RTTs
        // ≈ 400-800ms) — the "paragraph at once" cadence. Now the server
        // holds ONE streaming connection open and PUSHES each batch of new
        // events the moment its sandbox read lands:
        //   - active stream: poll the event log every 60ms
        //   - idle (thinking/boot/retry): every 150ms + a ~2.5s keep-alive
        //     frame (empty events) so proxies keep the connection open and
        //     the client keeps yielding
        //   - segment cap (maxWaitMs): send a timeout frame + close; the
        //     client re-opens immediately (one amortized RTT per ~11s)
        const ACTIVE_POLL_MS = 60;
        const IDLE_POLL_MS = 150;
        const HEARTBEAT_MS = 2_500;
        const encoder = new TextEncoder();
        let cursor = afterSeq0;
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            let closed = false;
            const send = (obj: Record<string, unknown>) => {
              if (closed) return;
              try {
                controller.enqueue(encoder.encode("data: " + JSON.stringify(obj) + "\n\n"));
              } catch {
                closed = true;
              }
            };
            const sendUnreachable = (message: string) => {
              send({
                sandboxId: bgSandboxId,
                status: "unreachable",
                error: message,
                events: [],
                done: false,
                afterSeq: cursor,
              });
            };
            try {
              const deadline = Date.now() + maxWaitMs;
              let lastBeat = Date.now();
              for (;;) {
                const snap = await readBackgroundRun(sandbox, args, cursor, true);
                if (snap.events.length > 0) {
                  send({
                    sandboxId: bgSandboxId,
                    ...snap,
                    afterSeq: snap.nextSeq ?? cursor,
                  });
                  if (snap.nextSeq) cursor = snap.nextSeq;
                  if (snap.done) break;
                  await new Promise((r) => setTimeout(r, ACTIVE_POLL_MS));
                  continue;
                }
                if (snap.done) {
                  send({
                    sandboxId: bgSandboxId,
                    ...snap,
                    afterSeq: snap.nextSeq ?? cursor,
                  });
                  break;
                }
                if (Date.now() >= deadline) {
                  // Segment cap — clean end; the client re-opens immediately.
                  send({
                    sandboxId: bgSandboxId,
                    ...snap,
                    afterSeq: snap.nextSeq ?? cursor,
                    timeout: true,
                  });
                  break;
                }
                if (Date.now() - lastBeat >= HEARTBEAT_MS) {
                  lastBeat = Date.now();
                  // Keep-alive DATA frame (empty events): keeps intermediaries
                  // from closing the connection AND lets the client's for-await
                  // yield so it can check its stop flag.
                  send({
                    sandboxId: bgSandboxId,
                    status: snap.status,
                    events: [],
                    content: "",
                    error: null,
                    startedAt: snap.startedAt,
                    done: false,
                    afterSeq: cursor,
                  });
                }
                await new Promise((r) => setTimeout(r, IDLE_POLL_MS));
              }
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              sendUnreachable(`bg_wait stream failed: ${errMsg}`);
            }
            try {
              controller.close();
            } catch {
              // already closed by the consumer
            }
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            // Disable nginx-style proxy buffering (Vercel honors this too).
            "X-Accel-Buffering": "no",
          },
        });
      }

      case "bg_stop": {
        const bgSandboxId = (args.sandboxId as string) ?? clientSandboxId;
        if (!bgSandboxId) {
          return NextResponse.json({ error: "Missing sandboxId" }, { status: 400 });
        }
        try {
          const sandbox = await Sandbox.connect(bgSandboxId, { apiKey });
          const cmds = await sandbox.commands.list();
          // Kill every running command in this sandbox — the background
          // agent included. The sandbox itself (and its files) stays.
          for (const c of cmds) {
            try {
              await sandbox.commands.kill(c.pid);
            } catch {
              // already exited
            }
          }
          return NextResponse.json({ sandboxId: bgSandboxId, ok: true });
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          return NextResponse.json({ error: errMsg }, { status: 500 });
        }
      }

      case "keepalive": {
        // Keepalive ping — just touches the sandbox to reset the inactivity
        // timer. Returns the sandbox ID + a timestamp so the client can
        // verify it's still alive.
        const sandbox = await getSandbox(apiKey, conversationId, sandboxMode, clientSandboxId);
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
        // Recursively walk /home/user and return ALL text files as
        // { path, content } pairs (raw UTF-8 text, NOT base64).
        // Files >500KB are SKIPPED (too large for JSON transport).
        // Binary files are SKIPPED (can't JSON-serialize — detected by
        // checking the first 1KB for null bytes).
        // Shell dotfiles are skipped (sandbox-template-specific).
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
        // Atomic sandbox rotation: killOrphans → backup → kill → create → restore.
        // Called by the client-side `ensureFreshSandbox` when the sandbox is
        // >23h old (approaching E2B's 24h hard TTL).
        //
        // The rotation is TRANSPARENT — the new sandbox has the same files
        // as the old one (text files ≤500KB). Tools don't know it happened;
        // they just see the new sandboxId on the next call.
        //
        // Returns { sandboxId, backedUp, restored }.
        const { sandbox, backedUp, restored } = await performRotation(
          apiKey,
          conversationId,
          sandboxMode,
        );
        return NextResponse.json({
          sandboxId: sandbox.sandboxId,
          backedUp,
          restored,
          rotated: true,
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

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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_CWD = "/home/user";
const SANDBOX_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours — files persist for a full day
// SHARED SANDBOX ARCHITECTURE: one sandbox per API key, reused across ALL
// conversations. OPFS is the single source of truth for files — the sandbox
// is only a code runner. When the sandbox quota is exceeded (e.g. "20/20"),
// we kill ALL sandboxes on the account, create ONE fresh sandbox, and OPFS
// auto-syncs to it on the next run_python/run_terminal call.
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
  createdAt: number;
  key: string;
  /** Set to true after a liveness check has confirmed the sandbox is alive.
   *  Prevents redundant pings on every call. Reset on cache lookup miss. */
  verifiedAliveAt?: number;
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
  void killOrphanedSandboxes(oldest.sandbox.apiKey).catch(() => {});
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
    // Kill any running sandbox that isn't in our cache (orphaned).
    // Keep the 3 most recent (in case the user has multiple tabs open).
    const sorted = page
      .filter((s) => s.state !== "closed" && !localIds.has(s.sandboxId))
      .sort((a, b) => (b.startedAt?.getTime() ?? 0) - (a.startedAt?.getTime() ?? 0));
    // Kill all but the 3 most recent orphans.
    const toKill = sorted.slice(3);
    await Promise.all(
      toKill.map((s) =>
        Sandbox.kill(s.sandboxId, { apiKey: knownApiKey }).catch(() => {}),
      ),
    );
    if (toKill.length > 0) {
      console.log(`[sandbox] killed ${toKill.length} orphaned sandbox(es) to free quota`);
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
    const running = page.filter((s) => s.state !== "closed");
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

/** Create a fresh sandbox and cache it. Used by getSandbox() and the
 *  dead-sandbox recovery path. Creates predefined folders best-effort.
 *
 *  QUOTA RECOVERY: if `Sandbox.create` fails with a quota error (e.g.
 *  "20/20 sandbox limit reached"), we kill ALL sandboxes on the account
 *  (enforcing the "one shared sandbox" rule), clear our local cache, and
 *  retry the create. OPFS auto-syncs to the new sandbox on the next
 *  run_python/run_terminal call — no files are lost. */
async function createAndCacheSandbox(
  apiKey: string,
  conversationId: string | null,
  mode: "shared" | "separate",
): Promise<Sandbox> {
  await enforceLimit();

  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.create({ apiKey, timeout: 86_400_000 }); // 24 hours
  } catch (createErr) {
    // QUOTA RECOVERY: kill ALL sandboxes on the account and retry.
    // The shared-sandbox architecture means we only ever need ONE sandbox
    // per API key. When quota is exceeded, nuke everything and start fresh.
    // OPFS is the source of truth — no files are lost.
    if (isQuotaError(createErr)) {
      console.warn(`[sandbox] quota exceeded, killing ALL sandboxes on account and retrying...`);
      await killAllSandboxesOnAccount(apiKey);
      // Clear our local caches (the sandboxes we just killed are dead).
      sharedCache.clear();
      separateCache.clear();
      // Retry the create — should succeed now that the account has 0 sandboxes.
      sandbox = await Sandbox.create({ apiKey, timeout: 86_400_000 });
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

  const key = cacheKey(apiKey, conversationId, mode);
  const entry: CacheEntry = {
    sandbox,
    createdAt: Date.now(),
    key,
    verifiedAliveAt: Date.now(),
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
        createdAt: Date.now(),
        key,
        verifiedAliveAt: Date.now(), // trust it's alive
      };
      getCache(mode).set(key, entry);
      return sandbox;
    } catch {
      // Sandbox is dead or doesn't exist — fall through to create a new one.
    }
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

export async function POST(req: NextRequest) {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { apiKey, action, args = {}, conversationId = null, sandboxMode = "shared", sandboxId: clientSandboxId } = body;

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
        } catch (pyErr) {
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
                e.type === "dir" ||
                e.type === "directory" ||
                e.type === "FILE_TYPE_DIRECTORY"
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
                  e.type === "dir" ||
                  e.type === "directory" ||
                  e.type === "FILE_TYPE_DIRECTORY"
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
        // Files larger than 500KB are skipped (too big for JSON transport).
        // Binary files are returned as base64 to avoid UTF-8 corruption.
        const sandbox = await getSandbox(apiKey, conversationId, sandboxMode, clientSandboxId);
        const files: Array<{ path: string; content: string; isBase64?: boolean }> = [];
        const MAX_FILE_SIZE = 500 * 1024; // 500KB per file

        async function walkDir(dirPath: string) {
          try {
            const entries = await sandbox.files.list(dirPath);
            for (const entry of entries) {
              const entryPath = entry.path;
              if (entry.type === "dir" || entry.type === "directory" || entry.type === "FILE_TYPE_DIRECTORY" || entry.type === "dir") {
                // Recurse into subdirectories
                await walkDir(entryPath);
              } else {
                // Read file content as bytes to avoid UTF-8 corruption.
                try {
                  const bytes = await sandbox.files.read(entryPath, { format: "bytes" });
                  if (bytes.byteLength <= MAX_FILE_SIZE) {
                    // Convert to base64 for safe JSON transport.
                    const base64 = Buffer.from(bytes).toString("base64");
                    files.push({ path: entryPath, content: base64, isBase64: true });
                  }
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
            templateID: s.templateID,
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

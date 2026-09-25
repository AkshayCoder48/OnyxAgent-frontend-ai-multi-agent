// ============================================================================
// Sandbox Proxy — BACKWARD-COMPAT shim for old cached JS bundles.
//
// The old client code (cached in the user's browser) calls /api/sandbox-proxy
// with these headers:
//   x-sandbox-target-url: https://api.e2b.dev/sandboxes/{id}/commands
//   X-API-KEY: e2b_...
//   Body: { command: "...", cwd: "..." }
//
// The new client code calls /api/sandbox with a JSON body specifying the
// action. This route detects the old format and proxies to the E2B SDK,
// so old cached bundles keep working until the user hard-refreshes.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { Sandbox } from "@e2b/code-interpreter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_CWD = "/home/user";
// Cache TTL for the apiKey-keyed CREATE path: match E2B's sandbox lifetime so
// a warm instance keeps handing the SAME sandbox back to old bundles (the
// previous 5-minute TTL silently swapped in an EMPTY sandbox every 5 min —
// "files auto-delete after waiting some time" for stale-bundle users).
const SANDBOX_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SANDBOXES = 10;
// Same stale-only kill rule as /api/sandbox: a cached entry under pressure
// is DROPPED from the cache unless it is demonstrably stale (>20h — E2B's
// 24h TTL kills it within hours anyway). Never kill a fresh sandbox just to
// free a cache slot — the client reconnects by sandbox ID (PRD §9–10).
const STALE_SANDBOX_KILL_AGE_MS = 20 * 60 * 60 * 1000;

interface CacheEntry {
  sandbox: Sandbox;
  createdAt: number;
}

const sandboxCache = new Map<string, CacheEntry>();

function normalizePath(p: string | undefined | null): string {
  if (!p || typeof p !== "string" || p.trim() === "") return DEFAULT_CWD;
  const trimmed = p.trim();
  if (trimmed.startsWith("/")) return trimmed;
  return `${DEFAULT_CWD}/${trimmed}`;
}

/** Evict the oldest cache entries when the shim's cache is full. Fresh
 *  entries are only DROPPED (their client reconnects by sandbox ID);
 *  only stale (>20h) ones are killed. */
function enforceLimit(): void {
  if (sandboxCache.size < MAX_SANDBOXES) return;
  const oldest = [...sandboxCache.entries()].sort(
    (a, b) => a[1].createdAt - b[1].createdAt,
  )[0];
  if (oldest) {
    sandboxCache.delete(oldest[0]);
    if (Date.now() - oldest[1].createdAt > STALE_SANDBOX_KILL_AGE_MS) {
      void oldest[1].sandbox.kill().catch(() => {});
    }
  }
}

/** Create (or reuse) the sandbox for an apiKey — the POST /sandboxes
 *  (create) path of the old protocol, which carries no sandbox ID. */
async function getSandbox(apiKey: string): Promise<Sandbox> {
  const cached = sandboxCache.get(apiKey);
  if (cached && Date.now() - cached.createdAt < SANDBOX_TTL_MS) {
    return cached.sandbox;
  }
  enforceLimit();
  const sandbox = await Sandbox.create({ apiKey, timeoutMs: 86_400_000 }); // 24 hours
  sandboxCache.set(apiKey, { sandbox, createdAt: Date.now() });
  return sandbox;
}

/** Resolve the sandbox the OLD BUNDLE asked for by ID (every
 *  /sandboxes/{id}/... request). Connects to that exact sandbox — the
 *  previous implementation ignored the ID entirely and served whatever was
 *  in the apiKey cache, so after the cache TTL expired every command landed
 *  in a fresh EMPTY sandbox while the bundle's real workspace kept running
 *  orphaned. Returns null when the sandbox is gone; the caller then replies
 *  with an explicit error instead of silently substituting a new sandbox
 *  (PRD §9: an empty/incomplete answer must never read as "delete all
 *  files"). */
async function getSandboxById(
  apiKey: string,
  sandboxId: string,
): Promise<Sandbox | null> {
  const cached = sandboxCache.get(sandboxId);
  if (cached && Date.now() - cached.createdAt < SANDBOX_TTL_MS) {
    return cached.sandbox;
  }
  try {
    const sandbox = await Sandbox.connect(sandboxId, { apiKey });
    sandboxCache.set(sandboxId, { sandbox, createdAt: Date.now() });
    return sandbox;
  } catch {
    return null; // dead or inaccessible — do NOT create a replacement
  }
}

function parseSandboxIdFromUrl(url: string): string | null {
  // Match /sandboxes/{id}/commands, /sandboxes/{id}/files, etc.
  const match = url.match(/\/sandboxes\/([^/]+)(?:\/|$)/);
  return match?.[1] ?? null;
}

function parseActionFromUrl(url: string): string {
  if (url.includes("/commands")) return "exec";
  if (url.includes("/code")) return "run_python";
  if (url.includes("/files/read")) return "read_file";
  if (url.match(/\/files$/)) return "list_files"; // GET /files?path=...
  return "unknown";
}

export async function POST(req: NextRequest) {
  const targetUrl = req.headers.get("x-sandbox-target-url");
  const apiKey = req.headers.get("x-api-key");

  if (!targetUrl) {
    return NextResponse.json(
      { error: "Missing x-sandbox-target-url header" },
      { status: 400 },
    );
  }
  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing X-API-KEY header" },
      { status: 401 },
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    return NextResponse.json({ error: "Invalid target URL" }, { status: 400 });
  }

  const body = await req.text().catch(() => "");
  let bodyJson: Record<string, unknown> = {};
  try {
    bodyJson = body ? JSON.parse(body) : {};
  } catch {
    // non-JSON body
  }

  try {
    // POST /sandboxes → create sandbox
    if (parsedUrl.pathname === "/sandboxes" || parsedUrl.pathname === "/sandboxes/") {
      const sandbox = await getSandbox(apiKey);
      return NextResponse.json({
        sandboxID: sandbox.sandboxId,
        sandboxId: sandbox.sandboxId,
        id: sandbox.sandboxId,
      });
    }

    const sandboxId = parseSandboxIdFromUrl(parsedUrl.pathname);
    const action = parseActionFromUrl(parsedUrl.pathname);

    if (!sandboxId) {
      return NextResponse.json(
        { error: `Cannot parse sandbox ID from URL: ${parsedUrl.pathname}` },
        { status: 400 },
      );
    }

    // Resolve the EXACT sandbox the old bundle is addressing (by ID — never
    // a substitute). If it is gone, say so explicitly: silently serving a
    // fresh sandbox made the bundle's workspace appear to vanish.
    const sandbox = await getSandboxById(apiKey, sandboxId);
    if (!sandbox) {
      return NextResponse.json(
        {
          error:
            `Sandbox ${sandboxId} is not running anymore. Refresh the page to ` +
            "load the current app version, which reconnects to your workspace.",
        },
        { status: 404 },
      );
    }

    switch (action) {
      case "exec": {
        // POST /sandboxes/{id}/commands — old body: { command, cwd }
        const command = bodyJson.command as string;
        const cwd = normalizePath(bodyJson.cwd as string);
        if (!command) {
          return NextResponse.json(
            { error: "Missing 'command' in body" },
            { status: 400 },
          );
        }
        const result = await sandbox.commands.run(command, {
          cwd,
          timeoutMs: 120_000,
        });
        return NextResponse.json({
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          exitCode: result.exitCode ?? 0,
          // Old client expects exit_code (snake_case)
          exit_code: result.exitCode ?? 0,
        });
      }

      case "run_python": {
        // POST /sandboxes/{id}/code — old body: { code, language }
        const code = bodyJson.code as string;
        if (!code) {
          return NextResponse.json(
            { error: "Missing 'code' in body" },
            { status: 400 },
          );
        }
        try {
          const exec = await (sandbox as unknown as {
            runCode: (
              code: string,
              opts?: { timeoutMs?: number },
            ) => Promise<{
              logs: { stdout?: string[]; stderr?: string[] };
              error?: { value?: string };
            }>;
          }).runCode(code, { timeoutMs: 60_000 });
          return NextResponse.json({
            results: [],
            logs: exec.logs,
            error: exec.error,
          });
        } catch {
          // Fall back to python3 -c
          const result = await sandbox.commands.run(
            `python3 -c '${code.replace(/'/g, "'\\''")}'`,
            { cwd: DEFAULT_CWD, timeoutMs: 60_000 },
          );
          return NextResponse.json({
            results: [],
            logs: {
              stdout: result.stdout ? [result.stdout] : [],
              stderr: result.stderr ? [result.stderr] : [],
            },
            error: result.exitCode !== 0 ? { value: result.stderr } : undefined,
          });
        }
      }

      case "read_file": {
        // GET /sandboxes/{id}/files/read?path=... (but this is POST here)
        const path = normalizePath(
          bodyJson.path as string ?? parsedUrl.searchParams.get("path"),
        );
        const content = await sandbox.files.read(path);
        return NextResponse.json({
          content: typeof content === "string" ? content : new TextDecoder().decode(content),
        });
      }

      default:
        return NextResponse.json(
          { error: `Unsupported old-proxy action: ${parsedUrl.pathname}` },
          { status: 400 },
        );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = /auth|401|403|invalid/i.test(msg) ? 401 : 500;
    return NextResponse.json({ error: msg }, { status });
  }
}

export async function GET(req: NextRequest) {
  const targetUrl = req.headers.get("x-sandbox-target-url");
  const apiKey = req.headers.get("x-api-key");

  if (!targetUrl || !apiKey) {
    return NextResponse.json(
      { error: "Missing x-sandbox-target-url or X-API-KEY header" },
      { status: 400 },
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    return NextResponse.json({ error: "Invalid target URL" }, { status: 400 });
  }

  try {
    // GET /sandboxes?limit=... → list sandboxes
    if (parsedUrl.pathname === "/sandboxes" || parsedUrl.pathname === "/sandboxes/") {
      const paginator = Sandbox.list({ apiKey, limit: 20 });
      const page = await paginator.nextItems();
      return NextResponse.json(
        page.map((s) => ({
          sandboxID: s.sandboxId,
          startedAt: s.startedAt ?? new Date().toISOString(),
        })),
      );
    }

    const sandboxId = parseSandboxIdFromUrl(parsedUrl.pathname);
    if (!sandboxId) {
      return NextResponse.json(
        { error: `Cannot parse sandbox ID from URL: ${parsedUrl.pathname}` },
        { status: 400 },
      );
    }

    // Serve the EXACT sandbox the old bundle is addressing — never a
    // substitute (see getSandboxById).
    const sandbox = await getSandboxById(apiKey, sandboxId);
    if (!sandbox) {
      return NextResponse.json(
        {
          error:
            `Sandbox ${sandboxId} is not running anymore. Refresh the page to ` +
            "load the current app version, which reconnects to your workspace.",
        },
        { status: 404 },
      );
    }

    // GET /sandboxes/{id}/files?path=... → list files
    if (parsedUrl.pathname.includes("/files")) {
      const path = normalizePath(parsedUrl.searchParams.get("path"));
      const entries = await sandbox.files.list(path);
      return NextResponse.json(
        entries.map((e) => ({
          path: e.path,
          type:
            (e.type as string) === "directory" ||
            (e.type as string) === "FILE_TYPE_DIRECTORY" ||
            e.type === "dir"
              ? "directory"
              : "file",
          size: e.size,
        })),
      );
    }

    return NextResponse.json(
      { error: `Unsupported old-proxy GET: ${parsedUrl.pathname}` },
      { status: 400 },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const targetUrl = req.headers.get("x-sandbox-target-url");
  const apiKey = req.headers.get("x-api-key");

  if (!targetUrl || !apiKey) {
    return new NextResponse(null, { status: 204 });
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    return new NextResponse(null, { status: 204 });
  }

  const sandboxId = parseSandboxIdFromUrl(parsedUrl.pathname);
  if (sandboxId) {
    // Delete from cache and kill
    for (const [key, entry] of sandboxCache.entries()) {
      if (entry.sandbox.sandboxId === sandboxId) {
        sandboxCache.delete(key);
        void entry.sandbox.kill().catch(() => {});
        break;
      }
    }
  }
  return new NextResponse(null, { status: 204 });
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-max-age": "86400",
    },
  });
}

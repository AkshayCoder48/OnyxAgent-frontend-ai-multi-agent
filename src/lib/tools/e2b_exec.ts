"use client";

import { registerTool } from "./registry";
import { getE2BClient } from "@/lib/e2b/client";
import * as opfs from "@/lib/storage/opfs";

// E2B Python sandbox — modules available in the code-interpreter template.
const PYTHON_NOTE =
  "The sandbox has a 60-second timeout. Returns stdout, stderr, and the exit code.";

/**
 * Auto-sync OPFS workspace files to the E2B sandbox before running code.
 * This is fully automatic — the user doesn't need to upload anything.
 * Files are stored locally (OPFS) and synced to the sandbox on-demand
 * when code needs to access them.
 *
 * Only syncs files ≤ 500KB to avoid overwhelming the sandbox. The sync
 * is best-effort — failures are logged but don't block code execution.
 *
 * PERF: Uses a manifest (stored in localStorage) to track which files have
 * been synced (by path + size + lastModified). Only CHANGED files are
 * re-uploaded, and they're uploaded in a SINGLE batch_write HTTP call
 * instead of N sequential fetch() calls. This reduces a 20-file sync
 * from 1-2 minutes (20 sequential HTTP round-trips) to <2 seconds
 * (1 HTTP call + parallel file reads).
 */
interface SyncManifestEntry {
  size: number;
  lastModified: number;
}
type SyncManifest = Record<string, SyncManifestEntry>;

function loadSyncManifest(userId: string): SyncManifest {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(`e2b-sync-manifest:${userId}`);
    return raw ? (JSON.parse(raw) as SyncManifest) : {};
  } catch {
    return {};
  }
}

function saveSyncManifest(userId: string, manifest: SyncManifest): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`e2b-sync-manifest:${userId}`, JSON.stringify(manifest));
  } catch {
    // ignore quota errors
  }
}

/** Invalidate the sync manifest for a user — forces the next syncOpfsToSandbox
 *  to re-upload ALL files. Called by file tools (write_file, create_file,
 *  edit_file, delete_file, move_file, rename_file) after they modify OPFS,
 *  so the next run_terminal/run_python sees the updated files. */
export function invalidateSyncManifest(userId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(`e2b-sync-manifest:${userId}`);
  } catch {
    // ignore
  }
}

async function syncOpfsToSandbox(
  userId: string,
  apiKey: string,
): Promise<void> {
  try {
    const dir = await opfs.ensurePath(userId, "workspace");
    const walked = await opfs.walkFiles(dir);
    if (walked.length === 0) return; // No files to sync — skip entirely

    const client = getE2BClient(apiKey, null, "shared");
    const MAX_FILE_SIZE = 500 * 1024; // 500KB
    const manifest = loadSyncManifest(userId);
    const newManifest: SyncManifest = {};

    // Phase 1: Read all files in PARALLEL and figure out which changed.
    // Previously this was sequential (for...of with await inside) which
    // made 20 files take 20x the read time. Now all reads happen
    // concurrently via Promise.all.
    const readResults = await Promise.all(
      walked.map(async (f) => {
        try {
          const file = await f.handle.getFile();
          if (file.size > MAX_FILE_SIZE) return null;
          // Skip hidden/system files (allow .onyxagent_files.json)
          const fname = f.path.split("/").pop() ?? "";
          if (fname.startsWith(".") && fname !== ".onyxagent_files.json") return null;
          // Check if file changed since last sync (by size + lastModified).
          // This is the key optimization — if nothing changed, we skip
          // the upload entirely.
          const entry = manifest[f.path];
          if (entry && entry.size === file.size && entry.lastModified === file.lastModified) {
            // Unchanged — carry over to new manifest, skip upload.
            newManifest[f.path] = entry;
            return null;
          }
          // Read first 1KB to check if text (skip binary).
          const slice = file.slice(0, 1024);
          const buf = await slice.arrayBuffer();
          const view = new Uint8Array(buf);
          let isText = true;
          for (let i = 0; i < view.length; i++) {
            if (view[i] === 0) { isText = false; break; }
          }
          if (!isText) return null; // skip binary
          const text = await file.text();
          // Record in new manifest.
          newManifest[f.path] = { size: file.size, lastModified: file.lastModified };
          return { path: `/home/user/${f.path}`, content: text };
        } catch {
          return null;
        }
      }),
    );

    // Phase 2: Filter out nulls and batch-upload all changed files in
    // ONE HTTP call. Previously this was N sequential fetch() calls to
    // /api/sandbox (each potentially cold-starting a Vercel serverless
    // function) = 1-2 minutes. Now: 1 HTTP call.
    const changedFiles = readResults.filter(
      (r): r is { path: string; content: string } => r !== null,
    );

    if (changedFiles.length === 0) {
      // Nothing changed — save manifest and return instantly.
      saveSyncManifest(userId, newManifest);
      return;
    }

    // Single batch write — 1 HTTP round-trip for all files.
    await client.batchWrite(changedFiles);

    // Save the updated manifest so the next sync skips these files.
    saveSyncManifest(userId, newManifest);
  } catch {
    // best-effort — don't block code execution
  }
}

/**
 * Reverse sync: pull files created/modified by run_terminal/run_python
 * from the E2B sandbox back to OPFS so they appear in the file sidebar.
 *
 * This is what makes files created via `mkdir`, `echo > file`, `touch`,
 * `pip install`, etc. visible in the local file system. Without this,
 * files created by terminal commands only exist in the (ephemeral)
 * sandbox and disappear on refresh.
 *
 * Walks the sandbox's /home/user directory recursively, reads each file,
 * and writes it to the corresponding OPFS path. Files ≤ 500KB only.
 */
async function syncSandboxToOpfs(
  userId: string,
  apiKey: string,
): Promise<void> {
  try {
    const client = getE2BClient(apiKey, null, "shared");
    const { writeFileAtPath, ensurePath } = opfs;
    const MAX_FILE_SIZE = 500 * 1024; // 500KB

    // Recursively walk the sandbox /home/user directory
    // Skip system directories that don't contain user files
    const SKIP_DIRS = new Set([
      ".cache", ".npm", ".local", ".config", ".bash_history",
      ".bash_logout", ".bashrc", ".profile", ".sudo_as_admin_successful",
    ]);

    async function walkSandbox(dirPath: string): Promise<void> {
      let entries;
      try {
        entries = await client.listFiles(dirPath);
      } catch {
        return; // can't list this dir — skip
      }

      for (const entry of entries) {
        // Skip hidden/system files
        if (entry.name?.startsWith(".") || entry.path.split("/").pop()?.startsWith(".")) continue;

        // Check if it's a directory
        if (entry.type === "directory" || entry.type === "dir") {
          // Recurse into subdirectories
          await walkSandbox(entry.path);
        } else {
          // It's a file — read it as BYTES (not text) to avoid UTF-8
          // corruption of binary files (images, PDFs, archives, etc.).
          // The old code used client.readFile() which returned a string,
          // causing binary bytes like 0xFF to be replaced with the UTF-8
          // replacement character (EF BF BD), corrupting the file.
          try {
            const blob = await client.readFileBytes(entry.path);
            if (blob && blob.size <= MAX_FILE_SIZE) {
              const relPath = entry.path.replace(/^\/home\/user\/?/, "");
              if (!relPath) continue;

              const parts = relPath.split("/");
              const filename = parts.pop()!;
              const subdir = parts.join("/");

              if (subdir) {
                await ensurePath(userId, `workspace/${subdir}`);
              }
              // Write as Blob — preserves binary data perfectly.
              await writeFileAtPath(
                `users/${userId}/workspace${subdir ? `/${subdir}` : ""}`,
                filename,
                blob,
              );
            }
          } catch {
            // skip files that can't be read (binary, too large, permissions)
          }
        }
      }
    }

    await walkSandbox("/home/user");

    // Dispatch a window event so the file sidebar knows to refresh
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("tool_result", { detail: { tool_name: "run_terminal" } }));
    }
  } catch {
    // best-effort — don't block code execution
  }
}

registerTool(
  "run_python",
  `Run Python 3 source code in a sandboxed E2B environment. ${PYTHON_NOTE} Output streams in real time. Files from the local workspace are automatically synced to the sandbox before execution.`,
  {
    type: "object",
    properties: {
      code: { type: "string", description: "Python 3 source code to execute." },
    },
    required: ["code"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const code = args.code as string;
    if (!code || !code.trim()) {
      return { error: "No code provided" };
    }
    const apiKey = ctx.e2bApiKey ?? ctx.sandboxApiKey;
    if (!apiKey) {
      // No E2B key — try to load it dynamically from settings in case the
      // runtime context didn't include it (e.g. subagent calls that build
      // a minimal context). This fixes "key not configured" errors when
      // the user HAS added a key but it wasn't passed through.
      try {
        const { settingsService } = await import("@/lib/services");
        const { useAuthStore } = await import("@/stores");
        const userId = ctx.userId || useAuthStore.getState().user?.id;
        if (userId) {
          const dynamicKey = await settingsService.getDecryptedSandboxKey(userId);
          if (dynamicKey) {
            // Use the dynamically-loaded key for this call.
            const client = getE2BClient(dynamicKey, ctx.conversationId, ctx.sandboxMode ?? "shared");
            // AWAIT the sync so the sandbox sees the latest OPFS files
            // before the code runs. Previously this was fire-and-forget
            // (`void syncOpfsToSandbox(...)`) which meant the terminal/
            // Python command ran BEFORE the sync finished, seeing stale
            // file content (e.g. `cat file.txt` showed old content after
            // `write_file` had updated it).
            await syncOpfsToSandbox(ctx.userId, dynamicKey);
            const onOutput = ctx.onToolOutput;
            let stdout = "";
            let stderr = "";
            let exitCode = 0;
            for await (const chunk of client.runPythonStream(code, { timeout: 60 })) {
              if (chunk.type === "stdout" && chunk.data) {
                stdout += chunk.data;
                if (onOutput) onOutput("", chunk.data, "stdout");
              } else if (chunk.type === "stderr" && chunk.data) {
                stderr += chunk.data;
                if (onOutput) onOutput("", chunk.data, "stderr");
              } else if (chunk.type === "result") {
                exitCode = chunk.exit_code ?? 0;
              }
            }
            void syncSandboxToOpfs(ctx.userId, dynamicKey);
            return { exit_code: exitCode, stdout, stderr };
          }
        }
      } catch {
        // fall through to the error below
      }
      return {
        error:
          "Python execution requires an E2B Sandbox API key. Add one in Settings → Config → E2B Sandbox.",
        exit_code: -1,
        stdout: "",
        stderr: "E2B Sandbox API key not configured. The key may be set but the vault is locked — try refreshing the page.",
      };
    }

    try {
      // AWAIT the sync so the sandbox sees the latest OPFS files before
      // the code runs. Previously fire-and-forget (`void ...`) which
      // caused terminal/Python to see stale file content.
      await syncOpfsToSandbox(ctx.userId, apiKey);

      const client = getE2BClient(apiKey, ctx.conversationId, ctx.sandboxMode ?? "shared");
      const onOutput = ctx.onToolOutput;

      // runPythonStream is an async generator. Iterate it and pipe chunks.
      let stdout = "";
      let stderr = "";
      let exitCode = 0;

      for await (const chunk of client.runPythonStream(code, { timeout: 60 })) {
        if (chunk.type === "stdout" && chunk.data) {
          stdout += chunk.data;
          if (onOutput) onOutput("", chunk.data, "stdout");
        } else if (chunk.type === "stderr" && chunk.data) {
          stderr += chunk.data;
          if (onOutput) onOutput("", chunk.data, "stderr");
        } else if (chunk.type === "result") {
          exitCode = chunk.exit_code ?? 0;
        }
      }

      // Reverse sync: pull any new/modified files from sandbox back to OPFS
      // so they appear in the file sidebar. Fire-and-forget (don't block
      // the tool result) — the sync is best-effort.
      void syncSandboxToOpfs(ctx.userId, apiKey);

      return { exit_code: exitCode, stdout, stderr };
    } catch (e) {
      return {
        error: e instanceof Error ? e.message : String(e),
        exit_code: -1,
        stdout: "",
        stderr: e instanceof Error ? e.message : String(e),
      };
    }
  },
  false,
  "exec",
);

registerTool(
  "run_terminal",
  "Run a shell command in the E2B sandbox. Supports shell operators (|, &&, ;, >). 120-second timeout, 256 KB output cap. Output streams in real time. Files from the local workspace are automatically synced to the sandbox before execution.",
  {
    type: "object",
    properties: {
      command: { type: "string", description: "Command line to execute." },
      cwd: {
        type: "string",
        description: "Working directory (relative to workspace root). Defaults to root.",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  async (args, ctx) => {
    const command = args.command as string;
    const cwd = (args.cwd as string) ?? "/home/user";
    if (!command || !command.trim()) {
      return { error: "No command provided" };
    }
    const apiKey = ctx.e2bApiKey ?? ctx.sandboxApiKey;
    if (!apiKey) {
      return {
        error:
          "Terminal execution requires an E2B Sandbox API key. Add one in Settings → Config → E2B Sandbox.",
        exit_code: -1,
        stdout: "",
        stderr: "E2B Sandbox API key not configured",
      };
    }

    try {
      // AWAIT the sync so the sandbox sees the latest OPFS files before
      // the terminal command runs. Previously fire-and-forget (`void ...`)
      // which caused `cat file.txt` to show old content after `write_file`
      // had updated it in OPFS — the sync hadn't finished yet.
      await syncOpfsToSandbox(ctx.userId, apiKey);

      const client = getE2BClient(apiKey, ctx.conversationId, ctx.sandboxMode ?? "shared");
      const onOutput = ctx.onToolOutput;

      let stdout = "";
      let stderr = "";
      let exitCode = 0;

      for await (const chunk of client.runCommandStream(command, { cwd, timeout: 120 })) {
        if (chunk.type === "stdout" && chunk.data) {
          stdout += chunk.data;
          if (onOutput) onOutput("", chunk.data, "stdout");
        } else if (chunk.type === "stderr" && chunk.data) {
          stderr += chunk.data;
          if (onOutput) onOutput("", chunk.data, "stderr");
        } else if (chunk.type === "result") {
          exitCode = chunk.exit_code ?? 0;
        }
      }

      // Cap output at 256 KB
      if (stdout.length > 256 * 1024) stdout = stdout.slice(0, 256 * 1024) + "\n... (truncated)";
      if (stderr.length > 256 * 1024) stderr = stderr.slice(0, 256 * 1024) + "\n... (truncated)";

      // Reverse sync: fire-and-forget — don't block the tool result.
      void syncSandboxToOpfs(ctx.userId, apiKey);

      return { exit_code: exitCode, stdout, stderr };
    } catch (e) {
      return {
        error: e instanceof Error ? e.message : String(e),
        exit_code: -1,
        stdout: "",
        stderr: e instanceof Error ? e.message : String(e),
      };
    }
  },
  false,
  "exec",
);

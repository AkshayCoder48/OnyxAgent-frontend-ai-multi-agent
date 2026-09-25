"use client";

/**
 * E2B Sandbox auto-rotation system.
 *
 * E2B sandboxes have a hard lifetime cap — the Hobby plan allows 1h max
 * continuous runtime (the server creates sandboxes with onTimeout:"pause"
 * + autoResume, so a paused sandbox is RESUMED, not lost, but rotation keeps
 * the lifecycle simple). To keep the workspace healthy we auto-rotate the
 * sandbox every 50 minutes:
 *
 *   1. The client sends `rotate` + its CURRENT sandboxId to the server
 *   2. The server backs up ALL files from the old sandbox (BINARY-SAFE
 *      base64 — images, archives, dotfiles included; only volatile shell
 *      state like .bash_history is skipped)
 *   3. Kills ONLY that old sandbox (never anything else)
 *   4. Creates a new sandbox
 *   5. Restores the backup (binary-safe writes)
 *   6. The client updates sandboxId in localStorage + its client cache
 *
 * The rotation is TRANSPARENT — tools don't know it happened. They just
 * call `ensureFreshSandbox(apiKey)` before every file operation and code
 * execution, and the rotation happens automatically if needed.
 *
 * FILE-LOSS SAFETY (PRD §9–10): rotation never kills sandboxes it isn't
 * replacing, and it backs up BEFORE killing — the client sandboxId makes
 * the rotation work even on a serverless cold start (empty server cache).
 * The durable layer for the 24h E2B TTL is the OnyxBase cloud workspace
 * (auto-restore below + push/retrieve_workspace tools).
 */

import { getE2BClient, evictAllE2BClients } from "./client";
import type { ToolContext } from "@/lib/tools/registry";

// 50 minutes — rotate BEFORE the 1-hour E2B sandbox timeout kills the sandbox.
// E2B's max sandbox timeout is 1 hour, so we rotate at 50 min to be safe.
const ROTATION_AGE_MS = 50 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────
// Cloud-workspace auto-restore (PRD §16/§37).
//
// When a BRAND-NEW (empty) E2B sandbox is created and the user has OnyxBase
// configured with a stored cloud workspace, transparently restore it so the
// workspace survives sandbox expiry / app reopens / new sessions.
//
// SAFETY: restore ONLY runs when the sandbox is EMPTY — a sandbox that
// already has files (post-rotation backup/restore, uploads, an earlier
// restore) is NEVER overwritten by an older cloud snapshot. A per-sandbox
// localStorage flag keeps the check to one localStorage read on every
// subsequent call. A module-level mutex prevents concurrent restores.
// ─────────────────────────────────────────────────────────────────────────
let autoRestorePromise: Promise<void> | null = null;

function restoredFlagKey(sandboxId: string): string {
  return `onyxbase-restored:${sandboxId}`;
}

/** Files present in EVERY fresh E2B sandbox (template + app-managed) — a
 *  sandbox containing only these is "empty" for auto-restore purposes.
 *  Volatile shell-state files (.bash_history, .viminfo, …) are included:
 *  they appear the moment the user runs any command but are never user
 *  workspace content, so their presence must not block a cloud restore. */
const FRESH_SANDBOX_BUILTIN = new Set([
  ".bash_logout",
  ".bashrc",
  ".profile",
  ".sudo_as_admin_successful",
  ".bash_history",
  ".wget-hsts",
  ".viminfo",
  ".python_history",
  ".node_repl_history",
  ".lesshst",
  "onyx.md",
  ".onyxagent_files.json",
]);

/** True when the sandbox has NO user content (only template + app-managed
 *  files) — i.e. a cloud snapshot should be restored into it. Syncs the
 *  ignore rules via a lazy import (avoids a static dependency cycle). */
async function isFreshEmptySandbox(files: Array<{ path: string }>): Promise<boolean> {
  const { isExcludedPath } = await import("@/lib/onyxbase/ignore");
  return !files.some(
    (f) => !FRESH_SANDBOX_BUILTIN.has(f.path.toLowerCase()) && !isExcludedPath(f.path),
  );
}

async function runAutoRestore(apiKey: string): Promise<void> {
  try {
    if (typeof window === "undefined") return;
    const { settingsService } = await import("@/lib/services");
    const { useAuthStore } = await import("@/stores");
    const userId = useAuthStore.getState().user?.id;
    if (!userId) return;

    // Unconfigured → silent no-op (never surfaces to the user).
    const obKey = await settingsService.getDecryptedOnyxBaseApiKey(userId);
    if (!obKey || !obKey.trim()) return;

    const client = getE2BClient(apiKey, null, "shared");
    const { id: sandboxId } = await client.createSandbox();
    const flag = restoredFlagKey(sandboxId);
    if (window.localStorage.getItem(flag)) return; // already handled

    const markHandled = () => {
      try {
        window.localStorage.setItem(flag, "1");
      } catch { /* ignore */ }
    };

    // Only a sandbox with NO user content gets the cloud snapshot — never
    // clobber live files (rotation already restored them server-side).
    // Fresh sandboxes always contain template dotfiles + the app-written
    // Onyx.md, so "empty" ignores those (FRESH_SANDBOX_BUILTIN + rules).
    const files = await client.walkFiles();
    if (!(await isFreshEmptySandbox(files))) {
      // Sandbox already has content — nothing to restore, ever, for this
      // sandbox id. Consume the flag so we never re-check it.
      markHandled();
      return;
    }

    const settings = await settingsService.get(userId).catch(() => null);
    const baseUrl = settings?.onyxbase_base_url || undefined;
    const { OnyxBaseKV } = await import("@/lib/onyxbase/kv-client");
    const { getCloudPointer, retrieveWorkspace } = await import(
      "@/lib/onyxbase/workspace-sync"
    );
    const kv = new OnyxBaseKV(obKey, baseUrl);
    // FLAG-CONSUMPTION SAFETY (PRD §9–10): the flag is consumed ONLY after a
    // definitive answer. A transient pointer-read failure (OnyxBase's
    // multi-instance KV can throw on a cold instance) returns WITHOUT
    // setting the flag, so the next ensureFreshSandboxForCtx call retries —
    // the old code marked ATTEMPTED up-front, so one network blip left a
    // fresh sandbox permanently empty with the restore never re-attempted.
    let pointer: Awaited<ReturnType<typeof getCloudPointer>>;
    try {
      pointer = await getCloudPointer(kv);
    } catch {
      return; // transient — flag NOT consumed; retried on a later call
    }
    if (!pointer) {
      markHandled(); // definitively nothing in the cloud for this workspace
      return; // nothing in the cloud yet
    }

    let result: Awaited<ReturnType<typeof retrieveWorkspace>>;
    try {
      result = await retrieveWorkspace({ e2b: client, kv, mode: "restore" });
    } catch {
      // The engine itself threw (bug / hard KV failure). Consume the flag
      // so a broken restore can't loop on every tool call, but tell the
      // user — silence is how "files vanished" went unnoticed before.
      markHandled();
      const { toast } = await import("sonner");
      toast.error("Cloud workspace restore failed", {
        description:
          "The sandbox is empty and the cloud snapshot could not be read. " +
          "Ask Onyx to run retrieve_workspace for a detailed report.",
      });
      return;
    }
    // The restore ATTEMPT completed — consume the flag (failed restores
    // don't retry in a loop; the toasts below surface them honestly).
    markHandled();

    // Best-effort notification — the AI-side retrieve_workspace card shows
    // the detailed glass UI; this toast covers the app-level auto path.
    const { toast } = await import("sonner");
    if (result.ok) {
      toast.success("Cloud workspace restored", {
        description: `${result.restoredFiles} files · ${
          result.downloadedBytes >= 1048576
            ? `${(result.downloadedBytes / 1048576).toFixed(1)} MB`
            : `${Math.max(1, Math.round(result.downloadedBytes / 1024))} KB`
        } from OnyxBase`,
      });
    } else if (result.status === "partial" && result.salvage) {
      // Corrupt snapshot that salvage mode partially recovered — say so
      // honestly instead of silence; the sync card has the full detail.
      toast.warning("Cloud snapshot partially recovered", {
        description:
          `OnyxBase lost part of the snapshot. ${result.salvage.salvagedFiles} file(s) ` +
          "salvaged to .onyx-salvage/ — see the restore card for details.",
      });
    } else if (result.status === "partial") {
      toast.warning("Cloud workspace partially restored", {
        description: `${result.restoredFiles} files restored — some were skipped.`,
      });
    } else if (result.status === "error") {
      // Surface full failures too — silence made users believe their data
      // would come back "in a minute" when it actually needed attention.
      toast.error("Cloud workspace restore failed", {
        description:
          result.errors[0]?.code === "CHECKSUM_MISMATCH"
            ? "OnyxBase lost part of the snapshot — nothing was deleted. Ask Onyx to run retrieve_workspace for a salvage report."
            : (result.errors[0]?.message ?? "See the workspace sync card for details."),
      });
    }
  } catch {
    /* best-effort — never break tool execution. Deliberately does NOT
       consume the flag: infrastructure failures before the restore decision
       remain retryable on a later call (bounded — one attempt per tool call). */
  }
}

/** Fire-and-forget auto-restore guard — called after every sandbox
 *  freshness check. Cheap (one localStorage read) once handled. */
function maybeAutoRestoreWorkspace(apiKey: string): void {
  if (autoRestorePromise) return;
  autoRestorePromise = runAutoRestore(apiKey).finally(() => {
    autoRestorePromise = null;
  });
}

// localStorage keys (per API key).
function createdAtKey(apiKey: string): string {
  return `e2b-sandbox-createdAt:${apiKey}`;
}

function getStoredCreatedAt(apiKey: string): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(createdAtKey(apiKey));
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function setStoredCreatedAt(apiKey: string, ts: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(createdAtKey(apiKey), String(ts));
  } catch {
    // ignore quota errors
  }
}

function clearStoredCreatedAt(apiKey: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(createdAtKey(apiKey));
  } catch {
    // ignore
  }
}

// Module-level mutex — ensures only ONE rotation runs at a time, even if
// multiple tools call ensureFreshSandbox concurrently.
let rotationPromise: Promise<void> | null = null;

/**
 * Resolve the E2B sandbox API key from a tool context.
 *
 * Tries `ctx.e2bApiKey` then `ctx.sandboxApiKey`. If neither is set, falls
 * back to dynamically loading the key from the user's settings (same pattern
 * as e2b_exec.ts — handles the case where subagents build a minimal context
 * without the decrypted key).
 *
 * Returns null if no key is available.
 */
export async function resolveSandboxApiKey(ctx: {
  e2bApiKey?: string;
  sandboxApiKey?: string;
  userId?: string;
}): Promise<string | null> {
  const direct = ctx.e2bApiKey ?? ctx.sandboxApiKey;
  if (direct) return direct;
  try {
    const { settingsService } = await import("@/lib/services");
    const { useAuthStore } = await import("@/stores");
    const userId = ctx.userId || useAuthStore.getState().user?.id;
    if (!userId) return null;
    return await settingsService.getDecryptedSandboxKey(userId);
  } catch {
    return null;
  }
}

/**
 * Ensure the sandbox for the given API key is fresh (< 50 min old).
 *
 * If the sandbox is older than the rotation age (or no creation timestamp is
 * recorded), performs an atomic rotation on the server:
 *   backup → kill old → create → restore.
 *
 * Called before EVERY file operation and code execution. Transparent to
 * callers — never throws (rotation failures are logged and swallowed so
 * the operation can proceed; the next call will retry).
 *
 * Concurrency: a module-level mutex ensures only ONE rotation runs at a
 * time. Concurrent callers wait for the in-progress rotation to finish.
 */
export async function ensureFreshSandbox(apiKey: string): Promise<void> {
  if (!apiKey) return;

  // If rotation is already in progress, wait for it (don't start a second one).
  if (rotationPromise) {
    try {
      await rotationPromise;
    } catch {
      // swallow — the original caller already logged the error
    }
    return;
  }

  const createdAt = getStoredCreatedAt(apiKey);

  // First call — no timestamp stored yet. Touch the sandbox to ensure one
  // exists, then record the timestamp. This is NOT a rotation — we just
  // need to know when the sandbox was first seen so we can rotate it later.
  if (!createdAt) {
    try {
      const client = getE2BClient(apiKey, null, "shared");
      // createSandbox() is idempotent — reuses an existing sandbox if one
      // is already cached on the server, otherwise creates a new one.
      await client.createSandbox();
      setStoredCreatedAt(apiKey, Date.now());
    } catch {
      // best-effort — don't block the operation. The next call will retry.
    }
    return;
  }

  // Still fresh — no rotation needed.
  if (Date.now() - createdAt < ROTATION_AGE_MS) return;

  // Rotation needed — perform it atomically on the server.
  rotationPromise = performRotation(apiKey).finally(() => {
    rotationPromise = null;
  });

  try {
    await rotationPromise;
  } catch (err) {
    console.warn("[sandbox-rotation] rotation failed:", err);
    // Don't rethrow — the operation should proceed even if rotation failed.
    // The next call will try again (the timestamp was cleared by performRotation).
  }
}

/**
 * Perform the actual rotation by calling the server's `rotate` action.
 *
 * The server does: backup (ALL files, binary-safe) → kill the OLD sandbox
 * only → create → restore — all atomically. We pass our CURRENT sandbox ID
 * so the server can find the old sandbox even on a serverless cold start
 * (its in-memory cache is empty there — without the id a cold rotation
 * couldn't back anything up and the workspace would be lost). Afterwards we
 * update the client-side cached sandboxId and creation timestamp.
 */
async function performRotation(apiKey: string): Promise<void> {
  try {
    // The CURRENT sandbox id — the server uses it (as a fallback to its own
    // cache) to back up + replace exactly this sandbox. localStorage is the
    // primary source; the in-memory E2BClient's id is the fallback for when
    // localStorage is unavailable.
    const storedSandboxId =
      typeof window !== "undefined"
        ? window.localStorage.getItem(`e2b-sandbox-id:${apiKey}`)
        : null;
    const currentSandboxId =
      storedSandboxId ??
      getE2BClient(apiKey, null, "shared").peekSandboxId();
    const res = await fetch("/api/sandbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey,
        action: "rotate",
        sandboxMode: "shared",
        sandboxId: currentSandboxId,
      }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const msg =
        (data as { error?: string })?.error ?? `HTTP ${res.status}`;
      throw new Error(`rotate failed: ${msg}`);
    }

    const data = (await res.json()) as {
      sandboxId?: string;
      restored?: number;
      backedUp?: number;
    };

    if (data.sandboxId) {
      // Update localStorage with the NEW sandboxId so the next E2BClient
      // instance picks it up.
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(
            `e2b-sandbox-id:${apiKey}`,
            data.sandboxId,
          );
        } catch {
          // ignore
        }
      }
      // Evict ALL cached E2BClient instances for this apiKey so the next
      // getE2BClient() call creates a fresh client that loads the new
      // sandboxId from localStorage. (The old client still holds a reference
      // to the killed sandbox.)
      evictAllE2BClients();
      // Record the rotation time so we rotate again after the rotation age.
      setStoredCreatedAt(apiKey, Date.now());
      console.log(
        `[sandbox-rotation] rotated to ${data.sandboxId} (backed up ${data.backedUp ?? 0}, restored ${data.restored ?? 0})`,
      );
    } else {
      // No sandboxId returned — rotation failed silently. Clear the
      // timestamp so we try again next time.
      clearStoredCreatedAt(apiKey);
      throw new Error("rotate returned no sandboxId");
    }
  } catch (err) {
    // Clear the timestamp so the next call retries the rotation.
    clearStoredCreatedAt(apiKey);
    throw err;
  }
}

/**
 * Convenience wrapper: resolve the API key from a tool context, then ensure
 * the sandbox is fresh. Returns the resolved API key (or null if none).
 *
 * Used by file tools to do both steps in one call:
 *   const apiKey = await ensureFreshSandboxForCtx(ctx);
 *   if (!apiKey) return { error: "..." };
 */
export async function ensureFreshSandboxForCtx(
  ctx: ToolContext,
): Promise<string | null> {
  const apiKey = await resolveSandboxApiKey(ctx);
  if (!apiKey) return null;
  await ensureFreshSandbox(apiKey);
  // After the sandbox is known-fresh, opportunistically restore the cloud
  // workspace into brand-new empty sandboxes (no-op when unconfigured or
  // already restored — see runAutoRestore).
  maybeAutoRestoreWorkspace(apiKey);
  return apiKey;
}

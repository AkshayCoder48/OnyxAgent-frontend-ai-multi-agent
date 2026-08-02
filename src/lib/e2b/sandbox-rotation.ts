"use client";

/**
 * E2B Sandbox auto-rotation system.
 *
 * E2B sandboxes have a 24-hour hard TTL — after 24h, the sandbox is killed
 * by E2B and all files in it are lost. To prevent data loss, we auto-rotate
 * the sandbox at 23h:
 *
 *   1. Download ALL files from the old sandbox (recursive walk of /home/user)
 *   2. Kill the old sandbox (Sandbox.kill)
 *   3. Create a new sandbox
 *   4. Upload ALL files to the new sandbox (batch_write)
 *   5. Update sandboxId in localStorage + client cache
 *
 * The rotation is TRANSPARENT — tools don't know it happened. They just
 * call `ensureFreshSandbox(apiKey)` before every file operation and code
 * execution, and the rotation happens automatically if needed.
 *
 * SINGLE SANDBOX RULE: the server's `rotate` action kills ALL orphaned
 * sandboxes on the account before creating a new one, enforcing the
 * "one sandbox per API key" rule.
 *
 * Files >500KB are skipped in backup/restore (too large for JSON transport).
 * Binary files are skipped (can't JSON-serialize).
 */

import { getE2BClient, evictAllE2BClients } from "./client";
import type { ToolContext } from "@/lib/tools/registry";

// 23 hours — rotate BEFORE the 24h E2B hard limit kicks in.
const ROTATION_AGE_MS = 23 * 60 * 60 * 1000;

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
 * Ensure the sandbox for the given API key is fresh (< 23h old).
 *
 * If the sandbox is older than 23h (or no creation timestamp is recorded),
 * performs an atomic rotation on the server:
 *   backup → kill → create → restore.
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
 * The server does: killOrphans → backup → kill → create → restore, all
 * atomically. We just need to update the client-side cached sandboxId and
 * creation timestamp afterwards.
 */
async function performRotation(apiKey: string): Promise<void> {
  try {
    const res = await fetch("/api/sandbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey,
        action: "rotate",
        sandboxMode: "shared",
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
      // Record the rotation time so we rotate again in 23h.
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
  return apiKey;
}

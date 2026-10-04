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
 */

import {
  getE2BClient,
  evictAllE2BClients,
  evictE2BClient,
  sandboxIdStorageKey,
  type E2BClient,
} from "./client";
import type { ToolContext } from "@/lib/tools/registry";

// 50 minutes — rotate BEFORE the 1-hour E2B sandbox timeout kills the sandbox.
// E2B's max sandbox timeout is 1 hour, so we rotate at 50 min to be safe.
const ROTATION_AGE_MS = 50 * 60 * 1000;

// localStorage keys (per rotation target).
function createdAtKey(t: SandboxTarget): string {
  // Shared targets keep the LEGACY per-apiKey key (no migration); separate
  // targets scope the timestamp per conversation so each chat's sandbox
  // rotates on its own 50-minute schedule.
  return t.mode === "separate" && t.conversationId
    ? `e2b-sandbox-createdAt:${t.apiKey}:${t.conversationId}`
    : `e2b-sandbox-createdAt:${t.apiKey}`;
}

function getStoredCreatedAt(t: SandboxTarget): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(createdAtKey(t));
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function setStoredCreatedAt(t: SandboxTarget, ts: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(createdAtKey(t), String(ts));
  } catch {
    // ignore quota errors
  }
}

function clearStoredCreatedAt(t: SandboxTarget): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(createdAtKey(t));
  } catch {
    // ignore
  }
}

// Module-level mutexes — one in-progress rotation PER TARGET, so a shared
// rotation never blocks (or gets blocked by) a per-chat rotation, and two
// different chats can rotate concurrently while the same chat coalesces.
const rotationPromises = new Map<string, Promise<void>>();

/** Which sandbox a tool operates on. (apiKey, conversationId, mode) — the
 *  same triple `getE2BClient` caches clients by, so rotation and tool calls
 *  can never disagree about WHICH sandbox they are keeping fresh. */
export interface SandboxTarget {
  apiKey: string;
  conversationId: string | null;
  mode: "shared" | "separate";
}

/** Mutex key — per (apiKey, conversationId, mode). */
function targetMutexKey(t: SandboxTarget): string {
  return t.mode === "separate" && t.conversationId
    ? `${t.apiKey}:${t.conversationId}:separate`
    : `${t.apiKey}:shared`;
}

/** The (cached) E2B client for a target. */
export function targetE2BClient(t: SandboxTarget): E2BClient {
  return getE2BClient(t.apiKey, t.conversationId, t.mode);
}

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
 * Ensure the sandbox for the given target is fresh (< 50 min old).
 *
 * If the sandbox is older than the rotation age (or no creation timestamp is
 * recorded), performs an atomic rotation on the server:
 *   backup → kill old → create → restore.
 *
 * The optional `target` selects WHICH sandbox: omitting it (or passing the
 * default) rotates the legacy user-level SHARED sandbox exactly as before;
 * passing `{ conversationId, mode: "separate" }` rotates THAT conversation's
 * own sandbox. Timestamps, the localStorage
 * sandbox-id slot and the rotation mutex are all per-target.
 *
 * Called before EVERY file operation and code execution. Transparent to
 * callers — never throws (rotation failures are logged and swallowed so
 * the operation can proceed; the next call will retry).
 *
 * Concurrency: one in-progress rotation PER TARGET. Concurrent callers for
 * the same target wait for the in-progress rotation; other targets (other
 * chats, the shared sandbox) rotate independently.
 */
export async function ensureFreshSandbox(
  apiKey: string,
  target?: { conversationId?: string | null; mode?: "shared" | "separate" },
): Promise<void> {
  if (!apiKey) return;
  const t: SandboxTarget = {
    apiKey,
    conversationId: target?.conversationId ?? null,
    mode: target?.mode ?? "shared",
  };

  // If rotation is already in progress FOR THIS TARGET, wait for it (don't
  // start a second one). Other targets rotate on their own schedules.
  const inProgress = rotationPromises.get(targetMutexKey(t));
  if (inProgress) {
    try {
      await inProgress;
    } catch {
      // swallow — the original caller already logged the error
    }
    return;
  }

  const createdAt = getStoredCreatedAt(t);

  // First call — no timestamp stored yet for this target. Touch the sandbox
  // to ensure one exists, then record the timestamp. This is NOT a rotation
  // — we just need to know when the sandbox was first seen so we can rotate
  // it later.
  if (!createdAt) {
    try {
      // createSandbox() is idempotent — reuses the existing sandbox for
      // this target (shared: per apiKey; separate: per apiKey+conversation)
      // or creates a new one.
      await targetE2BClient(t).createSandbox();
      setStoredCreatedAt(t, Date.now());
    } catch {
      // best-effort — don't block the operation. The next call will retry.
    }
    return;
  }

  // Still fresh — no rotation needed.
  if (Date.now() - createdAt < ROTATION_AGE_MS) return;

  // Rotation needed — perform it atomically on the server.
  const rotation = performRotation(t).finally(() => {
    rotationPromises.delete(targetMutexKey(t));
  });
  rotationPromises.set(targetMutexKey(t), rotation);

  try {
    await rotation;
  } catch (err) {
    console.warn("[sandbox-rotation] rotation failed:", err);
    // Don't rethrow — the operation should proceed even if rotation failed.
    // The next call will try again (the timestamp was cleared by performRotation).
  }
}

/**
 * Perform the actual rotation of ONE target's sandbox by calling the
 * server's `rotate` action.
 *
 * The server does: backup (ALL files, binary-safe) → kill the OLD sandbox
 * only → create → restore — all atomically, scoped to the target's
 * (apiKey, conversationId, mode) cache key. We pass our CURRENT sandbox ID
 * so the server can find the old sandbox even on a serverless cold start
 * (its in-memory cache is empty there — without the id a cold rotation
 * couldn't back anything up and the workspace would be lost). Afterwards we
 * update the client-side cached sandboxId (in the target's PER-MODE
 * localStorage slot — shared = the legacy key, separate = the per-chat key)
 * and the creation timestamp.
 */
async function performRotation(t: SandboxTarget): Promise<void> {
  try {
    // The CURRENT sandbox id — the server uses it (as a fallback to its own
    // cache) to back up + replace exactly this sandbox. localStorage is the
    // primary source; the in-memory E2BClient's id is the fallback for when
    // localStorage is unavailable. The key is PER-MODE (see client.ts's
    // sandboxIdStorageKey) so a per-chat rotation reads THIS chat's id.
    const idKey = sandboxIdStorageKey(t.apiKey, t.conversationId, t.mode);
    const storedSandboxId =
      typeof window !== "undefined" ? window.localStorage.getItem(idKey) : null;
    const currentSandboxId = storedSandboxId ?? targetE2BClient(t).peekSandboxId();
    const res = await fetch("/api/sandbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: t.apiKey,
        action: "rotate",
        conversationId: t.conversationId,
        sandboxMode: t.mode,
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
      // Update localStorage with the NEW sandboxId (the target's own slot)
      // so the next E2BClient instance picks it up.
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(idKey, data.sandboxId);
        } catch {
          // ignore
        }
      }
      if (t.mode === "separate" && t.conversationId) {
        // Precise eviction — only THIS chat's client is dropped (it reloads
        // its id from its per-chat slot, which we just updated). Every other
        // chat's client keeps its in-memory id.
        evictE2BClient(t.apiKey, t.conversationId, "separate");
      } else {
        // Shared: ALL shared clients for this apiKey persist to the ONE
        // legacy localStorage slot, so every one of them must be evicted to
        // pick up the new id (the legacy behavior — unchanged).
        evictAllE2BClients();
      }
      // Record the rotation time so we rotate again after the rotation age.
      setStoredCreatedAt(t, Date.now());
      console.log(
        `[sandbox-rotation] rotated ${t.mode === "separate" && t.conversationId ? `chat ${t.conversationId.slice(0, 8)}…` : "shared sandbox"} to ${data.sandboxId} (backed up ${data.backedUp ?? 0}, restored ${data.restored ?? 0})`,
      );
    } else {
      // No sandboxId returned — rotation failed silently. Clear the
      // timestamp so we try again next time.
      clearStoredCreatedAt(t);
      throw new Error("rotate returned no sandboxId");
    }
  } catch (err) {
    // Clear the timestamp so the next call retries the rotation.
    clearStoredCreatedAt(t);
    throw err;
  }
}

/**
 * Convenience wrapper: resolve the API key from a tool context, then ensure
 * the SHARED sandbox (the legacy user-level workspace) is fresh. Returns the
 * resolved API key (or null if none).
 *
 * Used by the shared-surface file tools to do both steps in one call:
 *   const apiKey = await ensureFreshSandboxForCtx(ctx);
 *   if (!apiKey) return { error: "..." }
 */
export async function ensureFreshSandboxForCtx(
  ctx: ToolContext,
): Promise<string | null> {
  const apiKey = await resolveSandboxApiKey(ctx);
  if (!apiKey) return null;
  await ensureFreshSandbox(apiKey);
  return apiKey;
}

/** A fully resolved sandbox: the target triple + the live client. */
export interface ResolvedSandbox extends SandboxTarget {
  client: E2BClient;
}

/** Shared-surface tools (image path resolution, security audit, …):
 *  resolve the API key, ensure the user-level shared workspace sandbox is
 *  fresh, and return its client. Returns null when no sandbox key is
 *  configured (callers surface their own no-key error). */
export async function chatSandboxForCtx(
  ctx: ToolContext,
): Promise<ResolvedSandbox | null> {
  const apiKey = await resolveSandboxApiKey(ctx);
  if (!apiKey) return null;
  const target: SandboxTarget = {
    apiKey,
    conversationId: null,
    mode: ctx.sandboxMode ?? "shared",
  };
  await ensureFreshSandbox(apiKey, target);
  return { ...target, client: targetE2BClient(target) };
}

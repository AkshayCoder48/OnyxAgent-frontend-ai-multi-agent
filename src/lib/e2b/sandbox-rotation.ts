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
import { prepareBrowserInBackground, resetBrowserSessionCache } from "./browser-session";
import type { ToolContext } from "@/lib/tools/registry";

// 50 minutes — rotate BEFORE the 1-hour E2B sandbox timeout kills the sandbox.
// E2B's max sandbox timeout is 1 hour, so we rotate at 50 min to be safe.
const ROTATION_AGE_MS = 50 * 60 * 1000;

// Hard client-side deadline for the rotate API call. Generous (10 min):
// rotation is real work — backup (ALL files, binary-safe) → kill → create →
// restore — and a big workspace legitimately takes minutes. The point is a
// BOUND: without one, a wedged rotate fetch held the per-target rotation
// mutex forever and every subsequent tool call awaited the dead promise
// (the "stuck at first tool call forever" report, 2026-11-28).
export const ROTATION_CALL_TIMEOUT_MS = 10 * 60 * 1000;

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
      // ZERO-STARTUP-DELAY PREPARE (CloakBrowser + E2B reimplementation):
      // the sandbox just came up — kick the detached browser runtime
      // install NOW so the CloakBrowser download runs while the user
      // chats. Fire-and-forget; failures are swallowed (the tool-side
      // boot path reports real errors). The server performs the same
      // kick at creation (createAndCacheSandbox → prepareBrowserRuntime);
      // boot.sh's .boot-lock makes the double-kick harmless, and this one
      // covers rotation flows that reuse an existing server instance.
      prepareBrowserInBackground(targetE2BClient(t));
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
    // HARD BUDGET (the "stuck at first tool call" fix, 2026-11-28): rotation
    // is backup → kill → create → restore of an ENTIRE workspace — with a
    // large one this legitimately takes minutes. But a bare fetch has NO
    // browser deadline: a wedged rotation held the per-target mutex FOREVER
    // and every subsequent tool call awaited the dead promise (infinite
    // hang). The budget is generous on purpose (10 min — real work, not a
    // stall); on abort the timestamp is cleared below and the next call
    // retries, so the mutex always frees.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ROTATION_CALL_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch("/api/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: t.apiKey,
          action: "rotate",
          conversationId: t.conversationId,
          sandboxMode: t.mode,
          sandboxId: currentSandboxId,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as { name?: string } | null)?.name === "AbortError") {
        throw new Error(
          `sandbox rotation timed out after ${Math.round(ROTATION_CALL_TIMEOUT_MS / 1000)}s (backup → kill → create → restore) and was aborted — it will be retried on the next tool call`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

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
      /** "running-commands" — the server SKIPPED the rotation because a
       *  live process (background run / in-flight exec) is on the sandbox;
       *  the SAME sandbox id is returned untouched. */
      skipped?: string;
    };

    if (data.sandboxId) {
      const idChanged = data.sandboxId !== currentSandboxId;
      // Update localStorage with the sandboxId (the target's own slot) so
      // the next E2BClient instance picks it up. On a SKIPPED rotation this
      // is a harmless same-value write.
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(idKey, data.sandboxId);
        } catch {
          // ignore
        }
      }
      // Skipped rotation (live background run on the sandbox): the sandbox
      // is UNTOUCHED — its caches are still valid. Only re-stamp the
      // rotation clock so the next attempt happens after the guard window.
      if (data.skipped) {
        setStoredCreatedAt(t, Date.now());
        console.log(
          `[sandbox-rotation] server skipped rotation (${data.skipped}) — a live run keeps this sandbox; it will pause at the E2B timeout and auto-resume instead of being killed`,
        );
        return;
      }
      // A REAL rotation happened (id changed or same-id replacement):
      // the old sandbox is gone. BROWSER SESSION CACHE (CloakBrowser
      // integration): the old driver (and its cached boot promise) is
      // dead. Without this reset the first post-rotation browser action
      // pays a full command timeout (~90s) against a dead driver before
      // the reconnect path re-boots it. The restored
      // ~/.onyx/browser/profile backup keeps cookies + localStorage
      // across the rotation.
      if (idChanged) {
        try {
          resetBrowserSessionCache();
        } catch {
          // best-effort — module init order should never break rotation
        }
        if (t.mode === "separate" && t.conversationId) {
          // Precise eviction — only THIS chat's client is dropped (it
          // reloads its id from its per-chat slot, which we just updated).
          // Every other chat's client keeps its in-memory id.
          evictE2BClient(t.apiKey, t.conversationId, "separate");
        } else {
          // Shared: ALL shared clients for this apiKey persist to the ONE
          // legacy localStorage slot, so every one of them must be evicted
          // to pick up the new id (the legacy behavior — unchanged).
          evictAllE2BClients();
        }
        // The replacement sandbox just came up — kick its browser
        // prepare in the background so the browser is warm before the
        // next use_browser call (the restored ~/.onyx/browser/profile
        // backup keeps the session state across the swap).
        prepareBrowserInBackground(targetE2BClient(t));
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
 *  resolve the API key, ensure the ctx-target sandbox is fresh, and return
 *  its client. Returns null when no sandbox key is configured (callers
 *  surface their own no-key error).
 *
 *  conversationId fix (the "simple tools take 1-3 minutes" report,
 *  2026-11-05): the target now carries ctx.conversationId. It used to be
 *  hardcoded null — in "separate" mode every file tool resolved the
 *  (apiKey, null, separate) slot instead of THIS chat's, hit a dead or
 *  missing sandbox, and paid the full dead-sandbox recovery (fresh create
 *  + library attach ≈ a minute) on the WRONG target. */
export async function chatSandboxForCtx(
  ctx: ToolContext,
): Promise<ResolvedSandbox | null> {
  const apiKey = await resolveSandboxApiKey(ctx);
  if (!apiKey) return null;
  const target: SandboxTarget = {
    apiKey,
    conversationId: ctx.conversationId ?? null,
    mode: ctx.sandboxMode ?? "shared",
  };
  await ensureFreshSandbox(apiKey, target);
  return { ...target, client: targetE2BClient(target) };
}

/** Code-panel tools (code_app / code_preview / code_diagnostics /
 *  code_web_session): the same ctx-resolved target as chatSandboxForCtx.
 *  Historical name kept — the four code_* tools import this symbol (a
 *  refactor removed it and left them type-broken on main; restored
 *  2026-11-05 as a thin alias). */
export const codeSandboxForCtx = chatSandboxForCtx;

// ─── PREWARM (user directive 2026-11-28) ────────────────────────────────────
//
// "if it's due to sandbox start make the sandbox start in chat start not the
//  first message" — the first sandbox tool call of a session used to pay the
// ENTIRE cold-start inline: serverless cold instance → orphan reclaim →
// Sandbox.create → workspace prep (+ 429 backoffs). That is the 2–6 minute
// `verify_path` / `list_folder` / `ls` first-call latency.
//
// prewarmSandbox() kicks the SAME ensureFreshSandbox path the tools use, but
// AT CHAT START — the create (or reconnect to the persisted id / metadata
// lookup) runs while the user is still typing their first message, so by the
// time the first tool call arrives the sandbox exists, is cached server-side,
// and the tool call only pays the actual file operation.

/** In-flight prewarm promise per target — concurrent mounts / re-renders
 *  share one kick (React StrictMode double-mounts, sidebar + page both
 *  prewarming, …). Never persisted: a new page load prewarms again, which
 *  is correct — the serverless instance may have recycled meanwhile. */
const prewarmInFlight = new Map<string, Promise<boolean>>();

/** Re-prewarm when the last successful prewarm is older than this (the page
 *  sits open for hours; the sandbox pauses at the E2B timeout — a fresh
 *  ensureFreshSandbox reconnects/auto-resumes it). */
const PREWARM_STALE_MS = 30 * 60 * 1000;
const prewarmLastOk = new Map<string, number>();

/**
 * Start (or confirm) the user's sandbox NOW — fire-and-forget, never throws.
 *
 * Called at chat-page mount (BEFORE any message is sent). Deduped per
 * (apiKey, conversationId, mode): while one prewarm is in flight, later
 * callers await the SAME promise instead of issuing a second create. When a
 * prewarm already SUCCEEDED recently (< PREWARM_STALE_MS), it's a no-op.
 *
 * Returns (for callers/tests that care): true when the sandbox is warm
 * (this call or a recent earlier one), false when prewarming was impossible
 * (no key) or failed — the normal lazy tool path remains the fallback in
 * that case, so a prewarm failure NEVER breaks the chat.
 */
export async function prewarmSandbox(opts?: {
  userId?: string;
  conversationId?: string | null;
  mode?: "shared" | "separate";
}): Promise<boolean> {
  try {
    // Resolve the key EXACTLY the way the agent runtime will on the first
    // tool call: getEffectiveE2BKey (decrypted vault → legacy localStorage
    // copy → the USE_SERVER_ENV sentinel when the server carries
    // E2B_API_KEY). A cheaper vault-only lookup here would silently skip
    // prewarming for every user on the zero-config server-key lane, and
    // their first tool call would pay the full cold start anyway.
    const { getEffectiveE2BKey } = await import("./env-key");
    const { useAuthStore } = await import("@/stores");
    const userId = opts?.userId ?? useAuthStore.getState().user?.id ?? null;
    const apiKey = userId ? await getEffectiveE2BKey(userId) : null;
    if (!apiKey) return false;

    const target: SandboxTarget = {
      apiKey,
      conversationId: opts?.conversationId ?? null,
      mode: opts?.mode ?? "shared",
    };
    const mutexKey = targetMutexKey(target);

    // Recently warmed — nothing to do.
    const lastOk = prewarmLastOk.get(mutexKey);
    if (lastOk && Date.now() - lastOk < PREWARM_STALE_MS) return true;

    // Dedupe: share the in-flight kick.
    const inFlight = prewarmInFlight.get(mutexKey);
    if (inFlight) return await inFlight;

    const kick = (async (): Promise<boolean> => {
      // ensureFreshSandbox never throws: first call → createSandbox() +
      // timestamp stamp; stale (>50 min) → rotation; fresh → no-op. A
      // failure leaves NO timestamp, so the next call (the first tool
      // call's own ensureFreshSandbox) retries transparently.
      await ensureFreshSandbox(apiKey, target);
      // Warmth signal: the creation stamp is written ONLY on a successful
      // first create / healthy rotation (and persists across reloads for
      // fresh sandboxes — exactly the state the tool path would see). A
      // failed create leaves no stamp → report not-warm so a later prewarm
      // retries instead of caching a false "warm".
      return getStoredCreatedAt(target) !== null;
    })()
      .catch(() => false)
      .finally(() => {
        prewarmInFlight.delete(mutexKey);
      });
    prewarmInFlight.set(mutexKey, kick);
    const ok = await kick;
    if (ok) prewarmLastOk.set(mutexKey, Date.now());
    return ok;
  } catch {
    // Never let a prewarm break anything — it's a pure optimization.
    return false;
  }
}

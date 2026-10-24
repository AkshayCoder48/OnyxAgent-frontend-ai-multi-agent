"use client";

// ============================================================================
// Background Task Execution Framework — FR-1.3 rotational key pool.
//
// Builds the per-trigger pool of DECRYPTED provider API keys handed to the
// orchestrator (TaskTriggerRequest.keyPool): the sandbox runner rotates
// through it so a single rate-limited key never kills a long background run.
//
// Ordering: the user's preferred provider first, then every other active
// provider. Deduped, capped at TASK_PAYLOAD_BUDGET.maxKeyPool. Each call
// advances a localStorage round-robin index (`onyx:key-rotation`) so
// consecutive TRIGGERS start on different keys — spreading rate limits
// across runs, not just within one.
//
// A locked vault is NOT an error: providers whose keys can't be decrypted
// are skipped silently and an empty pool is returned — the run then uses the
// app's keyless LLM bridge (/api/tasks/llm) by design (PRD §4.2).
// ============================================================================

import { aiProviderService } from "@/lib/services";
import { TASK_PAYLOAD_BUDGET } from "@/lib/tasks/protocol";

/** localStorage round-robin index (int) — advances once per built pool. */
const ROTATION_STORAGE_KEY = "onyx:key-rotation";

export interface BuildKeyPoolOptions {
  userId: string;
  /** Provider id whose key should lead the pool (the active chat provider). */
  preferredProviderId?: string;
}

export interface KeyPool {
  /** Decrypted keys, rotation-started. Empty when none could be decrypted. */
  pool: string[];
  /** True when a rotation was applied (non-empty pool). */
  rotated: boolean;
}

/**
 * Build the rotational key pool for one trigger.
 *
 *  1. Best-effort vault restore from session (mirrors
 *     settingsService.getDecryptedSandboxKey) — a page reload shouldn't
 *     silently empty the pool.
 *  2. List active providers; decrypt each key via
 *     aiProviderService.getDecryptedApiKey — a provider that throws (vault
 *     locked / undecryptable ciphertext) is skipped SILENTLY.
 *  3. Order: preferredProviderId first, then the rest. Dedupe by key value,
 *     cap at TASK_PAYLOAD_BUDGET.maxKeyPool.
 *  4. Rotate the start by the persisted index, then increment it
 *     (round-robin across triggers).
 */
export async function buildKeyPool(opts?: BuildKeyPoolOptions): Promise<KeyPool> {
  const userId = opts?.userId ?? "";
  if (!userId) return { pool: [], rotated: false };

  // (1) Session vault restore — best-effort, never fatal.
  try {
    const { isVaultUnlocked, restoreVaultFromSession } = await import("@/lib/crypto/vault");
    if (!isVaultUnlocked()) {
      await restoreVaultFromSession();
    }
  } catch {
    /* locked vault → empty pool is a valid outcome (bridge fallback) */
  }

  // (2) Active providers, preferred first.
  let providers: Awaited<ReturnType<typeof aiProviderService.list>> = [];
  try {
    providers = await aiProviderService.list(userId, true);
  } catch {
    return { pool: [], rotated: false };
  }
  const preferred = opts?.preferredProviderId;
  const ordered = preferred
    ? [
        ...providers.filter((p) => p.id === preferred),
        ...providers.filter((p) => p.id !== preferred),
      ]
    : providers;

  // (3) Decrypt + dedupe + cap.
  const seen = new Set<string>();
  const pool: string[] = [];
  for (const provider of ordered) {
    if (pool.length >= TASK_PAYLOAD_BUDGET.maxKeyPool) break;
    let key = "";
    try {
      key = await aiProviderService.getDecryptedApiKey(provider.id);
    } catch {
      continue; // vault locked / undecryptable — skip silently (FR-1.3)
    }
    if (!key || seen.has(key)) continue;
    seen.add(key);
    pool.push(key);
  }

  if (pool.length === 0) return { pool: [], rotated: false };

  // (4) Round-robin across triggers.
  let index = 0;
  try {
    const raw =
      typeof window !== "undefined" ? window.localStorage.getItem(ROTATION_STORAGE_KEY) : null;
    const parsed = raw !== null ? Number.parseInt(raw, 10) : Number.NaN;
    if (Number.isFinite(parsed) && parsed >= 0) index = parsed;
  } catch {
    index = 0;
  }
  const start = pool.length > 0 ? index % pool.length : 0;
  const rotatedPool =
    start === 0 ? [...pool] : [...pool.slice(start), ...pool.slice(0, start)];
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(ROTATION_STORAGE_KEY, String(index + 1));
    }
  } catch {
    /* storage unavailable — rotation just restarts next time */
  }
  return { pool: rotatedPool, rotated: true };
}

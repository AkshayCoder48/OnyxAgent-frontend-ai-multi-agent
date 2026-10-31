// ============================================================================
// Background Task Execution Framework — in-memory credential keyring
// (PRD §4.2 credential sandboxing).
//
// The task token (authorizer for the cancel/sync/artifact routes), the
// rotational LLM key pool, the E2B key and the run's pinned chat URL live
// ONLY here — in process memory — for the life of a run. SQLite stores just
// the sha256 hash of the task token (taskTokenHash), so a stolen database
// leaks no credentials and a restarted server can never resurrect them (the
// run's sandbox already has its run.json; the keyring is only needed to
// CREATE and START a run).
//
// BYOK NOTE (user directive 2026-10-31): the task token is NEVER an LLM
// bearer — the keyless bridge that accepted it was removed. LLM calls ride
// the user's own gateway + key pool exclusively.
//
// DISCIPLINE (mirrors chat-proxy):
//   - NEVER persist key material to disk, env or the database.
//   - NEVER log key values — log run ids only.
//   - Entries self-expire after KEYRING_TTL_MS (task cap 30min + slack), so a
//     long-lived process never accumulates stale secrets.
// ============================================================================

import { createHash, timingSafeEqual } from "node:crypto";

/** Keyring entry lifetime — the 30-min task cap (TASK_MAX_DURATION_MS) plus
 *  slack for the finalize/artifact window. Dropped lazily on access. */
const KEYRING_TTL_MS = 35 * 60 * 1000;

export interface KeyringEntry {
  /** Client-minted task token — the authorizer for the cancel/sync/artifact
   *  routes (NEVER an LLM bearer: the bridge that accepted it was removed
   *  with the BYOK policy). */
  taskToken: string;
  /** FR-1.3 rotational provider key pool (ordered by rotation index). */
  keyPool: string[];
  /** User provider chat URL — the run's OWN gateway (required for agent
   *  runs under the BYOK policy; dispatch fails honestly without it). */
  chatUrl?: string;
  /** Model id for the runner. */
  model?: string;
  /** E2B API key captured from the trigger request (or the USE_SERVER_ENV
   *  sentinel — resolved at sandbox-create time). */
  e2bApiKey?: string;
  /** Absolute origin of the app as seen by the triggering request — kept
   *  for diagnostics/worker coordination (the removed LLM bridge used to be
   *  derived from it; the durable-cron tick target still uses APP_URL). */
  appUrl: string;
  createdAt: number;
}

type KeyringMap = Map<string, KeyringEntry> & { __onyx_keyring__?: true };

// globalThis guard: keep one keyring per PROCESS across dev HMR reloads —
// a reload wiping live-run credentials would strand in-flight runs.
const globalForKering = globalThis as unknown as { __onyxTaskKeyring?: KeyringMap };

const store: KeyringMap =
  globalForKering.__onyxTaskKeyring ?? (new Map() as KeyringMap);
globalForKering.__onyxTaskKeyring = store;

/** Lazily evict entries past their TTL. Cheap (O(n) over a tiny map) and
 *  runs on every access path. */
function evictExpired(): void {
  const cutoff = Date.now() - KEYRING_TTL_MS;
  for (const [runId, entry] of store) {
    if (entry.createdAt < cutoff) {
      store.delete(runId);
    }
  }
}

export const keyring = {
  set(runId: string, entry: KeyringEntry): void {
    evictExpired();
    store.set(runId, entry);
  },

  get(runId: string): KeyringEntry | null {
    evictExpired();
    return store.get(runId) ?? null;
  },

  drop(runId: string): void {
    store.delete(runId);
  },

  /** True when the run's entry is alive AND the token matches
   *  (constant-time-ish comparison — length differences still leak, but the
   *  token is a fixed-width hex string in practice). */
  authorize(runId: string, token: string): boolean {
    const entry = store.get(runId);
    if (!entry) return false;
    return tokensEqual(entry.taskToken, token);
  },

  /** Number of live entries (diagnostics only — never the values). */
  get size(): number {
    evictExpired();
    return store.size;
  },
};

/** Constant-time string equality (both sides hashed to fixed width so the
 *  timingSafeEqual length requirement is always satisfied). */
export function tokensEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** sha256 hex of a secret — the ONLY form of the task token that is ever
 *  persisted (TaskRun.taskTokenHash) or compared on the auth routes. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

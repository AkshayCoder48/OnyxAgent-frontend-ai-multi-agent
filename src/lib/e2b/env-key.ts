"use client";

/**
 * Server-side E2B key support.
 *
 * The app stores the user's E2B key locally (encrypted vault + legacy
 * localStorage copy). When NEITHER exists but the server has E2B_API_KEY set
 * in its environment (e.g. configured on Vercel), sandbox features still
 * work: the client sends the ENV_KEY_SENTINEL placeholder and /api/sandbox
 * substitutes the real server-side key. The real key never crosses the wire
 * to the browser.
 */

/** Placeholder sent to /api/sandbox in place of a real key (see resolveApiKey). */
export const ENV_KEY_SENTINEL = "USE_SERVER_ENV";

let cachedHasEnvKey: boolean | null = null;
let inflight: Promise<boolean> | null = null;

/**
 * Does the server have E2B_API_KEY configured? Cached for the session — but
 * ONLY on a CONFIRMED answer. A transient fetch failure (cold start, network
 * blip) leaves the cache UNSET so the next caller retries; the old code
 * cached the failure as `false` for the whole session, which silently
 * disabled the zero-config lane (null key → no reattach, no dispatch) until
 * the next reload.
 */
export async function serverHasE2bEnvKey(): Promise<boolean> {
  if (cachedHasEnvKey !== null) return cachedHasEnvKey;
  if (inflight) return inflight;
  inflight = (async () => {
    let answer: boolean | null = null;
    try {
      const res = await fetch("/api/sandbox", { method: "GET" });
      const data = (await res.json().catch(() => ({}))) as { hasEnvKey?: boolean };
      if (typeof data.hasEnvKey === "boolean") answer = data.hasEnvKey;
    } catch {
      answer = null; // unknown — do NOT cache; the next call retries
    }
    if (answer !== null) cachedHasEnvKey = answer;
    inflight = null;
    return answer ?? false;
  })();
  return inflight;
}

/**
 * The effective E2B key for client → /api/sandbox calls:
 *   1. the decrypted vault key (user-entered in Settings → API Keys), else
 *   2. the legacy localStorage copy, else
 *   3. ENV_KEY_SENTINEL when the server has E2B_API_KEY configured.
 * Returns null when no key is available anywhere.
 */
export async function getEffectiveE2BKey(userId: string): Promise<string | null> {
  const { settingsService } = await import("@/lib/services");
  try {
    const vaultKey = await settingsService.getDecryptedSandboxKey(userId);
    if (vaultKey) return vaultKey;
  } catch {
    // fall through to the env check
  }
  if (await serverHasE2bEnvKey()) return ENV_KEY_SENTINEL;
  // One retry after a beat — a transient cold-start fetch failure on the
  // first check must not kill this turn's key resolution (failures are not
  // cached, so this refetches for real; a CONFIRMED keyless server answers
  // from the cache and only costs the delay).
  await new Promise((r) => setTimeout(r, 600));
  if (await serverHasE2bEnvKey()) return ENV_KEY_SENTINEL;
  return null;
}

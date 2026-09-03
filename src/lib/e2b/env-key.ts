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

/** Does the server have E2B_API_KEY configured? (Cached for the session.) */
export async function serverHasE2bEnvKey(): Promise<boolean> {
  if (cachedHasEnvKey !== null) return cachedHasEnvKey;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch("/api/sandbox", { method: "GET" });
      const data = (await res.json().catch(() => ({}))) as { hasEnvKey?: boolean };
      cachedHasEnvKey = !!data.hasEnvKey;
    } catch {
      cachedHasEnvKey = false;
    }
    inflight = null;
    return cachedHasEnvKey;
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
  return null;
}

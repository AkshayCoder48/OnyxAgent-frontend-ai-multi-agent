// ============================================================================
// Background Task Execution Framework — worker env helpers.
//
// All worker configuration comes from environment variables (set them on the
// Trigger.dev project, or in .env for local `trigger dev`). NOTHING here is
// ever logged with its value — tokens are referenced by name only.
// ============================================================================

/** Fail fast on a missing/empty env var (used at the top of every task). */
export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing required env var ${name} — set it on the Trigger.dev project ` +
        `(or in trigger-worker/.env for local dev; see .env.example)`,
    );
  }
  return value;
}

/** Optional env var ("" when unset/blank). */
export function optionalEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

/** Normalize an app origin (strip trailing slashes). */
export function normalizeOrigin(url: string): string {
  return url.replace(/\/+$/, "");
}

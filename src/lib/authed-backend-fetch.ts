/**
 * @deprecated Backendless mode — this file is no longer used.
 *
 * The original `authedBackendFetch.ts` was a server-side helper that wrapped
 * `backendFetch` with a silent access-token refresh on 401 from the FastAPI
 * backend. In backendless mode there is no FastAPI backend, no JWT tokens,
 * and no API routes: authentication is a local passphrase → PBKDF2 → AES-GCM
 * vault (see `@/lib/crypto/vault`), and every data call goes directly to
 * IndexedDB via `@/lib/services`.
 *
 * This file is kept as an empty stub so that any stray imports don't break
 * the build while the rest of the migration lands. It will be deleted once
 * all API routes have been removed.
 */
export {};

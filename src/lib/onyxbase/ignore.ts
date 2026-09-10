"use client";

/**
 * Workspace ignore rules — safe defaults for what NEVER gets synchronized to
 * the OnyxBase KV cloud workspace (PRD §10).
 *
 * Excluded by default:
 *  - dependency/build/cache directories (huge + regenerable)
 *  - VCS internals (.git)
 *  - temp dirs
 *  - SECRET files (.env*, private keys, credentials, tokens) — these must
 *    NEVER leave the user's machine, let alone reach the cloud.
 *  - app-managed system files (Onyx.md is re-written by the app on every
 *    sandbox boot; syncing it would just churn)
 *
 * The list is intentionally conservative: everything else (source code,
 * configs, assets, documents the user created) syncs.
 */

/** Directory names excluded anywhere in the tree (compared lowercase). */
const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".turbo",
  ".vercel",
  ".cache",
  ".parcel-cache",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "dist",
  "build",
  "out",
  "coverage",
  "tmp",
  "temp",
  ".tmp",
  "__pycache__",
  ".venv",
  "venv",
  "env",
  ".idea",
  ".gradle",
  "target",
  ".terraform",
]);

/** Directory-name patterns never recursed into. */
const EXCLUDED_DIR_PATTERNS: RegExp[] = [/^\.(git|hg|svn)$/];

/** Exact file names excluded (secrets + credentials + app-managed docs). */
const EXCLUDED_FILES = new Set([
  "onyx.md", // app-managed identity doc — rewritten on sandbox boot
  ".onyxagent_files.json", // app-managed upload manifest
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
  ".env.dev",
  ".env.prod",
  ".env.staging",
  ".env.default",
  ".ds_store",
  ".npmrc",
  ".netrc",
  ".pypirc",
  "credentials.json",
  "service-account.json",
  "service_account.json",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "authorized_keys",
  "known_hosts",
  "wallet.dat",
]);

/** Filename patterns excluded (regex tested against the BASE NAME). */
const EXCLUDED_PATTERNS: RegExp[] = [
  /^\.env\./, // .env.anything
  /(^|\.)pem$/i, // *.pem private keys/certs
  /(^|\.)key$/i, // *.key
  /(^|\.)p12$/i, // *.p12 / *.pfx bundles
  /(^|\.)pfx$/i,
  /(^|\.)kdbx$/i, // KeePass vaults
  /^id_rsa_?\w*$/, // id_rsa / id_rsa_github …
  /^id_ed25519_?\w*$/,
];

/** True when a relative workspace path must NOT be synced. */
export function isExcludedPath(relPath: string): boolean {
  if (!relPath) return true;
  const parts = relPath.split("/").filter(Boolean);
  if (parts.length === 0) return true;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (EXCLUDED_DIRS.has(lower)) return true;
    for (const re of EXCLUDED_DIR_PATTERNS) {
      if (re.test(part)) return true;
    }
  }
  const base = parts[parts.length - 1] ?? "";
  const lowerBase = base.toLowerCase();
  if (EXCLUDED_FILES.has(lowerBase)) return true;
  for (const re of EXCLUDED_PATTERNS) {
    if (re.test(base)) return true;
  }
  return false;
}

/** Human-readable reason used in skipped-file reports (null = not excluded). */
export function exclusionReason(relPath: string): string | null {
  const parts = relPath.split("/").filter(Boolean);
  if (parts.length === 0) return "invalid_path";
  const base = parts[parts.length - 1] ?? "";
  const lowerBase = base.toLowerCase();
  const parentDirs = parts.slice(0, -1).map((p) => p.toLowerCase());

  if (parentDirs.some((d) => EXCLUDED_DIRS.has(d)) || EXCLUDED_DIRS.has(lowerBase)) {
    return "excluded_directory";
  }
  if (EXCLUDED_FILES.has(lowerBase) || /^\.env\./.test(base)) return "secret_file";
  for (const re of EXCLUDED_PATTERNS) {
    if (re.test(base)) return "secret_file";
  }
  return null;
}

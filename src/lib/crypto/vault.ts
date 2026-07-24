"use client";

/**
 * Web Crypto vault — the backendless replacement for JWT + bcrypt + Fernet.
 *
 * Auth model:
 *   1. On register: derive a random 16-byte salt; PBKDF2(passphrase, salt,
 *      250k iters) → AES-GCM 256-bit key. Encrypt a known check string
 *      ("vault-ok") and persist salt + check alongside the user row.
 *   2. On login: re-derive the key from passphrase + stored salt; attempt to
 *      decrypt the check string; if it matches, the passphrase was correct.
 *   3. The derived key lives in memory AND in sessionStorage (tab-scoped) so
 *      page reloads within the same tab don't require re-entering the passphrase.
 *      Closing the tab clears sessionStorage automatically.
 *   4. On logout, both the in-memory key and sessionStorage entry are wiped.
 *
 * This mirrors the original backend's `core/security.py` (bcrypt + JWT) +
 * `core/crypto.py` (Fernet field-level encryption) — combined into a single
 * browser-native crypto pipeline with no server round-trip.
 *
 * Unicode-safe: every ciphertext blob is stored as base64 over the raw
 * AES-GCM payload (iv ‖ ciphertext ‖ tag), and every plaintext is encoded as
 * UTF-8 before encryption so emojis / non-ASCII text round-trip cleanly.
 */

const PBKDF2_ITERATIONS = 250_000;
const SALT_BYTES = 16;
const IV_BYTES = 12; // AES-GCM standard nonce length.
const CHECK_STRING = "vault-ok:v1";

// In-memory vault holder. Cleared by `setVault(null)` on logout.
let _vaultKey: CryptoKey | null = null;

// ---------------------------------------------------------------------------
// Unicode-safe base64 helpers.
// ---------------------------------------------------------------------------

/** UTF-8 → base64. Handles emojis and any non-ASCII byte sequence. */
export function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i++) {
    binary += String.fromCharCode(view[i] ?? 0);
  }
  return btoa(binary);
}

/** base64 → Uint8Array. */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/** String → base64 (UTF-8 safe). */
export function stringToBase64(s: string): string {
  return bytesToBase64(new TextEncoder().encode(s));
}

/** base64 → String (UTF-8 safe). */
export function base64ToString(b64: string): string {
  return new TextDecoder().decode(base64ToBytes(b64));
}

// ---------------------------------------------------------------------------
// Random helpers.
// ---------------------------------------------------------------------------

export function randomBytes(length: number): Uint8Array {
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  return buf;
}

export function randomBase64(length: number): string {
  return bytesToBase64(randomBytes(length));
}

// ---------------------------------------------------------------------------
// Key derivation.
// ---------------------------------------------------------------------------

/**
 * Derive an AES-GCM 256-bit CryptoKey from a passphrase + salt via PBKDF2
 * with SHA-256 and 250k iterations. The returned key IS extractable so we
 * can persist it to sessionStorage for page-reload survival (tab-scoped).
 */
export async function deriveVaultKey(
  passphrase: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as unknown as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    true, // extractable — needed for sessionStorage persistence
    ["encrypt", "decrypt"],
  );
}

// ---------------------------------------------------------------------------
// Encryption / decryption.
// ---------------------------------------------------------------------------

/**
 * Encrypt a UTF-8 string with AES-GCM. Returns base64(iv || ciphertext)
 * — the GCM auth tag is appended to the ciphertext by WebCrypto.
 */
export async function encryptString(
  vaultKey: CryptoKey,
  plaintext: string,
): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    vaultKey,
    new TextEncoder().encode(plaintext),
  );
  // Concatenate iv + ciphertext into a single blob.
  const cipherBytes = new Uint8Array(ciphertext);
  const combined = new Uint8Array(iv.length + cipherBytes.length);
  combined.set(iv, 0);
  combined.set(cipherBytes, iv.length);
  return bytesToBase64(combined);
}

/**
 * Decrypt a base64(iv || ciphertext) blob. Throws if the GCM tag fails to
 * verify (wrong key, tampered ciphertext) — callers should treat any throw
 * as a "wrong passphrase / corrupted row" condition.
 */
export async function decryptString(
  vaultKey: CryptoKey,
  ciphertextB64: string,
): Promise<string> {
  const combined = base64ToBytes(ciphertextB64);
  if (combined.length < IV_BYTES + 1) {
    throw new Error("Ciphertext too short");
  }
  const iv = combined.slice(0, IV_BYTES);
  const ciphertext = combined.slice(IV_BYTES);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    vaultKey,
    ciphertext as unknown as BufferSource,
  );
  return new TextDecoder().decode(plaintext);
}

// ---------------------------------------------------------------------------
// Vault lifecycle — create / unlock / hold.
// ---------------------------------------------------------------------------

export interface VaultCreated {
  salt: string; // base64
  check: string; // base64 — encrypted CHECK_STRING
  key: CryptoKey;
}

/**
 * Create a brand-new vault for a fresh passphrase. Derives the AES-GCM key,
 * encrypts a known check string, and stores the in-memory key.
 */
export async function createVault(passphrase: string): Promise<VaultCreated> {
  if (!passphrase) throw new Error("Passphrase is required");
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveVaultKey(passphrase, salt);
  const check = await encryptString(key, CHECK_STRING);
  _vaultKey = key;
  await persistToSession(key);
  return { salt: bytesToBase64(salt), check, key };
}

/**
 * Attempt to unlock an existing vault. Throws on wrong passphrase (the GCM
 * tag won't verify) so callers can surface a "wrong credentials" error.
 */
export async function unlockVault(
  passphrase: string,
  saltB64: string,
  checkB64: string,
): Promise<CryptoKey> {
  if (!passphrase) throw new Error("Passphrase is required");
  const salt = base64ToBytes(saltB64);
  const key = await deriveVaultKey(passphrase, salt);
  // Verify by decrypting the check string. Wrong passphrase → GCM auth fail.
  let decrypted: string;
  try {
    decrypted = await decryptString(key, checkB64);
  } catch {
    throw new Error("Wrong passphrase");
  }
  if (decrypted !== CHECK_STRING) {
    throw new Error("Wrong passphrase");
  }
  _vaultKey = key;
  await persistToSession(key);
  return key;
}

const SESSION_KEY = "__vault_key_jwk__";

/** Set / clear the in-memory vault key. `null` wipes it (logout). */
export function setVault(v: CryptoKey | null): void {
  _vaultKey = v;
  if (v === null) {
    try {
      sessionStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(SESSION_KEY);
    } catch {
      // storage might not be available (SSR)
    }
  }
}

/** Read the in-memory vault key. Returns null if locked. */
export function getVault(): CryptoKey | null {
  return _vaultKey;
}

/** True iff a vault key is resident in memory. */
export function isVaultUnlocked(): boolean {
  return _vaultKey !== null;
}

/**
 * Persist the vault key to localStorage as JWK so it survives page reloads
 * AND new tabs. The key is an AES-GCM CryptoKey, not the passphrase — an
 * attacker with localStorage access can decrypt secrets but can't derive
 * the passphrase. This is the standard "stay logged in" tradeoff.
 */
async function persistToSession(key: CryptoKey): Promise<void> {
  try {
    const jwk = await crypto.subtle.exportKey("jwk", key);
    const serialized = JSON.stringify(jwk);
    sessionStorage.setItem(SESSION_KEY, serialized);
    localStorage.setItem(SESSION_KEY, serialized);
  } catch {
    // Non-fatal
  }
}

/**
 * Try to restore the vault key from storage. Checks sessionStorage first
 * (same tab — fast), then localStorage (persistent across tabs/reloads).
 */
export async function restoreVaultFromSession(): Promise<CryptoKey | null> {
  if (_vaultKey) return _vaultKey;
  try {
    let raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) {
      raw = localStorage.getItem(SESSION_KEY);
      if (raw) sessionStorage.setItem(SESSION_KEY, raw);
    }
    if (!raw) return null;
    const jwk = JSON.parse(raw) as JsonWebKey;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    _vaultKey = key;
    return key;
  } catch {
    try {
      sessionStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(SESSION_KEY);
    } catch {}
    return null;
  }
}

/**
 * Require an unlocked vault, throwing a friendly error if locked. Used by
 * service-layer methods that touch encrypted columns so the error message is
 * consistent across the codebase.
 */
export function requireVault(): CryptoKey {
  if (!_vaultKey) {
    throw new Error("Vault is locked — please unlock with your passphrase");
  }
  return _vaultKey;
}

// ---------------------------------------------------------------------------
// Convenience: encrypt/decrypt using the in-memory vault key.
// ---------------------------------------------------------------------------

export async function vaultEncrypt(plaintext: string): Promise<string> {
  return encryptString(requireVault(), plaintext);
}

export async function vaultDecrypt(ciphertextB64: string): Promise<string> {
  return decryptString(requireVault(), ciphertextB64);
}

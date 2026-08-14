/**
 * Secret vault — AES-256-GCM encryption for API keys and secrets.
 *
 * Secrets are stored encrypted at rest in a separate vault file.
 * The encryption key is derived from a master password (prompted on first use)
 * or from the ONYXAGENT_MASTER_KEY environment variable (for CI).
 *
 * File permissions: 0600 on Unix.
 */

import { createCipheriv, createDecipheriv, scryptSync, randomBytes } from "crypto";
import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import { join } from "path";
import { PATHS } from "./paths.js";

const VAULT_FILE = join(PATHS.config, "vault.enc");
const VAULT_SALT = join(PATHS.config, "vault.salt");
const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

interface VaultData {
  [keyName: string]: string; // decrypted secret value
}

let cachedVault: VaultData | null = null;
let cachedMasterKey: string | null = null;

/**
 * Get the master key from env var or prompt.
 */
export function getMasterKey(): string {
  if (cachedMasterKey) return cachedMasterKey;

  const envKey = process.env.ONYXAGENT_MASTER_KEY;
  if (envKey) {
    cachedMasterKey = envKey;
    return envKey;
  }

  // For non-interactive use, we need the key to be set via env
  if (!process.stdin.isTTY) {
    throw new Error(
      "No master key available. Set ONYXAGENT_MASTER_KEY environment variable for non-interactive use, or run 'onyx setup' interactively."
    );
  }

  // Interactive prompt (simplified — in production use readline with hidden input)
  const { execSync } = require("child_process") as typeof import("child_process");
  // Use `read -s` on Unix to read password without echo
  try {
    const password = execSync("read -s -p 'Enter master password: ' pw && echo $pw", {
      encoding: "utf-8",
      shell: "/bin/bash",
      stdio: ["inherit", "pipe", "pipe"],
    }).trim();
    if (!password) throw new Error("Empty password");
    cachedMasterKey = password;
    return password;
  } catch {
    throw new Error("Failed to read master password");
  }
}

/**
 * Derive an encryption key from the master password + salt.
 */
function deriveKey(masterKey: string, salt: Buffer): Buffer {
  return scryptSync(masterKey, salt, KEY_LENGTH);
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a single Buffer containing: salt + iv + tag + ciphertext.
 */
function encrypt(plaintext: string, masterKey: string): Buffer {
  // Load or create salt
  let salt: Buffer;
  if (existsSync(VAULT_SALT)) {
    salt = readFileSync(VAULT_SALT);
  } else {
    salt = randomBytes(16);
    writeFileSync(VAULT_SALT, salt, { mode: 0o600 });
  }

  const key = deriveKey(masterKey, salt);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // Format: [salt(16)] + [iv(16)] + [tag(16)] + [ciphertext]
  // Salt is stored separately, but we include it for self-contained decryption
  return Buffer.concat([salt, iv, tag, ciphertext]);
}

/**
 * Decrypt a buffer produced by encrypt().
 */
function decrypt(data: Buffer, masterKey: string): string {
  const salt = data.subarray(0, 16);
  const iv = data.subarray(16, 16 + IV_LENGTH);
  const tag = data.subarray(16 + IV_LENGTH, 16 + IV_LENGTH + TAG_LENGTH);
  const ciphertext = data.subarray(16 + IV_LENGTH + TAG_LENGTH);

  const key = deriveKey(masterKey, salt);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return plaintext.toString("utf-8");
}

/**
 * Load the vault from disk and decrypt.
 */
export function loadVault(masterKey?: string): VaultData {
  if (cachedVault) return cachedVault;

  const key = masterKey ?? getMasterKey();

  if (!existsSync(VAULT_FILE)) {
    cachedVault = {};
    return cachedVault;
  }

  try {
    const encryptedData = readFileSync(VAULT_FILE);
    const decrypted = decrypt(encryptedData, key);
    cachedVault = JSON.parse(decrypted) as VaultData;
    return cachedVault;
  } catch {
    throw new Error("Failed to decrypt vault. Wrong master password or corrupted vault file.");
  }
}

/**
 * Save the vault encrypted to disk.
 */
export function saveVault(vault: VaultData, masterKey?: string): void {
  const key = masterKey ?? getMasterKey();
  const json = JSON.stringify(vault, null, 2);
  const encrypted = encrypt(json, key);

  // Atomic write
  const tmpFile = VAULT_FILE + ".tmp";
  writeFileSync(tmpFile, encrypted, { mode: 0o600 });
  renameSync(tmpFile, VAULT_FILE);

  cachedVault = vault;
}

/**
 * Get a secret by name.
 */
export function getSecret(name: string): string | null {
  const vault = loadVault();
  return vault[name] ?? null;
}

/**
 * Set a secret (encrypts and persists).
 */
export function setSecret(name: string, value: string): void {
  const vault = loadVault();
  vault[name] = value;
  saveVault(vault);
}

/**
 * Remove a secret.
 */
export function removeSecret(name: string): boolean {
  const vault = loadVault();
  if (!(name in vault)) return false;
  delete vault[name];
  saveVault(vault);
  return true;
}

/**
 * List secret names (never values).
 */
export function listSecrets(): string[] {
  const vault = loadVault();
  return Object.keys(vault);
}

/**
 * Check if the vault has been initialized (exists on disk).
 */
export function vaultExists(): boolean {
  return existsSync(VAULT_FILE);
}

/**
 * Clear the cached vault + master key (for security between operations).
 */
export function clearVaultCache(): void {
  cachedVault = null;
  cachedMasterKey = null;
}

export { VAULT_FILE };

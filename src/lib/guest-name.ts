/**
 * Guest identity naming — replaces the old "Local User" default.
 *
 * The app auto-creates a local user on first launch (no login screen). The
 * original default full name was literally "Local User", which surfaced as
 * "Welcome to OnyxAgent, Local" on the chat welcome screen — read as a
 * half-finished label. Per user request the default is now a RANDOM,
 * friendly, STABLE-per-install name (generated once, persisted in
 * localStorage, reused on every subsequent launch) — and existing installs
 * whose user row still says "Local User" are healed on auth init.
 */

/** localStorage key holding this install's generated guest name. */
const GUEST_NAME_KEY = "onyx:guest-name";

/** Wordlists for the generated name — adjective + noun ("Brave Falcon"). */
const ADJECTIVES = [
  "Brave",
  "Calm",
  "Clever",
  "Curious",
  "Dazzling",
  "Eager",
  "Gentle",
  "Happy",
  "Merry",
  "Nimble",
  "Serene",
  "Swift",
  "Vivid",
  "Witty",
  "Zealous",
  "Bright",
] as const;

const NOUNS = [
  "Falcon",
  "Nova",
  "Comet",
  "Otter",
  "Ember",
  "Harbor",
  "Lumen",
  "Maple",
  "Orbit",
  "Pebble",
  "Quill",
  "Ripple",
  "Sable",
  "Thistle",
  "Willow",
  "Zephyr",
] as const;

function pick<T>(arr: readonly T[]): T {
  // Math.random is fine here — this is a display name, not a secret.
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/**
 * The legacy default names that should be replaced by a random guest name
 * (existing installs created before this change).
 */
export function isLegacyLocalName(name: string | null | undefined): boolean {
  if (!name) return false;
  const n = name.trim().toLowerCase();
  return n === "local user" || n === "local";
}

/**
 * Get this install's guest name, generating + persisting one on first use.
 * Deterministic per install (the generated name survives reloads); falls
 * back to a fixed name only when storage is unavailable (private mode).
 */
export function getOrCreateGuestName(): string {
  if (typeof window !== "undefined") {
    try {
      const existing = window.localStorage.getItem(GUEST_NAME_KEY);
      if (existing && existing.trim()) return existing.trim();
      const generated = `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
      window.localStorage.setItem(GUEST_NAME_KEY, generated);
      return generated;
    } catch {
      // Storage unavailable — a fresh random name per call is fine here.
    }
  }
  return `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
}

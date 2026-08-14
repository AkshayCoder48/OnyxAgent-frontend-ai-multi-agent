/**
 * Config store — atomic JSON persistence for global CLI configuration.
 *
 * Schema-versioned, atomic writes (temp file + rename), last-known-good backup.
 * Secrets are stored separately in the vault, never in config.
 */

import { readFileSync, writeFileSync, existsSync, renameSync, copyFileSync } from "fs";
import { join } from "path";
import { PATHS } from "./paths.js";

const CONFIG_FILE = join(PATHS.config, "config.json");
const CONFIG_BACKUP = join(PATHS.config, "config.json.bak");
const CONFIG_VERSION = 1;

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  modelType: "chat" | "responses";
  toolsEnabled: boolean;
  noPrefix?: boolean;
  thinkingEnabled?: boolean;
  models: string[];
  hasApiKey: boolean; // never store the actual key here
}

export interface WorkspaceConfig {
  root: string;
  executor: "local" | "e2b";
  authorized: boolean;
  authorizedAt?: string;
  sandboxId?: string;
}

export interface GlobalConfig {
  schemaVersion: number;
  activeProviderId: string | null;
  defaultModel: string | null;
  temperature: number;
  thinkingEffort: "low" | "medium" | "high" | null;
  customSystemPrompt: string;
  systemPromptEnabled: boolean;
  singleRoundMode: boolean;
  autoApprove: boolean;
  appearance: {
    color: "auto" | "always" | "never";
    showReasoning: boolean;
  };
  providers: ProviderConfig[];
  workspaces: WorkspaceConfig[];
  activeWorkspaceRoot: string | null;
  recentWorkspaces: string[];
}

const DEFAULT_CONFIG: GlobalConfig = {
  schemaVersion: CONFIG_VERSION,
  activeProviderId: null,
  defaultModel: null,
  temperature: 0.7,
  thinkingEffort: null,
  customSystemPrompt: "",
  systemPromptEnabled: false,
  singleRoundMode: false,
  autoApprove: false,
  appearance: {
    color: "auto",
    showReasoning: false,
  },
  providers: [],
  workspaces: [],
  activeWorkspaceRoot: null,
  recentWorkspaces: [],
};

let cachedConfig: GlobalConfig | null = null;

/**
 * Load config from disk. Falls back to defaults if missing or corrupt.
 * Creates a backup of the current file before overwriting with defaults.
 */
export function loadConfig(): GlobalConfig {
  if (cachedConfig) return cachedConfig;

  if (!existsSync(CONFIG_FILE)) {
    cachedConfig = { ...DEFAULT_CONFIG };
    return cachedConfig;
  }

  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<GlobalConfig>;

    // Schema migration: if parsed.schemaVersion !== CONFIG_VERSION, migrate here
    cachedConfig = { ...DEFAULT_CONFIG, ...parsed, schemaVersion: CONFIG_VERSION };
    return cachedConfig;
  } catch (err) {
    // Config is corrupt — back it up and start fresh
    if (existsSync(CONFIG_FILE)) {
      try {
        copyFileSync(CONFIG_FILE, CONFIG_FILE + ".corrupt");
      } catch {}
    }
    console.error("Warning: config was corrupt, starting fresh. Backup saved as config.json.corrupt");
    cachedConfig = { ...DEFAULT_CONFIG };
    return cachedConfig;
  }
}

/**
 * Save config atomically (temp file + rename). Maintains a backup.
 */
export function saveConfig(config: GlobalConfig): void {
  const json = JSON.stringify(config, null, 2);

  // Backup current config if it exists
  if (existsSync(CONFIG_FILE)) {
    try {
      copyFileSync(CONFIG_FILE, CONFIG_BACKUP);
    } catch {}
  }

  // Write to temp file, then rename (atomic on most platforms)
  const tmpFile = CONFIG_FILE + ".tmp";
  writeFileSync(tmpFile, json, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmpFile, CONFIG_FILE);

  cachedConfig = config;
}

/**
 * Update a partial config and save atomically.
 */
export function updateConfig(updates: Partial<GlobalConfig>): GlobalConfig {
  const current = loadConfig();
  const next = { ...current, ...updates };
  saveConfig(next);
  return next;
}

/**
 * Reset config to defaults.
 */
export function resetConfig(): void {
  saveConfig({ ...DEFAULT_CONFIG });
}

export { CONFIG_FILE, CONFIG_VERSION };

import { loadConfig, saveConfig, resetConfig, type GlobalConfig } from "../lib/config.js";
import { writeFileSync } from "fs";

export async function showConfig(): Promise<void> {
  const config = loadConfig();
  // Redact secrets — they're in the vault, not config
  const safe = { ...config };
  console.log(JSON.stringify(safe, null, 2));
}

export async function getConfig(key: string): Promise<void> {
  const config = loadConfig();
  const value = (config as Record<string, unknown>)[key];
  console.log(value !== undefined ? JSON.stringify(value) : "undefined");
}

export async function setConfig(key: string, value: string): Promise<void> {
  const config = loadConfig();
  // Parse value as JSON if possible
  let parsed: unknown = value;
  try { parsed = JSON.parse(value); } catch {}
  // Handle nested keys like "appearance.color"
  const parts = key.split(".");
  if (parts.length === 1) {
    (config as Record<string, unknown>)[key] = parsed;
  } else {
    let obj: Record<string, unknown> = config as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
      obj = obj[parts[i]!] as Record<string, unknown>;
    }
    obj[parts[parts.length - 1]!] = parsed;
  }
  saveConfig(config);
  console.log(`✓ Set ${key} = ${value}`);
}

export async function resetConfigCmd(): Promise<void> {
  resetConfig();
  console.log("✓ Configuration reset to defaults");
}

export async function exportConfig(path?: string): Promise<void> {
  const config = loadConfig();
  // Never export secrets — they're in the vault
  const json = JSON.stringify(config, null, 2);
  if (path) {
    writeFileSync(path, json);
    console.log(`✓ Exported to ${path}`);
  } else {
    console.log(json);
  }
}

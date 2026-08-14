import { loadConfig } from "../lib/config.js";
import { writeFileSync, rmSync } from "fs";
import { PATHS } from "../lib/paths.js";

export async function exportData(path?: string): Promise<void> {
  const config = loadConfig();
  const json = JSON.stringify({ config, exportedAt: new Date().toISOString() }, null, 2);
  if (path) {
    writeFileSync(path, json, { mode: 0o600 });
    console.log(`✓ Exported to ${path} (no secrets included)`);
  } else {
    console.log(json);
  }
}

export async function resetData(yes?: boolean): Promise<void> {
  if (!yes) {
    console.error("Factory reset requires --yes flag. This will delete ALL config, vault, and workspace state.");
    process.exit(1);
  }
  // Delete config directory
  try { rmSync(PATHS.config, { recursive: true, force: true }); } catch {}
  try { rmSync(PATHS.state, { recursive: true, force: true }); } catch {}
  try { rmSync(PATHS.cache, { recursive: true, force: true }); } catch {}
  console.log("✓ All OnyxAgent CLI data has been deleted.");
}

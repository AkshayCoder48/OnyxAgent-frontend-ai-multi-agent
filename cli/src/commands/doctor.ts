import { loadConfig } from "../lib/config.js";
import { vaultExists, listSecrets } from "../lib/vault.js";
import { existsSync } from "fs";
import { PATHS } from "../lib/paths.js";

export async function runDoctor(): Promise<void> {
  const config = loadConfig();
  console.log("OnyxAgent CLI — Diagnostics\n");

  // Config
  console.log(`Config file: ${PATHS.config}/config.json`);
  console.log(`  Schema version: ${config.schemaVersion}`);
  console.log(`  Active provider: ${config.activeProviderId ?? "none"}`);
  console.log(`  Default model: ${config.defaultModel ?? "none"}`);
  console.log(`  Providers: ${config.providers.length}`);
  console.log(`  Workspaces: ${config.workspaces.length}`);
  console.log(`  Active workspace: ${config.activeWorkspaceRoot ?? "none"}`);

  // Vault
  console.log(`\nVault: ${vaultExists() ? "initialized" : "not initialized"}`);
  if (vaultExists()) {
    try {
      const secrets = listSecrets();
      console.log(`  Secrets: ${secrets.length} (${secrets.join(", ") || "none"})`);
    } catch {
      console.log(`  Secrets: locked — set ONYXAGENT_MASTER_KEY or run interactively to inspect`);
    }
  }

  // Active workspace check
  if (config.activeWorkspaceRoot) {
    const exists = existsSync(config.activeWorkspaceRoot);
    const wsState = existsSync(`${config.activeWorkspaceRoot}/.onyxagent`);
    console.log(`\nWorkspace: ${config.activeWorkspaceRoot}`);
    console.log(`  Exists: ${exists}`);
    console.log(`  Initialized: ${wsState}`);
    const ws = config.workspaces.find((w) => w.root === config.activeWorkspaceRoot);
    if (ws) {
      console.log(`  Executor: ${ws.executor}`);
      console.log(`  Authorized: ${ws.authorized}`);
    }
  }

  // Providers
  if (config.providers.length === 0) {
    console.log("\n⚠ No providers configured. Run 'onyx setup' to add one.");
  }

  console.log("\n✓ Diagnostics complete");
}

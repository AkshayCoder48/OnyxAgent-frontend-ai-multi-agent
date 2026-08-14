import { loadConfig, saveConfig } from "../lib/config.js";

export async function listWorkspaces(): Promise<void> {
  const config = loadConfig();
  for (const ws of config.workspaces) {
    const active = ws.root === config.activeWorkspaceRoot ? " ← active" : "";
    console.log(`  ${ws.root} [${ws.executor}]${active}`);
  }
}

export async function switchWorkspace(path: string): Promise<void> {
  const config = loadConfig();
  const ws = config.workspaces.find((w) => w.root === path);
  if (!ws) {
    console.error(`Workspace not found: ${path}. Run 'onyx init' first.`);
    process.exit(1);
  }
  config.activeWorkspaceRoot = path;
  config.recentWorkspaces = [path, ...config.recentWorkspaces.filter((w) => w !== path)].slice(0, 10);
  saveConfig(config);
  console.log(`✓ Switched to: ${path} [${ws.executor}]`);
}

import { loadConfig, saveConfig } from "../lib/config.js";

export async function getExecutor(): Promise<void> {
  const config = loadConfig();
  const ws = config.workspaces.find((w) => w.root === config.activeWorkspaceRoot);
  console.log(ws?.executor ?? "none");
}

export async function useExecutor(type: string): Promise<void> {
  if (type !== "local" && type !== "e2b") {
    console.error(`Invalid executor: ${type}. Use 'local' or 'e2b'.`);
    process.exit(1);
  }
  const config = loadConfig();
  const ws = config.workspaces.find((w) => w.root === config.activeWorkspaceRoot);
  if (!ws) {
    console.error("No active workspace.");
    process.exit(1);
  }
  ws.executor = type;
  saveConfig(config);
  console.log(`✓ Executor set to: ${type}`);
}

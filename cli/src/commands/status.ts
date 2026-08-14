import { loadConfig } from "../lib/config.js";

export async function showStatus(): Promise<void> {
  const config = loadConfig();
  console.log("OnyxAgent CLI — Status\n");

  const provider = config.providers.find((p) => p.id === config.activeProviderId);
  const workspace = config.workspaces.find((w) => w.root === config.activeWorkspaceRoot);

  console.log(`Provider: ${provider?.name ?? "none"} (${config.activeProviderId ?? "-"})`);
  console.log(`Model: ${config.defaultModel ?? "none"}`);
  console.log(`Temperature: ${config.temperature}`);
  console.log(`Thinking: ${config.thinkingEffort ?? "off"}`);
  console.log(`Single-round: ${config.singleRoundMode ? "on" : "off"}`);
  console.log(`Auto-approve: ${config.autoApprove ? "on" : "off"}`);
  console.log(`Executor: ${workspace?.executor ?? "none"}`);
  console.log(`Workspace: ${config.activeWorkspaceRoot ?? "none"}`);
}

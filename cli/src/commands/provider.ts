import { loadConfig, saveConfig, type ProviderConfig } from "../lib/config.js";
import { getSecret, setSecret, removeSecret } from "../lib/vault.js";
import { testProvider as testProviderConn } from "../lib/provider.js";

export async function listProviders(): Promise<void> {
  const config = loadConfig();
  if (config.providers.length === 0) {
    console.log("No providers configured. Run 'onyx provider add' or 'onyx setup'.");
    return;
  }
  console.log("Providers:\n");
  for (const p of config.providers) {
    const active = p.id === config.activeProviderId ? " ← active" : "";
    console.log(`  ${p.name} (${p.id})${active}`);
    console.log(`    URL: ${p.baseUrl}`);
    console.log(`    Model type: ${p.modelType}`);
    console.log(`    Tools: ${p.toolsEnabled ? "on" : "off"}`);
    console.log(`    Key: ${p.hasApiKey ? "yes" : "no"}`);
    console.log(`    Models: ${p.models.join(", ") || "none"}`);
    console.log();
  }
}

export async function addProvider(): Promise<void> {
  const { createInterface } = await import("readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((r) => rl.question(q, r));

  const name = (await ask("Provider name (e.g., OpenAI, OpenRouter, Ollama): ")).trim();
  const baseUrl = (await ask("Base URL (e.g., https://api.openai.com): ")).trim();
  const apiKey = (await ask("API key (blank for keyless): ")).trim();
  const modelType = ((await ask("Model type [chat/responses] (default: chat): ")).trim() || "chat") as "chat" | "responses";
  const model = (await ask("Default model (e.g., gpt-4o): ")).trim();
  const toolsEnabled = ((await ask("Enable tools? [Y/n]: ")).trim().toLowerCase() !== "n");

  rl.close();

  const id = `provider_${Date.now()}`;
  const provider: ProviderConfig = {
    id,
    name: name || "unnamed",
    baseUrl,
    modelType,
    toolsEnabled,
    models: model ? [model] : [],
    hasApiKey: !!apiKey,
  };

  const config = loadConfig();
  config.providers.push(provider);
  if (!config.activeProviderId) config.activeProviderId = id;
  if (model && !config.defaultModel) config.defaultModel = model;
  saveConfig(config);

  if (apiKey) {
    setSecret(`provider_${id}`, apiKey);
  }

  console.log(`\n✓ Provider "${provider.name}" added (${id})`);
}

export async function useProvider(id: string): Promise<void> {
  const config = loadConfig();
  const provider = config.providers.find((p) => p.id === id);
  if (!provider) {
    console.error(`Provider not found: ${id}`);
    process.exit(1);
  }
  config.activeProviderId = id;
  saveConfig(config);
  console.log(`✓ Active provider set to: ${provider.name}`);
}

export async function removeProvider(id: string): Promise<void> {
  const config = loadConfig();
  const idx = config.providers.findIndex((p) => p.id === id);
  if (idx < 0) {
    console.error(`Provider not found: ${id}`);
    process.exit(1);
  }
  config.providers.splice(idx, 1);
  if (config.activeProviderId === id) {
    config.activeProviderId = config.providers[0]?.id ?? null;
  }
  saveConfig(config);
  // Also remove the provider's secret from the vault
  try {
    removeSecret(`provider_${id}`);
  } catch {
    // Vault may not be accessible — non-fatal
  }
  console.log(`✓ Provider removed: ${id}`);
}

export async function testProviderCmd(id?: string): Promise<void> {
  const config = loadConfig();
  const provider = id
    ? config.providers.find((p) => p.id === id)
    : config.providers.find((p) => p.id === config.activeProviderId);
  if (!provider) {
    console.error(`Provider not found: ${id ?? config.activeProviderId ?? "none"}`);
    process.exit(1);
  }
  const apiKey = provider.hasApiKey ? getSecret(`provider_${provider.id}`) : null;
  console.log(`Testing ${provider.name} (${provider.baseUrl})...`);
  const result = await testProviderConn(provider.baseUrl, apiKey);
  if (result.ok) {
    console.log(`✓ Connected in ${result.latency}ms`);
    console.log(`  Models: ${result.models.slice(0, 10).join(", ")}${result.models.length > 10 ? ` (+${result.models.length - 10} more)` : ""}`);
  } else {
    console.log(`✗ Failed: ${result.error}`);
  }
}

export async function listModels(id?: string): Promise<void> {
  const config = loadConfig();
  const provider = id
    ? config.providers.find((p) => p.id === id)
    : config.providers.find((p) => p.id === config.activeProviderId);
  if (!provider) {
    console.error(`Provider not found`);
    process.exit(1);
  }
  const apiKey = provider.hasApiKey ? getSecret(`provider_${provider.id}`) : null;
  const result = await testProviderConn(provider.baseUrl, apiKey);
  if (result.ok) {
    for (const m of result.models) {
      console.log(m);
    }
  } else {
    console.error(`Failed: ${result.error}`);
    process.exit(1);
  }
}

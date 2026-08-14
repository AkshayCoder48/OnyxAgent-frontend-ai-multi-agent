import { loadConfig, saveConfig } from "../lib/config.js";
import { setSecret, vaultExists } from "../lib/vault.js";

export async function runSetup(): Promise<void> {
  const { createInterface } = await import("readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((r) => rl.question(q, r));

  console.log("OnyxAgent CLI Setup\n");

  // Provider setup
  const providerName = (await ask("Provider name (e.g., OpenAI, OpenRouter, Ollama): ")).trim() || "default";
  const baseUrl = (await ask("Base URL (e.g., https://api.openai.com): ")).trim();
  const apiKey = (await ask("API key (leave blank for keyless/local): ")).trim();
  const model = (await ask("Default model (e.g., gpt-4o): ")).trim() || "gpt-4o";

  const providerId = `provider_${Date.now()}`;
  const config = loadConfig();
  config.providers.push({
    id: providerId,
    name: providerName,
    baseUrl,
    modelType: "chat",
    toolsEnabled: true,
    models: [model],
    hasApiKey: !!apiKey,
  });
  config.activeProviderId = providerId;
  config.defaultModel = model;
  saveConfig(config);

  if (apiKey) {
    setSecret(`provider_${providerId}`, apiKey);
  }

  rl.close();
  console.log("\n✓ Setup complete!");
  console.log(`  Provider: ${providerName} (${providerId})`);
  console.log(`  Model: ${model}`);
  console.log(`  Base URL: ${baseUrl}`);
  console.log(`  API key: ${apiKey ? "saved (encrypted)" : "none"}`);
  console.log(`\n  Run 'onyx chat "Hello!"' to test.`);
}

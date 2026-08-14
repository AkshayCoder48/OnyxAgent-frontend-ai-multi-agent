import { readFileSync } from "fs";
import { loadConfig } from "../lib/config.js";
import { getSecret } from "../lib/vault.js";
import { streamChatCompletion, type ProviderConfig, type ChatMessage, type ToolDefinition } from "../lib/provider.js";
import { LocalExecutor } from "../lib/local-executor.js";

export async function runChat(opts: {
  prompt?: string;
  promptFile?: string;
  model?: string;
  maxRounds: number;
  json?: boolean;
  jsonl?: boolean;
  showReasoning?: boolean;
  singleRound?: boolean;
  yes?: boolean;
}): Promise<void> {
  const config = loadConfig();
  const provider = config.providers.find((p) => p.id === config.activeProviderId);
  if (!provider) {
    console.error("No provider configured. Run 'onyx setup' first.");
    process.exit(1);
  }

  // Get prompt
  let prompt = opts.prompt ?? "";
  if (opts.promptFile) {
    prompt = readFileSync(opts.promptFile, "utf-8");
  }
  if (!prompt) {
    console.error("No prompt provided. Use 'onyx chat \"prompt\"' or '--prompt-file <path>'.");
    process.exit(1);
  }

  // Build provider config
  const apiKey = provider.hasApiKey ? getSecret(`provider_${provider.id}`) : null;
  const providerConfig: ProviderConfig = {
    baseUrl: provider.baseUrl,
    apiKey,
    model: opts.model ?? config.defaultModel ?? provider.models[0] ?? "gpt-4o",
    modelType: provider.modelType,
    toolsEnabled: provider.toolsEnabled,
    noPrefix: provider.noPrefix,
    thinkingEnabled: provider.thinkingEnabled,
    temperature: config.temperature,
  };

  // Build messages
  const messages: ChatMessage[] = [];

  // System prompt
  let systemPrompt = "You are OnyxAgent, a helpful AI assistant. Use tools when needed. Be concise.";
  if (config.systemPromptEnabled && config.customSystemPrompt) {
    systemPrompt = config.customSystemPrompt;
  }
  messages.push({ role: "system", content: systemPrompt });

  // User message
  messages.push({ role: "user", content: prompt });

  // For now, no tools (tools are handled in the agent loop)
  const tools: ToolDefinition[] | undefined = undefined;

  // Stream
  const abortController = new AbortController();
  process.on("SIGINT", () => {
    abortController.abort();
    console.log("\n[Interrupted]");
  });

  try {
    let fullText = "";
    let fullReasoning = "";

    for await (const chunk of streamChatCompletion(providerConfig, messages, tools, abortController.signal)) {
      if (chunk.textDelta) {
        fullText += chunk.textDelta;
        if (!opts.json) {
          process.stdout.write(chunk.textDelta);
        }
      }
      if (chunk.reasoningDelta) {
        fullReasoning += chunk.reasoningDelta;
        if (opts.showReasoning && !opts.json) {
          process.stderr.write(`\x1b[90m${chunk.reasoningDelta}\x1b[0m`);
        }
      }
      if (chunk.done) {
        break;
      }
    }

    if (opts.json) {
      console.log(JSON.stringify({
        content: fullText,
        reasoning: opts.showReasoning ? fullReasoning : undefined,
        model: providerConfig.model,
      }, null, 2));
    } else {
      console.log(); // newline after streaming
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.log("\n[Stopped]");
    } else {
      throw err;
    }
  }
}

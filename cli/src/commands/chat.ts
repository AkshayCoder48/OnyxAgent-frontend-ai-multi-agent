import { readFileSync } from "fs";
import { loadConfig } from "../lib/config.js";
import { getSecret } from "../lib/vault.js";
import type { ProviderConfig } from "../lib/provider.js";
import { LocalExecutor } from "../lib/local-executor.js";
import { E2BExecutor } from "../lib/e2b-executor.js";
import { runAgentLoop } from "../lib/agent-loop.js";
import type { Executor } from "../lib/executor.js";

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

  // Get executor
  const ws = config.workspaces.find((w) => w.root === config.activeWorkspaceRoot);
  let executor: Executor;
  if (ws?.executor === "e2b") {
    const e2bKey = getSecret("e2b");
    if (!e2bKey) {
      console.error("E2B key not set. Run 'onyx key set e2b <key>' or use local executor.");
      process.exit(1);
    }
    executor = new E2BExecutor(e2bKey, ws.sandboxId);
  } else {
    const root = ws?.root ?? process.cwd();
    executor = new LocalExecutor(root);
  }

  // Build system prompt
  let systemPrompt = "You are OnyxAgent, a helpful AI assistant running in a terminal CLI. Use tools when needed. Be concise and helpful.";
  if (config.systemPromptEnabled && config.customSystemPrompt) {
    systemPrompt = config.customSystemPrompt;
  }

  // Set up abort handling
  const abortController = new AbortController();
  process.on("SIGINT", () => {
    abortController.abort();
  });

  // Run agent loop
  try {
    const result = await runAgentLoop({
      provider: providerConfig,
      executor,
      systemPrompt,
      userMessage: prompt,
      maxRounds: opts.maxRounds,
      singleRound: opts.singleRound ?? config.singleRoundMode,
      showReasoning: opts.showReasoning,
      signal: abortController.signal,
      onTextDelta: (delta) => {
        if (!opts.json) {
          process.stdout.write(delta);
        }
      },
      onReasoningDelta: (delta) => {
        if (opts.showReasoning && !opts.json) {
          process.stderr.write(`\x1b[90m${delta}\x1b[0m`);
        }
      },
      onToolCall: (name, args) => {
        if (!opts.json) {
          const argStr = Object.keys(args).length > 0 ? `(${JSON.stringify(args).slice(0, 100)})` : "()";
          console.log(`\n\x1b[33m🔧 ${name}${argStr}\x1b[0m`);
        }
      },
      onToolResult: (_id, result) => {
        if (!opts.json) {
          const status = result.success ? "✓" : "✗";
          const summary = result.success
            ? typeof result.output === "object" && result.output !== null
              ? JSON.stringify(result.output).slice(0, 200)
              : String(result.output).slice(0, 200)
            : result.error ?? "failed";
          console.log(`\x1b[33m  ${status} ${summary}\x1b[0m`);
        }
      },
      onRoundEnd: (round, hasToolCalls) => {
        if (opts.jsonl) {
          console.log(JSON.stringify({ type: "round_end", round, hasToolCalls }));
        }
      },
    });

    if (opts.json) {
      console.log(JSON.stringify({
        content: result.finalContent,
        reasoning: opts.showReasoning ? result.reasoning : undefined,
        toolCalls: result.toolCalls.map((tc) => ({
          name: tc.name,
          args: tc.args,
          success: tc.result?.success,
        })),
        rounds: result.rounds,
        usage: result.usage,
      }, null, 2));
    } else {
      console.log(); // newline after streaming
      if (result.toolCalls.length > 0) {
        console.log(`\n\x1b[90m[Completed in ${result.rounds} round(s), ${result.toolCalls.length} tool call(s)]\x1b[0m`);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.log("\n[Stopped]");
    } else {
      throw err;
    }
  }
}

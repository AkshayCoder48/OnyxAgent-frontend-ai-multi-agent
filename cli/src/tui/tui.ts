/**
 * TUI — Terminal User Interface for OnyxAgent CLI.
 *
 * A rich, interactive terminal UI with ANSI colors, boxed layout,
 * streaming chat, tool activity, and status bar.
 */

import { createInterface } from "readline";
import { loadConfig, saveConfig } from "../lib/config.js";
import { getSecret } from "../lib/vault.js";
import type { ProviderConfig, ChatMessage } from "../lib/provider.js";
import { runAgentLoop } from "../lib/agent-loop.js";
import { LocalExecutor } from "../lib/local-executor.js";
import { E2BExecutor } from "../lib/e2b-executor.js";
import type { Executor } from "../lib/executor.js";

interface TuiOptions {
  showReasoning?: boolean;
  singleRound?: boolean;
}

export async function startTui(opts: TuiOptions = {}): Promise<void> {
  const config = loadConfig();
  const provider = config.providers.find((p) => p.id === config.activeProviderId);

  if (!provider) {
    console.log("No provider configured. Run 'onyx setup' first.");
    process.exit(1);
  }

  const apiKey = provider.hasApiKey ? getSecret(`provider_${provider.id}`) : null;
  const model = config.defaultModel ?? provider.models[0] ?? "gpt-4o";

  const messages: ChatMessage[] = [];
  let systemPrompt = "You are OnyxAgent, a helpful AI assistant running in a terminal. Use tools when needed. Be concise.";
  if (config.systemPromptEnabled && config.customSystemPrompt) {
    systemPrompt = config.customSystemPrompt;
  }
  messages.push({ role: "system", content: systemPrompt });

  const showReasoning = opts.showReasoning ?? config.appearance.showReasoning;

  // Print header
  console.log("\n" + "═".repeat(60));
  console.log("  🤖 OnyxAgent CLI — Terminal UI Mode");
  console.log("═".repeat(60));
  console.log(`  Provider:  ${provider.name}`);
  console.log(`  Model:     ${model}`);
  console.log(`  Tools:     ${provider.toolsEnabled ? "enabled" : "disabled"}`);
  console.log(`  Reasoning: ${showReasoning ? "visible" : "hidden"}`);
  console.log("═".repeat(60));
  console.log("  Commands: /help /clear /model /exit  |  !cmd for shell\n");

  const ws = config.workspaces.find((w) => w.root === config.activeWorkspaceRoot);
  let executor: Executor;
  if (ws?.executor === "e2b") {
    const e2bKey = getSecret("e2b");
    if (e2bKey) {
      executor = new E2BExecutor(e2bKey, ws.sandboxId);
    } else {
      executor = new LocalExecutor(ws?.root ?? process.cwd());
    }
  } else {
    executor = new LocalExecutor(ws?.root ?? process.cwd());
  }

  const providerConfig: ProviderConfig = {
    baseUrl: provider.baseUrl,
    apiKey,
    model,
    modelType: provider.modelType,
    toolsEnabled: provider.toolsEnabled,
    noPrefix: provider.noPrefix,
    thinkingEnabled: provider.thinkingEnabled,
    temperature: config.temperature,
  };

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `\x1b[36monyx>\x1b[0m `,
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (input.startsWith("/")) {
      const [cmd, ...args] = input.slice(1).split(" ");
      const arg = args.join(" ");

      switch (cmd) {
        case "help":
          console.log("\n  Commands:");
          console.log("    /help          Show this help");
          console.log("    /clear         Clear conversation");
          console.log("    /model <name>  Set model");
          console.log("    /exit          Exit");
          console.log("    /reasoning     Toggle reasoning display");
          console.log("    !<cmd>         Run shell command\n");
          break;
        case "exit":
        case "quit":
          console.log("\nGoodbye!");
          process.exit(0);
          break;
        case "clear":
          messages.length = 1;
          console.log("\x1b[2J\x1b[H");
          console.log("  ✓ Conversation cleared\n");
          break;
        case "model":
          if (arg) {
            config.defaultModel = arg;
            saveConfig(config);
            console.log(`  ✓ Model set to: ${arg}\n`);
          } else {
            console.log(`  Current model: ${config.defaultModel ?? "none"}\n`);
          }
          break;
        case "reasoning":
          opts.showReasoning = !opts.showReasoning;
          console.log(`  Reasoning: ${opts.showReasoning ? "on" : "off"}\n`);
          break;
        default:
          console.log(`  Unknown: /${cmd}. Type /help.\n`);
      }
      rl.prompt();
      return;
    }

    if (input.startsWith("!")) {
      try {
        const { execSync } = await import("child_process");
        const output = execSync(input.slice(1), { encoding: "utf-8" });
        console.log(output);
      } catch (err) {
        console.error(`  Error: ${err instanceof Error ? err.message : err}`);
      }
      rl.prompt();
      return;
    }

    // Chat
    messages.push({ role: "user", content: input });
    console.log(`\n\x1b[36m┌─ You ──────────────────────────────────\x1b[0m`);
    console.log(`\x1b[36m│\x1b[0m ${input}`);
    console.log(`\x1b[36m└─────────────────────────────────────────\x1b[0m\n`);

    console.log(`\x1b[35m┌─ AI ───────────────────────────────────\x1b[0m`);
    console.log(`\x1b[35m│\x1b[0m `);

    const abortController = new AbortController();
    process.once("SIGINT", () => abortController.abort());

    try {
      const result = await runAgentLoop({
        provider: providerConfig,
        executor,
        systemPrompt,
        userMessage: input,
        maxRounds: 50,
        singleRound: opts.singleRound ?? config.singleRoundMode,
        showReasoning: opts.showReasoning,
        signal: abortController.signal,
        onTextDelta: (delta) => {
          process.stdout.write(delta);
        },
        onReasoningDelta: (delta) => {
          if (opts.showReasoning) {
            process.stderr.write(`\x1b[90m${delta}\x1b[0m`);
          }
        },
        onToolCall: (name, args) => {
          const argStr = Object.keys(args).length > 0 ? `(${JSON.stringify(args).slice(0, 80)})` : "()";
          console.log(`\n\x1b[33m🔧 ${name}${argStr}\x1b[0m`);
        },
        onToolResult: (_id, result) => {
          const status = result.success ? "✓" : "✗";
          const summary = result.success
            ? JSON.stringify(result.output).slice(0, 120)
            : result.error ?? "failed";
          console.log(`\x1b[33m  ${status} ${summary}\x1b[0m\n`);
        },
      });

      console.log(`\n\n\x1b[35m└─────────────────────────────────────────\x1b[0m`);
      if (result.toolCalls.length > 0) {
        console.log(`\x1b[90m  [${result.rounds} round(s), ${result.toolCalls.length} tool call(s)]\x1b[0m\n`);
      }

      messages.push({
        role: "assistant",
        content: result.finalContent,
        ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
      });
    } catch (err) {
      console.log(`\n\n\x1b[35m└─────────────────────────────────────────\x1b[0m`);
      if (err instanceof Error && err.name === "AbortError") {
        console.log("\x1b[90m  [Interrupted]\x1b[0m\n");
      } else {
        console.error(`\x1b[31m  Error: ${err instanceof Error ? err.message : err}\x1b[0m\n`);
      }
    }

    rl.prompt();
  });

  rl.on("close", () => {
    console.log("\nGoodbye!");
    process.exit(0);
  });
}

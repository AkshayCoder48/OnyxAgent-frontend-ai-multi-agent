/**
 * Interactive REPL — the core agentic terminal experience.
 *
 * Features:
 * - Streaming text output
 * - Optional reasoning display
 * - Live tool-call lines
 * - Ctrl-C to stop current turn
 * - Ctrl-D or /exit to exit
 * - Multi-line prompt entry
 * - Slash commands
 * - !<command> for shell execution
 * - Model/provider/executor indicators
 */

import { createInterface, type Interface as ReadlineInterface } from "readline";
import { loadConfig, saveConfig } from "../lib/config.js";
import { getSecret } from "../lib/vault.js";
import type { ProviderConfig, ChatMessage } from "../lib/provider.js";
import { runAgentLoop } from "../lib/agent-loop.js";
import { LocalExecutor } from "../lib/local-executor.js";
import { E2BExecutor } from "../lib/e2b-executor.js";
import type { Executor } from "../lib/executor.js";

interface ReplOptions {
  json?: boolean;
  jsonl?: boolean;
  showReasoning?: boolean;
  singleRound?: boolean;
}

export async function startRepl(opts: ReplOptions = {}): Promise<void> {
  const config = loadConfig();
  const provider = config.providers.find((p) => p.id === config.activeProviderId);

  if (!provider) {
    console.log("No provider configured. Run 'onyx setup' first.");
    process.exit(1);
  }

  const apiKey = provider.hasApiKey ? getSecret(`provider_${provider.id}`) : null;
  const model = config.defaultModel ?? provider.models[0] ?? "gpt-4o";

  console.log(`\n🤖 OnyxAgent CLI — Interactive Mode`);
  console.log(`   Provider: ${provider.name} (${provider.baseUrl})`);
  console.log(`   Model: ${model}`);
  console.log(`   Type /help for commands, /exit to quit.\n`);

  const messages: ChatMessage[] = [];

  // System prompt
  let systemPrompt = "You are OnyxAgent, a helpful AI assistant. Use tools when needed. Be concise.";
  if (config.systemPromptEnabled && config.customSystemPrompt) {
    systemPrompt = config.customSystemPrompt;
  }
  messages.push({ role: "system", content: systemPrompt });

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `onyx (${model}) > `,
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // Slash commands
    if (input.startsWith("/")) {
      await handleSlashCommand(input, rl, messages, opts);
      rl.prompt();
      return;
    }

    // Shell command
    if (input.startsWith("!")) {
      const cmd = input.slice(1);
      try {
        const { execSync } = await import("child_process");
        const output = execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
        console.log(output);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
      }
      rl.prompt();
      return;
    }

    // Chat message
    messages.push({ role: "user", content: input });

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

    // Get executor
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

    // System prompt
    let systemPrompt = "You are OnyxAgent, a helpful AI assistant running in a terminal CLI. Use tools when needed. Be concise.";
    if (config.systemPromptEnabled && config.customSystemPrompt) {
      systemPrompt = config.customSystemPrompt;
    }

    const abortController = new AbortController();

    process.stdout.write("\x1b[36m"); // cyan for assistant
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
            ? typeof result.output === "object" && result.output !== null
              ? JSON.stringify(result.output).slice(0, 150)
              : String(result.output).slice(0, 150)
            : result.error ?? "failed";
          console.log(`\x1b[33m  ${status} ${summary}\x1b[0m`);
        },
      });
      process.stdout.write("\x1b[0m\n");

      // Add assistant message to history
      messages.push({
        role: "assistant",
        content: result.finalContent,
        ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
      });
    } catch (err) {
      process.stdout.write("\x1b[0m\n");
      if (err instanceof Error && err.name === "AbortError") {
        console.log("[Interrupted]");
      } else {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    rl.prompt();
  });

  rl.on("close", () => {
    console.log("\nGoodbye!");
    process.exit(0);
  });

  // Handle Ctrl-C during streaming (second Ctrl-C exits)
  rl.on("SIGINT", () => {
    console.log("\n[Press Ctrl-C again or /exit to quit]");
    rl.prompt();
  });
}

async function handleSlashCommand(
  input: string,
  rl: ReadlineInterface,
  messages: ChatMessage[],
  opts: ReplOptions,
): Promise<void> {
  const [cmd, ...args] = input.slice(1).split(" ");
  const arg = args.join(" ");

  switch (cmd) {
    case "help":
      console.log(`
Available commands:
  /help              Show this help
  /exit              Exit the CLI
  /clear             Clear conversation history
  /model <name>      Show/set model
  /provider          Show active provider
  /status            Show workspace status
  /reasoning         Toggle reasoning display
  /round             Toggle single-round mode
  /tools             List available tools
  /files             List workspace files
  /history           Show conversation history
  !<command>         Execute shell command
`);
      break;

    case "exit":
    case "quit":
      console.log("Goodbye!");
      process.exit(0);
      break;

    case "clear":
    case "reset":
      messages.length = 0;
      const config = loadConfig();
      let systemPrompt = "You are OnyxAgent, a helpful AI assistant.";
      if (config.systemPromptEnabled && config.customSystemPrompt) {
        systemPrompt = config.customSystemPrompt;
      }
      messages.push({ role: "system", content: systemPrompt });
      console.log("✓ Conversation cleared");
      break;

    case "model":
      if (arg) {
        const config = loadConfig();
        config.defaultModel = arg;
        saveConfig(config);
        rl.setPrompt(`onyx (${arg}) > `);
        console.log(`✓ Model set to: ${arg}`);
      } else {
        const config = loadConfig();
        console.log(`Current model: ${config.defaultModel ?? "none"}`);
      }
      break;

    case "provider":
      const config2 = loadConfig();
      const provider = config2.providers.find((p) => p.id === config2.activeProviderId);
      console.log(`Provider: ${provider?.name ?? "none"}`);
      console.log(`URL: ${provider?.baseUrl ?? "none"}`);
      break;

    case "reasoning":
      opts.showReasoning = !opts.showReasoning;
      console.log(`Reasoning display: ${opts.showReasoning ? "on" : "off"}`);
      break;

    case "round":
      opts.singleRound = !opts.singleRound;
      console.log(`Single-round mode: ${opts.singleRound ? "on" : "off"}`);
      break;

    case "status":
      const { showStatus } = await import("./commands/status.js");
      await showStatus();
      break;

    case "tools":
      const { listTools } = await import("./commands/tool.js");
      await listTools();
      break;

    case "files":
      const { listFiles } = await import("./commands/files.js");
      await listFiles(".");
      break;

    case "history":
      console.log(`Conversation (${messages.length} messages):\n`);
      for (const m of messages) {
        if (m.role === "system") continue;
        const role = m.role.toUpperCase().padEnd(10);
        const content = (m.content ?? "").slice(0, 200);
        console.log(`  ${role} ${content}${m.content && m.content.length > 200 ? "..." : ""}`);
      }
      break;

    default:
      console.log(`Unknown command: /${cmd}. Type /help for available commands.`);
  }
}

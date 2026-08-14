#!/usr/bin/env node
/**
 * OnyxAgent CLI — a first-class terminal agentic workspace.
 *
 * Usage:
 *   onyx                    — start interactive REPL (if in a workspace)
 *   onyx init [dir]         — initialize a new workspace
 *   onyx chat "prompt"      — non-interactive chat
 *   onyx provider list      — manage providers
 *   onyx key set <name>     — manage secrets
 *   onyx --help             — see all commands
 */

import { Command } from "commander";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { ensureDirectories } from "./lib/paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read version from package.json
let version = "0.1.0";
try {
  const pkgPath = join(__dirname, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  version = pkg.version;
} catch {}

const program = new Command();

program
  .name("onyx")
  .description("OnyxAgent CLI — a first-class terminal agentic workspace")
  .version(version, "-v, --version")
  .option("--color <mode>", "color output: auto, always, never", "auto")
  .option("--json", "output machine-readable JSON")
  .option("--jsonl", "stream JSONL events")
  .option("--yes", "auto-confirm prompts (non-interactive)")
  .option("--executor <type>", "override executor: local or e2b")
  .option("--provider <id>", "override active provider ID")
  .option("--model <name>", "override active model")
  .option("--show-reasoning", "show reasoning/thinking content")
  .option("--no-tools", "disable tool calls for this turn")
  .option("--single-round", "enable single-round mode")
  .option("-d, --debug", "enable debug logging")
  .option("--workspace <path>", "override workspace root path");

// --- Commands ---

// init
program
  .command("init [directory]")
  .description("Initialize a new OnyxAgent workspace")
  .option("--executor <type>", "executor type: local or e2b", "local")
  .action(async (directory: string | undefined, opts: { executor: string }) => {
    const { initWorkspace } = await import("./commands/init.js");
    await initWorkspace({ directory, executor: opts.executor, yes: program.opts().yes });
  });

// setup
program
  .command("setup")
  .description("Interactive first-run setup — configure provider, model, and keys")
  .action(async () => {
    const { runSetup } = await import("./commands/setup.js");
    await runSetup();
  });

// doctor
program
  .command("doctor")
  .description("Run diagnostics — check config, vault, providers, executor")
  .action(async () => {
    const { runDoctor } = await import("./commands/doctor.js");
    await runDoctor();
  });

// status
program
  .command("status")
  .description("Show current workspace, provider, model, executor, and config status")
  .action(async () => {
    const { showStatus } = await import("./commands/status.js");
    await showStatus();
  });

// chat / run
program
  .command("chat [prompt]")
  .description("Send a prompt to the AI. Starts interactive REPL if no prompt given.")
  .alias("run")
  .option("--prompt-file <path>", "read prompt from file")
  .option("--model <name>", "override model for this turn")
  .option("--max-rounds <n>", "maximum agent rounds", "50")
  .action(async (prompt: string | undefined, opts: { promptFile?: string; model?: string; maxRounds: string }) => {
    const { runChat } = await import("./commands/chat.js");
    await runChat({
      prompt,
      promptFile: opts.promptFile,
      model: opts.model ?? program.opts().model,
      maxRounds: parseInt(opts.maxRounds, 10),
      json: program.opts().json,
      jsonl: program.opts().jsonl,
      showReasoning: program.opts().showReasoning,
      singleRound: program.opts().singleRound,
      yes: program.opts().yes,
    });
  });

// exec — run a shell command through the executor
program
  .command("exec <command>")
  .description("Execute a shell command in the workspace executor")
  .option("--cwd <path>", "working directory")
  .option("--timeout <ms>", "timeout in milliseconds")
  .action(async (command: string, opts: { cwd?: string; timeout?: string }) => {
    const { runExec } = await import("./commands/exec.js");
    await runExec({ command, cwd: opts.cwd, timeout: opts.timeout ? parseInt(opts.timeout, 10) : undefined });
  });

// python — run Python code through the executor
program
  .command("python [code]")
  .description("Execute Python code in the workspace executor")
  .option("--file <path>", "read code from file")
  .action(async (code: string | undefined, opts: { file?: string }) => {
    const { runPython } = await import("./commands/python.js");
    await runPython({ code, file: opts.file });
  });

// --- Provider commands ---
const provider = program.command("provider").description("Manage AI providers");
provider.command("list").description("List configured providers").action(async () => {
  const { listProviders } = await import("./commands/provider.js");
  await listProviders();
});
provider.command("add").description("Add a new provider").action(async () => {
  const { addProvider } = await import("./commands/provider.js");
  await addProvider();
});
provider.command("use <id>").description("Set active provider").action(async (id: string) => {
  const { useProvider } = await import("./commands/provider.js");
  await useProvider(id);
});
provider.command("remove <id>").description("Remove a provider").action(async (id: string) => {
  const { removeProvider } = await import("./commands/provider.js");
  await removeProvider(id);
});
provider.command("test [id]").description("Test provider connectivity").action(async (id?: string) => {
  const { testProviderCmd } = await import("./commands/provider.js");
  await testProviderCmd(id);
});
provider.command("models [id]").description("List available models").action(async (id?: string) => {
  const { listModels } = await import("./commands/provider.js");
  await listModels(id);
});

// --- Key commands ---
const key = program.command("key").description("Manage API keys and secrets");
key.command("list").description("List configured secret names").action(async () => {
  const { listKeys } = await import("./commands/key.js");
  await listKeys();
});
key.command("set <name> [value]").description("Set a secret (prompt if value not given)").action(async (name: string, value?: string) => {
  const { setKey } = await import("./commands/key.js");
  await setKey(name, value);
});
key.command("remove <name>").description("Remove a secret").action(async (name: string) => {
  const { removeKey } = await import("./commands/key.js");
  await removeKey(name);
});
key.command("test <name>").description("Test a key (e.g., e2b, langsearch)").action(async (name: string) => {
  const { testKey } = await import("./commands/key.js");
  await testKey(name);
});

// --- Config commands ---
const config = program.command("config").description("Manage CLI configuration");
config.command("show").description("Show current configuration").action(async () => {
  const { showConfig } = await import("./commands/config.js");
  await showConfig();
});
config.command("get <key>").description("Get a config value").action(async (key: string) => {
  const { getConfig } = await import("./commands/config.js");
  await getConfig(key);
});
config.command("set <key> <value>").description("Set a config value").action(async (key: string, value: string) => {
  const { setConfig } = await import("./commands/config.js");
  await setConfig(key, value);
});
config.command("reset").description("Reset configuration to defaults").action(async () => {
  const { resetConfig } = await import("./commands/config.js");
  await resetConfig();
});
config.command("export [path]").description("Export configuration (no secrets)").action(async (path?: string) => {
  const { exportConfig } = await import("./commands/config.js");
  await exportConfig(path);
});

// --- Files commands ---
const files = program.command("files").description("Manage workspace files");
files.command("list [path]").description("List files in a directory").action(async (path?: string) => {
  const { listFiles } = await import("./commands/files.js");
  await listFiles(path ?? ".");
});
files.command("read <path>").description("Read a file").option("--binary", "read as binary").action(async (path: string, opts: { binary?: boolean }) => {
  const { readFile } = await import("./commands/files.js");
  await readFile(path, opts.binary);
});
files.command("write <path> [content]").description("Write to a file").option("--stdin", "read from stdin").action(async (path: string, content?: string, opts?: { stdin?: boolean }) => {
  const { writeFile } = await import("./commands/files.js");
  await writeFile(path, content, opts?.stdin);
});
files.command("delete <path>").description("Delete a file").action(async (path: string) => {
  const { deleteFile } = await import("./commands/files.js");
  await deleteFile(path);
});
files.command("search <query>").description("Search file contents").action(async (query: string) => {
  const { searchFiles } = await import("./commands/files.js");
  await searchFiles(query);
});

// --- Chat history commands ---
const chat = program.command("chat-history").description("Manage conversation history");
chat.command("list").description("List conversations").action(async () => {
  const { listChats } = await import("./commands/chat-history.js");
  await listChats();
});
chat.command("show <id>").description("Show a conversation").action(async (id: string) => {
  const { showChat } = await import("./commands/chat-history.js");
  await showChat(id);
});
chat.command("delete <id>").description("Delete a conversation").action(async (id: string) => {
  const { deleteChat } = await import("./commands/chat-history.js");
  await deleteChat(id);
});

// --- Workspace commands ---
const workspace = program.command("workspace").description("Manage workspaces");
workspace.command("list").description("List known workspaces").action(async () => {
  const { listWorkspaces } = await import("./commands/workspace.js");
  await listWorkspaces();
});
workspace.command("switch <path>").description("Switch to a workspace").action(async (path: string) => {
  const { switchWorkspace } = await import("./commands/workspace.js");
  await switchWorkspace(path);
});

// --- Executor commands ---
const executor = program.command("executor").description("Manage executor");
executor.command("get").description("Show current executor").action(async () => {
  const { getExecutor } = await import("./commands/executor.js");
  await getExecutor();
});
executor.command("use <type>").description("Set executor: local or e2b").action(async (type: string) => {
  const { useExecutor } = await import("./commands/executor.js");
  await useExecutor(type);
});

// --- Tool commands ---
const tool = program.command("tool").description("Manage tools");
tool.command("list").description("List available tools").action(async () => {
  const { listTools } = await import("./commands/tool.js");
  await listTools();
});

// --- Data commands ---
const data = program.command("data").description("Data management");
data.command("export [path]").description("Export data (no secrets)").action(async (path?: string) => {
  const { exportData } = await import("./commands/data.js");
  await exportData(path);
});
data.command("reset").description("Factory reset — delete all config, vault, and workspace data").action(async () => {
  const { resetData } = await import("./commands/data.js");
  await resetData(program.opts().yes);
});

// Default action — start REPL if in a workspace, otherwise show help
program.action(async () => {
  const opts = program.opts();
  if (opts.help) {
    program.help();
    return;
  }
  // Try to start the interactive REPL
  const { startRepl } = await import("./repl/repl.js");
  await startRepl({
    json: opts.json,
    jsonl: opts.jsonl,
    showReasoning: opts.showReasoning,
    singleRound: opts.singleRound,
  });
});

// Parse arguments — ensure directories exist first
ensureDirectories();
program.parseAsync(process.argv).catch((err) => {
  if (err instanceof Error) {
    console.error(`Error: ${err.message}`);
    if (program.opts().debug) {
      console.error(err.stack);
    }
  } else {
    console.error(`Error: ${err}`);
  }
  process.exit(1);
});

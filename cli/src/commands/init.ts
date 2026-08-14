import { resolve, isAbsolute, join } from "path";
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "fs";
import { loadConfig, saveConfig, updateConfig, type WorkspaceConfig } from "../lib/config.js";
import { getWorkspaceStateDir, ensureDirectories } from "../lib/paths.js";

export async function initWorkspace(opts: {
  directory?: string;
  executor: string;
  yes?: boolean;
}): Promise<void> {
  const dir = opts.directory ?? process.cwd();
  const targetDir = isAbsolute(dir) ? resolve(dir) : resolve(process.cwd(), dir);
  const executor = opts.executor === "e2b" ? "e2b" : "local";

  // Check if directory exists
  if (!existsSync(targetDir)) {
    const confirmed = opts.yes || (await confirm(`Create "${targetDir}" and authorize OnyxAgent to read, create, edit, rename, and delete files and execute commands only inside this directory?`, false));
    if (!confirmed) {
      console.log("Operation cancelled — no directory was created.");
      process.exit(0);
    }
    mkdirSync(targetDir, { recursive: true });
  }

  // Check if already initialized
  const stateDir = getWorkspaceStateDir(targetDir);
  if (existsSync(stateDir)) {
    console.log(`Workspace already initialized at ${targetDir}`);
    process.exit(0);
  }

  // Create .onyxagent state directory
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(stateDir, "conversations"), { recursive: true });

  // Set restrictive permissions
  try { chmodSync(stateDir, 0o700); } catch {}

  // Write workspace metadata
  const workspaceMeta: WorkspaceConfig = {
    root: targetDir,
    executor: executor as "local" | "e2b",
    authorized: true,
    authorizedAt: new Date().toISOString(),
  };
  writeFileSync(
    join(stateDir, "workspace.json"),
    JSON.stringify(workspaceMeta, null, 2),
    { mode: 0o600 },
  );

  // Add to global config
  const config = loadConfig();
  const existing = config.workspaces.findIndex((w) => w.root === targetDir);
  if (existing >= 0) {
    config.workspaces[existing] = workspaceMeta;
  } else {
    config.workspaces.push(workspaceMeta);
  }
  config.activeWorkspaceRoot = targetDir;
  config.recentWorkspaces = [targetDir, ...config.recentWorkspaces.filter((w) => w !== targetDir)].slice(0, 10);
  saveConfig(config);

  console.log(`✓ Workspace initialized at ${targetDir}`);
  console.log(`  Executor: ${executor}`);
  console.log(`  State: ${stateDir}`);
  if (executor === "e2b") {
    console.log(`\n  Next: set your E2B key with 'onyx key set e2b'`);
  } else {
    console.log(`\n  Next: configure a provider with 'onyx provider add'`);
  }
}

async function confirm(message: string, defaultValue: boolean): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return defaultValue;
  }
  const { createInterface } = await import("readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith("y"));
    });
  });
}

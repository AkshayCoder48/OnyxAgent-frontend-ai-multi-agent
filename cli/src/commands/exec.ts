import { loadConfig } from "../lib/config.js";
import { LocalExecutor } from "../lib/local-executor.js";

export async function runExec(opts: { command: string; cwd?: string; timeout?: number }): Promise<void> {
  const config = loadConfig();
  const ws = config.workspaces.find((w) => w.root === config.activeWorkspaceRoot);
  if (!ws) {
    console.error("No active workspace. Run 'onyx init' first.");
    process.exit(1);
  }
  const exec = new LocalExecutor(ws.root);
  const result = await exec.runCommand(opts.command, {
    cwd: opts.cwd,
    timeout: opts.timeout,
    onStdout: (chunk) => process.stdout.write(chunk),
    onStderr: (chunk) => process.stderr.write(chunk),
  });
  console.log(`\n[exit ${result.exitCode}, ${result.durationMs}ms]`);
  process.exit(result.exitCode);
}

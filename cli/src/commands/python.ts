import { readFileSync } from "fs";
import { loadConfig } from "../lib/config.js";
import { LocalExecutor } from "../lib/local-executor.js";

export async function runPython(opts: { code?: string; file?: string }): Promise<void> {
  const config = loadConfig();
  const ws = config.workspaces.find((w) => w.root === config.activeWorkspaceRoot);
  if (!ws) {
    console.error("No active workspace. Run 'onyx init' first.");
    process.exit(1);
  }
  const exec = new LocalExecutor(ws.root);

  let code = opts.code ?? "";
  if (opts.file) {
    code = readFileSync(opts.file, "utf-8");
  }
  if (!code) {
    console.error("No code provided. Use 'onyx python <code>' or '--file <path>'.");
    process.exit(1);
  }

  const result = await exec.runPython(code, {
    onStdout: (chunk) => process.stdout.write(chunk),
    onStderr: (chunk) => process.stderr.write(chunk),
  });
  console.log(`\n[exit ${result.exitCode}, ${result.durationMs}ms]`);
}

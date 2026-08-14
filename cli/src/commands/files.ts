import { loadConfig } from "../lib/config.js";
import { LocalExecutor } from "../lib/local-executor.js";

async function getExecutor() {
  const config = loadConfig();
  const ws = config.workspaces.find((w) => w.root === config.activeWorkspaceRoot);
  if (!ws) {
    console.error("No active workspace. Run 'onyx init' first.");
    process.exit(1);
  }
  return new LocalExecutor(ws.root);
}

export async function listFiles(path: string): Promise<void> {
  const exec = await getExecutor();
  const files = await exec.listFiles(path);
  for (const f of files) {
    const size = f.size ? ` (${(f.size / 1024).toFixed(1)}KB)` : "";
    const type = f.isDirectory ? "📁" : "📄";
    console.log(`  ${type} ${f.path}${size}`);
  }
}

export async function readFile(path: string, binary?: boolean): Promise<void> {
  const exec = await getExecutor();
  const content = await exec.readFile(path, binary ? "binary" : "utf-8");
  if (typeof content === "string") {
    process.stdout.write(content);
  } else {
    process.stdout.write(Buffer.from(content));
  }
}

export async function writeFile(path: string, content?: string, stdin?: boolean): Promise<void> {
  const exec = await getExecutor();
  let data = content ?? "";
  if (stdin || (!content && process.stdin.isTTY === false)) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    data = Buffer.concat(chunks).toString("utf-8");
  }
  await exec.writeFile(path, data);
  console.log(`✓ Wrote ${data.length} bytes to ${path}`);
}

export async function deleteFile(path: string): Promise<void> {
  const exec = await getExecutor();
  await exec.deleteFile(path);
  console.log(`✓ Deleted ${path}`);
}

export async function searchFiles(query: string): Promise<void> {
  const exec = await getExecutor();
  const results = await exec.searchFiles(query);
  if (results.length === 0) {
    console.log("No matches found.");
    return;
  }
  for (const r of results) {
    console.log(`${r.path}:${r.line}: ${r.text}`);
  }
}

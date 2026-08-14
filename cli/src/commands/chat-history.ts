import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { loadConfig } from "../lib/config.js";
import { getWorkspaceStateDir } from "../lib/paths.js";

export async function listChats(): Promise<void> {
  const config = loadConfig();
  const wsRoot = config.activeWorkspaceRoot;
  if (!wsRoot) {
    console.log("No active workspace.");
    return;
  }
  const convDir = join(getWorkspaceStateDir(wsRoot), "conversations");
  if (!existsSync(convDir)) {
    console.log("No conversations.");
    return;
  }
  const files = readdirSync(convDir).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(join(convDir, f), "utf-8"));
      console.log(`  ${f.replace(".json", "")}  ${data.title ?? "untitled"}  (${data.messages?.length ?? 0} msgs)`);
    } catch {}
  }
}

export async function showChat(id: string): Promise<void> {
  const config = loadConfig();
  const wsRoot = config.activeWorkspaceRoot;
  if (!wsRoot) return;
  const convDir = join(getWorkspaceStateDir(wsRoot), "conversations");
  const file = join(convDir, `${id}.json`);
  if (!existsSync(file)) {
    console.error(`Conversation not found: ${id}`);
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(file, "utf-8"));
  for (const msg of data.messages ?? []) {
    const role = msg.role.toUpperCase().padEnd(10);
    console.log(`${role} ${msg.content ?? ""}`);
    if (msg.toolCalls?.length) {
      for (const tc of msg.toolCalls) {
        console.log(`  🔧 ${tc.name}(${JSON.stringify(tc.args).slice(0, 100)})`);
      }
    }
    console.log();
  }
}

export async function deleteChat(id: string): Promise<void> {
  const { unlinkSync } = await import("fs");
  const config = loadConfig();
  const wsRoot = config.activeWorkspaceRoot;
  if (!wsRoot) return;
  const convDir = join(getWorkspaceStateDir(wsRoot), "conversations");
  unlinkSync(join(convDir, `${id}.json`));
  console.log(`✓ Deleted conversation: ${id}`);
}

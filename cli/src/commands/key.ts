import { listSecrets, setSecret, removeSecret, getSecret } from "../lib/vault.js";

export async function listKeys(): Promise<void> {
  const secrets = listSecrets();
  if (secrets.length === 0) {
    console.log("No secrets configured.");
    return;
  }
  console.log("Secrets:\n");
  for (const name of secrets) {
    console.log(`  ${name}`);
  }
}

export async function setKey(name: string, value?: string): Promise<void> {
  if (!value) {
    if (!process.stdin.isTTY) {
      console.error("Value required in non-interactive mode.");
      process.exit(1);
    }
    const { createInterface } = await import("readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    // Note: readline doesn't support hidden input natively. For a real CLI,
    // we'd use a library like `inquirer` or a native `read -s` wrapper.
    value = await new Promise<string>((r) => rl.question(`Enter value for ${name}: `, r));
    rl.close();
  }
  setSecret(name, value);
  console.log(`✓ Secret "${name}" saved (encrypted)`);
}

export async function removeKey(name: string): Promise<void> {
  const removed = removeSecret(name);
  if (removed) {
    console.log(`✓ Secret "${name}" removed`);
  } else {
    console.log(`Secret "${name}" not found`);
  }
}

export async function testKey(name: string): Promise<void> {
  const value = getSecret(name);
  if (!value) {
    console.log(`✗ Secret "${name}" not found`);
    process.exit(1);
  }
  // Basic format validation without revealing the value
  if (name === "e2b") {
    console.log(`✓ E2B key present (length: ${value.length})`);
  } else if (name.startsWith("provider_")) {
    console.log(`✓ Provider key present (length: ${value.length})`);
  } else {
    console.log(`✓ Secret "${name}" present (length: ${value.length})`);
  }
}

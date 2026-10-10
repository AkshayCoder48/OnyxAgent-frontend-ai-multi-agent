import ZAI from "z-ai-web-dev-sdk";

/**
 * Shared, lazily-created ZAI client. One process-wide instance — creating it
 * per call would rebuild the SDK (and its config) on every tool/stream use,
 * which is exactly the kind of per-token/per-tool churn the runtime should
 * avoid (tool registry / client memoization).
 */

let cached: Awaited<ReturnType<typeof ZAI.create>> | null = null;

export async function getZai(): Promise<Awaited<ReturnType<typeof ZAI.create>>> {
  if (!cached) cached = await ZAI.create();
  return cached;
}

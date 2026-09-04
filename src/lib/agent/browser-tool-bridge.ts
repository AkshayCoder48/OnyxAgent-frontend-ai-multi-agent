"use client";

/**
 * Browser-tool bridge (v3 FULL TOOLSET) — the browser-side half.
 *
 * The background runner (inside the E2B sandbox) exposes the FULL tool
 * surface to the LLM: tools with native sandbox implementations run there;
 * everything else (browser-registry tools backed by Dexie/OPFS stores —
 * chats, memories, skills, MCP configs, custom tools, subagents, ask_user)
 * is BRIDGED: the runner drops a request file + emits a `browser_tool_call`
 * event; this executor (wired into consumeRun in background-turn.ts) runs
 * the REAL registry handler — the same code the in-browser runtime runs —
 * and writes the result back into the sandbox through /api/sandbox
 * write_file, where the runner's poll picks it up.
 *
 * If the browser is closed, the runner's side times out with a graceful,
 * actionable error and the turn continues — background autonomy is intact.
 */

import { getTool, listTools, type ToolContext } from "@/lib/tools/registry";
import "@/lib/tools"; // Side-effect: registers all built-in tools with the registry.
import { waitForAskUser } from "@/lib/agent/ask-user-wait";
import { settingsService } from "@/lib/services";
import type { WSEvent } from "@/types";

const BRIDGE_DONE_KEY = "onyx-bridge-done";

export interface BrowserToolCall {
  /** Decrypted E2B key (used for the write-back call). */
  e2bApiKey: string;
  /** The run's sandbox — the write-back MUST land there. */
  sandboxId: string;
  runId?: string;
  conversationId: string;
  userId: string;
  /** Provider API key (some tools read ctx.aiApiKey). */
  aiApiKey?: string | null;
  /** Tool call id from the model. */
  callId: string;
  name: string;
  args: Record<string, unknown>;
  /** The WSEvent pipeline (same emit the in-browser runtime uses). */
  emit: (e: WSEvent) => void;
  signal?: AbortSignal;
}

function bridgeDoneKey(call: { runId?: string; sandboxId: string; callId: string }): string {
  return (call.runId ? call.runId + ":" : call.sandboxId + ":") + call.callId;
}

/** Reload-safe dedup: consumeRun replays events from seq 0 after a reload, so
 *  a bridge call that already executed (result already written back) must NOT
 *  run again — e.g. memory_save twice. Marks persist for 24h in localStorage. */
function isBridgeDone(key: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(BRIDGE_DONE_KEY);
    if (!raw) return false;
    const map = JSON.parse(raw) as Record<string, number>;
    return Boolean(map[key]);
  } catch {
    return false;
  }
}

function markBridgeDone(key: string): void {
  if (typeof window === "undefined") return;
  try {
    let map: Record<string, number> = {};
    try {
      const raw = window.localStorage.getItem(BRIDGE_DONE_KEY);
      if (raw) map = JSON.parse(raw) as Record<string, number>;
    } catch {
      map = {};
    }
    map[key] = Date.now();
    // Prune entries older than 24h so the map never grows unbounded.
    const cutoff = Date.now() - 24 * 3600_000;
    for (const k of Object.keys(map)) {
      if (typeof map[k] === "number" && map[k] < cutoff) delete map[k];
    }
    window.localStorage.setItem(BRIDGE_DONE_KEY, JSON.stringify(map));
  } catch {
    // quota errors — dedup stays best-effort
  }
}

/** Write the bridge result file into the run's sandbox (same path the
 *  runner polls). Passes sandboxId so cold serverless instances reconnect
 *  to the RIGHT sandbox, and conversationId so warm instances hit the
 *  cached one. */
async function writeBridgeResult(
  e2bApiKey: string,
  sandboxId: string,
  conversationId: string,
  callId: string,
  payload: { ok: true; result: unknown } | { ok: false; error: string },
): Promise<void> {
  const token = String(callId).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "call";
  const res = await fetch("/api/sandbox", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiKey: e2bApiKey,
      conversationId,
      sandboxId,
      action: "write_file",
      args: {
        path: ".onyx/bridge/" + token + ".res.json",
        content: JSON.stringify(payload),
      },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error("Bridge write-back failed (HTTP " + res.status + "): " + text.slice(0, 200));
  }
}

/** Collect the browser-registry tools the background runner should expose as
 *  BRIDGED tools (everything without a native sandbox implementation).
 *  Called at launch (startBackgroundTurn) after hot-loading custom + MCP
 *  tools, mirroring the in-browser runtime's per-turn loading sequence. */
export function collectBridgeableTools(
  nativeNames: ReadonlySet<string>,
): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
  return listTools()
    .filter((t) => !nativeNames.has(t.name))
    .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

/**
 * Execute one browser_tool_call event. Fire-and-forget (never blocks the
 * event replay loop — the sandbox runner serializes ordering itself).
 */
export async function handleBrowserToolCall(call: BrowserToolCall): Promise<void> {
  const dedupKey = bridgeDoneKey(call);
  if (isBridgeDone(dedupKey)) return; // replay after reload — already handled

  const writeBack = (payload: { ok: true; result: unknown } | { ok: false; error: string }) =>
    writeBridgeResult(call.e2bApiKey, call.sandboxId, call.conversationId, call.callId, payload);

  const tool = getTool(call.name);
  if (!tool) {
    // Unknown on this client (e.g. registered by a different browser
    // session) — answer honestly so the model can adapt.
    await writeBack({
      ok: false,
      error: "Tool '" + call.name + "' is not registered in this browser session.",
    }).catch(() => {});
    markBridgeDone(dedupKey);
    return;
  }

  try {
    // ToolContext mirrors what the in-browser runtime builds (runtime.ts
    // toolCtx) so bridged tools behave EXACTLY like foreground tools —
    // including ask_user's live UI (waitForAskUser) and event emission.
    let envVars: Record<string, string> = {};
    try {
      envVars = (await settingsService.getDecryptedEnvVars(call.userId)) ?? {};
    } catch {
      envVars = {};
    }
    const ctx: ToolContext = {
      userId: call.userId,
      conversationId: call.conversationId,
      emit: call.emit,
      signal: call.signal,
      waitForAskUser: (questions) => waitForAskUser(questions, call.emit, call.signal),
      e2bApiKey: call.e2bApiKey,
      sandboxApiKey: call.e2bApiKey,
      sandboxMode: "shared",
      aiApiKey: call.aiApiKey ?? undefined,
      envVars,
    };
    const result = await tool.handler(call.args ?? {}, ctx);
    await writeBack({ ok: true, result: result ?? null });
    markBridgeDone(dedupKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeBack({ ok: false, error: message }).catch(() => {});
    markBridgeDone(dedupKey);
  }
}

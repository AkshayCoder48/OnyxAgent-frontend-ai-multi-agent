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
 *
 * HITL APPROVAL GATE (Task 2-d / PRD §8.2 + §13): every bridged call runs
 * through the SAME permission gate the in-browser runtime uses
 * (maybeGateToolCall) BEFORE its handler — bridged tools execute in this
 * browser, so the full interactive approval (card + queue + params-hash
 * verification) applies. The wait is capped just inside the runner's bridge
 * deadline (runBridgeApprovalGate) so a late decision cancels the request
 * instead of executing an operation the model believes timed out.
 */

import { getTool, listTools, type ToolContext } from "@/lib/tools/registry";
import { filterToolsForRequest } from "@/lib/tools/request-scoping";
import "@/lib/tools"; // Side-effect: registers all built-in tools with the registry.
import { waitForAskUser } from "@/lib/agent/ask-user-wait";
import {
  maybeGateToolCall,
  recordApprovalOutcome,
  respondToApproval,
  selectPendingForToolCall,
  usePendingApprovals,
  type GateOutcome,
} from "@/lib/agent/approval-gate";
import { settingsService } from "@/lib/services";
import type { WSEvent } from "@/types";

const BRIDGE_DONE_KEY = "onyx-bridge-done";

// ---------------------------------------------------------------------------
// HITL APPROVAL GATE (Task 2-d / PRD §8.2 + §13) — bridge half
// ---------------------------------------------------------------------------

/** Mirror of the sandbox runner's bridge budget (bg-agent-script.ts) — kept
 * here so the gate's wait can settle BEFORE the runner stops polling for the
 * result. If the user's decision landed after the runner's deadline, the
 * model would believe the call timed out while the APPROVED action still
 * executed — the horizon cancels the request honestly instead. */
const BRIDGE_TIMEOUT_MS: Record<string, number> = { ask_user: 900_000 };
const BRIDGE_DEFAULT_TIMEOUT_MS = 240_000;
/** Safety margin between the gate's horizon and the runner's deadline. */
const BRIDGE_GATE_SAFETY_MS = 60_000;

/** The approval id the gate opened for one tool call (resolves when the
 * gate publishes its pending payload; the upsert happens BEFORE the wait). */
function approvalIdForToolCall(toolCallId: string): Promise<string | null> {
  const existing = selectPendingForToolCall(usePendingApprovals.getState(), toolCallId);
  if (existing) return Promise.resolve(existing.approval_id);
  return new Promise((resolve) => {
    const unsub = usePendingApprovals.subscribe((s) => {
      const p = selectPendingForToolCall(s, toolCallId);
      if (p) {
        unsub();
        resolve(p.approval_id);
      }
    });
  });
}

/**
 * Gate one bridged tool call. Bridged tools execute in THIS browser, so the
 * FULL interactive gate applies (approval card + queue + params-hash-bound
 * decision) even though the LLM loop runs inside the sandbox. The wait is
 * capped at the bridge budget (see BRIDGE_TIMEOUT_MS): a decision that
 * hasn't arrived in time cancels the request so the sandbox receives an
 * honest result inside its own deadline — never an approved-but-unreported
 * late execution.
 */
async function runBridgeApprovalGate(
  call: Pick<BrowserToolCall, "name" | "args" | "callId" | "conversationId" | "emit" | "signal">,
): Promise<GateOutcome> {
  const gate = maybeGateToolCall({
    toolName: call.name,
    args: call.args ?? {},
    toolCallId: call.callId,
    conversationId: call.conversationId,
    emit: call.emit,
    signal: call.signal,
    source: "bridge",
  });
  const timeoutMs = BRIDGE_TIMEOUT_MS[call.name] ?? BRIDGE_DEFAULT_TIMEOUT_MS;
  const horizonMs = Math.max(30_000, timeoutMs - BRIDGE_GATE_SAFETY_MS);
  let horizonTimer: ReturnType<typeof setTimeout> | null = null;
  const horizon = new Promise<"horizon">((resolve) => {
    horizonTimer = setTimeout(() => resolve("horizon"), horizonMs);
  });
  try {
    const raced = await Promise.race([gate, horizon]);
    if (raced === "horizon") {
      // The sandbox is about to give up on this call — wake the gate with a
      // cancel so it never executes a decision that arrives too late. (If
      // the gate never opened a request — permission failure path — there is
      // no id to wake and the gate promise settles on its own.)
      const approvalId = await Promise.race([
        approvalIdForToolCall(call.callId),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
      ]);
      if (approvalId) respondToApproval(approvalId, "cancelled");
      return await gate;
    }
    return raced;
  } finally {
    if (horizonTimer !== null) clearTimeout(horizonTimer);
  }
}

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
  /** Tool call id from the model. NOTE: some gateways (kilo-auto and
   *  friends) reuse ids like "call_0_0" across rounds — the id is NOT
   *  unique per call, which is why the dedup key uses eventSeq. */
  callId: string;
  name: string;
  args: Record<string, unknown>;
  /** The browser_tool_call EVENT's seq — unique + monotonic per run, used
   *  as the dedup key (the call id alone collides across rounds). */
  eventSeq?: number;
  /** The WSEvent pipeline (same emit the in-browser runtime uses). */
  emit: (e: WSEvent) => void;
  signal?: AbortSignal;
}

function bridgeDoneKey(call: { runId?: string; sandboxId: string; callId: string; name: string; eventSeq?: number }): string {
  // Prefer the EVENT SEQ (unique per run — gateways reuse tool-call ids like
  // "call_0_0" across rounds, so runId+callId alone collides and wrongly
  // skipped later calls). Fallback for seq-less events: id + name.
  const scope = call.runId ?? call.sandboxId;
  if (typeof call.eventSeq === "number") return scope + ":s" + call.eventSeq;
  return scope + ":" + call.callId + ":" + call.name;
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

/** Derive the SAME bridge file token the sandbox runner uses — the ack
 * file the runner polls for MUST land at the exact path it expects. */
function bridgeToken(call: { callId: string; name: string }): string {
  // NOTE: mirrors the runner exactly — `callId || name` fallback, then the
  // charset scrub + 80-char cap. A mismatch would make the runner's ack
  // poll miss the file and fast-fail a healthy call.
  return (
    String(call.callId || call.name).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "call"
  );
}

/** Write a file into the run's sandbox through /api/sandbox write_file
 * (the same transport the result write-back uses). */
async function writeSandboxFile(
  e2bApiKey: string,
  sandboxId: string,
  conversationId: string,
  sandboxPath: string,
  content: string,
): Promise<void> {
  const res = await fetch("/api/sandbox", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiKey: e2bApiKey,
      conversationId,
      sandboxId,
      action: "write_file",
      args: { path: sandboxPath, content },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error("Bridge write-back failed (HTTP " + res.status + "): " + text.slice(0, 200));
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
  name: string,
  payload: { ok: true; result: unknown } | { ok: false; error: string },
): Promise<void> {
  await writeSandboxFile(
    e2bApiKey,
    sandboxId,
    conversationId,
    ".onyx/bridge/" + bridgeToken({ callId, name }) + ".res.json",
    JSON.stringify(payload),
  );
}

/** Collect the browser-registry tools the background runner should expose as
 *  BRIDGED tools (everything without a native sandbox implementation).
 *  Called at launch (startBackgroundTurn) after hot-loading custom + MCP
 *  tools, mirroring the in-browser runtime's per-turn loading sequence.
 *  INTENT SCOPING (tool-reliability Part B): the optional scope applies the
 *  same intent-based policy the fg runtime uses (user message + history
 *  latch + model context window) to the bridged snapshot. `nativeNames`
 *  (BG_NATIVE_TOOL_NAMES) already excludes the sandbox-native surface. */
export function collectBridgeableTools(
  nativeNames: ReadonlySet<string>,
  scope?: import("@/lib/tools/request-scoping").RequestToolScope,
): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
  const tools = filterToolsForRequest(
    listTools().filter((t) => !nativeNames.has(t.name)),
    scope,
  );
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

/**
 * Execute one browser_tool_call event. Fire-and-forget (never blocks the
 * event replay loop — the sandbox runner serializes ordering itself).
 */
export async function handleBrowserToolCall(call: BrowserToolCall): Promise<void> {
  // ACK FIRST (the 240s timeout fix): the moment this browser receives the
  // call it writes .ack.json — the runner's liveness signal. When no tab
  // is open, no ack ever lands and the runner fails fast (~25s) instead of
  // burning its full 240s timeout on every bridged tool call. Best-effort:
  // an ack write failure never kills the call (the runner would time out
  // exactly as before).
  await writeSandboxFile(
    call.e2bApiKey,
    call.sandboxId,
    call.conversationId,
    ".onyx/bridge/" + bridgeToken(call) + ".ack.json",
    JSON.stringify({ ok: true, ack: true, at: Date.now() }),
  ).catch(() => {});

  const dedupKey = bridgeDoneKey(call);
  if (isBridgeDone(dedupKey)) return; // replay after reload — already handled

  const writeBack = (payload: { ok: true; result: unknown } | { ok: false; error: string }) =>
    writeBridgeResult(call.e2bApiKey, call.sandboxId, call.conversationId, call.callId, call.name, payload);

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

  // HITL APPROVAL GATE (Task 2-d / PRD §8.2 + §13): bridged tools execute in
  // THIS browser, so the FULL interactive gate applies — the card + queue
  // surface the request, the decision is params-hash-verified, and the wait
  // is capped at the bridge budget (see runBridgeApprovalGate). A blocked
  // verdict never runs the handler: the honest gate message rides the
  // normal write-back protocol.
  const gate = await runBridgeApprovalGate(call);
  if (gate.verdict !== "allowed") {
    const message = gate.verdict === "denied" ? gate.reason : gate.result;
    await writeBack({ ok: false, error: message }).catch(() => {});
    markBridgeDone(dedupKey);
    return;
  }
  const gateApprovalId = gate.approvalId;

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
    // APPROVAL OUTCOME (PRD §13.6): when this call passed the gate via an
    // APPROVAL, record the honest result on the approval row (best-effort).
    if (gateApprovalId) {
      void recordApprovalOutcome(gateApprovalId, result ?? null);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeBack({ ok: false, error: message }).catch(() => {});
    markBridgeDone(dedupKey);
    if (gateApprovalId) {
      void recordApprovalOutcome(gateApprovalId, message, true);
    }
  }
}

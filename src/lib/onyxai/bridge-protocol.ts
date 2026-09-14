/**
 * OnyxAI Browser-Runtime Bridge — shared protocol (client + server safe).
 *
 * OnyxAI models run IN THE USER'S BROWSER — `qvac serve --openai` on the
 * user's own device is reachable ONLY from that browser (the server and the
 * E2B sandbox can never reach the user's localhost). Remote triggers
 * (Telegram webhook, scheduled tasks) still execute the FULL agent loop in
 * E2B — only the MODEL CALL is relayed through the connected browser:
 *
 *   E2B sandbox ──POST /api/onyxai/bridge/submit──▶ KV queue record
 *   browser     ──KV list (direct)──▶ sees pending request
 *   browser     ──GET /api/onyxai/bridge/req──▶ full request body (sandbox file)
 *   browser     ──fetch localhost QVAC (streaming)──▶ local inference
 *   browser     ──KV set ev:<seq> / final──▶ normalized deltas
 *   E2B sandbox ──GET /api/onyxai/bridge/stream (long-poll)──▶ deltas → the
 *   SAME delta pipeline as a direct provider call (tools, thinking, tokens).
 *
 * The CLI gates the same way: the browser runtime's presence record must be
 * fresh before a local OnyxAI call ("the user has to start the models").
 *
 * SECURITY:
 *   - The sandbox never holds the OnyxBase key. It carries a per-execution
 *     bridge TOKEN (`onyxai:bridge:auth:<token>`, written by the engine at
 *     launch, expiring with the run) that authorizes submit + stream only.
 *   - The browser talks to OnyxBase KV directly with the vault key (same
 *     pattern as the workspace sync — the key never crosses our server).
 *   - Auth records, queue records, deltas and finals live in the user's own
 *     OnyxBase account (collection "onyxagent").
 */

// ---------------------------------------------------------------------------
// KV layout (OnyxBase, collection "onyxagent")
// ---------------------------------------------------------------------------

/** Browser-runtime heartbeat: BridgePresence JSON. Written by the browser. */
export const BRIDGE_PRESENCE_KEY = "onyxai:bridge:presence";
/** Per-execution auth: BRIDGE_AUTH_PREFIX + token → BridgeAuthRecord. */
export const BRIDGE_AUTH_PREFIX = "onyxai:bridge:auth:";
/** Model-call queue: BRIDGE_REQ_PREFIX + reqId → BridgeRequestRecord. */
export const BRIDGE_REQ_PREFIX = "onyxai:bridge:req:";
/** Deltas: BRIDGE_REQ_PREFIX + reqId + ":ev:<seq>" → BridgeDelta[] JSON. */
export const BRIDGE_EV_INFIX = ":ev:";
/** Terminal: BRIDGE_REQ_PREFIX + reqId + ":final" → BridgeFinal JSON. */
export const BRIDGE_FINAL_SUFFIX = ":final";

export function bridgeAuthKey(token: string): string {
  return BRIDGE_AUTH_PREFIX + token;
}
export function bridgeReqKey(reqId: string): string {
  return BRIDGE_REQ_PREFIX + reqId;
}
export function bridgeEvKey(reqId: string, seq: number): string {
  return BRIDGE_REQ_PREFIX + reqId + BRIDGE_EV_INFIX + seq;
}
export function bridgeFinalKey(reqId: string): string {
  return BRIDGE_REQ_PREFIX + reqId + BRIDGE_FINAL_SUFFIX;
}
/** Parse "<seq>" out of ".../req:<reqId>:ev:<seq>" — null when not an ev key. */
export function bridgeEvSeqOf(key: string): number | null {
  const i = key.indexOf(BRIDGE_EV_INFIX);
  if (i < 0) return null;
  const seq = Number.parseInt(key.slice(i + BRIDGE_EV_INFIX.length), 10);
  return Number.isFinite(seq) ? seq : null;
}

// ---------------------------------------------------------------------------
// Timings / limits
// ---------------------------------------------------------------------------

/** Browser heartbeat cadence (module default — the runtime owns the loop). */
export const BRIDGE_HEARTBEAT_MS = 5_000;
/** Presence older than this = the browser runtime is considered OFFLINE. */
export const BRIDGE_PRESENCE_STALE_MS = 20_000;
/** Queue poll cadence (browser) + stream poll cadence inside one long-poll. */
export const BRIDGE_POLL_MS = 1_800;
export const BRIDGE_STREAM_POLL_MS = 800;
/** One long-poll /stream invocation waits at most this long before replying. */
export const BRIDGE_STREAM_WAIT_MS = 20_000;
/** How long the sandbox waits for the browser to PICK UP a request. */
export const BRIDGE_PICKUP_TIMEOUT_MS = 150_000;
/** No-delta idle timeout once streaming started (matches IDLE_TIMEOUT_MS). */
export const BRIDGE_IDLE_TIMEOUT_MS = 240_000;
/** Pending requests older than this are ignored + garbage collected. */
export const BRIDGE_REQ_TTL_MS = 15 * 60_000;
/** After completion, ev/final/req keys live this long for late pollers. */
export const BRIDGE_GC_GRACE_MS = 90_000;
/** Per-batch value budget — OnyxBase values must stay ≤ ~4 KB. */
export const BRIDGE_EV_MAX_BYTES = 2_500;
/** Auth token validity: run duration + buffer (engine passes maxDurationMs). */
export const BRIDGE_AUTH_DEFAULT_TTL_MS = 4_200_000;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * The browser runtime's heartbeat record. `models` comes from a LIVE
 * `GET {base}/v1/models` probe (localhost) — it is the list of models the
 * user has actually STARTED, which is exactly what remote triggers need to
 * verify ("the user has to start the models").
 */
export interface BridgePresence {
  /** Epoch ms of the last heartbeat. */
  lastSeenAt: number;
  /** Local QVAC base URL (e.g. http://localhost:11434/v1) — debug info. */
  baseUrl?: string;
  /** Models the local server is actually serving (from /v1/models). */
  models: string[];
  /** False when the local server probe failed (runtime on, qvac down). */
  modelsOk: boolean;
  /** The provider row's currently selected model, when known. */
  activeModel?: string | null;
  /** Protocol version. */
  version: 1;
}

/** Per-execution bridge authorization (written by the engine, KV-only). */
export interface BridgeAuthRecord {
  execId: string;
  chatId: string;
  trigger: string;
  createdAt: number;
  expiresAt: number;
}

/** One queued model call (written by /submit, updated by the browser). */
export interface BridgeRequestRecord {
  reqId: string;
  sandboxId: string;
  /** Absolute path of the request-body file inside the sandbox. */
  reqPath: string;
  model: string;
  round?: number;
  status: "pending" | "running" | "done" | "error";
  createdAt: number;
  claimedAt?: number;
  completedAt?: number;
}

/**
 * One normalized streaming delta — EXACTLY the shape the bg-agent's delta
 * pipeline consumes (`feedDeltas`), so bridge events flow through the same
 * reasoning/text/tool-call machinery as a direct provider SSE stream.
 */
export interface BridgeDelta {
  text?: string;
  reasoning?: string;
  toolCalls?: {
    index: number;
    id?: string;
    name?: string;
    arguments?: string;
  }[];
}

/** Terminal marker for one bridged model call. */
export interface BridgeFinal {
  finish_reason?: string | null;
  usage?: Record<string, number>;
  /** Set when the local inference failed ( surfaced as a round error). */
  error?: string;
}

/** Envelope the /stream long-poll answers with. */
export interface BridgeStreamResponse {
  ok: true;
  /** New delta batches, ascending seq. */
  events: { seq: number; deltas: BridgeDelta[] }[];
  /** Present once the call reached a terminal state. */
  final?: BridgeFinal | null;
  /** Cursor for the next call's `after`. */
  nextAfter: number;
  /** True when the request record is missing/expired (stop polling). */
  gone?: boolean;
}

// ---------------------------------------------------------------------------
// Error codes + user-facing copy
// ---------------------------------------------------------------------------

export type OnyxAiBridgeErrorCode =
  | "ONYXAI_RUNTIME_OFFLINE"
  | "ONYXAI_QVAC_UNREACHABLE"
  | "ONYXAI_MODEL_NOT_RUNNING"
  | "ONYXAI_BRIDGE_AUTH"
  | "ONYXAI_BRIDGE_TIMEOUT";

/** The actionable "start your models" message — ONE canonical phrasing. */
export function onyxAiRuntimeOfflineMessage(extra?: string): string {
  return (
    "OnyxAI models run locally in your browser. Open the OnyxAgent app, turn ON the OnyxAI Browser Runtime (Settings → OnyxAI) and make sure `qvac serve --openai` is running on your device, then try again." +
    (extra ? " " + extra : "")
  );
}

/** Read + validate a presence payload (null when absent/corrupt/stale). */
export function parseBridgePresence(raw: string | null): BridgePresence | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<BridgePresence>;
    if (!p || typeof p.lastSeenAt !== "number") return null;
    if (Date.now() - p.lastSeenAt > BRIDGE_PRESENCE_STALE_MS) return null;
    return {
      version: 1,
      baseUrl: p.baseUrl,
      models: Array.isArray(p.models) ? p.models : [],
      modelsOk: p.modelsOk === true,
      activeModel: p.activeModel ?? null,
      lastSeenAt: p.lastSeenAt,
    };
  } catch {
    return null;
  }
}

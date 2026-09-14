"use client";

// ============================================================================
// OnyxAI Browser Runtime — the browser half of the model-call bridge.
//
// OnyxAI models run IN THIS BROWSER: `qvac serve --openai` on the user's
// device is reachable only from the user's browser, so every REMOTE agent
// trigger (Telegram webhook, scheduled task) that uses OnyxAI relays its
// model calls through here while an app tab is open:
//
//   1. HEARTBEAT (5s): probe the local QVAC server (GET /v1/models) and
//      publish `onyxai:bridge:presence` — the engine's pre-launch gate
//      ("the user has to start the models") reads exactly this record.
//   2. QUEUE POLL (1.8s): list `onyxai:bridge:req:*` KV records; pending
//      requests are executed SEQUENTIALLY (a local model does one
//      inference at a time).
//   3. EXECUTE: pull the request body from the execution sandbox via
//      /api/onyxai/bridge/req (messages + tools are far too big for KV),
//      stream it against the local QVAC server, and write normalized delta
//      batches (`…:ev:<seq>`, ≤ ~2.5 KB) + a terminal `…:final` back to KV —
//      the sandbox long-polls those and feeds them through its normal
//      streaming pipeline (tools, thinking, tokens — 1:1).
//
// LEADER ELECTION: the Web Locks API guarantees ONE serving tab, even with
// the app open in many windows. Non-leader tabs idle.
//
// The runtime is mounted once in the dashboard layout (renders null); the
// Settings → OnyxAI card exposes its status + toggle.
// ============================================================================

import { OnyxBaseKV, ONYXBASE_DEFAULT_BASE_URL } from "@/lib/onyxbase/kv-client";
import { isLocalBaseUrl } from "@/lib/onyxai/catalog";
import {
  BRIDGE_EV_MAX_BYTES,
  BRIDGE_GC_GRACE_MS,
  BRIDGE_HEARTBEAT_MS,
  BRIDGE_POLL_MS,
  BRIDGE_PRESENCE_KEY,
  BRIDGE_REQ_PREFIX,
  BRIDGE_REQ_TTL_MS,
  bridgeEvKey,
  bridgeFinalKey,
  bridgeReqKey,
  type BridgeDelta,
  type BridgePresence,
  type BridgeRequestRecord,
} from "@/lib/onyxai/bridge-protocol";

// ---------------------------------------------------------------------------
// Public status (consumed by the Settings → OnyxAI runtime card)
// ---------------------------------------------------------------------------

export interface BridgeServedEntry {
  reqId: string;
  model: string;
  status: "running" | "done" | "error";
  startedAt: number;
  finishedAt?: number;
  error?: string;
  /** Delta batches written (≈ streaming chunks relayed). */
  chunks?: number;
}

export interface BridgeRuntimeStatus {
  /** The loops are active in THIS tab. */
  running: boolean;
  /** This tab holds the exclusive serving lock (the executing tab). */
  leader: boolean;
  /** "on" | "off" (manual) | "auto" (on while OnyxAI is the active provider). */
  enabled: "on" | "off" | "auto";
  /** enabled === "auto" ? resolved now : enabled === "on". */
  effectiveOn: boolean;
  /** The OnyxAI provider row exists and points at a LOCAL base URL. */
  providerConfigured: boolean;
  baseUrl: string | null;
  /** The local QVAC server answered the last /v1/models probe. */
  modelsOk: boolean;
  servedModels: string[];
  lastHeartbeatAt: number | null;
  lastError: string | null;
  busy: boolean;
  servedCount: number;
  recent: BridgeServedEntry[];
}

const ENABLED_KEY = "onyxai-bridge-enabled";
const LOCK_NAME = "onyxai-bridge-runtime";

function readEnabled(): "on" | "off" | "auto" {
  try {
    const v = window.localStorage.getItem(ENABLED_KEY);
    if (v === "1") return "on";
    if (v === "0") return "off";
  } catch {
    /* private mode — auto */
  }
  return "auto";
}

// ---------------------------------------------------------------------------
// SSE parsing + delta normalization (local QVAC → BridgeDelta)
// ---------------------------------------------------------------------------

interface SseParse {
  events: string[];
  rest: string;
}

function parseSSEFrames(buf: string): SseParse {
  const events: string[] = [];
  let rest = buf;
  for (;;) {
    const m = /\r?\n\r?\n/.exec(rest);
    if (!m || m.index === undefined) break;
    const frame = rest.slice(0, m.index);
    rest = rest.slice(m.index + m[0].length);
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (payload && payload !== "[DONE]") events.push(payload);
      }
    }
  }
  return { events, rest };
}

/** Split a text delta so no KV value can exceed the ~4 KB budget. */
function splitTextDelta(d: BridgeDelta): BridgeDelta[] {
  const text = d.text ?? "";
  if (text.length <= 1200) return [d];
  const out: BridgeDelta[] = [];
  for (let i = 0; i < text.length; i += 1200) {
    out.push({ text: text.slice(i, i + 1200) });
  }
  return out;
}

interface OpenAiChunk {
  choices?: {
    delta?: {
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
      thinking?: string;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    message?: {
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
      thinking?: string;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: Record<string, unknown>;
  error?: { message?: string };
}

function chunkToDeltas(chunk: OpenAiChunk): BridgeDelta[] {
  const choice = chunk.choices?.[0];
  const d = choice?.delta ?? choice?.message;
  const out: BridgeDelta[] = [];
  if (d) {
    const reasoning = d.reasoning_content ?? d.reasoning ?? d.thinking;
    if (typeof reasoning === "string" && reasoning) out.push({ reasoning });
    if (typeof d.content === "string" && d.content) {
      out.push(...splitTextDelta({ text: d.content }));
    }
    if (Array.isArray(d.tool_calls)) {
      const toolCalls = d.tool_calls
        .map((tc, i) => ({
          index: typeof tc.index === "number" ? tc.index : i,
          ...(typeof tc.id === "string" && tc.id ? { id: tc.id } : {}),
          name: typeof tc.function?.name === "string" ? tc.function.name : undefined,
          arguments: typeof tc.function?.arguments === "string" ? tc.function.arguments : undefined,
        }))
        .filter((tc) => tc.id !== undefined || tc.name !== undefined || tc.arguments !== undefined);
      if (toolCalls.length) out.push({ toolCalls });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The runtime manager (module singleton)
// ---------------------------------------------------------------------------

interface ProviderRuntimeConfig {
  baseUrl: string;
  apiKey: string;
  activeModel: string | null;
  noPrefix: boolean;
}

class BridgeRuntimeManager {
  private userId: string | null = null;
  private running = false;
  private leader = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lockRelease: (() => void) | null = null;
  private provider: ProviderRuntimeConfig | null = null;
  private providerConfigured = false;
  private modelsOk = false;
  private servedModels: string[] = [];
  private lastHeartbeatAt: number | null = null;
  private lastError: string | null = null;
  private busy = false;
  private servedCount = 0;
  private recent: BridgeServedEntry[] = [];
  private seenReqIds = new Set<string>();
  private queue: BridgeRequestRecord[] = [];
  private kvKey: string | null = null;
  private kvBaseUrl: string | null = null;
  private kv: OnyxBaseKV | null = null;
  /** Consecutive provider-resolution misses in auto mode (cold-load races). */
  private providerMisses = 0;
  private listeners = new Set<() => void>();

  // -- lifecycle -----------------------------------------------------------

  /** Mount entry: evaluate enabled and start when appropriate. Returns a
   *  stop() for the caller's useEffect cleanup. Idempotent. */
  ensure(userId: string): () => void {
    if (this.userId !== userId) {
      this.userId = userId;
      this.seenReqIds.clear();
      this.queue = [];
    }
    void this.evaluateAndStart();
    return () => {
      /* the layout-level mount lives for the whole session; nothing here */
    };
  }

  private async evaluateAndStart(): Promise<void> {
    if (!this.userId) return;
    const enabled = readEnabled();
    if (enabled === "off") {
      await this.stop();
      return;
    }
    if (enabled === "on") {
      await this.start();
      return;
    }
    // auto: run while OnyxAI is the ACTIVE provider
    const provider = await this.resolveProvider();
    if (provider) {
      await this.start();
    } else {
      await this.stop();
    }
  }

  async start(): Promise<void> {
    if (this.running || !this.userId) return;
    this.running = true;
    this.lastError = null;
    this.emit();
    await this.resolveKv();
    if (!this.kv) {
      // Cold-load race: the vault/settings may not be rehydrated yet. The
      // heartbeat retries resolution every beat — don't give up permanently.
      this.lastError =
        "OnyxBase key not configured yet — add it in Settings → Cloud Workspace (retrying automatically).";
      this.emit();
    }
    this.acquireLeadership();
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), BRIDGE_HEARTBEAT_MS);
    this.pollTimer = setInterval(() => void this.pollQueue(), BRIDGE_POLL_MS);
    void this.heartbeat();
    void this.pollQueue();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.leader = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.heartbeatTimer = null;
    this.pollTimer = null;
    this.queue = [];
    this.seenReqIds.clear();
    try {
      this.lockRelease?.();
    } catch {
      /* best-effort */
    }
    this.lockRelease = null;
    // best-effort presence removal (only meaningful when THIS tab served)
    const kv = this.kv;
    if (kv) {
      void kv.delete(BRIDGE_PRESENCE_KEY).catch(() => {});
    }
    this.emit();
  }

  /** Manual toggle from the settings card (null → back to auto). */
  async setEnabled(v: "on" | "off" | "auto"): Promise<void> {
    try {
      if (v === "on") window.localStorage.setItem(ENABLED_KEY, "1");
      else if (v === "off") window.localStorage.setItem(ENABLED_KEY, "0");
      else window.localStorage.removeItem(ENABLED_KEY);
    } catch {
      /* private mode */
    }
    await this.evaluateAndStart();
  }

  // -- leader election -----------------------------------------------------

  private acquireLeadership(): void {
    const locks = (navigator as { locks?: { request: (name: string, opts: { mode: "exclusive" }, cb: () => Promise<void>) => Promise<void> } }).locks;
    if (!locks || typeof locks.request !== "function") {
      // Web Locks unavailable (old browser) — serve from this tab directly.
      this.leader = true;
      this.emit();
      return;
    }
    const attempt = () => {
      void locks
        .request(LOCK_NAME, { mode: "exclusive" }, async () => {
          this.leader = true;
          this.emit();
          // Hold the lock until stop() resolves this promise.
          await new Promise<void>((resolve) => {
            this.lockRelease = resolve;
          });
          this.leader = false;
          this.emit();
        })
        .catch(() => {
          /* another tab holds the lock — we are a standby tab */
        })
        .finally(() => {
          // Re-acquire when the lock frees (leader tab closed) while running.
          if (this.running) {
            setTimeout(() => {
              if (this.running) attempt();
            }, 2000);
          }
        });
    };
    attempt();
  }

  // -- resolution helpers --------------------------------------------------

  private async resolveKv(): Promise<void> {
    try {
      const { settingsService } = await import("@/lib/services");
      if (!this.userId) return;
      const key = await settingsService.getDecryptedOnyxBaseApiKey(this.userId);
      if (!key || !key.trim()) {
        this.kv = null;
        return;
      }
      this.kvKey = key.trim();
      const settings = await settingsService.get(this.userId).catch(() => null);
      this.kvBaseUrl = settings?.onyxbase_base_url || ONYXBASE_DEFAULT_BASE_URL;
      this.kv = new OnyxBaseKV(this.kvKey, this.kvBaseUrl);
    } catch {
      this.kv = null;
    }
  }

  private async resolveProvider(): Promise<ProviderRuntimeConfig | null> {
    try {
      if (!this.userId) return null;
      // findOnyxAiProvider reads the RAW table with the seed's single-user
      // adoption semantics (the transient pre-auth "local-user" can own the
      // row while the runtime runs as the post-init user, and vice versa) —
      // aiProviderService.list() filters by user_id and would miss it.
      const { findOnyxAiProvider } = await import("@/lib/onyxai/seed");
      const row = await findOnyxAiProvider(this.userId);
      if (!row || !row.base_url || !isLocalBaseUrl(row.base_url)) {
        this.providerConfigured = false;
        return null;
      }
      this.providerConfigured = true;
      const { aiProviderService } = await import("@/lib/services");
      let apiKey = "";
      try {
        apiKey = (await aiProviderService.getDecryptedApiKey(row.id)) ?? "";
      } catch {
        apiKey = "";
      }
      const cfg = {
        baseUrl: row.base_url.replace(/\/+$/, ""),
        apiKey,
        activeModel: row.models?.[0] ?? null,
        noPrefix: row.no_prefix === true,
      };
      this.provider = cfg;
      return cfg;
    } catch {
      this.providerConfigured = false;
      return null;
    }
  }

  // -- heartbeat -----------------------------------------------------------

  private async heartbeat(): Promise<void> {
    if (!this.running) return;
    // Cold-load retry: the vault key may only be decryptable after the auth
    // store finished rehydrating (the same race SchedulerHeartbeat guards).
    if (!this.kv) {
      await this.resolveKv();
      if (!this.kv) {
        if (readEnabled() === "off") return;
        this.lastError =
          "OnyxBase key not configured yet — add it in Settings → Cloud Workspace (retrying automatically).";
        this.emit();
        return;
      }
      this.emit();
    }
    try {
      const provider = this.provider ?? (await this.resolveProvider());
      if (!provider) {
        // auto mode + provider gone → stand down, but only after repeated
        // misses (a single failure can be a cold Dexie/vault race).
        if (readEnabled() === "auto") {
          this.providerMisses = (this.providerMisses ?? 0) + 1;
          if (this.providerMisses >= 3) {
            await this.stop();
            return;
          }
          this.emit();
          return;
        }
        this.modelsOk = false;
        this.servedModels = [];
        this.lastError = "The OnyxAI provider isn't configured (or its URL isn't local).";
        this.emit();
        return;
      }
      this.providerMisses = 0;
      // Probe the local server — the models the user actually STARTED.
      const base = provider.baseUrl;
      const modelsUrl = /\/v\d+$/.test(base) ? `${base}/models` : `${base}/v1/models`;
      let models: string[] = [];
      let modelsOk = false;
      try {
        const res = await fetch(modelsUrl, {
          headers: provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {},
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          const data = (await res.json()) as { data?: { id?: unknown }[] };
          models = Array.isArray(data?.data)
            ? data.data.map((m) => (typeof m?.id === "string" ? m.id : null)).filter((x): x is string => x !== null)
            : [];
          modelsOk = true;
        }
      } catch {
        modelsOk = false;
      }
      this.modelsOk = modelsOk;
      this.servedModels = models;
      const presence: BridgePresence = {
        lastSeenAt: Date.now(),
        baseUrl: base,
        models,
        modelsOk,
        activeModel: provider.activeModel,
        version: 1,
      };
      await this.kv.set(BRIDGE_PRESENCE_KEY, JSON.stringify(presence));
      this.lastHeartbeatAt = Date.now();
      this.lastError = modelsOk
        ? null
        : "The browser runtime is ON, but the local QVAC server isn't reachable — start it with `qvac serve --openai --cors-origin <app-origin>`.";
      this.emit();
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      this.emit();
    }
  }

  // -- queue poll ----------------------------------------------------------

  private async pollQueue(): Promise<void> {
    if (!this.running || !this.leader || !this.kv || this.busy) return;
    try {
      const keys = await this.kv.listKeys(BRIDGE_REQ_PREFIX);
      const now = Date.now();
      for (const key of keys) {
        const rest = key.slice(BRIDGE_REQ_PREFIX.length);
        if (!rest || rest.includes(":")) continue; // :ev:<seq> / :final
        const reqId = rest;
        if (this.seenReqIds.has(reqId)) continue;
        const raw = await this.kv.get(key).catch(() => null);
        if (!raw) continue;
        let rec: BridgeRequestRecord;
        try {
          rec = JSON.parse(raw) as BridgeRequestRecord;
        } catch {
          continue;
        }
        if (rec.status !== "pending") continue;
        if (now - rec.createdAt > BRIDGE_REQ_TTL_MS) continue;
        this.seenReqIds.add(reqId);
        this.queue.push(rec);
      }
      void this.drain();
    } catch {
      /* transient KV errors — next poll */
    }
  }

  private async drain(): Promise<void> {
    if (this.busy || !this.queue.length || !this.kv) return;
    const rec = this.queue.shift();
    if (!rec) return;
    this.busy = true;
    this.emit();
    try {
      await this.execute(rec, this.kv);
    } finally {
      this.busy = false;
      this.emit();
    }
  }

  // -- execution -----------------------------------------------------------

  private async execute(rec: BridgeRequestRecord, kv: OnyxBaseKV): Promise<void> {
    const entry: BridgeServedEntry = {
      reqId: rec.reqId,
      model: rec.model,
      status: "running",
      startedAt: Date.now(),
    };
    this.recent = [entry, ...this.recent].slice(0, 8);
    this.emit();

    const fail = async (error: string) => {
      entry.status = "error";
      entry.finishedAt = Date.now();
      entry.error = error.slice(0, 200);
      this.lastError = error.slice(0, 200);
      try {
        await kv.set(bridgeFinalKey(rec.reqId), JSON.stringify({ error: error.slice(0, 500) }));
        await kv.set(
          bridgeReqKey(rec.reqId),
          JSON.stringify({ ...rec, status: "error", completedAt: Date.now() }),
        );
      } catch {
        /* best-effort */
      }
      this.scheduleGc(rec.reqId, kv);
      this.emit();
    };

    // 1. Pull the request body from the execution sandbox.
    if (!this.kvKey) {
      await fail("OnyxBase key unavailable — cannot pull the bridged request.");
      return;
    }
    let body: Record<string, unknown>;
    try {
      const res = await fetch(`/api/onyxai/bridge/req?reqId=${encodeURIComponent(rec.reqId)}`, {
        headers: { "X-OnyxBase-Key": this.kvKey },
        signal: AbortSignal.timeout(20_000),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; body?: Record<string, unknown>; error?: string };
      if (!res.ok || !data.ok || !data.body) {
        await fail(`Fetching the bridged request failed: ${data.error ?? `HTTP ${res.status}`}`);
        return;
      }
      body = data.body;
    } catch (e) {
      await fail(`Fetching the bridged request failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    // 2. Claim the request (leader-only path; read-check + write).
    try {
      await kv.set(bridgeReqKey(rec.reqId), JSON.stringify({ ...rec, status: "running", claimedAt: Date.now() }));
    } catch {
      /* best-effort — proceed; the claim is advisory for standby tabs */
    }

    // 3. Provider config (fresh) + endpoint.
    const provider = this.provider ?? (await this.resolveProvider());
    if (!provider) {
      await fail("The OnyxAI provider isn't configured in this browser.");
      return;
    }
    let endpoint = provider.baseUrl;
    if (!provider.noPrefix) {
      if (!endpoint.endsWith("/chat/completions")) endpoint += "/chat/completions";
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
    if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
    const payload = { ...body, stream: true };

    // 4. Stream against the LOCAL QVAC server, relaying normalized deltas.
    let seq = 0;
    let batch: BridgeDelta[] = [];
    let lastFlush = Date.now();
    let finishReason: string | null = null;
    let usage: Record<string, number> | undefined;
    const flush = async (force = false) => {
      if (!batch.length) return;
      const size = JSON.stringify(batch).length;
      if (!force && Date.now() - lastFlush < 500 && size < BRIDGE_EV_MAX_BYTES) return;
      await kv.set(bridgeEvKey(rec.reqId, ++seq), JSON.stringify(batch));
      entry.chunks = (entry.chunks ?? 0) + 1;
      batch = [];
      lastFlush = Date.now();
    };

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(600_000),
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 300);
        await fail(`Local model error: HTTP ${res.status} ${detail.replace(/\s+/g, " ")}`);
        return;
      }
      const ct = String(res.headers.get("content-type") || "");
      if (ct.includes("application/json")) {
        // Non-streaming answer — one honest bulk delivery.
        const json = (await res.json()) as OpenAiChunk & { error?: { message?: string } };
        if (json.error?.message) {
          await fail(`Local model error: ${json.error.message}`);
          return;
        }
        const deltas = chunkToDeltas(json);
        for (const d of deltas) {
          batch.push(d);
          await flush(true);
        }
        finishReason = json.choices?.[0]?.finish_reason ?? "stop";
        if (json.usage) {
          usage = Object.fromEntries(
            Object.entries(json.usage).filter((v): v is [string, number] => typeof v[1] === "number"),
          );
        }
      } else {
        const reader = res.body?.getReader();
        if (!reader) {
          await fail("Local model returned no stream.");
          return;
        }
        const decoder = new TextDecoder();
        let sseBuf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          sseBuf += decoder.decode(value, { stream: true });
          const parsed = parseSSEFrames(sseBuf);
          sseBuf = parsed.rest;
          for (const ev of parsed.events) {
            let chunk: OpenAiChunk;
            try {
              chunk = JSON.parse(ev) as OpenAiChunk;
            } catch {
              continue;
            }
            if (chunk.error?.message) {
              throw new Error(`Provider stream error: ${chunk.error.message}`);
            }
            for (const d of chunkToDeltas(chunk)) batch.push(d);
            const fr = chunk.choices?.[0]?.finish_reason;
            if (typeof fr === "string" && fr) finishReason = fr;
            if (chunk.usage) {
              usage = Object.fromEntries(
                Object.entries(chunk.usage).filter((v): v is [string, number] => typeof v[1] === "number"),
              );
            }
            await flush();
          }
        }
        // flush trailing buffer
        sseBuf += decoder.decode();
        const tail = parseSSEFrames(sseBuf + "\n\n");
        for (const ev of tail.events) {
          try {
            const chunk = JSON.parse(ev) as OpenAiChunk;
            for (const d of chunkToDeltas(chunk)) batch.push(d);
          } catch {
            /* skip */
          }
        }
        await flush(true);
      }

      // 5. Terminal marker + completed record.
      await kv.set(bridgeFinalKey(rec.reqId), JSON.stringify({ finish_reason: finishReason ?? "stop", ...(usage ? { usage } : {}) }));
      await kv.set(bridgeReqKey(rec.reqId), JSON.stringify({ ...rec, status: "done", completedAt: Date.now() }));
      entry.status = "done";
      entry.finishedAt = Date.now();
      this.servedCount += 1;
      this.scheduleGc(rec.reqId, kv);
      this.emit();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await fail(`Local model stream failed: ${msg}`);
    }
  }

  /** Delete a completed request's keys after the grace window (late pollers). */
  private scheduleGc(reqId: string, kv: OnyxBaseKV): void {
    setTimeout(() => {
      void (async () => {
        try {
          const keys = await kv.listKeys(BRIDGE_REQ_PREFIX + reqId);
          for (const key of keys) {
            await kv.delete(key).catch(() => {});
          }
        } catch {
          /* best-effort */
        }
      })();
    }, BRIDGE_GC_GRACE_MS);
  }

  // -- status --------------------------------------------------------------

  private snapshotCache: BridgeRuntimeStatus | null = null;

  private emit(): void {
    // Invalidate the stable snapshot FIRST — getSnapshot() must return a
    // referentially-stable object between emits (useSyncExternalStore would
    // otherwise re-render forever on freshly-allocated snapshots).
    this.snapshotCache = null;
    for (const fn of this.listeners) fn();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getSnapshot(): BridgeRuntimeStatus {
    if (!this.snapshotCache) {
      this.snapshotCache = {
        running: this.running,
        leader: this.leader,
        enabled: readEnabled(),
        effectiveOn: this.running,
        providerConfigured: this.providerConfigured,
        baseUrl: this.provider?.baseUrl ?? null,
        modelsOk: this.modelsOk,
        servedModels: this.servedModels,
        lastHeartbeatAt: this.lastHeartbeatAt,
        lastError: this.lastError,
        busy: this.busy,
        servedCount: this.servedCount,
        recent: this.recent,
      };
    }
    return this.snapshotCache;
  }
}

export const bridgeRuntime = new BridgeRuntimeManager();

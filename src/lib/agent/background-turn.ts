"use client";

import { nanoid } from "nanoid";
import type { AgentTurnOptions } from "./runtime";
import type { WSEvent } from "@/types";
import { useChatStore, type ExecutionChatStore } from "@/stores/chat-store";
import { useResearchStore } from "@/stores";
import { conversationService } from "@/lib/services";
import { isCodeMode } from "@/lib/code-mode";
import {
  launchBackgroundTurn,
  streamBackgroundTurn,
  pollBackgroundTurn,
  stopBackgroundTurn,
  clearJob,
  updateJobCursor,
  getActiveJob,
  type BgEvent,
  type BgJob,
} from "@/lib/e2b/background-agent";
import { BG_NATIVE_TOOL_NAMES } from "@/lib/e2b/bg-native-tools";
import { bumpWorkspaceVersion } from "@/lib/tools/workspace-snapshot";
import {
  collectBridgeableTools,
  handleBrowserToolCall,
} from "@/lib/agent/browser-tool-bridge";
import { manageContext } from "@/lib/agent/context/context-manager";

/**
 * Background agent turn — runs the agent loop INSIDE the E2B sandbox as a
 * background command, so the turn keeps working after the browser closes,
 * stops, or minimizes (E2B sandboxes are server-side VMs; background
 * commands "keep running inside the sandbox even after the SDK disconnects"
 * — per the E2B docs).
 *
 * v2.1 STREAMING DELIVERY: the sandbox runner streams token-level events
 * (reasoning_delta / text_delta / tool_call_delta / tool_call / tool_result
 * / status / done — 1:1 with each upstream SSE delta) into an append-only
 * per-run log (.onyx/runs/<runId>/events.jsonl, every event carrying ts +
 * seq). This orchestrator consumes that log through `bg_wait` — a
 * SERVER-PUSH SSE stream (the server reads the log every 60ms while events
 * flow and PUSHES each batch as a data frame over ONE connection per ~11s
 * segment) driven by a seq cursor — and replays every event through the
 * SAME `emit` pipeline the in-browser runtime uses. Latency from runner→UI
 * is the server's read cadence (~60-150ms) — no per-batch HTTP round trip —
 * so thinking/text/tools update word-by-word exactly like a foreground
 * turn.
 *
 * Every event carries the RUNNER's wall-clock (`ts`), which flows into the
 * WSEvent timestamp + `data.ts` — duration badges ("Reasoned for Ns") stamp
 * with when things actually happened inside the sandbox, not when this
 * browser happened to receive them.
 *
 * On reload, `resumeBackgroundTurn` picks the persisted job back up and
 * continues consuming from its seq cursor (persisted next to every Dexie
 * checkpoint): whatever ran while the browser was closed replays into the
 * chat exactly once.
 *
 * v2.2 TRANSPORT RESILIENCE (PRD §23 — "stream loss ≠ job failure"): a
 * dead SSE segment (serverless cold start, network blip, paused sandbox,
 * black-holed connection) NEVER fails the turn. The consumer reconnects
 * with exponential backoff, resumes from the seq cursor (bg_wait is
 * cursor-driven → reconnects are idempotent), probes the run's real
 * liveness through the bg_status REST channel (which doubles as a fallback
 * event drain while SSE is down), and only ever surfaces an error when the
 * RUN ITSELF reports terminal failure. The persisted job is never cleared
 * on transport failure — a reload can always resume it.
 */

/** One bg_wait segment — the HTTP request stays open up to ~11s, then the
 *  client immediately re-issues. Well under the route's maxDuration=300.
 *  The segment IS the heartbeat: the server pushes a keep-alive data frame
 *  every ~2.5s while idle and a timeout frame at the cap, so a healthy
 *  segment ALWAYS yields ≥1 frame — “no EVENTS but frames” = alive,
 *  “no FRAMES at all / fetch throw” = dead connection → reconnect. */
const WAIT_SEGMENT_MS = 11_000;

// ── TRANSPORT-FAILURE RECOVERY (PRD §23) ────────────────────────────────────
/** First reconnect delay after a transport failure — doubles each failure. */
const RECONNECT_BASE_MS = 1_000;
/** Backoff ceiling — a long outage settles into one retry every 30s. */
const RECONNECT_MAX_MS = 30_000;
/** Zombie-connection watchdog: healthy segments cap at ~11s + heartbeats
 *  arrive every ~2.5s, so NO frame for this long means the connection is
 *  black-holed (no FIN/RST — the fetch promise would hang forever). Generous
 *  on purpose: a paused-sandbox `Sandbox.connect` auto-resume can take tens
 *  of seconds at segment open before the first frame. */
const SEGMENT_WATCHDOG_MS = 60_000;
/** Continuous outage length before the first NON-destructive banner
 *  (“reconnecting…”). Below this the hiccup is invisible — brief blips
 *  self-heal without bothering the user. */
const RECONNECT_NOTICE_MS = 30_000;
/** Hard limit (PRD §23): after this long without ANY transport, swap the
 *  banner to the reassuring “your job is still running” notice. NEVER a
 *  fatal error — reconnecting continues silently for as long as the job
 *  lives (the E2B run is unaffected server-side). */
const TRANSPORT_NOTICE_MS = 10 * 60_000;

export interface BackgroundTurnHandle {
  /** Stop the background job + the consumer. */
  stop: () => Promise<void>;
  /** The sandbox running this turn (ExecutionHub sidebar surfaces it). */
  sandboxId?: string;
  /** The run id (.onyx/runs/<runId>) — the replayable event log. */
  runId?: string;
}

interface RunContext {
  turn: AgentTurnOptions;
  e2bApiKey: string;
  userId: string;
  conversationId: string | null;
  /** The emit callback from the ExecutionHub's processor (the WSEvent
   *  pipeline — survives React unmounts). */
  emit: (event: WSEvent) => void;
  /** Synchronously land the processor's buffered render deltas (text /
   *  thinking / reasoning / tool args) into the store BEFORE a checkpoint
   * reads it. The processor batches render updates on a ~1ms macrotask
   * timer; without this flush a mid-run checkpoint persists content that
   * lags the last processed event by one delta while the seq cursor
   * already covers it — an abrupt kill (reload mid-stream) then lost
   * exactly that token on resume (cursor ahead of the checkpoint).
   * PRD §38: replay must be idempotent, never lossy. */
  flush?: () => void;
  /** Called when the turn finishes (done or error). */
  onFinished: () => void;
  /** The EXECUTION's headless chat store (ExecutionHub). History building
   *  and Dexie checkpointing read from it so they keep working while the
   *  user views another conversation (the global UI store may hold a
   *  different conversation's messages at that point). */
  store?: ExecutionChatStore;
}

/** Text-only conversation history for the sandbox runner (no tool parts).
 *  Reads the execution's store when provided (the hub always provides it),
 *  falling back to the global chat store for legacy callers. */
function buildHistory(turn: AgentTurnOptions, store?: ExecutionChatStore): Array<{ role: "user" | "assistant" | "system"; content: string }> {
  void turn; // history reads the live store (below); the options param
  // is kept for future turn-scoped history shaping.
  const history: Array<{ role: "user" | "assistant" | "system"; content: string }> = [];
  const messages = store ? store.getState().messages : globalMessagesCompat();
  // Prior turns (text content only — the background runner has no access to
  // browser-side tool context).
  for (const msg of messages) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const text =
      msg.content ||
      (msg.parts ?? [])
        .filter((p) => p.type === "text" && p.content)
        .map((p) => p.content)
        .join("\n\n");
    if (text && text.trim()) {
      history.push({ role: msg.role, content: text });
    }
  }
  // ONYX CONTEXT MANAGER (Infinite Context PRD): budget-aware window instead
  // of the old fixed slice(-20) — the same tiered compaction the foreground
  // runtime uses, so background turns get identical context shaping.
  const managed = manageContext({
    systemPrompt: turn.systemPrompt ?? "",
    tools: [],
    history: history.slice(-80), // bounded default window (cost control)
    model: turn.provider.model,
  });
  // Managed messages minus the LEADING system prompt (the sandbox runner
  // receives the system prompt separately in the turn payload).
  const shaped = managed.messages.filter((m, idx) => !(idx === 0 && m.role === "system"));
  console.log(
    `[context:bg] model=${turn.provider.model} window=${managed.usage.modelLabel} ` +
      `${Math.round(managed.usage.usagePercentage * 100)}% ${managed.usage.status} ` +
      `compaction=${managed.compaction.level} removed=${managed.compaction.removedMessages}`,
  );
  return shaped;
}

/** Global-store read (legacy callers without an execution store). */
function globalMessagesCompat(): import("@/types").ChatMessage[] {
  return useChatStore.getState().messages;
}

async function persistCheckpoint(
  conversationId: string,
  userId: string,
  assistantMessageId: string,
  isStreaming: boolean,
  store?: ExecutionChatStore,
): Promise<void> {
  const messages = store ? store.getState().messages : globalMessagesCompat();
  const msg = messages.find((m) => m.id === assistantMessageId);
  if (!msg) return;
  await conversationService.saveAgentCheckpoint(conversationId, userId, assistantMessageId, {
    role: "assistant",
    content: msg.content ?? "",
    thinking: (msg.parts ?? []).some((p) => p.type === "thinking")
      ? (msg.parts ?? []).filter((p) => p.type === "thinking").map((p) => p.content ?? "").join("\n")
      : undefined,
    reasoning: (msg.parts ?? []).some((p) => p.type === "reasoning")
      ? (msg.parts ?? []).filter((p) => p.type === "reasoning").map((p) => p.content ?? "").join("\n")
      : undefined,
    parts: msg.parts,
    toolCalls: msg.toolCalls,
    // "Worked {time}" summary — the event processor stamps it on the store
    // message at complete/error; the final (settling) checkpoint persists it.
    generation: msg.generation,
    isStreaming,
  });
}

/**
 * Consume one background run: seq-cursor SSE segment loop with TRANSPORT
 * RESILIENCE (PRD §23). The server PUSHES each batch of new events the
 * moment its sandbox read lands (60ms cadence while the stream is hot);
 * this consumer replays every event through the SAME `emit` pipeline the
 * in-browser runtime uses and re-opens the segment when it caps out (~11s,
 * one amortized RTT).
 *
 * STREAM LOSS ≠ JOB FAILURE — the reconnect contract:
 *   • dead segment (fetch throw / zero frames / unreachable frame / watchdog
 *     trip) → reconnect with exponential backoff (1s→2s→…→30s cap),
 *     indefinitely while the job is alive; backoff + outage clock reset the
 *     moment frames (or fallback events) flow again;
 *   • before anything is declared dead, `pollBackgroundTurn` (bg_status — a
 *     separate REST channel that reconnects to the sandbox independently and
 *     auto-resumes a paused one) is probed for the RUN's real status: still
 *     running/paused → keep reconnecting; its events are also drained as a
 *     fallback so the UI keeps moving while SSE is down; terminal → the
 *     honest done/error is surfaced (genuine job failure only);
 *   • the persisted job (localStorage `onyx-bg-jobs`) is NEVER cleared on
 *     transport failure, so a reload always resumes;
 *   • after TRANSPORT_NOTICE_MS of continuous outage a NON-destructive
 *     banner ("reconnecting… your job is still running") replaces the old
 *     fatal error — reconnecting continues silently.
 *
 * Returns when the run reaches a terminal status (done/error), the consumer
 * is stopped, or an unexpected exception escapes (the caller's last-resort
 * net). Shared by start + resume so both paths replay identically.
 *
 * Exported for the reconnect-loop regression test (transport loss must NEVER
 * produce a fatal error — PRD §23).
 */
export async function consumeRun(ctx: {
  e2bApiKey: string;
  job: BgJob;
  conversationId: string;
  userId: string;
  emit: (type: WSEvent["type"], data: Record<string, unknown>) => void;
  onFinished: () => void;
  isStopped: () => boolean;
  /** v3 bridge: provider API key + abort signal for browser-side tool calls. */
  aiApiKey?: string | null;
  bridgeAbort?: AbortController;
  /** The execution's store (checkpointing source — survives navigation). */
  store?: ExecutionChatStore;
  /** Land the processor's buffered render deltas before checkpoints (see
   *  RunContext.flush — keeps the seq cursor strictly behind the persisted
   *  content, never ahead). */
  flush?: () => void;
}): Promise<void> {
  const { e2bApiKey, job } = ctx;
  /** Seq cursor — starts at the persisted lastSeq (resume lands AFTER the
   *  checkpointed content) and advances with every processed event; bg_wait
   *  takes it as `afterSeq`, so every reconnect/reload replays exactly the
   *  events this browser has not yet seen (idempotent — PRD §38). */
  let cursor = job.lastSeq ?? 0;

  // WSEvent-emitting wrapper handed to bridged tools (ask_user questions,
  // tool_output, todo events …) — the same pipeline the runtime uses.
  const bridgeEmit = (e: WSEvent) => {
    ctx.emit(e.type, e.data as Record<string, unknown>);
  };

  // ── seq-cursor persistence (reload-resume starts after the checkpoint) ──
  // COHERENCE RULE: the cursor advances in localStorage only AFTER the
  // matching Dexie checkpoint landed. A crash between the two replays the
  // tail onto the stale checkpoint (harmless re-render — the content wasn't
  // in the checkpoint); the reverse order would SKIP events whose
  // checkpoint never landed (lost output — PRD §38 forbids that).
  let cursorSavedAt = 0;
  const persistCursor = (force = false) => {
    const now = Date.now();
    // Throttle non-forced writes: token-level batches land every 60-150ms;
    // one localStorage write per second is plenty. Forced writes ride every
    // successful checkpoint + every exit path.
    if (!force && now - cursorSavedAt < 1_000) return;
    cursorSavedAt = now;
    try {
      updateJobCursor(job.assistantMessageId, cursor);
    } catch {
      // best-effort — localStorage quota / private mode
    }
  };
  /** Checkpoint + cursor in the coherence order (see above). */
  const checkpointAndAdvance = async (isStreaming: boolean) => {
    try {
      // Flush the processor's render buffers FIRST so the checkpoint
      // content covers every event the seq cursor is about to cover.
      // (The buffers land on a ~1ms macrotask; reading the store without
      // flushing persisted content one delta BEHIND the cursor — an abrupt
      // kill then skipped exactly that delta on resume.)
      try {
        ctx.flush?.();
      } catch {
        // best-effort — the 1ms buffer timer still lands the content
      }
      await persistCheckpoint(ctx.conversationId, ctx.userId, job.assistantMessageId, isStreaming, ctx.store);
      persistCursor(true);
    } catch {
      // Checkpoint failed — leave the cursor BEHIND so a reload replays
      // this batch onto the stale checkpoint (idempotent re-render).
    }
  };

  /** Sandbox-native tools that MUTATE the workspace (bg-agent-script's
   *  TOOLS array). Their results must bump the browser-side workspace
   *  version — they bypass the browser registry, so without this neither
   *  the snapshot cache nor the preview panel's freshness bus (the
   *  stale-iframe fix) would ever learn that files changed during a
   *  background turn. */
  const BG_NATIVE_WRITE_TOOLS = new Set([
    "write_file",
    "create_file",
    "edit_file",
    "create_file_chunk",
    "delete_file",
    "move_file",
    "create_folder",
    "delete_folder",
    "run_terminal",
    "run_python",
  ]);

  /** tool_call id → name (native bg tools), so the nameless tool_result
   *  events can be attributed. */
  const nativeToolNames = new Map<string, string>();

  /** Replay one batch of events through the pipeline (seq order == file
   *  order). Shared by the SSE frames and the bg_status fallback drain.
   *  Returns true when the batch contained a terminal (done/error) event. */
  const processEvents = (events: BgEvent[]): boolean => {
    let finished = false;
    for (const ev of events) {
      if (typeof ev.seq === "number" && ev.seq > cursor) cursor = ev.seq;
      if (ev.t === "browser_tool_call") {
        // v3 FULL TOOLSET — the sandbox runner delegated a browser-registry
        // tool to this browser. Fire-and-forget: NEVER block the replay
        // loop (a long ask_user wait must not stall event consumption —
        // the runner serializes tool ordering on its side). Reload-safe
        // dedup lives inside handleBrowserToolCall (localStorage marks,
        // keyed by the EVENT SEQ — gateways like kilo-auto reuse tool-call
        // ids such as call_0_0 across rounds, so the id alone collides).
        void handleBrowserToolCall({
          e2bApiKey,
          sandboxId: job.sandboxId,
          runId: job.runId,
          conversationId: ctx.conversationId,
          userId: ctx.userId,
          aiApiKey: ctx.aiApiKey,
          callId: String(ev.id ?? ""),
          name: String(ev.name ?? ""),
          args: (ev.args ?? {}) as Record<string, unknown>,
          eventSeq: typeof ev.seq === "number" ? ev.seq : undefined,
          emit: bridgeEmit,
          signal: ctx.bridgeAbort?.signal,
        }).catch(() => {
          // best-effort — the runner's timeout produces a graceful error
        });
        continue;
      }
      // NATIVE WRITE TRANSPARENCY: attribute tool_call → name, and when a
      // mutating NATIVE tool finishes, bump the browser workspace version
      // (also publishes to the workspace-activity bus → the preview panel
      // reloads its iframe once writes settle — the stale-scaffold-page
      // fix applies to background turns too). Bridged tools bump inside
      // their own browser handlers, so they are filtered by the name set.
      if (ev.t === "tool_call" && typeof ev.name === "string" && BG_NATIVE_TOOL_NAMES.has(ev.name)) {
        nativeToolNames.set(String(ev.id ?? ""), ev.name);
      } else if (ev.t === "tool_result" && typeof ev.id === "string") {
        const name = nativeToolNames.get(ev.id);
        if (name && BG_NATIVE_WRITE_TOOLS.has(name)) {
          bumpWorkspaceVersion();
        }
      }
      replayEvent(ctx.emit, ev);
      if (ev.t === "done" || ev.t === "error") finished = true;
    }
    return finished;
  };

  /** Close the run out: final checkpoint (isStreaming=false), terminal
   *  events, job cleanup. `statusError` is set ONLY for a genuine run
   *  failure reported by the run itself — never for transport loss. */
  const finishRun = async (statusError: string | null) => {
    try {
      await persistCheckpoint(ctx.conversationId, ctx.userId, job.assistantMessageId, false, ctx.store);
    } catch {
      // best-effort — the per-batch checkpoint already covers the content
    }
    persistCursor(true);
    if (statusError) {
      ctx.emit("error", { message: statusError });
    }
    ctx.emit("complete", {});
    clearJob(job.assistantMessageId);
    ctx.onFinished();
  };

  // ── outage state ──
  let backoffMs = RECONNECT_BASE_MS;
  /** When the CURRENT continuous transport outage began (null = healthy). */
  let failedSince: number | null = null;
  /** Banner stage: 0 none, 1 early "reconnecting…", 2 hard-limit
   *  "your job is still running". NON-destructive (the PRD §7 rate-limit
   *  banner slot — agent state preserved, nothing duplicated). */
  let noticeStage = 0;

  // ── VISIBILITY-AWARE OUTAGE ACCOUNTING (Runtime PRD §10/§86/§87) ─────────
  // A hidden browser tab is NOT evidence of a sandbox disconnection. Browser
  // timer throttling in a hidden tab can stall the SSE reader + backoff
  // timers for 20-60s while the E2B job runs perfectly — the old wall-clock
  // outage then showed the false "connection interrupted" banner the moment
  // the user returned. Rules implemented here:
  //   1. Notices are driven by VISIBLE outage time only — on
  //      visibilitychange→visible the notice clock RESETS (fresh 30s budget)
  //      and any stage-1 banner clears; the user sees the live state, not a
  //      stale accusation.
  //   2. Returning to the tab wakes the backoff sleep immediately (a silent
  //      re-subscribe of the SAME single loop — never a second consumer, so
  //      reconnects stay idempotent, PRD §14/§78). No sandbox is created or
  //      restarted by visibility changes (PRD §86).
  let wakeSleep: (() => void) | null = null;
  const onVisible = () => {
    if (document.visibilityState !== "visible") return;
    if (failedSince !== null) {
      // Restart the VISIBLE-outage budget; keep silently reconnecting.
      failedSince = Date.now();
      if (noticeStage === 1) clearNotice();
    }
    // Short-circuit the current backoff sleep — probe right now.
    backoffMs = RECONNECT_BASE_MS;
    try {
      wakeSleep?.();
    } catch {
      // best-effort
    }
  };
  try {
    document.addEventListener("visibilitychange", onVisible);
  } catch {
    // non-browser context — no visibility API
  }

  const clearNotice = () => {
    if (noticeStage === 0) return;
    noticeStage = 0;
    try {
      ctx.store?.getState().setRateLimitStatus(null);
    } catch {
      // best-effort
    }
  };
  const showNotice = (stage: 1 | 2) => {
    if (noticeStage >= stage) return;
    noticeStage = stage;
    try {
      ctx.store?.getState().setRateLimitStatus(
        stage === 1
          ? "Connection to the background sandbox was interrupted — reconnecting automatically…"
          : "Still reconnecting to the background sandbox — your job is still running on E2B and will resume here automatically.",
      );
    } catch {
      // best-effort
    }
  };
  /** Frames (or fallback events) are flowing again — the outage is over. */
  const outageOver = () => {
    failedSince = null;
    backoffMs = RECONNECT_BASE_MS;
    clearNotice();
  };

  try {
    for (;;) {
      if (ctx.isStopped()) return;
      let transportFailure = false;
      let failureReason = "";
      let sawFrame = false;

      // Zombie watchdog: abort a segment that produced NO frame for way
      // longer than its natural lifetime (dead connection without FIN/RST —
      // the fetch promise would hang forever). Generous on purpose: a
      // paused-sandbox Sandbox.connect auto-resume at segment open can take
      // tens of seconds before the first frame.
      const segmentAbort = new AbortController();
      const watchdog = setTimeout(() => segmentAbort.abort(), SEGMENT_WATCHDOG_MS);
      try {
        for await (
          const resp of streamBackgroundTurn(
            e2bApiKey,
            job.sandboxId,
            job.runId,
            cursor,
            WAIT_SEGMENT_MS,
            segmentAbort.signal,
          )
        ) {
          sawFrame = true;
          if (ctx.isStopped()) return; // for-await return → generator's finally cancels the fetch
          if (resp.status === "unreachable") {
            // Sandbox-side connect failure (paused sandbox / cold start /
            // E2B blip) — TRANSPORT, not job failure. Sandbox.connect
            // auto-resumes paused sandboxes, so retrying is the cure.
            transportFailure = true;
            failureReason = resp.error ?? "sandbox unreachable";
            break;
          }
          // A live frame — any previous outage is over.
          if (failedSince !== null) outageOver();
          // Replay new events through the pipeline (seq order == file order).
          const events = resp.events ?? [];
          const finished = processEvents(events);
          if (typeof resp.afterSeq === "number" && resp.afterSeq > cursor) cursor = resp.afterSeq;
          if (resp.done || finished) {
            await finishRun(null); // terminal events already replayed
            return;
          }
          // Checkpoint after every batch with content (so a reload mid-run
          // shows progress), then advance the persisted cursor.
          if (events.length > 0) {
            await checkpointAndAdvance(true);
          }
          // Immediately keep reading — the server pushes the next batch the
          // moment it lands (no fixed-tick sleep, no per-batch round trip).
        }
      } catch (err) {
        // fetch/stream failed mid-segment (network blip, watchdog abort) —
        // transport failure, NOT job failure.
        transportFailure = true;
        failureReason = err instanceof Error ? err.message : String(err);
      } finally {
        clearTimeout(watchdog);
      }
      if (ctx.isStopped()) return;

      // A healthy segment ALWAYS yields ≥1 frame (keep-alive every ~2.5s,
      // timeout frame at the ~11s cap). The generator ending cleanly with
      // ZERO frames means the connection was silently killed — a transport
      // failure too (otherwise this would busy-loop re-opening segments).
      if (!sawFrame && !transportFailure) {
        transportFailure = true;
        failureReason = "no stream frames";
      }

      if (!transportFailure) {
        // Clean segment end (timeout frame / stream close after frames) —
        // checkpoint and re-open at once. Empty EVENTS with a frame = the
        // connection is ALIVE (keep-alive/timeout frame); only a missing
        // FRAME means the connection died.
        await checkpointAndAdvance(true);
        continue;
      }

      // ── TRANSPORT FAILURE → RECONNECT WITH BACKOFF (never a fatal error) ─
      if (failedSince === null) {
        failedSince = Date.now();
        console.warn(
          "[background-turn] stream lost — reconnecting (the E2B job keeps running):",
          failureReason,
        );
      }

      // Liveness probe through the sibling REST channel (bg_status): it
      // reconnects to the sandbox independently of the SSE path, is the
      // ONLY source of an honest terminal verdict, and doubles as a
      // FALLBACK event drain so the UI keeps moving while the stream is
      // down. Sandbox.connect inside it auto-resumes a paused sandbox.
      try {
        const snap = await pollBackgroundTurn(e2bApiKey, job.sandboxId, job.runId);
        if (snap.status !== "unreachable") {
          // REST LIVENESS (Runtime PRD §13/§84): the sandbox + run are
          // verifiably REACHABLE through the sibling channel — the SSE leg
          // merely hiccuped. That is NOT a "connection to the background
          // sandbox interrupted" event: restart the visible-outage budget
          // so no banner fires while probes keep proving liveness, and keep
          // re-subscribing the SSE leg silently.
          failedSince = Date.now();
          if (noticeStage === 1) clearNotice();
          // bg_status returns the WHOLE event log — keep only what this
          // browser has not consumed yet (seq dedupe; seq-less v1-legacy
          // events stay on the SSE channel to avoid replay loops).
          const missed = (snap.events ?? []).filter(
            (ev): ev is BgEvent => typeof ev.seq === "number" && ev.seq > cursor,
          );
          if (missed.length > 0) {
            const finished = processEvents(missed);
            await checkpointAndAdvance(!snap.done);
            if (finished || snap.done) {
              // Terminal state reached through the fallback channel.
              await finishRun(
                snap.status === "error" && !finished ? snap.error ?? "Background run failed." : null,
              );
              return;
            }
            // Events ARE flowing through the fallback — the run is alive;
            // only the SSE path is broken.
            outageOver();
          } else if (snap.done) {
            // Terminal state with no undelivered events (the terminal event
            // was already consumed; state.json merely confirms it).
            await finishRun(snap.status === "error" ? snap.error ?? "Background run failed." : null);
            return;
          }
        }
      } catch {
        // /api/sandbox itself unreachable (offline / serverless cold start)
        // — pure network outage; keep retrying.
      }

      // NON-destructive notices (PRD §23): early banner, then the hard-limit
      // reassurance — now driven by VISIBLE outage time only (hidden periods
      // reset the clock on return, and a successful REST liveness probe
      // restarts it — see above). NEVER the old fatal "Lost the connection"
      // error — the job stays persisted and reconnecting continues indefinitely.
      if (failedSince !== null) {
        const outageMs = Date.now() - failedSince;
        if (outageMs >= TRANSPORT_NOTICE_MS) showNotice(2);
        else if (outageMs >= RECONNECT_NOTICE_MS) showNotice(1);
      }

      // Wakeable backoff sleep — visibilitychange→visible short-circuits it
      // (silent immediate re-probe; never a second consumer loop).
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          wakeSleep = null;
          resolve();
        };
        wakeSleep = finish;
        setTimeout(finish, backoffMs);
      });
      backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
    }
  } finally {
    // Last-write-wins safety net for every exit path (stop / terminal /
    // unexpected) — a no-op once the job record was cleared.
    persistCursor(true);
    try {
      document.removeEventListener("visibilitychange", onVisible);
    } catch {
      // best-effort
    }
    wakeSleep = null;
  }
}

/**
 * Run one turn in the background sandbox. Returns the handle, or null when
 * the launch failed (caller falls back to the in-browser runtime).
 */
export async function startBackgroundTurn(ctx: RunContext): Promise<BackgroundTurnHandle | null> {
  // GENERATION IDENTITY (the "streaming behind, Thinking forever" fix):
  // useChat.doSend primes the ExecutionHub's processor with an early
  // `model_request_start` carrying `turn.generationId` — the processor then
  // DISCARDS every event whose generation_id doesn't match it (stale-turn
  // guard). Minting a separate `bg-…` id here meant the live consumer's
  // every event (text/thinking/tool deltas, message_saved, complete) was
  // dropped as "stale": the sandbox streamed fine, but the UI stayed on the
  // Thinking orb with zero rendered text and no Dexie checkpoints (the
  // bgmsg row never materialized in the execution store) — only a page
  // reload "fixed" it because the resumed processor was unprimed and
  // accepted the fresh generation. Stamp this turn's events with the SAME
  // generation doSend primed; fall back to a fresh one for callers that
  // don't provide one (their processors are unprimed).
  const generationId = ctx.turn.generationId ?? `bg-${nanoid(10)}`;
  let conversationId = ctx.conversationId;

  const emit = (type: WSEvent["type"], data: Record<string, unknown>) => {
    ctx.emit({ type, data: { ...data, generation_id: generationId }, timestamp: new Date().toISOString() });
  };

  try {
    // 1. Ensure a conversation exists (new chat → create + notify).
    if (!conversationId) {
      // OnyxCode Code Mode: turns started on /code stamp their lazily-created
      // conversation with mode:"code" so the sidebars can filter them.
      const conv = await conversationService.create(
        ctx.userId,
        undefined,
        isCodeMode() ? "code" : undefined,
      );
      conversationId = conv.id;
      // The pipeline's conversation_created handler attaches the id, fixes
      // the URL, and notifies the host — no separate callback needed.
      emit("conversation_created", { conversation_id: conv.id });
    }

    // 2. Persist the user message (mirrors the runtime's user_prompt path —
    //    the store's optimistic temp id swaps for the DB row id).
    const userRow = await conversationService.addMessage(conversationId, ctx.userId, {
      role: "user",
      content: ctx.turn.userMessage,
      fileIds: ctx.turn.fileIds,
    });
    emit("user_prompt", { message_id: userRow.id });

    // 3. Create the assistant message in the store via the pipeline.
    emit("model_request_start", { round: 1 });
    // The pipeline creates the message with a temp id; use a stable id via
    // message_saved immediately so later checkpoints upsert one row.
    const assistantMessageId = `bgmsg-${nanoid(10)}`;
    emit("message_saved", { message_id: assistantMessageId });

    // 4. Launch the sandbox background job. The current todo plan (live
    //    store snapshot) rides along as seedTodos — the runner restores it
    //    into the sandbox's shared todos.json when the sandbox was recreated
    //    (PRD FR-1: todos persist across tool calls, turns, sessions).
    const seedTodos = (() => {
      try {
        const bucket = useResearchStore.getState().byTurn[conversationId ?? ""];
        const todos = bucket?.agentTodos;
        return Array.isArray(todos) && todos.length > 0
          ? todos.map((t) => ({
              id: t.id,
              title: t.title,
              status: t.status,
              createdAt: t.createdAt,
              updatedAt: t.updatedAt,
            }))
          : undefined;
      } catch {
        return undefined;
      }
    })();

    // v3 FULL TOOLSET — mirror the in-browser runtime's per-turn loading
    // sequence (custom tools from IndexedDB + MCP tools), then snapshot every
    // registry tool that has no native sandbox implementation. The runner
    // exposes these to the LLM as bridged tools executed back here.
    let browserTools: Array<{ name: string; description: string; parameters: Record<string, unknown> }> = [];
    // MODE ISOLATION (OnyxCode PRD §3) — record-driven (the conversation
    // decides, not the current route: a background job outlives the page).
    // Defaults to the live route flag; upgraded to the record's mode below.
    let bgCodeMode = isCodeMode();
    try {
      const { loadDynamicTools } = await import("@/lib/tools/dynamic_tools");
      await loadDynamicTools(ctx.userId);
    } catch {
      // Non-fatal — built-ins still bridge.
    }
    try {
      const { loadMCPTools } = await import("@/lib/tools/mcp_tools");
      await loadMCPTools(ctx.userId);
    } catch {
      // Non-fatal — a bad MCP server doesn't block the turn.
    }
    try {
      // REQUEST-SCOPED EXPOSURE for the bridged snapshot: the conversation
      // RECORD decides the mode (Runtime PRD §63 — the route is not enough;
      // a background job outlives the page). Code-only tools (create_app,
      // previews, the kv_*/storage_* suite) never bridge into normal Agent
      // background turns; in Code Mode the database write half is
      // intent-gated exactly like the foreground runtime.
      let bgScope: { codeMode: boolean; lastUserText?: string | null; usedToolNames?: Iterable<string> } | undefined;
      try {
        const conv = conversationId
          ? await conversationService.get(conversationId, ctx.userId)
          : null;
        const storeMsgs = ctx.store?.getState().messages ?? [];
        const lastUser = [...storeMsgs].reverse().find((m) => m.role === "user");
        const used = new Set<string>();
        for (const m of storeMsgs) {
          for (const p of m.parts ?? []) {
            if (p.type === "tool" && p.toolCall?.name) used.add(p.toolCall.name);
          }
        }
        bgScope = {
          codeMode: conv?.mode === "code",
          lastUserText:
            (typeof lastUser?.content === "string" ? lastUser.content : "") || null,
          usedToolNames: used,
        };
        bgCodeMode = conv?.mode === "code";
      } catch {
        bgScope = undefined; // unscoped — bridge everything (legacy behavior)
      }
      browserTools = collectBridgeableTools(BG_NATIVE_TOOL_NAMES, bgScope);
    } catch {
      browserTools = [];
    }

    const job = await launchBackgroundTurn({
      e2bApiKey: ctx.e2bApiKey,
      codeMode: bgCodeMode,
      provider: {
        baseUrl: ctx.turn.provider.baseUrl,
        apiKey: ctx.turn.provider.apiKey,
        model: ctx.turn.provider.model,
        temperature: ctx.turn.temperature ?? undefined,
        toolsEnabled: ctx.turn.provider.toolsEnabled,
        noPrefix: ctx.turn.provider.noPrefix,
        disabledParams: ctx.turn.provider.disabledParams ?? [],
      },
      systemPrompt: ctx.turn.systemPrompt,
      history: buildHistory(ctx.turn, ctx.store),
      assistantMessageId,
      conversationId,
      seedTodos,
      browserTools,
    });

    // 5. Consume the run's event stream until it finishes. The consumer
    //    lives only as long as this browser tab is open; the JOB itself
    //    keeps running regardless.
    const bridgeAbort = new AbortController();
    let stopped = false;
    void (async () => {
      await consumeRun({
        e2bApiKey: ctx.e2bApiKey,
        job,
        conversationId: conversationId!,
        userId: ctx.userId,
        emit,
        onFinished: ctx.onFinished,
        isStopped: () => stopped,
        aiApiKey: ctx.turn.provider.apiKey,
        bridgeAbort,
        store: ctx.store,
        flush: ctx.flush,
      });
    })().catch(() => {
      // LAST-RESORT net only: transport failures are handled INSIDE
      // consumeRun (reconnect with backoff — PRD §23); this fires solely
      // on an unexpected consumer crash (e.g. a thrown emit).
      emit("error", { message: "The background stream consumer stopped unexpectedly." });
      clearJob(assistantMessageId);
      ctx.onFinished();
    });

    return {
      stop: async () => {
        stopped = true;
        bridgeAbort.abort();
        try {
          await stopBackgroundTurn(ctx.e2bApiKey, job.sandboxId);
        } catch {
          // best-effort
        }
        clearJob(assistantMessageId);
        emit("final_result", { output: "" });
        emit("complete", {});
        ctx.onFinished();
      },
      /** The sandbox running this turn (ExecutionHub surfaces it). */
      sandboxId: job.sandboxId,
      /** The run id (.onyx/runs/<runId>). */
      runId: job.runId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[background-turn] launch failed, falling back to in-browser runtime:", message);
    return null;
  }
}

/** Translate one sandbox event into the WSEvent pipeline. */
function replayEvent(
  emit: (type: WSEvent["type"], data: Record<string, unknown>) => void,
  ev: BgEvent,
): void {
  const round = ev.round ?? 1;
  // Runner wall-clock flows into the event data (`ts`) so the chat store
  // stamps durations with when things ACTUALLY happened in the sandbox.
  const ts = typeof ev.ts === "number" ? ev.ts : Date.now();
  switch (ev.t) {
    case "round_start":
      emit("model_request_start", { round, ts });
      break;
    case "reasoning":
      // v1 legacy monolithic reasoning — one big delta.
      emit("reasoning_delta", { content: ev.content ?? "", round, ts });
      break;
    case "reasoning_delta":
      emit("reasoning_delta", { content: ev.content ?? "", round, ts });
      break;
    case "text":
      // v1 legacy monolithic text — one big delta.
      emit("text_delta", { content: ev.content ?? "", round, ts });
      break;
    case "text_delta":
      emit("text_delta", { content: ev.content ?? "", round, ts });
      break;
    case "tool_call_delta":
      if (ev.tool_calls?.length) {
        emit("tool_call_delta", { tool_calls: ev.tool_calls, ts });
      }
      break;
    case "tool_call": {
      const preemit = (ev as { _preemit?: boolean })._preemit === true;
      emit("tool_call", {
        tool_call_id: ev.id ?? `bg-${round}-${ev.name}`,
        tool_name: ev.name ?? "unknown",
        args: ev.args ?? {},
        ts,
        ...(preemit ? { _preemit: true } : {}),
      });
      break;
    }
    case "tool_result": {
      // The runner stringifies the result; parse it back so the cards get
      // real objects (matching the in-browser tool_result shape).
      let result: unknown = ev.result ?? "";
      if (typeof result === "string" && result.trim().startsWith("{")) {
        try {
          result = JSON.parse(result);
        } catch {
          // keep the string
        }
      }
      emit("tool_result", {
        tool_call_id: ev.id ?? "unknown",
        content: result,
        ts,
      });
      break;
    }
    case "status": {
      const kind = ev.kind ?? "";
      if (kind === "first_token") {
        emit("llm_started", { ts });
      } else if (kind === "llm_end") {
        emit("llm_completed", { round, ts });
      } else if (kind === "retry") {
        emit("rate_limited", {
          retryAfterMs: ev.delayMs ?? 2_000,
          attempt: ev.attempt ?? 1,
          maxAttempts: 4,
          reason: typeof ev.reason === "string" ? ev.reason : undefined,
          ts,
        });
      }
      // "boot" and unknown kinds carry no UI state — ignored.
      break;
    }
    case "todo_event": {
      // Live todo snapshot from the sandbox's shared todos.json — feeds the
      // same todo_event pipeline the in-browser tools use, so the
      // TodoPreview statuses update IN REAL TIME in background mode too.
      if (Array.isArray(ev.todos)) {
        emit("todo_event", {
          event_type: "snapshot",
          todo: null,
          all_todos: ev.todos,
          ts,
        });
      }
      break;
    }
    case "done":
      emit("llm_completed", { round, ts });
      emit("final_result", { output: ev.content ?? "" });
      break;
    case "error":
      emit("error", { message: ev.message ?? "Background run failed." });
      break;
  }
}

/**
 * Resume the persisted background job for a conversation after a reload:
 * replays any events that ran while the browser was closed, then keeps
 * consuming until the turn finishes. consumeRun picks up from the job's
 * persisted seq cursor (saved next to every Dexie checkpoint), so the
 * replay lands strictly AFTER the checkpointed content — exactly once,
 * never duplicated (PRD §38). Returns the handle, or null when there is
 * nothing to resume.
 */
export async function resumeBackgroundTurn(ctx: {
  e2bApiKey: string;
  userId: string;
  conversationId: string;
  emit: (event: WSEvent) => void;
  /** Land the processor's buffered render deltas before checkpoints (see
   *  RunContext.flush — same coherence contract as the live path). */
  flush?: () => void;
  onFinished: () => void;
  /** The execution's store (checkpointing source — the hub provides it). */
  store?: ExecutionChatStore;
}): Promise<BackgroundTurnHandle | null> {
  const job = getActiveJob(ctx.conversationId);
  if (!job) return null;

  const generationId = `bg-${nanoid(10)}`;
  const emit = (type: WSEvent["type"], data: Record<string, unknown>) => {
    ctx.emit({ type, data: { ...data, generation_id: generationId }, timestamp: new Date().toISOString() });
  };

  // Reload restored the assistant message from the checkpoint; re-adopt it
  // as the current streaming message. (The processor's message_saved handler
  // ADOPTS the existing checkpointed row — it never renames the fresh temp
  // shell on top of it, so no duplicate empty bubble.)
  emit("model_request_start", { round: 1 });
  emit("message_saved", { message_id: job.assistantMessageId });

  const bridgeAbort = new AbortController();
  let stopped = false;
  void (async () => {
    await consumeRun({
      e2bApiKey: ctx.e2bApiKey,
      job,
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      emit,
      onFinished: ctx.onFinished,
      isStopped: () => stopped,
      bridgeAbort,
      store: ctx.store,
      flush: ctx.flush,
    });
  })().catch(() => {
    // best-effort — the next reload resumes again.
  });

  return {
    stop: async () => {
      stopped = true;
      bridgeAbort.abort();
      try {
        await stopBackgroundTurn(ctx.e2bApiKey, job.sandboxId);
      } catch {
        // best-effort
      }
      clearJob(job.assistantMessageId);
      emit("final_result", { output: "" });
      emit("complete", {});
      ctx.onFinished();
    },
    /** The sandbox running this turn (ExecutionHub surfaces it). */
    sandboxId: job.sandboxId,
    /** The run id (.onyx/runs/<runId>). */
    runId: job.runId,
  };
}

/** The persisted job for a conversation, if any (used by the resume path). */
export function backgroundJobFor(conversationId: string | null): BgJob | null {
  const job = getActiveJob(conversationId);
  return job;
}

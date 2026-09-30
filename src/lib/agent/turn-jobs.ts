import ZAI from "z-ai-web-dev-sdk";
import {
  REASONING_OPEN,
  routeRequest,
  splitThinking,
  type ModelPreference,
  type RouterMessage,
} from "./router";

/**
 * Background turn jobs.
 *
 * A model turn used to live inside the /api/chat request handler: when the
 * browser backgrounded/froze the tab (or any proxy dropped the leg),
 * `request.signal` fired and aborted the whole turn mid-reasoning — the
 * "Stream read failed: This operation was aborted" class of failure.
 *
 * Now a turn runs as an in-process JOB that is completely detached from any
 * HTTP connection. The SSE response is just a *viewer* that replays the job's
 * event log and follows it live; disconnecting the viewer never touches the
 * job. When the tab comes back it re-attaches with a `since` cursor and
 * receives exactly the events it missed — so background work always
 * completes and retrieval is near-instant.
 */

export type TurnEvent =
  | {
      type: "route";
      route: "fast" | "balanced" | "deep";
      label: string;
      model: string;
      reason: string;
      thinking: boolean;
      resume: boolean;
    }
  | { type: "reasoning"; text: string }
  | { type: "delta"; text: string }
  | { type: "replace"; reasoning: string; answer: string }
  | { type: "status"; text: string }
  | { type: "warning"; text: string }
  | { type: "done"; elapsedMs?: number; partial?: boolean }
  | { type: "error"; message: string }
  | { type: "cancelled" };

export interface IndexedTurnEvent {
  index: number;
  event: TurnEvent;
}

type Subscriber = (indexed: IndexedTurnEvent) => void;

/** How long a finished job stays retrievable. */
const FINISHED_TTL_MS = 10 * 60_000;
/** Hard wall-clock cap on a single turn. */
const RUNNING_TTL_MS = 12 * 60_000;
/** Finished jobs kept in memory (LRU by finish time). */
const MAX_FINISHED_JOBS = 20;

/** How long an upstream silence may last before we cancel the stalled reader. */
const UPSTREAM_IDLE_MS = 90_000;
/** Fresh retries when the upstream dies before any content was produced. */
const MAX_FRESH_RETRIES = 2;
/** Headers timeout for the upstream create call. */
const UPSTREAM_HEADERS_MS = 60_000;

export class TurnJob {
  readonly id: string;
  readonly createdAt = Date.now();
  readonly events: IndexedTurnEvent[] = [];
  done = false;
  finishedAt: number | null = null;
  cancelReason: "user" | "ttl" | null = null;

  private readonly subscribers = new Set<Subscriber>();
  private readonly abortController = new AbortController();
  private ttlTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(id: string) {
    this.id = id;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get aborted(): boolean {
    return this.abortController.signal.aborted;
  }

  append(event: TurnEvent): void {
    if (this.done) return;
    const indexed: IndexedTurnEvent = { index: this.events.length, event };
    this.events.push(indexed);
    for (const subscriber of this.subscribers) {
      try {
        subscriber(indexed);
      } catch {
        // A broken viewer never breaks the job.
        this.subscribers.delete(subscriber);
      }
    }
    if (event.type === "done" || event.type === "error" || event.type === "cancelled") {
      this.done = true;
      this.finishedAt = Date.now();
      this.subscribers.clear();
      if (this.ttlTimer) {
        clearTimeout(this.ttlTimer);
        this.ttlTimer = null;
      }
    }
  }

  subscribe(subscriber: Subscriber): () => void {
    if (this.done) return () => undefined;
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /** Detached viewers disconnect freely — the job keeps running. */
  cancel(reason: "user" | "ttl" = "user"): void {
    if (this.done) return;
    this.cancelReason = reason;
    this.abortController.abort();
  }

  armTtl(): void {
    if (this.ttlTimer) return;
    this.ttlTimer = setTimeout(() => {
      this.ttlTimer = null;
      this.cancel("ttl");
    }, RUNNING_TTL_MS);
  }
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

const jobs = new Map<string, TurnJob>();

function gcJobs(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.done && job.finishedAt !== null && now - job.finishedAt > FINISHED_TTL_MS) {
      jobs.delete(id);
    } else if (!job.done && now - job.createdAt > RUNNING_TTL_MS + 30_000) {
      // Safety net if the pipeline failed to observe the TTL abort.
      job.cancel("ttl");
      jobs.delete(id);
    }
  }
  // Cap finished jobs (newest first).
  const finished = [...jobs.values()]
    .filter((j) => j.done)
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  for (const job of finished.slice(MAX_FINISHED_JOBS)) {
    jobs.delete(job.id);
  }
}

if (typeof setInterval === "function") {
  const timer = setInterval(gcJobs, 60_000);
  // Never hold the process open just for GC.
  (timer as { unref?: () => void }).unref?.();
}

export function getTurnJob(id: string): TurnJob | undefined {
  return jobs.get(id);
}

export function cancelTurnJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  job.cancel("user");
  return true;
}

/* ------------------------------------------------------------------ */
/* Upstream reader (idle-only watchdog, never kills an active stream)  */
/* ------------------------------------------------------------------ */

let cachedZai: Awaited<ReturnType<typeof ZAI.create>> | null = null;
async function getZai() {
  if (!cachedZai) cachedZai = await ZAI.create();
  return cachedZai;
}

interface UpstreamChunk {
  content: string;
  finish: string | null;
}

function isAbortLike(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? "";
  const message = error instanceof Error ? error.message : String(error);
  return name === "AbortError" || name === "TimeoutError" || /aborted|abort/i.test(message);
}

function isRetryableUpstream(error: unknown): boolean {
  if (isAbortLike(error)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    /fetch failed|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket|premature|stalled|idle watchdog|ended before any data|never responded|did not return a stream|stream read failed/i.test(
      message,
    ) || /\bHTTP (5|408|429)\d\b/.test(message)
  );
}

async function readUpstream(
  upstreamMessages: { role: "system" | "user" | "assistant"; content: string }[],
  thinking: boolean,
  temperature: number,
  onChunk: (chunk: UpstreamChunk) => void,
  externalAbort?: AbortSignal,
): Promise<{ finished: boolean }> {
  const zai = await getZai();

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let cancelledByWatchdog = false;

  // The SDK does not forward fetch signals, so cancellation works by
  // cancelling the body reader — that tears the upstream socket down.
  const cancelUpstream = () => {
    cancelledByWatchdog = true;
    try {
      void reader?.cancel();
    } catch {
      // already cancelled
    }
  };
  const armIdleWatchdog = () => {
    if (idleTimer) clearTimeout(idleTimer);
    // Never abort an ACTIVE stream — only one that has been silent for
    // UPSTREAM_IDLE_MS, which no healthy reasoning phase should exceed.
    idleTimer = setTimeout(cancelUpstream, UPSTREAM_IDLE_MS);
  };
  const onExternalAbort = () => cancelUpstream();
  externalAbort?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    // Race the SDK call: if the gateway never even sends headers, fail fast
    // into the retry logic instead of hanging the turn forever. If the race
    // is lost on time but the create later resolves, release its body so the
    // socket never leaks.
    let createSettled = false;
    const createPromise = zai.chat.completions.create({
      messages: upstreamMessages,
      stream: true,
      thinking: { type: thinking ? "enabled" : "disabled" },
      temperature,
    }).then(
      (value) => {
        createSettled = true;
        return value;
      },
      (error) => {
        createSettled = true;
        throw error;
      },
    );
    const headersTimeout = new Promise<never>((_, reject) => {
      setTimeout(() => {
        if (createSettled) return;
        reject(new Error("Upstream never responded within 60s."));
        void createPromise.then(
          (late) => {
            if (late instanceof ReadableStream) void late.cancel().catch(() => undefined);
          },
          () => undefined,
        );
      }, UPSTREAM_HEADERS_MS);
    });
    const body: unknown = await Promise.race([createPromise, headersTimeout]);

    // The SDK resolves with the raw ReadableStream body when streaming.
    if (!(body instanceof ReadableStream)) {
      throw new Error("Upstream did not return a stream — retrying.");
    }

    reader = (body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finished = false;
    let sawAnyChunk = false;

    armIdleWatchdog();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdleWatchdog();
      sawAnyChunk = true;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, boundary).replace(/\r$/, "");
        buffer = buffer.slice(boundary + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === "[DONE]") {
          finished = true;
          continue;
        }
        try {
          const json = JSON.parse(payload) as {
            choices?: { delta?: { content?: unknown }; finish_reason?: unknown }[];
          };
          const choice = json.choices?.[0];
          const content = choice?.delta?.content;
          if (typeof content === "string" && content.length > 0) {
            onChunk({ content, finish: null });
          }
          if (typeof choice?.finish_reason === "string" && choice.finish_reason !== "null") {
            onChunk({ content: "", finish: choice.finish_reason });
            finished = true;
          }
        } catch {
          // Ignore malformed SSE fragments — the next chunk usually repairs.
        }
      }
    }
    if (cancelledByWatchdog && !finished) {
      throw new Error("Upstream stalled mid-stream (idle watchdog) — retryable.");
    }
    if (!sawAnyChunk && !finished) {
      throw new Error("Upstream stream ended before any data arrived.");
    }
    return { finished };
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (!cancelledByWatchdog) {
      try {
        void reader?.cancel();
      } catch {
        // already cancelled
      }
    }
    externalAbort?.removeEventListener("abort", onExternalAbort);
  }
}

/* ------------------------------------------------------------------ */
/* Turn pipeline — the whole model turn, detached from any request     */
/* ------------------------------------------------------------------ */

function errorDetail(error: unknown): string {
  if (!(error instanceof Error)) return "";
  const message = error.message ?? "";
  const httpMatch = /HTTP (\d{3})/.exec(message);
  if (httpMatch) {
    const status = httpMatch[1];
    if (status === "401" || status === "403") {
      return "The AI provider rejected the credentials. Please try again later.";
    }
    if (status === "429") {
      return "The AI provider is rate-limiting us for a moment. Try again shortly.";
    }
    if (status.startsWith("5")) {
      return "The AI provider is having a rough minute. Try again shortly.";
    }
  }
  if (/json|parse/i.test(message)) {
    return "The AI provider sent an unreadable reply. Please try again.";
  }
  return "";
}

export function startTurnJob(
  id: string,
  messages: RouterMessage[],
  preference: ModelPreference,
  resumeFrom: string | null,
): TurnJob {
  const existing = jobs.get(id);
  if (existing && !existing.done) return existing;

  gcJobs();
  const job = new TurnJob(id);
  jobs.set(id, job);
  job.armTtl();

  // Fire and forget: the job runs to completion no matter what any
  // HTTP connection does. All outcomes terminate the job.
  void runTurnPipeline(job, messages, preference, resumeFrom).catch((error) => {
    if (!job.done) {
      job.append({
        type: "error",
        message: `Terra could not complete the reply. ${
          errorDetail(error) || "Please try again."
        }`,
      });
    }
  });

  return job;
}

async function runTurnPipeline(
  job: TurnJob,
  messages: RouterMessage[],
  preference: ModelPreference,
  resumeFrom: string | null,
): Promise<void> {
  const startedAt = Date.now();
  const decision = routeRequest(messages, preference);
  const history = messages.slice(-decision.historyWindow);

  const upstreamMessages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: decision.systemPrompt },
    ...history.map((m) => ({ role: m.role, content: m.content }) as const),
  ];

  const temperature = decision.route === "fast" ? 0.4 : decision.route === "deep" ? 0.6 : 0.7;

  const send = (event: TurnEvent) => job.append(event);

  send({
    type: "route",
    route: decision.route,
    label: decision.label,
    model: decision.model,
    reason: decision.reason,
    thinking: decision.thinking,
    resume: Boolean(resumeFrom),
  });

  // Seed the replayable log with the recovered base so any viewer that
  // re-attaches from index 0 reconstructs the full reply.
  if (resumeFrom) {
    send({ type: "replace", reasoning: "", answer: resumeFrom });
  }

  let rawSoFar = resumeFrom ?? "";
  let lastReasoning = "";
  let lastAnswer = resumeFrom ?? "";
  let producedContent = rawSoFar.length > 0;
  let recoveredOnce = false;

  // While the opening "THINKING:" marker is still arriving one delta at
  // a time ("TH", "THIN", …) hold emission — otherwise those fragments
  // would flash as answer text before the marker completes.
  const openMarkerPending = (raw: string): boolean => {
    if (resumeFrom) return false;
    const stripped = raw.replace(/^[*_#>\s]*/, "");
    const head = stripped.slice(0, REASONING_OPEN.length).toUpperCase();
    if (head.length === 0) return raw.length < 8;
    return REASONING_OPEN.startsWith(head) && head.length < REASONING_OPEN.length;
  };

  const emitSplit = (nextRaw: string) => {
    rawSoFar = nextRaw;
    if (openMarkerPending(rawSoFar)) return;
    const { reasoning, answer } = splitThinking(nextRaw);
    if (reasoning.startsWith(lastReasoning) && reasoning.length > lastReasoning.length) {
      send({ type: "reasoning", text: reasoning.slice(lastReasoning.length) });
      lastReasoning = reasoning;
    } else if (!reasoning.startsWith(lastReasoning)) {
      send({ type: "replace", reasoning, answer });
      lastReasoning = reasoning;
      lastAnswer = answer;
      return;
    }
    if (answer.startsWith(lastAnswer) && answer.length > lastAnswer.length) {
      send({ type: "delta", text: answer.slice(lastAnswer.length) });
      lastAnswer = answer;
    } else if (!answer.startsWith(lastAnswer)) {
      send({ type: "replace", reasoning, answer });
      lastAnswer = answer;
      lastReasoning = reasoning;
    }
  };

  const attemptOnce = async (continueFrom: string | null): Promise<boolean> => {
    const upstream = continueFrom
      ? [
          { role: "system" as const, content: decision.systemPrompt },
          ...history.map((m) => ({ role: m.role, content: m.content }) as const),
          { role: "assistant" as const, content: continueFrom },
          {
            role: "user" as const,
            content:
              "Your reply above was cut off by a connection drop. Continue EXACTLY where it stopped, mid-sentence if needed. Output ONLY the continuation — never repeat earlier text.",
          },
        ]
      : upstreamMessages;

    await readUpstream(
      upstream,
      decision.thinking,
      temperature,
      (chunk) => {
        if (chunk.content) {
          producedContent = true;
          emitSplit(rawSoFar + chunk.content);
        }
      },
      job.signal,
    );
    return true;
  };

  let success = false;
  let lastError: unknown = null;

  // Fresh attempts while nothing has been produced yet.
  for (let attempt = 0; attempt <= MAX_FRESH_RETRIES && !producedContent; attempt++) {
    if (job.aborted) break;
    try {
      if (attempt > 0) {
        send({
          type: "status",
          text: `Connection hiccup — retrying (${attempt}/${MAX_FRESH_RETRIES})…`,
        });
      }
      await attemptOnce(null);
      success = true;
      break;
    } catch (error) {
      lastError = error;
      if (!isRetryableUpstream(error) || job.aborted) break;
    }
  }

  // Mid-stream recovery: content already streamed, continue the reply.
  if (!success && !job.aborted && producedContent) {
    const answerSoFar = splitThinking(rawSoFar).answer;
    if (answerSoFar.length > 0 && !recoveredOnce) {
      recoveredOnce = true;
      try {
        send({ type: "status", text: "Stream dropped — recovering your reply…" });
        await attemptOnce(answerSoFar);
        success = true;
      } catch (error) {
        lastError = error;
      }
    }
  }

  if (job.aborted) {
    if (job.cancelReason === "ttl") {
      send({
        type: "error",
        message: "This reply ran too long and was stopped. Please try a shorter question.",
      });
      return;
    }
    // User cancel: keep whatever streamed; viewers finalize the partial.
    send({ type: "cancelled" });
    return;
  }

  if (success) {
    send({ type: "done", elapsedMs: Date.now() - startedAt });
  } else if (producedContent) {
    // Never destroy a reply we already streamed — finish with a note.
    send({
      type: "warning",
      text: "The connection wobbled and recovery failed — this reply may be incomplete.",
    });
    send({ type: "done", elapsedMs: Date.now() - startedAt, partial: true });
  } else {
    const message = isAbortLike(lastError)
      ? "The model stream kept stalling. Nothing was lost — please try again."
      : `Terra could not complete the reply. ${errorDetail(lastError) || "Please try again."}`;
    send({ type: "error", message });
  }
}

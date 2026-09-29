import { NextResponse, type NextRequest } from "next/server";
import ZAI from "z-ai-web-dev-sdk";
import {
  REASONING_OPEN,
  routeRequest,
  splitThinking,
  type ModelPreference,
  type RouterMessage,
} from "@/lib/agent/router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_MESSAGES = 16;
const MAX_CHARS = 8000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 30;

/** How long an upstream silence (no bytes at all) may last before we retry. */
const UPSTREAM_IDLE_MS = 90_000;
/** Heartbeat on the client leg: keeps browsers/proxies from idling out
 *  during long silent reasoning phases — the root cause of
 *  "Stream read failed: This operation was aborted". */
const HEARTBEAT_MS = 10_000;
/** Fresh retries when the upstream dies before any content was produced. */
const MAX_FRESH_RETRIES = 2;

const requestTimestamps: number[] = [];

interface IncomingMessage {
  role: string;
  content: unknown;
}

interface ChatRequestBody {
  messages?: unknown;
  model?: unknown;
  resumeFrom?: unknown;
}

function sanitizeMessages(
  raw: unknown,
): { messages: RouterMessage[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: "A non-empty messages array is required." };
  }
  const messages: RouterMessage[] = [];
  for (const item of raw.slice(-MAX_MESSAGES) as IncomingMessage[]) {
    if (
      (item?.role !== "user" && item?.role !== "assistant") ||
      typeof item?.content !== "string" ||
      item.content.trim().length === 0
    ) {
      return {
        error: "Each message needs a role of user or assistant and non-empty content.",
      };
    }
    if (item.content.length > MAX_CHARS) {
      return { error: "One of the messages is too long. Keep replies under 8000 characters." };
    }
    messages.push({ role: item.role, content: item.content });
  }
  if (messages.length === 0) {
    return { error: "No valid messages were provided." };
  }
  return { messages };
}

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function isAbortLike(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    name === "AbortError" ||
    name === "TimeoutError" ||
    /aborted|abort/i.test(message)
  );
}

function isRetryableUpstream(error: unknown): boolean {
  if (isAbortLike(error)) return true;
  const message = error instanceof Error ? error.message : String(error);
  // Network hiccups, stream read failures, stalls and 5xx from the gateway.
  return (
    /fetch failed|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket|premature|stalled|idle watchdog|ended before any data|never responded|did not return a stream/i.test(
      message,
    ) || /\bHTTP (5|408|429)\d\b/.test(message)
  );
}

let cachedZai: Awaited<ReturnType<typeof ZAI.create>> | null = null;
async function getZai() {
  if (!cachedZai) cachedZai = await ZAI.create();
  return cachedZai;
}

interface UpstreamChunk {
  content: string;
  finish: string | null;
}

/**
 * Opens a streaming completion and invokes onChunk for every content delta.
 * Resolves with { finished } when the stream completes normally.
 * Rejects with a retryable or fatal error.
 * An idle watchdog aborts the upstream body if it stays silent for too long —
 * we never abort an active stream, only a stalled one.
 */
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
    // into the retry logic instead of hanging the request forever.
    const createPromise = zai.chat.completions.create({
      messages: upstreamMessages,
      stream: true,
      thinking: { type: thinking ? "enabled" : "disabled" },
      temperature,
    });
    const headersTimeout = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error("Upstream never responded within 60s.")),
        60_000,
      );
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
      // Release the upstream socket promptly on every exit path.
      try {
        void reader?.cancel();
      } catch {
        // already cancelled
      }
    }
    externalAbort?.removeEventListener("abort", onExternalAbort);
  }
}

export async function POST(request: NextRequest) {
  const now = Date.now();
  while (requestTimestamps.length > 0 && now - requestTimestamps[0] > RATE_WINDOW_MS) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length >= RATE_LIMIT) {
    return NextResponse.json(
      { error: "Too many requests — take a breath and try again in a minute." },
      { status: 429 },
    );
  }
  requestTimestamps.push(now);

  let body: ChatRequestBody;
  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = sanitizeMessages(body.messages);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const preference: ModelPreference =
    body.model === "fast" || body.model === "balanced" || body.model === "deep"
      ? body.model
      : "auto";
  const resumeFrom =
    typeof body.resumeFrom === "string" && body.resumeFrom.trim().length > 0
      ? body.resumeFrom.trim()
      : null;

  const decision = routeRequest(parsed.messages, preference);
  const history = parsed.messages.slice(-decision.historyWindow);

  // When the client leg died mid-reply, ask the model to continue from the
  // partial text instead of restarting from scratch.
  const upstreamMessages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: decision.systemPrompt },
    ...history.map((m) => ({ role: m.role, content: m.content }) as const),
  ];
  if (resumeFrom) {
    upstreamMessages.push({ role: "assistant", content: resumeFrom });
    upstreamMessages.push({
      role: "user",
      content:
        "Your reply above was cut off by a connection drop. Continue EXACTLY where it stopped, mid-sentence if needed. Output ONLY the continuation — never repeat earlier text, never apologize, never restate the question.",
    });
  }

  const temperature = decision.route === "fast" ? 0.4 : decision.route === "deep" ? 0.6 : 0.7;

  const startedAt = Date.now();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

      const send = (payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sse(payload)));
        } catch {
          closed = true;
        }
      };
      const ping = () => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`));
        } catch {
          closed = true;
        }
      };

      // Heartbeat for the whole lifetime of the request: the client leg never
      // goes silent for more than HEARTBEAT_MS, so background tabs, proxies
      // and fetch idle timeouts have nothing to abort.
      heartbeatTimer = setInterval(ping, HEARTBEAT_MS);

      const onClientAbort = () => {
        closed = true;
        cleanup();
      };
      const cleanup = () => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        request.signal.removeEventListener("abort", onClientAbort);
        if (!closed) {
          closed = true;
        }
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      request.signal.addEventListener("abort", onClientAbort, { once: true });

      try {
        send({
          type: "route",
          route: decision.route,
          label: decision.label,
          model: decision.model,
          reason: decision.reason,
          thinking: decision.thinking,
          resume: Boolean(resumeFrom),
        });

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
          return (
            REASONING_OPEN.startsWith(head) && head.length < REASONING_OPEN.length
          );
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
          const messages = continueFrom
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
            messages,
            decision.thinking,
            temperature,
            (chunk) => {
              if (chunk.content) {
                producedContent = true;
                emitSplit(rawSoFar + chunk.content);
              }
            },
            request.signal,
          );
          return true;
        };

        let success = false;
        let lastError: unknown = null;

        // Fresh attempts while nothing has been shown to the client yet.
        for (let attempt = 0; attempt <= MAX_FRESH_RETRIES && !producedContent; attempt++) {
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
            if (!isRetryableUpstream(error) || request.signal.aborted) break;
          }
        }

        // Mid-stream recovery: content already streamed, continue the reply.
        if (!success && producedContent && !request.signal.aborted) {
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

        if (request.signal.aborted) {
          cleanup();
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
            : `Terra could not complete the reply. ${
                errorDetail(lastError) || "Please try again."
              }`;
          send({ type: "error", message });
        }
      } catch (error) {
        console.error("[/api/chat] pipeline failed:", error);
        if (!request.signal.aborted) {
          send({ type: "error", message: "Terra hit an unexpected snag. Please try again." });
        }
      } finally {
        cleanup();
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

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

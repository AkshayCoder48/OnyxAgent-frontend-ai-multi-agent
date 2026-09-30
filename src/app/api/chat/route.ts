import { NextResponse, type NextRequest } from "next/server";
import {
  cancelTurnJob,
  getTurnJob,
  skipToolWait,
  startTurnJob,
  type TurnJob,
} from "@/lib/agent/turn-jobs";
import type { RouterMessage } from "@/lib/agent/router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_MESSAGES = 16;
const MAX_CHARS = 8000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 30;

/**
 * Heartbeat on the client leg: keeps browsers/proxies from idling out while
 * the viewer is attached. The turn itself no longer depends on this
 * connection at all — it runs as a background job and this SSE stream is
 * just a detachable viewer (reattach with turnId + since to replay).
 */
const HEARTBEAT_MS = 10_000;

const requestTimestamps: number[] = [];

interface IncomingMessage {
  role: string;
  content: unknown;
}

interface ChatRequestBody {
  action?: unknown;
  turnId?: unknown;
  toolId?: unknown;
  since?: unknown;
  create?: unknown;
  messages?: unknown;
  model?: unknown;
  resumeFrom?: unknown;
  mode?: unknown;
  workspaceId?: unknown;
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

export async function POST(request: NextRequest) {
  let body: ChatRequestBody;
  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  /* ---------------------------------------------------------------- */
  /* Cancel action — user pressed stop (possibly from another tab).   */
  /* ---------------------------------------------------------------- */
  if (body.action === "cancel") {
    if (typeof body.turnId === "string" && body.turnId.length > 0) {
      cancelTurnJob(body.turnId);
    }
    return NextResponse.json({ ok: true });
  }

  /* ---------------------------------------------------------------- */
  /* Skip-wait action — "Continue while this runs": unblock the      */
  /* pipeline; the tool keeps running detached in the job.           */
  /* ---------------------------------------------------------------- */
  if (body.action === "skip_wait") {
    if (typeof body.turnId === "string" && typeof body.toolId === "string") {
      const skipped = skipToolWait(body.turnId, body.toolId);
      return NextResponse.json({ ok: true, skipped });
    }
    return NextResponse.json({ ok: false, error: "turnId and toolId are required." }, { status: 400 });
  }

  const turnId =
    typeof body.turnId === "string" && body.turnId.trim().length > 0
      ? body.turnId.trim()
      : null;
  const since = typeof body.since === "number" && Number.isFinite(body.since) && body.since >= 0
    ? Math.floor(body.since)
    : 0;
  const create = body.create === true;

  let job: TurnJob | undefined = turnId ? getTurnJob(turnId) : undefined;
  /** True when THIS request created the job — the client must then rebuild its draft from a full replay. */
  let createdHere = false;

  /* ---------------------------------------------------------------- */
  /* Re-attach without a job present: the server restarted or the job */
  /* expired. Tell the client instead of silently restarting the turn */
  /* from scratch — it decides how to rebuild (resumeFrom fallback).  */
  /* ---------------------------------------------------------------- */
  if (!job && !create) {
    return NextResponse.json({ gone: true }, { status: 404 });
  }

  if (!job) {
    // Create a new background job. Rate limit creations only — attaches
    // are free (they must be, reconnects need them).
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

    const parsed = sanitizeMessages(body.messages);
    if ("error" in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const preference =
      body.model === "fast" || body.model === "balanced" || body.model === "deep"
        ? body.model
        : "auto";
    const resumeFrom =
      typeof body.resumeFrom === "string" && body.resumeFrom.trim().length > 0
        ? body.resumeFrom.trim()
        : null;
    const mode = body.mode === "code" ? "code" : "agent";
    const workspaceId =
      mode === "code" && typeof body.workspaceId === "string" && body.workspaceId.trim().length > 0
        ? body.workspaceId.trim()
        : undefined;

    const id = turnId ?? `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    job = startTurnJob(id, parsed.messages, preference, resumeFrom, { mode, workspaceId });
    createdHere = true;
  }

  /* ---------------------------------------------------------------- */
  /* Attach the SSE viewer: replay missed events, then follow live.   */
  /* The job keeps running when this connection drops.                */
  /* ---------------------------------------------------------------- */
  const attachedJob = job;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe: (() => void) | null = null;
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

      const cleanup = () => {
        closed = true;
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        unsubscribe?.();
        unsubscribe = null;
        request.signal.removeEventListener("abort", onClientAbort);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      const onClientAbort = () => cleanup();
      request.signal.addEventListener("abort", onClientAbort, { once: true });

      // If the client's cursor is ahead of this job's log (server restarted
      // and a new, shorter log exists under the same id), or this request
      // just created the job, tell it to reset its local draft — the replay
      // from 0 rebuilds the full state.
      const reset = createdHere || since > attachedJob.events.length;
      send({ type: "hello", turnId: attachedJob.id, reset });

      // Snapshot the log length BEFORE subscribing; between subscribe() and
      // the manual replay no appends can interleave (single-threaded JS),
      // so indices >= snapshotLength always arrive via the subscriber.
      const snapshotLength = attachedJob.events.length;
      unsubscribe = attachedJob.subscribe((indexed) => {
        if (indexed.index < snapshotLength) return;
        send({ ...indexed.event, index: indexed.index });
        if (
          indexed.event.type === "done" ||
          indexed.event.type === "error" ||
          indexed.event.type === "cancelled"
        ) {
          // Terminal event flushed — close the viewer. The job's own
          // bookkeeping already ran by the time this callback returns.
          setTimeout(cleanup, 0);
        }
      });

      const replayFrom = reset ? 0 : since;
      for (let i = replayFrom; i < snapshotLength; i++) {
        send({ ...attachedJob.events[i].event, index: attachedJob.events[i].index });
      }

      if (attachedJob.done) {
        cleanup();
        return;
      }

      heartbeatTimer = setInterval(ping, HEARTBEAT_MS);
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

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  streamBackgroundTurn,
  updateJobCursor,
  getActiveJob,
  clearJob,
  type BgStatus,
} from "./background-agent";

// ============================================================================
// PRD §23 — "Lost the connection to the background sandbox" regression tests.
// The false-fatal bug had two transport-level shapes, both of which must now
// surface as an UNREACHABLE FRAME (consumed by the reconnect loop — never a
// fatal error):
//   1. bg_wait answering Sandbox.connect failure with HTTP 200 + JSON (the
//      body contains no `data:` lines → the old parser saw ZERO frames).
//   2. fetch throwing / non-OK responses (network blips).
// Plus the BgJob seq-cursor persistence contract (reload-resume starts after
// the checkpoint — PRD §38: never duplicate, never lose output).
// ============================================================================

const JOBS_KEY = "onyx-bg-jobs";

function jsonRes(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function frame(partial: Partial<BgStatus>): BgStatus {
  return {
    sandboxId: "sbx1",
    status: "running",
    events: [],
    content: "",
    error: null,
    startedAt: null,
    done: false,
    ...partial,
  } as BgStatus;
}

describe("streamBackgroundTurn transport-failure shapes (PRD §23)", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = realFetch;
  });

  it("yields ONE unreachable frame (not zero frames) for the HTTP 200 JSON unreachable body", async () => {
    // Exact shape of /api/sandbox bg_wait's Sandbox.connect-failure branch:
    // NextResponse.json({...}) → HTTP 200 + application/json, no data lines.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonRes({
          sandboxId: "sbx1",
          status: "unreachable",
          error: "Background sandbox unreachable: paused",
          events: [],
          done: false,
          afterSeq: 7,
        }),
      ),
    );

    const out: BgStatus[] = [];
    for await (const resp of streamBackgroundTurn("key", "sbx1", "run_1", 7)) {
      out.push(resp);
    }

    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe("unreachable");
    expect(out[0]!.error).toContain("paused");
    expect(out[0]!.afterSeq).toBe(7);
  });

  it("yields an unreachable frame for a non-OK JSON body with status unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonRes(
          {
            sandboxId: "sbx1",
            status: "unreachable",
            error: "Background sandbox unreachable: boom",
            events: [],
            done: false,
            afterSeq: 0,
          },
          503,
        ),
      ),
    );

    const out: BgStatus[] = [];
    for await (const resp of streamBackgroundTurn("key", "sbx1", undefined, 0)) {
      out.push(resp);
    }
    expect(out).toHaveLength(1);
    expect(out[0]!.status).toBe("unreachable");
  });

  it("throws (transport failure for the reconnect loop) on a non-OK error body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonRes({ error: "Missing sandboxId" }, 400)));
    await expect(async () => {
      for await (const _r of streamBackgroundTurn("key", "sbx1", undefined, 0)) {
        void _r;
      }
    }).rejects.toThrow(/Missing sandboxId/);
  });

  it("parses healthy SSE frames in order (keep-alive comments and [DONE] skipped)", async () => {
    const body =
      `: keep-alive comment\n\n` +
      `data: ${JSON.stringify(frame({ events: [{ t: "text_delta", seq: 1 }], afterSeq: 1 }))}\n\n` +
      `data: ${JSON.stringify(frame({ events: [{ t: "text_delta", seq: 2 }], afterSeq: 2 }))}\n\n` +
      `data: [DONE]\n\n` +
      // trailing frame without the final blank line — exercised by the flush path
      `data: ${JSON.stringify(frame({ events: [{ t: "done", seq: 3 }], done: true, afterSeq: 3 }))}\n`;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        }),
      ),
    );

    const out: BgStatus[] = [];
    for await (const resp of streamBackgroundTurn("key", "sbx1", "run_1", 0)) {
      out.push(resp);
    }
    expect(out).toHaveLength(3);
    expect(out[0]!.events[0]).toMatchObject({ t: "text_delta", seq: 1 });
    expect(out[1]!.events[0]).toMatchObject({ t: "text_delta", seq: 2 });
    expect(out[2]!.done).toBe(true);
  });
});

describe("BgJob seq-cursor persistence (PRD §38)", () => {
  function seedJob(lastSeq?: number): void {
    window.localStorage.setItem(
      JOBS_KEY,
      JSON.stringify({
        bgmsg_1: {
          sandboxId: "sbx1",
          runId: "run_1",
          pid: 42,
          conversationId: "conv_1",
          assistantMessageId: "bgmsg_1",
          startedAt: Date.now(),
          ...(lastSeq !== undefined ? { lastSeq } : {}),
        },
      }),
    );
  }

  beforeEach(() => {
    window.localStorage.clear();
  });

  it("advances the persisted cursor and round-trips through getActiveJob", () => {
    seedJob();
    updateJobCursor("bgmsg_1", 12);
    const job = getActiveJob("conv_1");
    expect(job).not.toBeNull();
    expect(job!.lastSeq).toBe(12);
    updateJobCursor("bgmsg_1", 30);
    expect(getActiveJob("conv_1")!.lastSeq).toBe(30);
  });

  it("never RESURRECTS a cleared job (a late cursor write after finish)", () => {
    seedJob(5);
    clearJob("bgmsg_1");
    updateJobCursor("bgmsg_1", 9); // e.g. the consumer's exit-path write racing stop
    expect(getActiveJob("conv_1")).toBeNull();
    expect(window.localStorage.getItem(JOBS_KEY)).toBe("{}");
  });

  it("ignores invalid cursor values and redundant writes", () => {
    seedJob(7);
    updateJobCursor("bgmsg_1", Number.NaN);
    updateJobCursor("bgmsg_1", -3);
    updateJobCursor("bgmsg_1", 7);
    expect(getActiveJob("conv_1")!.lastSeq).toBe(7);
  });

  it("is a no-op for unknown jobs", () => {
    seedJob(1);
    updateJobCursor("bgmsg_other", 5);
    expect(getActiveJob("conv_1")!.lastSeq).toBe(1);
  });
});

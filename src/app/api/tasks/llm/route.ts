// ============================================================================
// Background Task Execution Framework — POST /api/tasks/llm (keyless bridge).
//
// The OpenAI-compatible chat endpoint the sandbox-resident runner calls when
// a run carries no user provider keys (TaskTriggerRequest.config.chatUrl is
// substituted by the orchestrator): the run's task token doubles as the
// Bearer credential.
//
// Auth: `Authorization: Bearer <taskToken>` + `x-task-run-id: <runId>` header
// (or a body `_runId`, stripped before forwarding). The token is validated
// against the in-memory keyring FIRST, then against the stored sha256 hash —
// so a bridge call survives an orchestrator restart (the keyring dies with
// the process; the hash and the sandbox's run.json do not).
//
// Response contract mirrors an OpenAI endpoint: 200 = completion JSON as-is;
// 400 = {error:{message, type:"invalid_request_error"}} (the runner degrades
// to a tools-off retry on 400); 401 = bad credentials.
//
// Body-logging discipline mirrors /api/chat-proxy: bodies carry conversation
// content and tokens — never logged.
// ============================================================================
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/tasks/prisma";
import { keyring, sha256Hex, tokensEqual } from "@/lib/tasks/keyring";
import { runBridgeCompletion, type BridgeCompletionBody } from "@/lib/tasks/llm-bridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function oaiError(message: string, type: string, status: number): NextResponse {
  return NextResponse.json({ error: { message, type } }, { status });
}

function unauthorized(): NextResponse {
  return oaiError("invalid task token or run id", "invalid_request_error", 401);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return oaiError("invalid JSON body", "invalid_request_error", 400);
  }

  // Run id: header first, then the body escape hatch (stripped below).
  const headerRunId = request.headers.get("x-task-run-id")?.trim();
  const bodyRunId = typeof body._runId === "string" ? body._runId.trim() : "";
  const runId = headerRunId || bodyRunId;

  // Token: Authorization: Bearer <taskToken>.
  const auth = request.headers.get("authorization") ?? "";
  const taskToken = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : "";

  if (!runId || !taskToken) return unauthorized();

  // Keyring first (in-memory, fast); hash fallback keeps adopted runs alive
  // across orchestrator restarts (the sandbox still holds its run.json). The
  // fallback is bounded to LIVE runs — a terminal run's token must stop
  // working when its sandbox is gone (the keyring path self-expires).
  if (!keyring.authorize(runId, taskToken)) {
    const row = await prisma.taskRun.findUnique({
      where: { id: runId },
      select: { taskTokenHash: true, status: true },
    });
    const live = row?.status === "queued" || row?.status === "running";
    if (!live || !row.taskTokenHash || !tokensEqual(sha256Hex(taskToken), row.taskTokenHash)) {
      return unauthorized();
    }
  }

  // Strip the routing escape hatch — the bridge must never see it.
  if ("_runId" in body) delete body._runId;

  const result = await runBridgeCompletion(body as BridgeCompletionBody);
  if (result.ok) {
    return NextResponse.json(result.result, { status: 200 });
  }
  // OpenAI-style error (400 → the runner's tools-off degradation path).
  return oaiError(result.error.message, result.error.type, result.status);
}

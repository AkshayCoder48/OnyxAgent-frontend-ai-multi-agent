// ============================================================================
// Background Task Execution Framework — keyless LLM bridge core
// (PRD §2.2 / TaskTriggerRequest.chatUrl contract).
//
// The sandbox-resident headless runner needs an OpenAI-compatible
// chat-completions endpoint. When a run carries no user provider keys, the
// orchestrator points it at the app's own bridge (/api/tasks/llm) where the
// task token doubles as the bearer credential; this module performs the
// actual completion through the shared ZAI client (z-ai-web-dev-sdk —
// server-only, never bundled to the client).
//
// The SDK result is returned AS-IS: it is already OpenAI-shaped
// ({id, choices:[{message:{content, tool_calls}}], ...}), which is exactly
// what the runner's urllib transport parses.
// ============================================================================

import { getZai } from "@/lib/agent/zai";

/** What the runner posts (OpenAI chat-completions subset). */
export interface BridgeCompletionBody {
  model?: string;
  messages: Array<{ role: string; content: unknown }>;
  tools?: unknown;
  tool_choice?: unknown;
  temperature?: number;
  stream?: boolean;
  [key: string]: unknown;
}

/** OpenAI-style error body — the runner already degrades to a tools-off
 * retry when it sees a 400, so shape fidelity matters. */
export interface BridgeError {
  message: string;
  type: string;
}

export type BridgeResult =
  | { ok: true; result: unknown }
  | { ok: false; status: number; error: BridgeError };

/**
 * Run one non-streaming chat completion through the ZAI SDK. `thinking` is
 * disabled — background runs want tool-call answers, not long silent
 * reasoning phases the monitor cannot distinguish from a hang.
 *
 * Errors surface as `{ok:false, status:400, error:{message, type}}`
 * (invalid_request_error) — including SDK rejections of the tools payload —
 * so the runner's existing 400→tools-off degradation path handles them.
 */
export async function runBridgeCompletion(
  body: BridgeCompletionBody,
): Promise<BridgeResult> {
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return {
      ok: false,
      status: 400,
      error: { message: "messages must be a non-empty array", type: "invalid_request_error" },
    };
  }

  try {
    const zai = await getZai();
    const payload: Record<string, unknown> = {
      model: typeof body.model === "string" ? body.model : undefined,
      messages: body.messages,
      stream: false,
      thinking: { type: "disabled" },
    };
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      payload.tools = body.tools;
      payload.tool_choice = body.tool_choice ?? "auto";
    }
    if (typeof body.temperature === "number") {
      payload.temperature = body.temperature;
    }
    const result = await zai.chat.completions.create(payload as never);
    return { ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Never log the body — it can carry conversation content.
    console.warn(`[tasks] llm bridge completion failed: ${message.slice(0, 300)}`);
    return {
      ok: false,
      status: 400,
      error: { message, type: "invalid_request_error" },
    };
  }
}

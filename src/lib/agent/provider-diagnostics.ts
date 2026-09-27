"use client";

/**
 * Provider diagnostics — PRD §21 "diagnostic mode".
 *
 * Six progressive tests that localize exactly WHERE an OpenAI-compatible
 * provider breaks, mirroring the request path the agent runtime actually
 * uses (same URL building, same headers, same param policy), but WITHOUT
 * the runtime's self-healing ladder — diagnostics REPORTS the provider's
 * raw verdicts so the user can see the difference between "playground
 * works" and "app fails".
 *
 *  1. connection  — GET {base}/models — network + auth reachability.
 *  2. basic       — minimal non-streaming chat completion.
 *  3. streaming   — stream:true; TTFT, chunks, finish_reason, [DONE].
 *  4. tool_free   — the runtime's real no-tools request shape (system
 *                   prompt + stream_options + temperature per policy).
 *  5. tools       — + one minimal tool; verifies tool_calls accumulate
 *                   and the args JSON parses.
 *  6. long        — a longer generation; verifies it completes WITH a
 *                   finish signal (the in-app regression test for the
 *                   silent "auto stop" bug).
 *
 * Each test is small (a few hundred tokens max) and runs sequentially,
 * emitting a result after each so the UI can show live progress. A
 * network-unreachable connection test skips the rest of the suite.
 */

import { parseSSEStream, extractDelta } from "./runtime";
import { extractStreamError } from "./stream-guards";
import { applyParamPolicy } from "./param-policy";
import { getWireCompat, wireAllowsTools, COMPAT_SYSTEM_PROMPT } from "./wire-compat";

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

export type DiagnosticTestId =
  | "connection"
  | "basic"
  | "streaming"
  | "tool_free"
  | "tools"
  | "long";

export type DiagnosticStatus = "pass" | "warn" | "fail" | "skip";

export interface DiagnosticMetrics {
  /** HTTP status code (0 = network failure before a response). */
  httpStatus?: number;
  /** Streaming: milliseconds until the first content/reasoning token. */
  ttftMs?: number;
  /** Streaming: parsed SSE chunk count. */
  chunks?: number;
  /** Characters of assistant content received. */
  chars?: number;
  /** finish_reason from the last chunk that carried one. */
  finishReason?: string | null;
  /** Whether the provider's `data: [DONE]` marker arrived. */
  sawDone?: boolean;
  /** Whether a usage chunk arrived (usage-only final chunk). */
  sawUsage?: boolean;
  /** Tools test: number of distinct tool calls received. */
  toolCallCount?: number;
  /** Tools test: whether every tool-call arguments string parsed as JSON. */
  toolArgsValid?: boolean;
  /** Sample response body (truncated for display). */
  sample?: string;
}

export interface DiagnosticResult {
  id: DiagnosticTestId;
  /** Human-readable test name. */
  name: string;
  /** One-line description of what this test checks. */
  purpose: string;
  status: DiagnosticStatus;
  /** Wall-clock duration of the test. */
  durationMs: number;
  /** Human-readable outcome / failure detail (provider quote on fail). */
  detail: string;
  /** Actionable next step when status is warn/fail. */
  advice?: string;
  metrics?: DiagnosticMetrics;
  /** The endpoint this test hit (for parity comparison with playgrounds). */
  requestUrl?: string;
}

export interface DiagnosticsOptions {
  /** Provider base URL, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  /** Decrypted API key (only used in transit, same as the runtime). */
  apiKey: string;
  /** Model ID sent verbatim. */
  model: string;
  /** Provider row's no_prefix flag — base URL used as-is when true. */
  noPrefix?: boolean;
  /** Provider row's disabled_params (mirrors runtime param policy). */
  disabledParams?: string[] | null;
  /** Provider row's tools_enabled — tools test skips when false. */
  toolsEnabled?: boolean;
  /** Cancels the whole suite. */
  signal?: AbortSignal;
  /** Called after each test completes (live UI progress). */
  onResult?: (result: DiagnosticResult) => void;
}

const CHAT_PROXY = "/api/chat-proxy";

/** Per-test timeout budgets (ms) — generous; a legitimate generation can
 *  be slow, but a hung connection should not wedge the suite. */
const TIMEOUTS_MS: Record<DiagnosticTestId, number> = {
  connection: 20_000,
  basic: 90_000,
  streaming: 120_000,
  tool_free: 120_000,
  tools: 120_000,
  long: 180_000,
};

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

function truncate(s: string, n = 160): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/** Extract a human-readable message from a failed HTTP response body. */
function extractHttpError(text: string): string {
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    const err = obj.error as Record<string, unknown> | string | undefined;
    if (typeof err === "string") return err;
    if (err && typeof err === "object") {
      const msg = err.message ?? obj.message;
      if (typeof msg === "string") return msg;
    }
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.detail === "string") return obj.detail;
  } catch {
    /* not JSON */
  }
  return truncate(text.replace(/\s+/g, " ").trim(), 200);
}

/** Build the chat-completions endpoint the same way streamRound does. */
function chatEndpoint(baseUrl: string, noPrefix?: boolean): string {
  const base = baseUrl.replace(/\/+$/, "");
  return noPrefix ? base : `${base}/chat/completions`;
}

/** Per-test abort controller: fires on (a) the test timeout, (b) the user
 *  cancelling the suite. ALWAYS call `cancel()` when the test ends. */
function testController(id: DiagnosticTestId, outerSignal: AbortSignal | undefined) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, TIMEOUTS_MS[id]);
  const onOuterAbort = () => ctrl.abort();
  if (outerSignal) {
    if (outerSignal.aborted) ctrl.abort();
    else outerSignal.addEventListener("abort", onOuterAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    cancel: () => {
      clearTimeout(timer);
      outerSignal?.removeEventListener("abort", onOuterAbort);
    },
    /** True when this controller was aborted by ITS timeout (not the user). */
    wasTimeout: () => timedOut,
  };
}

interface RunOutcome {
  status: DiagnosticStatus;
  detail: string;
  advice?: string;
  metrics: DiagnosticMetrics;
  /** True when the provider host is unreachable — skips remaining tests. */
  unreachable?: boolean;
}

/** Shared formatting for fetch/network-level errors. */
function networkFailure(err: unknown, timeoutMs: number): RunOutcome {
  const msg = err instanceof Error ? err.message : String(err);
  const isAbort = err instanceof DOMException && err.name === "AbortError";
  if (isAbort) {
    return {
      status: "fail",
      detail: `Timed out after ${Math.round(timeoutMs / 1000)}s — no response from the provider.`,
      advice: "The endpoint is unreachable or extremely slow. Check the Base URL and the provider's status page.",
      metrics: { httpStatus: 0 },
      unreachable: true,
    };
  }
  return {
    status: "fail",
    detail: `Network error: ${msg}`,
    advice:
      "The request never reached the provider. Verify the Base URL (DNS/TLS) and try again.",
    metrics: { httpStatus: 0 },
    unreachable: true,
  };
}

/** The proxy answers `502 {"error":"Failed to reach upstream: …"}` when the
 *  provider host is unreachable — classify it as a network failure. */
function isProxyUnreachable(status: number, text: string): boolean {
  return status === 502 && /failed to reach upstream/i.test(text);
}

// ---------------------------------------------------------------------------
// Test 1 — connection (GET /models).
// ---------------------------------------------------------------------------

async function testConnection(opts: DiagnosticsOptions, signal: AbortSignal): Promise<RunOutcome> {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const modelsUrl = opts.noPrefix
    ? base.replace(/\/chat\/completions\/?$/, "/models")
    : `${base}/models`;

  const res = await fetch(`${CHAT_PROXY}?url=${encodeURIComponent(modelsUrl)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      Accept: "application/json",
    },
    signal,
  });
  const text = await res.text();

  if (isProxyUnreachable(res.status, text)) {
    return {
      status: "fail",
      detail: `Host unreachable — the app's proxy could not connect to ${modelsUrl}`,
      advice: "Check the Base URL (typos, DNS, provider status page).",
      metrics: { httpStatus: 0, sample: truncate(text, 200) },
      unreachable: true,
    };
  }
  if (res.ok) {
    let count: number | undefined;
    try {
      const obj = JSON.parse(text) as { data?: Array<{ id?: string }> };
      if (Array.isArray(obj.data)) count = obj.data.length;
    } catch {
      /* body shape differs — reachability is what matters */
    }
    return {
      status: "pass",
      detail:
        count !== undefined
          ? `Reachable — /models listed ${count} model${count === 1 ? "" : "s"}.`
          : "Reachable — /models responded.",
      metrics: { httpStatus: res.status, sample: truncate(text, 120) },
    };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      status: "fail",
      detail: `Host reachable, but the API key was rejected (HTTP ${res.status}).`,
      advice: `Check the API key (and that it can access this model). Provider said: ${extractHttpError(text)}`,
      metrics: { httpStatus: res.status, sample: truncate(text, 200) },
    };
  }
  if (res.status === 404 || res.status === 405) {
    // /models is not universal — the chat endpoint may still work.
    return {
      status: "warn",
      detail: `Host reachable, but /models answered HTTP ${res.status} (not all gateways expose it).`,
      advice: "Not fatal — the next tests call the chat endpoint directly.",
      metrics: { httpStatus: res.status },
    };
  }
  return {
    status: res.status >= 500 ? "warn" : "fail",
    detail: `/models answered HTTP ${res.status}: ${extractHttpError(text)}`,
    advice:
      res.status >= 500
        ? "Provider-side error on /models — the chat endpoint may still work."
        : undefined,
    metrics: { httpStatus: res.status, sample: truncate(text, 200) },
  };
}

// ---------------------------------------------------------------------------
// Shared chat-request plumbing for tests 2–6.
// ---------------------------------------------------------------------------

interface ChatTestSpec {
  endpoint: string;
  body: Record<string, unknown>;
  /** Streaming by default; test 2 (basic) passes false. */
  stream?: boolean;
  /** Expect the model to call the tool (test 5). */
  expectTools?: boolean;
}

async function runChatTest(
  opts: DiagnosticsOptions,
  spec: ChatTestSpec,
  signal: AbortSignal,
): Promise<RunOutcome> {
  const stream = spec.stream ?? true;
  const body = { ...spec.body, stream };
  const res = await fetch(`${CHAT_PROXY}?url=${encodeURIComponent(spec.endpoint)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-target-url": spec.endpoint,
      Authorization: `Bearer ${opts.apiKey}`,
      Accept: stream ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text();
    if (isProxyUnreachable(res.status, text)) {
      return {
        status: "fail",
        detail: `Host unreachable — the app's proxy could not connect to ${spec.endpoint}`,
        advice: "Check the Base URL (typos, DNS, provider status page).",
        metrics: { httpStatus: 0, sample: truncate(text, 200) },
        unreachable: true,
      };
    }
    return {
      status: "fail",
      detail: `HTTP ${res.status}: ${extractHttpError(text)}`,
      advice:
        res.status === 400
          ? "The provider rejected the request body. If it names a parameter (e.g. temperature, stream_options, tools), disable that parameter in the provider's advanced settings; Onyx's runtime also auto-learns this during chat."
          : res.status === 404
            ? "Endpoint not found — check the Base URL (the app calls {base}/chat/completions; gateways differ in whether they want /v1 included)."
            : res.status === 429
              ? "Rate limited — wait a moment and run diagnostics again."
              : undefined,
      metrics: { httpStatus: res.status, sample: truncate(text, 300) },
    };
  }

  if (!stream) {
    // Non-streaming: parse the JSON body.
    const text = await res.text();
    let content = "";
    let finishReason: string | null | undefined;
    try {
      const obj = JSON.parse(text) as {
        choices?: Array<{ message?: { content?: unknown }; finish_reason?: string | null }>;
      };
      const errStr = extractStreamError(obj as Record<string, unknown>);
      if (errStr) {
        return {
          status: "fail",
          detail: `Provider returned an error inside a 200 response: ${errStr}`,
          advice: "This is a provider-side failure — the same request in their playground would fail too.",
          metrics: { httpStatus: res.status, sample: truncate(text, 300) },
        };
      }
      const choice = obj.choices?.[0];
      const raw = choice?.message?.content;
      content =
        typeof raw === "string"
          ? raw
          : Array.isArray(raw)
            ? raw.map((p) => (typeof p === "string" ? p : "")).join("")
            : "";
      finishReason = choice?.finish_reason;
    } catch {
      return {
        status: "fail",
        detail: `Response was not valid JSON: ${truncate(text, 160)}`,
        advice: "The endpoint may not be OpenAI-compatible, or a proxy/HTML error page was returned instead.",
        metrics: { httpStatus: res.status, sample: truncate(text, 200) },
      };
    }
    if (!content.trim()) {
      return {
        status: "fail",
        detail: finishReason
          ? `Empty response (finish_reason: ${finishReason}).`
          : "Empty response — no content and no finish_reason.",
        advice: "The provider accepted the request but returned nothing. Check the model ID.",
        metrics: { httpStatus: res.status, finishReason: finishReason ?? null },
      };
    }
    return {
      status: "pass",
      detail: `Non-streaming completion OK — ${content.length} chars (finish_reason: ${finishReason ?? "n/a"}).`,
      metrics: {
        httpStatus: res.status,
        chars: content.length,
        finishReason: finishReason ?? null,
        sample: truncate(content, 120),
      },
    };
  }

  // Streaming: walk the SSE stream with the SAME parser the runtime uses.
  const meta: { sawDone?: boolean } = {};
  if (!res.body) {
    return {
      status: "fail",
      detail: "Response had no body to stream.",
      advice: "A proxy between the app and the provider may be stripping streams. Try a non-streaming provider route.",
      metrics: { httpStatus: res.status },
    };
  }
  const reader = res.body.getReader();
  const started = Date.now();
  let ttft: number | undefined;
  let chunks = 0;
  let text = "";
  let finishReason: string | null | undefined;
  let sawUsage = false;
  let streamError: string | null = null;
  // Tool-call accumulation (index-keyed, same as the runtime).
  const toolCalls = new Map<number, { id?: string; name?: string; args: string }>();

  // Note: no manual reader.cancel() here — parseSSEStream releases the
  // reader lock in its own finally; cancelling a released reader throws.
  try {
    for await (const chunk of parseSSEStream(reader, signal, meta)) {
      chunks++;
      if (chunk.usage) sawUsage = true;
      const streamErr = extractStreamError(chunk);
      if (streamErr) streamError = streamErr;
      const delta = extractDelta(chunk);
      const choice = (chunk.choices as Array<{ finish_reason?: string | null }> | undefined)?.[0];
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (delta) {
        if (typeof delta.text === "string" && delta.text) {
          if (ttft === undefined) ttft = Date.now() - started;
          text += delta.text;
        }
        for (const r of [delta.reasoning, delta.thinking]) {
          if (typeof r === "string" && r && ttft === undefined) ttft = Date.now() - started;
        }
        if (delta.toolCalls) {
          if (ttft === undefined) ttft = Date.now() - started;
          for (const tc of delta.toolCalls) {
            const idx = tc.index ?? 0;
            const cur = toolCalls.get(idx) ?? { args: "" };
            if (tc.id) cur.id = tc.id;
            if (tc.name) cur.name = tc.name;
            if (tc.arguments) cur.args += tc.arguments;
            toolCalls.set(idx, cur);
          }
        }
      }
    }
  } catch (err) {
    // A torn-down stream (user cancel / timeout) must not lose the partial
    // metrics collected so far — rethrow only when nothing was received.
    if (!text && toolCalls.size === 0 && chunks === 0) throw err;
  }

  const metrics: DiagnosticMetrics = {
    httpStatus: res.status,
    ttftMs: ttft,
    chunks,
    chars: text.length,
    finishReason: finishReason ?? null,
    sawDone: meta.sawDone ?? false,
    sawUsage,
  };

  // In-stream error payload with no usable content → hard fail.
  if (streamError && !text && toolCalls.size === 0) {
    return {
      status: "fail",
      detail: `Error inside the stream: ${streamError}`,
      advice: "Provider-side failure delivered mid-stream. Quote this message to the provider if it persists.",
      metrics: { ...metrics, sample: truncate(streamError, 200) },
    };
  }

  // Tool expectations (test 5).
  if (spec.expectTools) {
    const calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    metrics.toolCallCount = calls.length;
    if (calls.length > 0) {
      const argsOk = calls.every((c) => {
        try {
          JSON.parse(c.args || "{}");
          return true;
        } catch {
          return false;
        }
      });
      metrics.toolArgsValid = argsOk;
      if (argsOk) {
        return {
          status: "pass",
          detail: `Tool call received (${calls.map((c) => c.name ?? "?").join(", ")}) — arguments are valid JSON.`,
          metrics,
        };
      }
      return {
        status: "warn",
        detail: `Tool call received but its arguments JSON did not parse: ${truncate(calls.map((c) => c.args).join(" "), 120)}`,
        advice: "The stream may have been cut mid-argument, or the provider emits malformed tool args. Tool use may be unreliable on this provider.",
        metrics,
      };
    }
    // No tool call — did the model just answer in text?
    if (text.trim()) {
      return {
        status: "warn",
        detail: `The model replied in text instead of calling the tool: "${truncate(text, 100)}"`,
        advice: "Function calling may be unsupported or unreliable on this model route. Chat still works; tool-using agent turns may degrade.",
        metrics,
      };
    }
    return {
      status: "fail",
      detail: "No content and no tool call arrived on the stream.",
      advice: "Tool requests appear to break this provider route. Disable 'Tools enabled' for it, or switch model.",
      metrics,
    };
  }

  // Plain streaming expectations (tests 3, 4, 6).
  if (!text.trim()) {
    return {
      status: "fail",
      detail: `Stream completed with zero content${finishReason ? ` (finish_reason: ${finishReason})` : ""}.`,
      advice: "The provider accepted the request but the stream produced nothing. Try a different model ID.",
      metrics,
    };
  }
  // Premature-cut detection — the regression check for the "silent auto
  // stop" bug: content arrived but no finish signal of any kind.
  const finishSignals = (finishReason ? 1 : 0) + (meta.sawDone ? 1 : 0) + (sawUsage ? 1 : 0);
  if (finishSignals === 0) {
    return {
      status: "warn",
      detail: `${text.length} chars streamed, but the stream ended with NO completion signal (no finish_reason, no [DONE] marker, no usage chunk) — the classic "AI stops mid-answer" cut.`,
      advice: "A proxy or the provider is severing streams early. Onyx detects this during chat and marks the answer partial; if it repeats, report it to the provider.",
      metrics,
    };
  }
  if (streamError && text) {
    return {
      status: "warn",
      detail: `Streamed ${text.length} chars, but an error payload also arrived mid-stream: ${streamError}`,
      advice: "Partial success. The provider delivered content then reported a failure — possibly a quota/timeout on their side.",
      metrics,
    };
  }
  return {
    status: "pass",
    detail: `Streamed ${text.length} chars over ${chunks} chunks (finish_reason: ${finishReason ?? "n/a"}${meta.sawDone ? ", [DONE] seen" : ""}).`,
    metrics,
  };
}

/** The minimal tool schema used by test 5 — small, universal, no exotic types. */
function diagnosticTool(): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the current weather for a city.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", description: "City name, e.g. Tokyo" },
        },
        required: ["city"],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// The suite.
// ---------------------------------------------------------------------------

export async function runProviderDiagnostics(
  opts: DiagnosticsOptions,
): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = [];
  const endpoint = chatEndpoint(opts.baseUrl, opts.noPrefix);

  const defs: Array<{
    id: DiagnosticTestId;
    name: string;
    purpose: string;
    run: (signal: AbortSignal) => Promise<RunOutcome>;
  }> = [];

  defs.push({
    id: "connection",
    name: "1 · Connection",
    purpose: "Network + auth reachability of the provider host",
    run: (signal) => testConnection(opts, signal),
  });

  defs.push({
    id: "basic",
    name: "2 · Basic request",
    purpose: "Minimal non-streaming chat completion (model ID + auth)",
    run: (signal) =>
      runChatTest(
        opts,
        {
          endpoint,
          stream: false,
          body: {
            model: opts.model,
            messages: [{ role: "user", content: "Reply with exactly: pong" }],
          },
        },
        signal,
      ),
  });

  defs.push({
    id: "streaming",
    name: "3 · Streaming",
    purpose: "SSE streaming with TTFT + completion-signal checks",
    run: (signal) =>
      runChatTest(
        opts,
        {
          endpoint,
          body: {
            model: opts.model,
            messages: [{ role: "user", content: "Count from 1 to 5, numbers only." }],
          },
        },
        signal,
      ),
  });

  defs.push({
    id: "tool_free",
    name: "4 · Agent request (no tools)",
    purpose: "The exact request shape a normal chat turn sends (system prompt + params)",
    run: (signal) => {
      const body: Record<string, unknown> = {
        model: opts.model,
        messages: [
          { role: "system", content: COMPAT_SYSTEM_PROMPT },
          { role: "user", content: "Say OK." },
        ],
        stream_options: { include_usage: true },
        temperature: 0.7,
      };
      applyParamPolicy(body, {
        baseUrl: opts.baseUrl,
        model: opts.model,
        disabledParams: opts.disabledParams,
      });
      return runChatTest(opts, { endpoint, body }, signal);
    },
  });

  defs.push({
    id: "tools",
    name: "5 · Tool request",
    purpose: "Function calling — one minimal tool, verifies the model calls it",
    run: async (signal) => {
      if (opts.toolsEnabled === false) {
        return {
          status: "skip",
          detail: "Tools are disabled for this provider in its settings.",
          metrics: {},
        };
      }
      if (!wireAllowsTools(opts.baseUrl, opts.model)) {
        return {
          status: "skip",
          detail:
            "Onyx previously learned this route must run without tools (wire-compat). The chat runtime will not send tool params here.",
          metrics: {},
        };
      }
      const body: Record<string, unknown> = {
        model: opts.model,
        messages: [
          {
            role: "user",
            content: "What is the weather in Tokyo right now? Use the get_weather tool.",
          },
        ],
        tools: [diagnosticTool()],
        tool_choice: "auto",
      };
      applyParamPolicy(body, {
        baseUrl: opts.baseUrl,
        model: opts.model,
        disabledParams: opts.disabledParams,
      });
      return runChatTest(opts, { endpoint, body, expectTools: true }, signal);
    },
  });

  defs.push({
    id: "long",
    name: "6 · Long response",
    purpose:
      "A longer generation — verifies it completes with a finish signal (auto-stop regression)",
    run: (signal) =>
      runChatTest(
        opts,
        {
          endpoint,
          body: {
            model: opts.model,
            messages: [
              {
                role: "user",
                content:
                  "Write a numbered list from 1 to 15. For each number, write one short sentence about why the number is interesting. No other text.",
              },
            ],
          },
        },
        signal,
      ),
  });

  let unreachable = false;
  let cancelled = false;
  for (const def of defs) {
    // A user cancel marks every remaining test as skipped (visible in the
    // UI) rather than silently truncating the result list.
    if (!cancelled && opts.signal?.aborted) cancelled = true;
    if (cancelled) {
      const r: DiagnosticResult = {
        id: def.id,
        name: def.name,
        purpose: def.purpose,
        status: "skip",
        durationMs: 0,
        detail: "Cancelled.",
      };
      results.push(r);
      opts.onResult?.(r);
      continue;
    }
    if (unreachable) {
      const r: DiagnosticResult = {
        id: def.id,
        name: def.name,
        purpose: def.purpose,
        status: "skip",
        durationMs: 0,
        detail: "Skipped — the provider host is unreachable.",
      };
      results.push(r);
      opts.onResult?.(r);
      continue;
    }
    const started = Date.now();
    const tc = testController(def.id, opts.signal);
    let r: DiagnosticResult;
    try {
      const outcome = await def.run(tc.signal);
      if (outcome.unreachable) unreachable = true;
      r = {
        id: def.id,
        name: def.name,
        purpose: def.purpose,
        status: outcome.status,
        durationMs: Date.now() - started,
        detail: outcome.detail,
        advice: outcome.advice,
        metrics: outcome.metrics,
        requestUrl: def.id === "connection" ? undefined : endpoint,
      };
    } catch (err) {
      if (opts.signal?.aborted && !tc.wasTimeout()) {
        r = {
          id: def.id,
          name: def.name,
          purpose: def.purpose,
          status: "skip",
          durationMs: Date.now() - started,
          detail: "Cancelled.",
        };
      } else if (tc.wasTimeout()) {
        r = {
          id: def.id,
          name: def.name,
          purpose: def.purpose,
          status: "fail",
          durationMs: Date.now() - started,
          detail: `Timed out after ${Math.round(TIMEOUTS_MS[def.id] / 1000)}s — no response from the provider.`,
          advice: "The endpoint is unreachable or extremely slow. Check the Base URL and the provider's status page.",
          metrics: { httpStatus: 0 },
          requestUrl: def.id === "connection" ? undefined : endpoint,
        };
        if (def.id === "connection") unreachable = true;
      } else {
        const nf = networkFailure(err, TIMEOUTS_MS[def.id]);
        if (def.id === "connection") unreachable = true;
        r = {
          id: def.id,
          name: def.name,
          purpose: def.purpose,
          status: nf.status,
          durationMs: Date.now() - started,
          detail: nf.detail,
          advice: nf.advice,
          metrics: nf.metrics,
          requestUrl: def.id === "connection" ? undefined : endpoint,
        };
      }
    } finally {
      tc.cancel();
    }
    results.push(r);
    opts.onResult?.(r);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Report formatting (clipboard / Logs panel).
// ---------------------------------------------------------------------------

/** Learned runtime adaptations for this provider+model, for the report
 *  header — explains differences between diagnostics (raw) and chat
 *  (adapted). */
export function learnedAdaptations(baseUrl: string, model: string): string[] {
  const notes: string[] = [];
  const mode = getWireCompat(baseUrl, model);
  if (mode.system === "compact") notes.push("chat sends a compacted system prompt (learned)");
  if (mode.system === "dropped") notes.push("chat drops the system prompt (learned)");
  if (mode.toolText) notes.push("chat converts tool traffic to plain text (learned)");
  if (mode.noTools) notes.push("chat omits tools entirely (learned)");
  return notes;
}

export function formatDiagnosticsReport(
  providerName: string,
  model: string,
  baseUrl: string,
  results: readonly DiagnosticResult[],
): string {
  const lines: string[] = [];
  lines.push(`OnyxAgent provider diagnostics — ${new Date().toISOString()}`);
  lines.push(`Provider: ${providerName} | Model: ${model}`);
  lines.push(`Base URL: ${baseUrl}`);
  const adaptations = learnedAdaptations(baseUrl, model);
  if (adaptations.length > 0) {
    lines.push(`Learned adaptations during chat: ${adaptations.join("; ")}`);
  }
  lines.push("");
  for (const r of results) {
    const m = r.metrics ?? {};
    const bits: string[] = [];
    if (m.httpStatus !== undefined) bits.push(`HTTP ${m.httpStatus}`);
    if (m.ttftMs !== undefined) bits.push(`TTFT ${m.ttftMs}ms`);
    if (m.chunks !== undefined) bits.push(`${m.chunks} chunks`);
    if (m.chars !== undefined) bits.push(`${m.chars} chars`);
    if (m.finishReason !== undefined && m.finishReason !== null)
      bits.push(`finish_reason=${m.finishReason}`);
    if (m.sawDone !== undefined) bits.push(m.sawDone ? "[DONE] seen" : "no [DONE]");
    if (m.toolCallCount !== undefined) bits.push(`${m.toolCallCount} tool call(s)`);
    lines.push(
      `[${r.status.toUpperCase()}] ${r.name} (${r.durationMs}ms${bits.length ? ` — ${bits.join(", ")}` : ""})`,
    );
    lines.push(`  ${r.detail}`);
    if (r.advice) lines.push(`  → ${r.advice}`);
  }
  const pass = results.filter((r) => r.status === "pass").length;
  lines.push("");
  lines.push(`Summary: ${pass}/${results.length} passed.`);
  return lines.join("\n");
}

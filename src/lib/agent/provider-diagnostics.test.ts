// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The diagnostics runner must never touch real network in tests — every
// test stubs global fetch with a scriptable router keyed off the request
// body (each test sends a distinctive prompt).
import {
  runProviderDiagnostics,
  formatDiagnosticsReport,
  type DiagnosticResult,
} from "./provider-diagnostics";

// ---------------------------------------------------------------------------
// Mock helpers.
// ---------------------------------------------------------------------------

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** SSE response body from parsed event payloads (auto `data: ` framing). */
function sseResponse(events: Array<Record<string, unknown> | "[DONE]">): Response {
  const parts = events.map((e) => `data: ${e === "[DONE]" ? "[DONE]" : JSON.stringify(e)}\n\n`);
  let i = 0;
  const chunks = parts.map((p) => bytes(p));
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i]!);
        i++;
      } else {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A content + finish + usage + [DONE] streaming happy-path event list. */
function happyStream(text = "1 2 3 4 5"): Array<Record<string, unknown> | "[DONE]"> {
  return [
    { choices: [{ delta: { content: text }, index: 0 }] },
    { choices: [{ delta: {}, finish_reason: "stop", index: 0 }] },
    { choices: [], usage: { total_tokens: 42 } },
    "[DONE]",
  ];
}

/** A tool-call stream split across THREE argument fragments (chunked-args
 *  accumulation — the PRD §17 requirement). */
function toolCallStream(): Array<Record<string, unknown> | "[DONE]"> {
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } },
            ],
          },
          index: 0,
        },
      ],
    },
    {
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] }, index: 0 },
      ],
    },
    {
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { arguments: ': "Tokyo"}' } }] }, index: 0 },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }] },
    "[DONE]",
  ];
}

/** Router rule — match against (url, body), respond with a Response. */
type Rule = { match: (url: string, body: string) => boolean; respond: () => Response };

/**
 * The full happy-path router, ordered by test:
 * 0 connection · 1 basic · 2 streaming · 3 tool_free · 4 tools · 5 long.
 */
function happyRouter(): Rule[] {
  return [
    { match: (url) => url.includes("/models"), respond: () => jsonResponse({ data: [{ id: "mock-model" }, { id: "other" }] }) },
    {
      match: (_url, body) => body.includes("Reply with exactly: pong"),
      respond: () => jsonResponse({ choices: [{ message: { content: "pong" }, finish_reason: "stop" }] }),
    },
    { match: (_url, body) => body.includes("Count from 1 to 5"), respond: () => sseResponse(happyStream()) },
    { match: (_url, body) => body.includes("Say OK."), respond: () => sseResponse(happyStream("OK")) },
    { match: (_url, body) => body.includes("get_weather"), respond: () => sseResponse(toolCallStream()) },
    {
      match: (_url, body) => body.includes("numbered list from 1 to 15"),
      respond: () => sseResponse(happyStream("1. one 2. two 3. three")),
    },
  ];
}

/** Install a fetch router (rules tried in order; unmatched → 500). */
function installRouter(rules: Rule[]) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    // The real client sends ?url=<encoded target> — decode so rules can
    // match on the human-readable endpoint.
    const url = decodeURIComponent(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const rawBody = typeof init?.body === "string" ? init.body : "";
    const rule = rules.find((r) => r.match(url, rawBody));
    if (!rule) return jsonResponse({ error: { message: `unmocked route: ${method} ${url}` } }, 500);
    return rule.respond();
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** Happy router with one rule's response replaced (by test index). */
function withRule(index: number, respond: Rule["respond"]): Rule[] {
  const rules = happyRouter();
  rules[index] = { match: rules[index]!.match, respond };
  return rules;
}

const BASE_OPTS = {
  baseUrl: "https://mock.example/v1",
  apiKey: "sk-test",
  model: "mock-model",
  toolsEnabled: true,
} as const;

function byId(results: DiagnosticResult[]) {
  return new Map(results.map((r) => [r.id, r]));
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 1. Happy path — 6/6 pass with correct metrics.
// ---------------------------------------------------------------------------

describe("runProviderDiagnostics — happy path", () => {
  it("passes all six tests and reports metrics", async () => {
    installRouter(happyRouter());
    const onResult = vi.fn();
    const results = await runProviderDiagnostics({ ...BASE_OPTS, onResult });

    expect(results).toHaveLength(6);
    expect(onResult).toHaveBeenCalledTimes(6);
    for (const r of results) expect(r.status).toBe("pass");

    const m = byId(results);
    // Connection parsed the model list.
    expect(m.get("connection")!.detail).toContain("2 models");
    // Basic is non-streaming.
    expect(m.get("basic")!.metrics.chars).toBe(4); // "pong"
    // Streaming saw [DONE] + finish_reason.
    expect(m.get("streaming")!.metrics.sawDone).toBe(true);
    expect(m.get("streaming")!.metrics.finishReason).toBe("stop");
    // Tool args accumulated across THREE chunks into valid JSON.
    const tools = m.get("tools")!;
    expect(tools.metrics.toolCallCount).toBe(1);
    expect(tools.metrics.toolArgsValid).toBe(true);
    expect(tools.detail).toContain("get_weather");
  });

  it("sends requests through the chat proxy with the right shapes", async () => {
    const bodies: Array<{ url: string; body: string }> = [];
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl = String(input);
      const url = decodeURIComponent(rawUrl);
      const method = (init?.method ?? "GET").toUpperCase();
      const rawBody = typeof init?.body === "string" ? init.body : "";
      if (method === "POST") bodies.push({ url: rawUrl, body: rawBody });
      const rule = happyRouter().find((r) => r.match(url, rawBody));
      if (!rule) return jsonResponse({ error: "unmocked" }, 500);
      return rule.respond();
    });
    vi.stubGlobal("fetch", fn);

    const results = await runProviderDiagnostics({ ...BASE_OPTS });
    expect(results).toHaveLength(6);
    expect(bodies).toHaveLength(5); // 5 POSTs (connection is a GET)

    // All POSTs go through the proxy with the encoded chat endpoint.
    const endpoint = "https://mock.example/v1/chat/completions";
    for (const { url } of bodies) {
      expect(url.startsWith("/api/chat-proxy?url=")).toBe(true);
      expect(decodeURIComponent(url)).toContain(endpoint);
    }
    // Basic is the ONLY non-streaming request.
    const basic = bodies.find((b) => b.body.includes("Reply with exactly: pong"))!;
    expect(basic.body).toContain('"stream":false');
    const streaming = bodies.find((b) => b.body.includes("Count from 1 to 5"))!;
    expect(streaming.body).toContain('"stream":true');
    // Tool-free agent request carries the system prompt + stream_options.
    const agent = bodies.find((b) => b.body.includes("Say OK."))!;
    expect(agent.body).toContain('"role":"system"');
    expect(agent.body).toContain("stream_options");
    expect(agent.body).toContain('"temperature"');
    // Tools request carries the tool schema.
    const tools = bodies.find((b) => b.body.includes("get_weather"))!;
    expect(tools.body).toContain('"tools"');
    expect(tools.body).toContain('"tool_choice":"auto"');
  });
});

// ---------------------------------------------------------------------------
// 2. Connection failures — skip the rest when the host is unreachable.
// ---------------------------------------------------------------------------

describe("runProviderDiagnostics — unreachable host", () => {
  it("fails connection via proxy 502 and skips the remaining tests", async () => {
    installRouter(
      withRule(0, () =>
        jsonResponse({ error: "Failed to reach upstream: getaddrinfo ENOTFOUND" }, 502),
      ),
    );
    const results = await runProviderDiagnostics({ ...BASE_OPTS });
    expect(results[0]!.status).toBe("fail");
    expect(results[0]!.detail).toContain("unreachable");
    for (const r of results.slice(1)) {
      expect(r.status).toBe("skip");
      expect(r.detail).toContain("unreachable");
    }
  });

  it("reports auth rejection on /models but continues the suite", async () => {
    installRouter(withRule(0, () => jsonResponse({ error: { message: "Invalid API key" } }, 401)));
    const results = await runProviderDiagnostics({ ...BASE_OPTS });
    expect(results[0]!.status).toBe("fail");
    expect(results[0]!.detail).toContain("API key was rejected");
    // Chat requests use their own verdicts.
    expect(results[1]!.status).toBe("pass");
  });

  it("treats /models 404 as a warning, not a failure", async () => {
    installRouter(withRule(0, () => jsonResponse({ error: "not found" }, 404)));
    const results = await runProviderDiagnostics({ ...BASE_OPTS });
    expect(results[0]!.status).toBe("warn");
    expect(results.filter((r) => r.status === "pass")).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// 3. The failure matrix — each test localizes its own failure class.
// ---------------------------------------------------------------------------

describe("runProviderDiagnostics — failure classification", () => {
  it("basic: empty non-streaming content fails", async () => {
    installRouter(
      withRule(1, () =>
        jsonResponse({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }),
      ),
    );
    const results = await runProviderDiagnostics({ ...BASE_OPTS });
    expect(results[1]!.status).toBe("fail");
    expect(results[1]!.detail).toContain("Empty response");
  });

  it("basic: a 400 surfaces the provider's message + advice", async () => {
    installRouter(
      withRule(1, () => jsonResponse({ error: { message: "temperature is not supported" } }, 400)),
    );
    const results = await runProviderDiagnostics({ ...BASE_OPTS });
    expect(results[1]!.status).toBe("fail");
    expect(results[1]!.detail).toContain("temperature is not supported");
    expect(results[1]!.advice).toContain("parameter");
  });

  it("streaming: error payload inside a 200 stream fails with the message", async () => {
    installRouter(
      withRule(2, () => sseResponse([{ error: { message: "upstream exploded", code: 503 } }])),
    );
    const results = await runProviderDiagnostics({ ...BASE_OPTS });
    expect(results[2]!.status).toBe("fail");
    expect(results[2]!.detail).toContain("upstream exploded");
  });

  it("streaming: premature cut (no finish signal) warns — the auto-stop regression", async () => {
    // Content then clean EOF: NO finish_reason, NO [DONE], NO usage.
    installRouter(
      withRule(2, () => sseResponse([{ choices: [{ delta: { content: "1 2 3" }, index: 0 }] }])),
    );
    const results = await runProviderDiagnostics({ ...BASE_OPTS });
    const streaming = results[2]!;
    expect(streaming.status).toBe("warn");
    expect(streaming.detail).toContain("NO completion signal");
    expect(streaming.metrics.sawDone).toBe(false);
  });

  it("tools: model replying in text instead of calling warns", async () => {
    installRouter(withRule(4, () => sseResponse(happyStream("I cannot check the weather."))));
    const results = await runProviderDiagnostics({ ...BASE_OPTS });
    expect(results[4]!.status).toBe("warn");
    expect(results[4]!.detail).toContain("instead of calling the tool");
  });

  it("tools: invalid args JSON warns with the cut-args detail", async () => {
    installRouter(
      withRule(4, () =>
        sseResponse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: "call_1", function: { name: "get_weather", arguments: '{"city": "Tok' } },
                  ],
                },
                index: 0,
              },
            ],
          },
          // Stream cut mid-argument — no closing brace, no finish.
          "[DONE]",
        ]),
      ),
    );
    const results = await runProviderDiagnostics({ ...BASE_OPTS });
    expect(results[4]!.status).toBe("warn");
    expect(results[4]!.detail).toContain("did not parse");
  });

  it("tools test skips when the provider has tools disabled", async () => {
    installRouter(happyRouter());
    const results = await runProviderDiagnostics({ ...BASE_OPTS, toolsEnabled: false });
    expect(results[4]!.status).toBe("skip");
    expect(results[4]!.detail).toContain("disabled");
    expect(results.filter((r) => r.status === "pass")).toHaveLength(5);
  });

  it("long: zero content after [DONE] fails", async () => {
    installRouter(withRule(5, () => sseResponse(["[DONE]"])));
    const results = await runProviderDiagnostics({ ...BASE_OPTS });
    expect(results[5]!.status).toBe("fail");
    expect(results[5]!.detail).toContain("zero content");
  });
});

// ---------------------------------------------------------------------------
// 4. Cancellation + report formatting.
// ---------------------------------------------------------------------------

describe("runProviderDiagnostics — cancellation + report", () => {
  it("user cancel mid-suite skips the remaining tests", async () => {
    const ctrl = new AbortController();
    installRouter(happyRouter());
    const results = await runProviderDiagnostics({
      ...BASE_OPTS,
      signal: ctrl.signal,
      onResult: (r) => {
        // Cancel right after the FIRST test completes.
        if (r.id === "connection") ctrl.abort();
      },
    });
    expect(results).toHaveLength(6);
    expect(results[0]!.status).toBe("pass");
    for (const r of results.slice(1)) {
      expect(r.status).toBe("skip");
      expect(r.detail).toBe("Cancelled.");
    }
  });

  it("formats a copyable report with per-test metrics", async () => {
    installRouter(happyRouter());
    const results = await runProviderDiagnostics({ ...BASE_OPTS });
    const report = formatDiagnosticsReport("Mock", "mock-model", BASE_OPTS.baseUrl, results);
    expect(report).toContain("Provider: Mock | Model: mock-model");
    expect(report).toContain("Summary: 6/6 passed.");
    expect(report).toContain("TTFT ");
    expect(report).toContain("[DONE] seen");
    expect(report).toContain("[PASS] 5 · Tool request");
  });
});

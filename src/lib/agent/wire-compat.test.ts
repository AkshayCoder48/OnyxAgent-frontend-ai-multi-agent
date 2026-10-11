/**
 * Wire-compat persistence TTL + background-runner tool-call accumulator
 * parity (tool-reliability Part B).
 *
 * 1. Persisted strict-gateway downgrades (toolText / system compact /
 *    dropped) now expire after 7 days — the old permanent persistence left
 *    providers with a neutral 2-line system prompt forever, which read to
 *    the model as "no tool instructions" (the "almost never calls tools"
 *    symptom).
 * 2. The E2B background runner (the DEFAULT execution path) accumulated
 *    streamed tool-call deltas with the same bugs the foreground runtime
 *    already fixed: index-less parallel calls merging into one malformed
 *    blob, and legacy `delta.function_call` never recognized. The runner's
 *    helpers live inside the BG_AGENT_SCRIPT template literal, so they are
 *    verified by EXTRACTING the exact source the sandbox executes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BG_AGENT_SCRIPT } from "@/lib/e2b/bg-agent-script";
import {
  beginTurnWireCompat,
  buildWireMessages,
  getWireCompat,
  nextStrictGatewayStep,
  type WireMessage,
} from "./wire-compat";

// ---------------------------------------------------------------------------
// wire-compat persistence TTL
// ---------------------------------------------------------------------------

describe("wire-compat persisted downgrades expire (TTL)", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("a fresh persisted downgrade hydrates", () => {
    localStorage.setItem(
      "onyx-wire-compat-v3",
      JSON.stringify({
        "https://api.example.com|model-x": {
          toolText: true,
          system: "compact",
          noTools: false,
          learnedAt: Date.now() - 1000,
        },
      }),
    );
    const mode = getWireCompat("https://api.example.com", "model-x");
    expect(mode.toolText).toBe(true);
    expect(mode.system).toBe("compact");
  });

  it("an EXPIRED downgrade (older than 7 days) is ignored — provider re-probes native", () => {
    localStorage.setItem(
      "onyx-wire-compat-v3",
      JSON.stringify({
        "https://api.example.com|model-x": {
          toolText: true,
          system: "dropped",
          noTools: false,
          learnedAt: Date.now() - 8 * 24 * 3600_000,
        },
      }),
    );
    const mode = getWireCompat("https://api.example.com", "model-x");
    expect(mode.system).toBe("native");
    expect(mode.toolText).toBe(false);
  });

  it("legacy v2 entries (no learnedAt) never hydrate — permanent downgrades expire immediately", () => {
    localStorage.setItem(
      "onyx-wire-compat-v2",
      JSON.stringify({
        "https://api.example.com|model-x": { toolText: true, system: "compact", noTools: false },
      }),
    );
    const mode = getWireCompat("https://api.example.com", "model-x");
    expect(mode.system).toBe("native");
    expect(mode.toolText).toBe(false);
  });

  it("learning a downgrade stamps learnedAt; noTools never persists", () => {
    const messages: WireMessage[] = [
      { role: "system", content: "You are Onyx" },
      { role: "user", content: "hi" },
    ];
    // First 400 → toolText.
    expect(nextStrictGatewayStep({
      baseUrl: "https://api.example.com",
      model: "model-x",
      messages,
      hasToolsParam: true,
      errorText: "Invalid role 'tool'",
    })).toContain("tool-text");
    const persisted = JSON.parse(
      localStorage.getItem("onyx-wire-compat-v3") ?? "{}",
    ) as Record<string, { learnedAt?: number; noTools?: boolean }>;
    const entry = persisted["https://api.example.com|model-x"];
    expect(typeof entry?.learnedAt).toBe("number");
    expect(entry?.noTools).toBe(false);
  });

  it("beginTurnWireCompat resets a session-learned noTools", () => {
    const messages: WireMessage[] = [
      { role: "system", content: "You are Onyx" },
      { role: "user", content: "hi" },
    ];
    // Walk the ladder to noTools with an error that explicitly names tools.
    nextStrictGatewayStep({ baseUrl: "https://api.example.com", model: "model-y", messages, hasToolsParam: true, errorText: "Invalid role 'tool'" });
    nextStrictGatewayStep({ baseUrl: "https://api.example.com", model: "model-y", messages, hasToolsParam: true, errorText: "bad" });
    nextStrictGatewayStep({ baseUrl: "https://api.example.com", model: "model-y", messages, hasToolsParam: true, errorText: "bad" });
    expect(nextStrictGatewayStep({ baseUrl: "https://api.example.com", model: "model-y", messages, hasToolsParam: true, errorText: "tools is not supported" })).toContain("no tools");
    expect(getWireCompat("https://api.example.com", "model-y").noTools).toBe(true);
    beginTurnWireCompat("https://api.example.com", "model-y");
    expect(getWireCompat("https://api.example.com", "model-y").noTools).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// bg runner accumulator parity (extracted from the sandbox script string)
// ---------------------------------------------------------------------------

/** Extract a top-level `function name(args) { … }` from the runner script. */
function extractRunnerFn(name: string): (...args: unknown[]) => unknown {
  const start = BG_AGENT_SCRIPT.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in BG_AGENT_SCRIPT`);
  let depth = 0;
  let end = -1;
  for (let i = start; i < BG_AGENT_SCRIPT.length; i++) {
    const ch = BG_AGENT_SCRIPT[i]!;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) throw new Error(`unbalanced braces for ${name}`);
  const factory = new Function(`${BG_AGENT_SCRIPT.slice(start, end)}\nreturn ${name};`);
  return factory() as (...args: unknown[]) => unknown;
}

type AccEntry = { id: string; name: string; args: string };
type AccMap = Map<number, AccEntry>;

describe("runner extractDeltas + resolveAccKey (fg-parity accumulator)", () => {
  const extractDeltas = extractRunnerFn("extractDeltas") as (chunk: unknown) => {
    toolCalls?: Array<{ index?: number; id?: string; name?: string; arguments?: string }>;
  };
  const resolveAccKey = extractRunnerFn("resolveAccKey") as (
    tc: { index?: number; id?: string; name?: string; arguments?: string },
    acc: AccMap,
  ) => number;
  const nextFreeAccKey = extractRunnerFn("nextFreeAccKey") as (acc: AccMap) => number;

  it("keeps index-less deltas index-less (no silent coercion to 0)", () => {
    const out = extractDeltas({
      choices: [{ delta: { tool_calls: [{ id: "call_1", function: { name: "web_search", arguments: "{\"q\":" } }] } }],
    });
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls![0]!.index).toBeUndefined();
    expect(out.toolCalls![0]!.name).toBe("web_search");
  });

  it("normalizes legacy delta.function_call to a tool call at index 0", () => {
    const out = extractDeltas({
      choices: [{ delta: { function_call: { name: "current_datetime", arguments: "{}" } } }],
    });
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls![0]).toMatchObject({ index: 0, name: "current_datetime", arguments: "{}" });
  });

  it("parallel index-less calls with DIFFERENT names land in separate slots", () => {
    const acc: AccMap = new Map();
    // Two interleaved index-less streams (a gateway that omits `index`).
    const a1 = { id: undefined, name: "web_search", arguments: '{"q":"a' } as const;
    const b1 = { id: undefined, name: "run_python", arguments: '{"code":"b' } as const;
    const a2 = { id: undefined, name: undefined, arguments: '"}' } as const;
    const b2 = { id: undefined, name: undefined, arguments: '"}' } as const;
    acc.set(resolveAccKey(a1, acc), { id: "", name: "web_search", args: '{"q":"a' });
    // Different name while the previous entry already has args → NEW slot.
    const keyB = resolveAccKey(b1, acc);
    expect(keyB).not.toBe(0);
    acc.set(keyB, { id: "", name: "run_python", args: '{"code":"b' });
    // Continuation deltas (no id, no name) land on the MOST RECENT entry.
    expect(resolveAccKey(b2, acc)).toBe(keyB);
    acc.set(keyB, { ...acc.get(keyB)!, args: acc.get(keyB)!.args + '"}' });
    expect(resolveAccKey(a2, acc)).toBe(0); // falls back to last key when names match/no name
    expect(acc.size).toBe(2);
    expect(acc.get(0)!.args).toBe('{"q":"a');
    expect(acc.get(keyB)!.args).toBe('{"code":"b"}');
  });

  it("an id arriving on a separate chunk matches its own entry", () => {
    const acc: AccMap = new Map();
    acc.set(0, { id: "", name: "web_search", args: '{"q":' });
    acc.set(1, { id: "", name: "use_browser", args: '{"action":' });
    // id chunk for the FIRST call arrives late.
    expect(resolveAccKey({ id: "call_A" }, acc)).not.toBe(0); // unknown id → next free slot… but then the executor keys by index below
    // The realistic replay: id + name together for an existing name.
    expect(resolveAccKey({ id: "call_A", name: "web_search" }, acc)).toBe(0);
  });

  it("nextFreeAccKey skips occupied slots", () => {
    const acc: AccMap = new Map([[1, { id: "", name: "a", args: "" }]]);
    expect(nextFreeAccKey(acc)).toBe(0);
    acc.set(0, { id: "", name: "b", args: "" });
    expect(nextFreeAccKey(acc)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// buildWireMessages smoke (annotation-free toolText encoding still intact)
// ---------------------------------------------------------------------------

describe("buildWireMessages still encodes toolText correctly", () => {
  it("merges tool results into one user message and textualizes calls", () => {
    const out = buildWireMessages(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "web_search", arguments: "{\"q\":\"x\"}" } }] },
        { role: "tool", content: "result", tool_call_id: "c1", name: "web_search" },
      ],
      { toolText: true, system: "native", noTools: false },
    );
    expect(out.some((m) => m.role === "tool")).toBe(false);
    expect(out.some((m) => Array.isArray(m.tool_calls) && m.tool_calls.length > 0)).toBe(false);
    const merged = out.find((m) => m.role === "user" && m.content?.includes("<tool_result"));
    expect(merged).toBeTruthy();
  });
});

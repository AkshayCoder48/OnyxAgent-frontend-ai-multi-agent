/**
 * Regression tests — reliability fixes round (chat-history boot hydration,
 * Composio catalog consistency, LLM-400 strict-compat request shaping).
 *
 * The bg-agent helpers (buildRequestMessages / sanitizeToolParameters) live
 * inside the BG_AGENT_SCRIPT template literal (they execute in the E2B
 * sandbox), so their behavior is verified by EXTRACTING the self-contained
 * function sources from the script string and evaluating them — the exact
 * code the sandbox runs, not a copy.
 */
import { describe, expect, it } from "vitest";
import { qk } from "@/lib/query-keys";
import { normalizeToolkitPage } from "@/lib/composio/client";
import { BG_AGENT_SCRIPT } from "@/lib/e2b/bg-agent-script";

// ---------------------------------------------------------------------------
// 1. USER-SCOPED QUERY KEYS (chat history empty on app open)
// ---------------------------------------------------------------------------

describe("conversations list query key is user-scoped", () => {
  it("produces DIFFERENT keys for different user ids", () => {
    // The auth store boots with the transient local-user and swaps to the
    // real Dexie user id asynchronously — a static key cached the transient
    // user's empty list forever (the "history empty until Settings visit"
    // bug). Different ids MUST be different cache entries so the swap
    // triggers a fresh fetch.
    expect(qk.conversations.list("local-user")).not.toEqual(qk.conversations.list("u_real_123"));
  });

  it("falls back to a stable anon key when no user yet", () => {
    expect(qk.conversations.list()).toEqual(qk.conversations.list(undefined));
    expect(qk.conversations.list().join(".")).toContain("anon");
  });

  it("stays under the conversations prefix so broad invalidation still matches", () => {
    const key = qk.conversations.list("u1");
    expect(key.slice(0, 1)).toEqual(["conversations"]);
    // React Query prefix matching: every scoped key starts with the all() key.
    const prefix = qk.conversations.all();
    expect(key.slice(0, prefix.length)).toEqual(prefix);
  });

  it("slash-commands list key is user-scoped the same way", () => {
    expect(qk.slashCommands.list("a")).not.toEqual(qk.slashCommands.list("b"));
    expect(qk.slashCommands.list(undefined)).toEqual(qk.slashCommands.list());
  });
});

// ---------------------------------------------------------------------------
// 2. COMPOSIO PAGE NORMALIZATION (count vs dropdown mismatch)
// ---------------------------------------------------------------------------

describe("normalizeToolkitPage", () => {
  it("passes the documented shape through", () => {
    const page = normalizeToolkitPage({
      items: [{ slug: "github", name: "GitHub" }],
      next_cursor: "cur_1",
      total_items: 1463,
      current_page: 1,
      total_pages: 15,
    });
    expect(page.items).toHaveLength(1);
    expect(page.next_cursor).toBe("cur_1");
    expect(page.total_items).toBe(1463);
  });

  it("unwraps a nested items.items shape", () => {
    const page = normalizeToolkitPage({
      items: { items: [{ slug: "slack" }], total_items: 42 },
    });
    expect(page.items).toEqual([{ slug: "slack" }]);
    expect(page.total_items).toBe(42);
  });

  it("handles a bare top-level array", () => {
    const page = normalizeToolkitPage([{ slug: "gmail" }, { slug: "notion" }]);
    expect(page.items).toHaveLength(2);
    expect(page.total_items).toBe(2);
    expect(page.next_cursor).toBeNull();
  });

  it("unwraps a data wrapper", () => {
    const page = normalizeToolkitPage({ data: { items: [{ slug: " linear " }], next_cursor: null } });
    expect(page.items[0]?.slug).toBe(" linear ");
  });

  it("returns an EMPTY page (never throws) for garbage", () => {
    for (const garbage of [null, undefined, 42, "nope", {}, { items: 7 }]) {
      const page = normalizeToolkitPage(garbage);
      expect(page.items).toEqual([]);
      expect(page.next_cursor).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. SANDBOX RUNNER REQUEST SHAPING (LLM HTTP 400 strict-compat)
// ---------------------------------------------------------------------------

/** Extract a top-level `function name(args) { … }` source from the runner
 *  script (balanced braces) and evaluate it in isolation. `deps` names other
 *  top-level functions the target calls (e.g. the wire-compat helpers
 *  buildRequestMessages now routes through) — they are extracted the same
 *  way and declared alongside the target inside the factory so the
 *  extracted function stays runnable standalone. */
function extractRunnerFn(name: string, deps: string[] = []): (...args: unknown[]) => unknown {
  const extractOne = (fnName: string): string => {
    const start = BG_AGENT_SCRIPT.indexOf(`function ${fnName}(`);
    if (start === -1) throw new Error(`function ${fnName} not found in BG_AGENT_SCRIPT`);
    let depth = 0;
    let end = -1;
    for (let i = start; i < BG_AGENT_SCRIPT.length; i++) {
      const ch = BG_AGENT_SCRIPT[i]!;
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end === -1) throw new Error(`unbalanced braces for ${fnName}`);
    return BG_AGENT_SCRIPT.slice(start, end);
  };
  const src = [name, ...deps].map(extractOne).join("\n");
  const factory = new Function(`${src}\nreturn ${name};`) as () => (...args: unknown[]) => unknown;
  return factory();
}

describe("runner buildRequestMessages (reasoning never on the wire by default)", () => {
  const buildRequestMessages = extractRunnerFn("buildRequestMessages", [
    "applyWireCompat",
    "wireMode",
  ]) as (state: unknown) => unknown[];

  it("strips the local reasoning field from assistant messages", () => {
    const state = {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "", reasoning: "I should call a tool", tool_calls: [{ id: "1" }] },
        { role: "tool", tool_call_id: "1", content: "{}" },
      ],
    };
    const wire = buildRequestMessages(state) as Array<Record<string, unknown>>;
    const assistant = wire.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(assistant).not.toHaveProperty("reasoning");
    expect(assistant).not.toHaveProperty("reasoning_content");
    // The rest of the message is intact.
    expect(assistant).toHaveProperty("tool_calls");
  });

  it("restores reasoning_content ONLY when replayReasoning is enabled", () => {
    const state = {
      replayReasoning: true,
      messages: [{ role: "assistant", content: "", reasoning: "thinking…" }],
    };
    const wire = buildRequestMessages(state) as Array<Record<string, unknown>>;
    expect(wire[0]).toHaveProperty("reasoning_content", "thinking…");
    // The local field itself must not leak as `reasoning` — JSON.stringify
    // drops undefined values, so an undefined-valued key is wire-invisible.
    expect(JSON.parse(JSON.stringify(wire[0]))).not.toHaveProperty("reasoning");
  });

  it("leaves non-assistant messages untouched", () => {
    const state = {
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "u" },
        { role: "tool", tool_call_id: "t1", content: "r" },
      ],
    };
    const wire = buildRequestMessages(state) as Array<Record<string, unknown>>;
    expect(wire).toEqual(state.messages);
  });
});

describe("runner sanitizeToolParameters (malformed schema defense)", () => {
  const sanitizeToolParameters = extractRunnerFn("sanitizeToolParameters") as (schema: unknown) => Record<string, unknown>;

  it("keeps a valid schema", () => {
    const schema = {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    };
    expect(sanitizeToolParameters(schema)).toEqual(schema);
  });

  it("falls back to a bare object schema for garbage", () => {
    for (const garbage of [null, undefined, 42, "x", [], { type: "object" }]) {
      const out = sanitizeToolParameters(garbage);
      expect(out).toHaveProperty("type", "object");
      expect(out).toHaveProperty("properties");
      expect(Array.isArray(out.properties)).toBe(false);
    }
  });

  it("drops required entries that name unknown properties", () => {
    const out = sanitizeToolParameters({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a", "ghost"],
    }) as { required?: string[] };
    expect(out.required).toEqual(["a"]);
  });

  it("replaces non-object property schemas with string stubs", () => {
    const out = sanitizeToolParameters({
      type: "object",
      properties: { good: { type: "number" }, bad: 42 },
    }) as { properties: Record<string, unknown> };
    expect(out.properties.good).toEqual({ type: "number" });
    expect(out.properties.bad).toEqual({ type: "string" });
  });
});

describe("runner script content invariants (LLM 400 fix)", () => {
  it("serializes request messages through buildRequestMessages in both call paths", () => {
    // Every request path routes the history through buildRequestMessages
    // AND the tool-call-argument sanitizer (malformed replayed arguments
    // poison the provider stream — see tool-args.ts).
    expect(BG_AGENT_SCRIPT).toContain(
      "messages: sanitizeToolCallHistory(buildRequestMessages(state))",
    );
    // Both the streaming round and the non-stream fallback.
    const occurrences = BG_AGENT_SCRIPT.split("buildRequestMessages(state)").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("sanitizes every tool schema before it enters a request body", () => {
    expect(BG_AGENT_SCRIPT).toContain("parameters: sanitizeToolParameters(t.parameters)");
  });

  it("assistant tool-call messages use a string content (never null)", () => {
    expect(BG_AGENT_SCRIPT).toContain('content: result.content || ""');
  });

  it("carries the reasoning self-healing branch for DeepSeek-style providers", () => {
    expect(BG_AGENT_SCRIPT).toContain("state.replayReasoning = true");
  });

  it("repairs / short-circuits malformed tool-call arguments (PRD tool-error fix)", () => {
    // The repair + structured-error pipeline is present in the runner…
    expect(BG_AGENT_SCRIPT).toContain("const repairJsonArgs =");
    expect(BG_AGENT_SCRIPT).toContain("const parseToolArgsSafe =");
    expect(BG_AGENT_SCRIPT).toContain("const malformedArgsResult =");
    // …malformed calls are never executed…
    expect(BG_AGENT_SCRIPT).toContain("if (tc._malformed) {");
    // …and the replayed arguments are ALWAYS wire-safe JSON.
    expect(BG_AGENT_SCRIPT).toContain("arguments: wireSafeArgs(tc.function.arguments)");
  });
});

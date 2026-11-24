/**
 * composio_execute_tool degenerate-args regression (user report 2026-11-24:
 * "args must be an object matching the tool's inputSchema" on EVERY
 * composio api call).
 *
 * OpenAI-compatible gateways deliver the tool's `args` in four degenerate
 * shapes; the old hard guard rejected them all:
 *   1. DOUBLE-STRINGIFIED — args as a JSON string
 *   2. ALIAS KEY — arguments/parameters/params/input instead of args
 *   3. FLATTENED — the tool's fields at the TOP level of our own call
 *   4. MISSING — zero-field tools called with no args at all
 *
 * The fix (coerceComposioArgs) normalizes every one of them into the plain
 * object Composio expects. These tests drive the REGISTERED tool handler
 * end-to-end with a stubbed fetch so the exact user-facing error can never
 * regress.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTool } from "./registry";

// The handler resolves the vault-encrypted Composio key via the settings
// service — stub it before importing the tool module so every handler call
// sees a connected profile without IndexedDB/localStorage.
vi.mock("@/lib/composio/browser", () => ({
  resolveComposioHeaders: async () => ({
    "x-composio-key": "test-key",
    "x-composio-user": "u1",
    "x-composio-session": "s-test",
  }),
  persistComposioSessionId: async () => undefined,
}));
vi.mock("@/lib/composio/branding", () => ({
  recordToolToolkits: () => undefined,
}));

import { coerceComposioArgs } from "./composio_tools";
import "./index"; // side-effect: registers all built-ins

// ── pure coercion unit tests ─────────────────────────────────────────────

describe("coerceComposioArgs — degenerate arg shapes", () => {
  it("passes a plain object through (merged, no mutation)", () => {
    const out = coerceComposioArgs({ channel: "C1", text: "hi" });
    expect(out).toEqual({ channel: "C1", text: "hi" });
  });

  it("(1) parses a double-stringified JSON args string", () => {
    const out = coerceComposioArgs('{"channel":"C123","text":"hello"}');
    expect(out).toEqual({ channel: "C123", text: "hello" });
  });

  it("(2) accepts the arguments/parameters/params/input alias keys", () => {
    expect(coerceComposioArgs({ arguments: { channel: "C1" } })).toEqual({ channel: "C1" });
    expect(coerceComposioArgs({ parameters: { channel: "C2" } })).toEqual({ channel: "C2" });
    expect(coerceComposioArgs({ params: { channel: "C3" } })).toEqual({ channel: "C3" });
    expect(coerceComposioArgs({ input: { channel: "C4" } })).toEqual({ channel: "C4" });
  });

  it("(2b) parses a JSON string INSIDE an alias key", () => {
    const out = coerceComposioArgs({ arguments: '{"channel":"C9"}' });
    expect(out).toEqual({ channel: "C9" });
  });

  it("(3) accepts the tool's fields flattened to the top level (extras)", () => {
    const out = coerceComposioArgs(undefined, { channel: "C7", text: "yo" });
    expect(out).toEqual({ channel: "C7", text: "yo" });
  });

  it("(4) missing/null args → {} (zero-field inputSchema tools)", () => {
    expect(coerceComposioArgs(undefined)).toEqual({});
    expect(coerceComposioArgs(null)).toEqual({});
    expect(coerceComposioArgs("")).toEqual({});
  });

  it("merges extras into string/alias/missing shapes (flattened call)", () => {
    const out = coerceComposioArgs('{"text":"hi"}', { channel: "C8" });
    expect(out).toEqual({ channel: "C8", text: "hi" });
  });

  it("rejects garbage: unparseable strings and arrays → null", () => {
    expect(coerceComposioArgs("not json at all {")).toBeNull();
    expect(coerceComposioArgs("[1,2,3]")).toBeNull();
    expect(coerceComposioArgs(42)).toBeNull();
  });
});

// ── end-to-end handler tests (registered tool + stubbed fetch) ───────────

describe("composio_execute_tool — the user-reported error is gone", () => {
  const ctx = { userId: "u1" } as never;

  let calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  beforeEach(() => {
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { body?: string }) => {
        calls.push({
          url: String(url),
          body: JSON.parse(init?.body ?? "{}") as Record<string, unknown>,
        });
        return new Response(JSON.stringify({ ok: true, sessionId: "s1", data: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const executeTool = getTool("composio_execute_tool");

  it("is registered", () => {
    expect(executeTool).toBeTruthy();
  });

  it("(1) STRING args execute — the exact reported error never fires", async () => {
    const r = await executeTool!.handler(
      { toolName: "SLACK_SEND_MESSAGE", args: '{"channel":"C123","text":"hello"}' } as never,
      ctx,
    );
    // The reported failure was {success:false, error:"args must be an object…"}.
    expect(r.success).toBe(true);
    expect((r as { error?: string }).error).toBeUndefined();
    expect(calls.length).toBeGreaterThan(0);
    const exec = calls.find((c) => c.url.includes("/api/composio/tools/execute"));
    expect(exec?.body.args).toEqual({ channel: "C123", text: "hello" });
  });

  it("(2) ALIAS arguments key executes with the inner object", async () => {
    const r = await executeTool!.handler(
      { toolName: "GITHUB_CREATE_ISSUE", arguments: { owner: "o", repo: "r" } } as never,
      ctx,
    );
    expect(r.success).toBe(true);
    const exec = calls.find((c) => c.url.includes("/api/composio/tools/execute"));
    expect(exec?.body.args).toEqual({ owner: "o", repo: "r" });
  });

  it("(3) FLATTENED fields (no args key at all) execute", async () => {
    const r = await executeTool!.handler(
      { toolName: "NOTION_CREATE_PAGE", parent: "pg1", title: "Notes" } as never,
      ctx,
    );
    expect(r.success).toBe(true);
    const exec = calls.find((c) => c.url.includes("/api/composio/tools/execute"));
    expect(exec?.body.args).toEqual({ parent: "pg1", title: "Notes" });
  });

  it("(4) MISSING args (zero-field tool) executes with {}", async () => {
    const r = await executeTool!.handler({ toolName: "SPOTIFY_GET_ME" } as never, ctx);
    expect(r.success).toBe(true);
    const exec = calls.find((c) => c.url.includes("/api/composio/tools/execute"));
    expect(exec?.body.args).toEqual({});
  });

  it("still rejects genuinely unparseable args with a clear error", async () => {
    const r = await executeTool!.handler(
      { toolName: "SLACK_SEND_MESSAGE", args: "definitely not json {" } as never,
      ctx,
    );
    expect(r.success).toBe(false);
    expect((r as { error?: string }).error).toMatch(/inputSchema/i);
  });
});

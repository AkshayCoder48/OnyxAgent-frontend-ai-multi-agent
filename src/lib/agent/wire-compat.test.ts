// @vitest-environment jsdom
/**
 * Wire-compat persistence TTL + buildWireMessages encoding (tool-reliability
 * Part B).
 *
 * 1. Persisted strict-gateway downgrades (toolText / system compact /
 *    dropped) now expire after 7 days — the old permanent persistence left
 *    providers with a neutral 2-line system prompt forever, which read to
 *    the model as "no tool instructions" (the "almost never calls tools"
 *    symptom).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  beginTurnWireCompat,
  buildWireMessages,
  getWireCompat,
  nextStrictGatewayStep,
  resetWireCompatForTests,
  type WireMessage,
} from "./wire-compat";

// ---------------------------------------------------------------------------
// wire-compat persistence TTL
// ---------------------------------------------------------------------------

describe("wire-compat persisted downgrades expire (TTL)", () => {
  beforeEach(() => {
    // The module-level learned-modes Map serves from memory once hydrated —
    // reset it so each case tests the localStorage state IT wrote, not the
    // previous case's hydrated mode.
    resetWireCompatForTests();
    localStorage.clear();
  });
  afterEach(() => {
    resetWireCompatForTests();
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

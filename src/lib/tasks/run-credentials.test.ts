// Unit tests for the BYOK credential policy (run-credentials.ts).
//
// USER DIRECTIVE: background runs use the USER's own credentials — the
// app's keyless LLM bridge fallback was removed. These tests pin the
// policy: no gateway → actionable failure; legacy pin → migration hint;
// task token never becomes an LLM bearer; bridge URLs are rejected.
import { describe, expect, it } from "vitest";
import {
  isAbsoluteHttpUrl,
  isAppBridgeUrl,
  NO_PROVIDER_CREDENTIALS_ERROR,
  resolveRunLlmCredentials,
  RETIRED_ENDPOINT_PIN_ERROR,
} from "./run-credentials";

describe("resolveRunLlmCredentials (BYOK policy)", () => {
  it("agent_run without a gateway fails with the actionable BYOK error", () => {
    const res = resolveRunLlmCredentials({ type: "agent_run", chatUrl: undefined, keyPool: ["sk-1"] });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe(NO_PROVIDER_CREDENTIALS_ERROR);
      expect(res.error).toContain("Settings");
      expect(res.error).toContain("byok_no_gateway");
    }
  });

  it("agent_run with an empty/whitespace gateway fails the same way", () => {
    expect(resolveRunLlmCredentials({ type: "agent_run", chatUrl: "   ", keyPool: [] }).ok).toBe(false);
  });

  it("a relative or malformed gateway pin is treated as no gateway", () => {
    expect(resolveRunLlmCredentials({ type: "agent_run", chatUrl: "/v1/chat", keyPool: ["k"] }).ok).toBe(false);
    expect(resolveRunLlmCredentials({ type: "agent_run", chatUrl: "ftp://x/y", keyPool: ["k"] }).ok).toBe(false);
  });

  it("a gateway pinned on the retired Classic endpoint fails with the migration hint", () => {
    const res = resolveRunLlmCredentials({
      type: "agent_run",
      chatUrl: "https://text.pollinations.ai/openai",
      keyPool: ["k"],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe(RETIRED_ENDPOINT_PIN_ERROR);
  });

  it("a valid user gateway resolves with the first pool key as bearer", () => {
    const res = resolveRunLlmCredentials({
      type: "agent_run",
      chatUrl: "https://gen.pollinations.ai/v1/chat/completions",
      keyPool: ["sk-first", "sk-second"],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.credentials.chatUrl).toBe("https://gen.pollinations.ai/v1/chat/completions");
      expect(res.credentials.chatToken).toBe("sk-first");
      expect(res.credentials.keyPool).toEqual(["sk-first", "sk-second"]);
    }
  });

  it("a keyless gateway (empty pool) resolves with an empty bearer — no token substitution", () => {
    const res = resolveRunLlmCredentials({
      type: "agent_run",
      chatUrl: "http://localhost:11434/v1/chat/completions",
      keyPool: [],
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.credentials.chatToken).toBe("");
  });

  it("falsy/garbage pool entries are dropped without failing the run", () => {
    const res = resolveRunLlmCredentials({
      type: "agent_run",
      chatUrl: "https://api.example.com/v1/chat/completions",
      keyPool: ["  ", "", "sk-real"] as unknown as string[],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.credentials.keyPool).toEqual(["sk-real"]);
      expect(res.credentials.chatToken).toBe("sk-real");
    }
  });

  it("terminal_command runs need no LLM credentials at all", () => {
    const res = resolveRunLlmCredentials({ type: "terminal_command", chatUrl: undefined, keyPool: [] });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.credentials.chatUrl).toBe("");
      expect(res.credentials.chatToken).toBe("");
      expect(res.credentials.keyPool).toEqual([]);
    }
  });
});

describe("isAppBridgeUrl", () => {
  it("recognizes the removed app bridge route on any origin", () => {
    expect(isAppBridgeUrl("https://my-app.example.com/api/tasks/llm")).toBe(true);
    expect(isAppBridgeUrl("http://localhost:3000/api/tasks/llm/")).toBe(true);
  });

  it("passes ordinary provider gateways through", () => {
    expect(isAppBridgeUrl("https://api.openai.com/v1/chat/completions")).toBe(false);
    expect(isAppBridgeUrl("https://my-app.example.com/api/tasks/status")).toBe(false);
    expect(isAppBridgeUrl("not-a-url")).toBe(false);
  });
});

describe("isAbsoluteHttpUrl", () => {
  it("accepts only absolute http(s) URLs", () => {
    expect(isAbsoluteHttpUrl("https://x.example.com/y")).toBe(true);
    expect(isAbsoluteHttpUrl("http://x.example.com/y")).toBe(true);
    expect(isAbsoluteHttpUrl("/relative/path")).toBe(false);
    expect(isAbsoluteHttpUrl("example.com")).toBe(false);
    expect(isAbsoluteHttpUrl("")).toBe(false);
    expect(isAbsoluteHttpUrl(undefined)).toBe(false);
  });
});

/**
 * ANTI-HALLUCINATION TOOL-CALL NORMALIZER — regression tests pinning the
 * correction rules from the user report (2026-10-19): the model repeatedly
 * called the invented tool `media_generation.operation` and other
 * name-predicted fake tools.
 *
 * Pure unit tests with a mock registry — no client-tool side effects.
 */
import { describe, expect, it } from "vitest";
import {
  normalizeToolCall,
  suggestToolCalls,
  unknownToolResult,
  type ToolLookupTarget,
} from "./tool-call-normalize";

const mediaGen: ToolLookupTarget = {
  name: "media_generation",
  parameters: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["list_models", "generate_image", "generate_video", "generate_audio", "get_model_details"],
      },
    },
    required: ["operation"],
  },
};

const manageSkill: ToolLookupTarget = {
  name: "manage_skill",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "read", "create", "edit", "delete"] },
    },
    required: ["action"],
  },
};

const webSearch: ToolLookupTarget = {
  name: "web_search",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};

const registry: ToolLookupTarget[] = [mediaGen, manageSkill, webSearch];

const lookup = (n: string): ToolLookupTarget | undefined =>
  registry.find((t) => t.name === n);

describe("normalizeToolCall", () => {
  it("passes registered names through untouched", () => {
    const nc = normalizeToolCall("web_search", { query: "hi" }, lookup);
    expect(nc.name).toBe("web_search");
    expect(nc.args).toEqual({ query: "hi" });
    expect(nc.correctedFrom).toBeUndefined();
  });

  it("rewrites a dotted subtool to the real tool + operation argument (the reported bug)", () => {
    const nc = normalizeToolCall(
      "media_generation.generate_image",
      { prompt: "a cat" },
      lookup,
    );
    expect(nc.name).toBe("media_generation");
    expect(nc.correctedFrom).toBe("media_generation.generate_image");
    expect(nc.args).toEqual({ prompt: "a cat", operation: "generate_image" });
    expect(nc.correctionNote).toContain('operation="generate_image"');
  });

  it("routes the literal reported name media_generation.operation to the tool (param-name suffix)", () => {
    const nc = normalizeToolCall("media_generation.operation", { prompt: "a cat" }, lookup);
    expect(nc.name).toBe("media_generation");
    expect(nc.correctedFrom).toBe("media_generation.operation");
    // Args kept as-is — the tool's own validation lists the valid operations.
    expect(nc.args).toEqual({ prompt: "a cat" });
  });

  it("rewrites action-style dotted names (manage_skill.list)", () => {
    const nc = normalizeToolCall("manage_skill.list", {}, lookup);
    expect(nc.name).toBe("manage_skill");
    expect(nc.args).toEqual({ action: "list" });
    expect(nc.correctedFrom).toBe("manage_skill.list");
  });

  it("strips legacy namespace prefixes (functions.web_search)", () => {
    const nc = normalizeToolCall("functions.web_search", { query: "q" }, lookup);
    expect(nc.name).toBe("web_search");
    expect(nc.correctedFrom).toBe("functions.web_search");
  });

  it("prefers the longest registered prefix for multi-dot names", () => {
    const nc = normalizeToolCall(
      "functions.media_generation.generate_image",
      {},
      lookup,
    );
    expect(nc.name).toBe("media_generation");
    expect(nc.args).toEqual({ operation: "generate_image" });
  });

  it("never overwrites a valid operation that already arrived in the args", () => {
    const nc = normalizeToolCall(
      "media_generation.some_garbage",
      { operation: "list_models" },
      lookup,
    );
    expect(nc.name).toBe("media_generation");
    // keep the valid arg value over the invalid suffix
    expect(nc.args.operation).toBe("list_models");
  });

  it("keeps an invalid dotted suffix routable (tool lists its valid operations)", () => {
    const nc = normalizeToolCall("media_generation.nonsense", {}, lookup);
    expect(nc.name).toBe("media_generation");
    expect(nc.args).toEqual({ operation: "nonsense" });
  });

  it("returns uncorrectable names unchanged", () => {
    const nc = normalizeToolCall("totally_fake_tool", { a: 1 }, lookup);
    expect(nc.name).toBe("totally_fake_tool");
    expect(nc.args).toEqual({ a: 1 });
    expect(nc.correctedFrom).toBeUndefined();
  });

  it("handles non-object args defensively", () => {
    const nc = normalizeToolCall("media_generation.generate_image", "junk", lookup);
    expect(nc.name).toBe("media_generation");
    expect(nc.args).toEqual({ operation: "generate_image" });
  });
});

describe("suggestToolCalls", () => {
  it("maps a called subtool VALUE to its owning multi-function tool", () => {
    const sug = suggestToolCalls("generate_image", registry);
    expect(sug[0]).toMatchObject({ name: "media_generation", viaParam: "operation" });
  });

  it("suggests the owning tool for a dotted hallucination prefix", () => {
    const sug = suggestToolCalls("media_generation.operation", registry);
    expect(sug.map((s) => s.name)).toContain("media_generation");
  });

  it("fuzzy-suggests close names (manage_skills → manage_skill)", () => {
    const sug = suggestToolCalls("manage_skills", registry);
    expect(sug.map((s) => s.name)).toContain("manage_skill");
  });

  it("returns no suggestion for totally unrelated names", () => {
    expect(suggestToolCalls("zzzzqqqq", registry)).toEqual([]);
  });
});

describe("unknownToolResult", () => {
  it("builds a corrective payload with suggestions + the never-invent rule", () => {
    const res = unknownToolResult("media_generation.operation", registry);
    expect(res.error).toContain("media_generation.operation");
    expect(res.error).toContain("NEVER invent");
    expect(res.did_you_mean).toContain("media_generation");
    expect(res.name_rule).toContain("never contain dots");
    expect(res.next_step).toContain("analyze_workspace");
    // The dotted name is NOT a valid operation value — the how_to_call
    // example must NOT embed it as the argument value (regression: it
    // previously produced {"operation":"media_generation.operation"}).
    expect(res.how_to_call).toBeUndefined();
  });

  it("includes an exact how_to_call example when the name is a subtool value", () => {
    const res = unknownToolResult("generate_image", registry);
    const how = String(res.how_to_call);
    expect(how).toContain("media_generation");
    expect(how).toContain("operation");
    expect(how).toContain("generate_image");
    expect(how).toContain("ARGUMENT");
  });

  it("tells the model not to retry the invented name", () => {
    const res = unknownToolResult("fake_tool_xyz", registry);
    expect(res.fix).toContain("Do not retry 'fake_tool_xyz'");
  });
});

/**
 * Intent-based request-scoped tool exposure (tool-reliability Part B).
 *
 * The registry's ~64-tool wire payload (~20k tokens) crushed small-context
 * models and degrades tool-selection accuracy everywhere. filterToolsForRequest
 * now ships a CORE (or ESSENTIAL on small models) surface + intent-matched
 * tools + a history latch + dynamic (custom/MCP) pass-through.
 *
 * UMBRELLA ERA: the granular tools are folded into 12 action-based umbrella
 * tools + standalone keepers (~21 model-visible built-ins). listTools()
 * returns UMBRELLA names — the granular names (web_search, run_python,
 * composio_execute_tool, …) are hidden and dispatch through their umbrella's
 * `action` parameter. These tests speak umbrella names.
 */
import { describe, expect, it } from "vitest";
import {
  ESSENTIAL_TOOLS,
  CORE_TOOLS,
  DISCOVERY_TOOLS,
  filterToolsForRequest,
  priorToolUseAnnotation,
  usedToolNamesFromHistory,
} from "./request-scoping";
import { ONYX_MD_DIGEST_TOOLS } from "@/lib/agent/onyx-md-digest";
import { listTools } from "./registry";
import "./index"; // side-effect: registers all built-ins

const nameOf = (tools: ReturnType<typeof listTools>) => tools.map((t) => t.name);

function fakeTool(name: string) {
  return {
    name,
    description: `fake ${name}`,
    parameters: { type: "object", properties: {} },
    handler: async () => ({}),
  } as const;
}

describe("filterToolsForRequest — surfaces", () => {
  it("passes everything through when no scope is given (back-compat)", () => {
    const all = listTools();
    expect(filterToolsForRequest(all).length).toBe(all.length);
  });

  it("normal-context models get the CORE surface even with no user text", () => {
    const got = new Set(nameOf(filterToolsForRequest(listTools(), {
      lastUserText: "",
      modelContextWindow: 128_000,
    })));
    // Every CORE tool is present.
    for (const n of CORE_TOOLS) expect(got.has(n)).toBe(true);
    // CAPABILITY DISCOVERY (user report 2026-10-21: "the AI never uses
    // skills / connectors / composio unless told"): the discovery meta-tools
    // ride on EVERY turn — the agent must be able to look for connected
    // integrations without the user naming them.
    for (const n of DISCOVERY_TOOLS) expect(got.has(n)).toBe(true);
    // CORE extras (chats / schedule / subagents / custom_tools /
    // counterfactual / workflow) ship on every NORMAL-context turn — they
    // are only intent-gated on small models.
    expect(got.has("workflow")).toBe(true);
    // Hidden granular names never leak into the wire list — they dispatch
    // through their umbrella (manage_env_var → workspace).
    expect(got.has("manage_env_var")).toBe(false);
    expect(got.has("web_search")).toBe(false);
  });

  it("small-context models (<128K incl. the 32K safe-fallback) get ESSENTIAL only", () => {
    const got = new Set(nameOf(filterToolsForRequest(listTools(), {
      lastUserText: "hello there",
      modelContextWindow: 32_000,
    })));
    for (const n of ESSENTIAL_TOOLS) expect(got.has(n)).toBe(true);
    // Discovery ships even on small models — autonomy is not a luxury.
    for (const n of DISCOVERY_TOOLS) expect(got.has(n)).toBe(true);
    // CORE extras are scoped out on small models without intent…
    expect(got.has("image_search")).toBe(false); // hidden granular (web umbrella action)
    expect(got.has("spawn_subagent")).toBe(false); // hidden granular (subagents umbrella action)
    expect(got.has("delete_file")).toBe(false); // hidden granular (files umbrella action)
    expect(got.has("subagents")).toBe(false); // CORE EXTRA umbrella — no intent in "hello there"
    expect(got.has("workflow")).toBe(false); // CORE EXTRA — intent-gated on small models
    // …while ESSENTIAL tools stay.
    expect(got.has("use_browser")).toBe(true);
    expect(got.has("web")).toBe(true); // the umbrella carrying web_search/image_search/video_search/web_fetch
    expect(got.has("code_exec")).toBe(true); // the umbrella carrying run_python/run_terminal
    expect(got.has("decision")).toBe(true); // first-class ESSENTIAL capability
  });
});

describe("filterToolsForRequest — intent routing", () => {
  it("integration intent keeps the composio suite reachable (integrations umbrella)", () => {
    const got = new Set(nameOf(filterToolsForRequest(listTools(), {
      lastUserText: "send a slack message via composio",
      modelContextWindow: 32_000, // small model — the tightest surface
    })));
    // composio_search_tools / composio_execute_tool dispatch through the
    // integrations umbrella (also always-on via DISCOVERY).
    expect(got.has("integrations")).toBe(true);
    // The granular names stay hidden from the wire list.
    expect(got.has("composio_execute_tool")).toBe(false);
  });

  it("browser/search intents keep the research surface", () => {
    const got = new Set(nameOf(filterToolsForRequest(listTools(), {
      lastUserText: "open example.com and click the login button",
      modelContextWindow: 32_000,
    })));
    expect(got.has("use_browser")).toBe(true);
    expect(got.has("web")).toBe(true); // web_fetch rides as the umbrella's action
  });

  it("subagent intent pulls the orchestration suite in on small models", () => {
    const got = new Set(nameOf(filterToolsForRequest(listTools(), {
      lastUserText: "delegate this to a subagent",
      modelContextWindow: 32_000,
    })));
    // spawn_subagent / query_subagent dispatch through the subagents
    // umbrella — a CORE EXTRA that only rides small-model turns via intent.
    expect(got.has("subagents")).toBe(true);
    expect(got.has("spawn_subagent")).toBe(false); // granular stays hidden
  });

  it("generic name-word matching catches uncategorized mentions", () => {
    const got = new Set(nameOf(filterToolsForRequest(listTools(), {
      lastUserText: "run the counterfactual analysis",
      modelContextWindow: 32_000, // small model — counterfactual is CORE EXTRA, so ONLY the name-word match ships it
    })));
    expect(got.has("counterfactual")).toBe(true);
  });
});

describe("filterToolsForRequest — latches & dynamic pass-through", () => {
  it("tools used earlier in the conversation are never scoped out", () => {
    const got = new Set(nameOf(filterToolsForRequest(listTools(), {
      lastUserText: "hello",
      usedToolNames: ["workflow", "subagents"],
      modelContextWindow: 32_000,
    })));
    // Both are CORE EXTRAS with no intent signal in "hello" — they ride
    // ONLY because the conversation already used them (the latch).
    expect(got.has("workflow")).toBe(true);
    expect(got.has("subagents")).toBe(true);
  });

  it("dynamic (non-digest) tools always ship — custom tools and MCP meta-tools", () => {
    const registry = [...listTools(), fakeTool("my_custom_translate")];
    const got = new Set(nameOf(filterToolsForRequest(registry, {
      lastUserText: "hello",
      modelContextWindow: 32_000,
    })));
    expect(got.has("my_custom_translate")).toBe(true);
  });

  it("preserves registration order", () => {
    const scoped = filterToolsForRequest(listTools(), { lastUserText: "" });
    const allNames = nameOf(listTools());
    const scopedNames = scoped.map((t) => t.name);
    // Every scoped tool is a real registered tool (no fabricated entries)…
    for (const n of scopedNames) {
      expect(allNames).toContain(n);
    }
    // …and the scoped list keeps the registry's registration order (the
    // digest in the system prompt and the wire tools array line up).
    const orderIdx = scopedNames.map((n) => allNames.indexOf(n));
    for (let i = 1; i < orderIdx.length; i++) {
      expect(orderIdx[i]!).toBeGreaterThan(orderIdx[i - 1]!);
    }
  });

  it("CORE + ESSENTIAL sets are subsets of the registered built-ins", () => {
    const registered = new Set(ONYX_MD_DIGEST_TOOLS);
    for (const n of CORE_TOOLS) expect(registered.has(n)).toBe(true);
    for (const n of ESSENTIAL_TOOLS) expect(registered.has(n)).toBe(true);
  });
});

describe("usedToolNamesFromHistory", () => {
  it("collects tool names from Dexie-style tool_calls rows", () => {
    const names = usedToolNamesFromHistory([
      { tool_calls: [{ tool_name: "web_search" }, { name: "run_python" }] },
      { tool_calls: null },
      { role: "user", content: "hi" },
    ] as Parameters<typeof usedToolNamesFromHistory>[0]);
    expect(Array.from(names).sort()).toEqual(["run_python", "web_search"]);
  });
});

describe("priorToolUseAnnotation", () => {
  it("renders a compact deduped one-liner", () => {
    expect(priorToolUseAnnotation(["web_search", "use_browser", "web_search"]))
      .toBe("[Used tools: web_search, use_browser]");
  });

  it("is empty when no tools were used", () => {
    expect(priorToolUseAnnotation([])).toBe("");
    expect(priorToolUseAnnotation([undefined, null])).toBe("");
  });
});

// @vitest-environment jsdom
/**
 * Subagent orchestration-tool regressions — TWO user crash reports:
 *
 * 1. query_subagent {task_id} only → DELIVERY_FAILED: Cannot read properties
 *    of undefined (reading 'slice') — message=undefined reached
 *    startSubagentTurn and died on userMessage.slice(0,40).
 * 2. spawn_subagent {role, task, disposable:"True"} → Cannot read properties
 *    of undefined (reading 'toLowerCase') — no subagent_name sent; the
 *    handler died on subagentName.toLowerCase(). Also "True"/"False" strings
 *    for the boolean disposable ("False" would truthy-dispose an agent).
 *
 * Fix layers, each pinned here:
 *   - spawn_subagent argument normalization: aliases (task→description,
 *     subagent_name←name←agent_name←role-as-fallback), coerceBool for
 *     string booleans, task_type enum guard, fallback name.
 *   - query_subagent: bare {task_id} = STATUS CHECK; message aliases
 *     (task/instruction/instructions); new-task mode requires message.
 *   - startSubagentTurn: honest throw on empty/undefined message.
 *   - Umbrella dispatch (consolidated.ts): enforces the target tool's
 *     schema.required before the handler runs.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { getTool } from "./registry";

// The subagent runtime resolves sandbox keys via the settings service and
// the auth store — stub both so the module graph loads without IndexedDB.
vi.mock("@/lib/services", () => ({
  settingsService: {
    getDecryptedSandboxKey: async () => null,
    getDecryptedEnvVars: async () => ({}),
    get: async () => null,
  },
  aiProviderService: {},
}));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: { getState: () => ({ user: null }) },
}));

import "./index"; // side-effect: registers all built-ins incl. umbrellas

beforeEach(() => {
  window.localStorage.clear();
});

describe("spawn_subagent — the toLowerCase crash (report #2)", () => {
  const spawn = getTool("spawn_subagent");
  it("is registered", () => expect(spawn).toBeTruthy());

  it("(the exact report) {role, task, disposable:'True'} no longer crashes", async () => {
    const r = (await spawn!.handler(
      {
        role: "Demo Agent",
        task: "Create an impressive demo web application that showcases interactive capabilities. The demo should be fun and interactive, possibly featuring:\n- Interactive elements (clicks, animations, user input)\n- Visual appeal with colors and motion\n- Something that demonstrates the subagent's ability to create web content\n- Could be a game, visualization, or interactive art piece\n\nMake it disposable (auto-removed after completion) and create it as an HTML file in the workspace. The demo should be something the user can open in a browser and interact with.",
        disposable: "True",
      },
      { userId: "u1" } as never,
    )) as Record<string, unknown>;
    expect(r.error).toBeUndefined();
    expect(r.task_id).toMatch(/^subagent_/);
    // The role doubles as the name (no subagent_name in the payload).
    expect(r.subagent_name).toBe("Demo Agent");
    // String "True" coerced to a REAL true (and "False" would be false).
    expect(r.disposable).toBe(true);
  });

  it("'disposable': 'False' (string) coerces to FALSE — never a truthy-string dispose", async () => {
    const r = (await spawn!.handler(
      { subagent_name: "PersistentProbe", description: "x", disposable: "False" },
      { userId: "u1" } as never,
    )) as Record<string, unknown>;
    expect(r.disposable).toBe(false);
  });

  it("empty payload → fallback name, no crash", async () => {
    const r = (await spawn!.handler({}, { userId: "u1" } as never)) as Record<string, unknown>;
    expect(r.error).toBeUndefined();
    expect(typeof r.subagent_name).toBe("string");
    expect((r.subagent_name as string).length).toBeGreaterThan(0);
  });

  it("schema-typed booleans keep working (disposable: true)", async () => {
    const r = (await spawn!.handler(
      { subagent_name: "BoolProbe", description: "x", disposable: true },
      { userId: "u1" } as never,
    )) as Record<string, unknown>;
    expect(r.disposable).toBe(true);
  });

  it("unknown task_type falls back to 'general' instead of poisoning the config", async () => {
    const r = (await spawn!.handler(
      { subagent_name: "TypeProbe", description: "x", task_type: "vibes" },
      { userId: "u1" } as never,
    )) as Record<string, unknown>;
    expect(r.error).toBeUndefined();
  });
});

describe("query_subagent — the DELIVERY_FAILED slice crash (report #1)", () => {
  const query = getTool("query_subagent");
  it("is registered", () => expect(query).toBeTruthy());

  it("(the exact report) bare {task_id} becomes a STATUS CHECK, never a delivery", async () => {
    const spawn = getTool("spawn_subagent")!;
    const spawned = (await spawn.handler(
      { subagent_name: "Researcher", description: "research composio", task_type: "research" },
      { userId: "u1" } as never,
    )) as { task_id?: string };
    expect(spawned?.task_id).toBeTruthy();

    const r = (await query!.handler(
      { task_id: spawned.task_id },
      { userId: "u1" } as never,
    )) as Record<string, unknown>;
    expect(r.error).toBeUndefined();
    expect(r.status_check).toBe(true);
    expect(r.task_id).toBe(spawned.task_id);
    expect(typeof r.task_status).toBe("string");
    expect((r.note as string).toLowerCase()).toContain("status");
  });

  it("no task_id AND no message → actionable error", async () => {
    const r = (await query!.handler({}, { userId: "u1" } as never)) as Record<string, unknown>;
    expect(r.error).toMatch(/message is required/i);
    expect(r.fix).toMatch(/task_id/i);
  });

  it("unknown task_id status-check → honest not-found", async () => {
    const r = (await query!.handler(
      { task_id: "subagent_NOPE" },
      { userId: "u1" } as never,
    )) as Record<string, unknown>;
    expect(r.error).toMatch(/not found/i);
  });

  it("message under the alias 'task' starts a new task", async () => {
    const r = (await query!.handler(
      { task: "Summarize the repo README", subagent_name: "AliasProbe" },
      { userId: "u1" } as never,
    )) as Record<string, unknown>;
    expect(r.error).toBeUndefined();
    expect(r.status).toBe("sent");
    expect(r.task_id).toMatch(/^subagent_/);
  });
});

describe("startSubagentTurn — delivery guard", () => {
  it("rejects an empty/undefined message honestly instead of `undefined.slice`", async () => {
    const { startSubagentTurn } = await import("@/lib/agent/subagent-runtime");
    const spawn = getTool("spawn_subagent")!;
    await spawn.handler(
      { subagent_name: "GuardProbe", description: "x" },
      { userId: "u1" } as never,
    );
    const { useSubagentStore } = await import("@/stores/subagent-store");
    const target = useSubagentStore.getState().subagents[0];
    expect(target).toBeTruthy();
    expect(() => startSubagentTurn(target.id, undefined as unknown as string)).toThrow(
      /No message provided/,
    );
    expect(() => startSubagentTurn(target.id, "")).toThrow(/No message provided/);
    expect(() => startSubagentTurn(target.id, "   ")).toThrow(/No message provided/);
  });

  it("unknown subagent still fails fast with the honest not-found error", async () => {
    const { startSubagentTurn } = await import("@/lib/agent/subagent-runtime");
    expect(() => startSubagentTurn("sa_does_not_exist", "hi")).toThrow(/not found/i);
  });
});

describe("set_subagent_config — name guard", () => {
  it("missing subagent_name → actionable error, not undefined.toLowerCase", async () => {
    const tool = getTool("set_subagent_config")!;
    const r = (await tool.handler(
      { model: "gpt-4o" },
      { userId: "u1" } as never,
    )) as Record<string, unknown>;
    expect(r.error).toMatch(/subagent_name is required/i);
  });
});

describe("steer_subagent — empty-message guard", () => {
  it("missing message → actionable error, never pushes undefined into the log", async () => {
    const steer = getTool("steer_subagent")!;
    const r = (await steer.handler(
      { task_id: "subagent_XDNTSH" },
      { userId: "u1" } as never,
    )) as Record<string, unknown>;
    expect(r.error).toMatch(/message is required/i);
  });
});

describe("umbrella dispatch — required-field pre-validation (the 'all tools erroring' family)", () => {
  const subagents = getTool("subagents");

  it("subagents umbrella is registered", () => expect(subagents).toBeTruthy());

  it("missing required fields are caught BEFORE the handler", async () => {
    const r = (await subagents!.handler(
      { action: "steer_subagent" },
      { userId: "u1" } as never,
    )) as Record<string, unknown>;
    expect(r.error).toMatch(/Missing required field/i);
    expect(r.fix).toMatch(/task_id/);
  });

  it("fields sent alongside `action` pass validation and reach the handler", async () => {
    const r = (await subagents!.handler(
      { action: "complete_subagent", task_id: "subagent_NOPE", result: "done" },
      { userId: "u1" } as never,
    )) as Record<string, unknown>;
    expect(r.error).toMatch(/not found/i); // handler-level, NOT "Missing required"
  });

  it("spawn through the umbrella with the report's alias payload works end-to-end", async () => {
    const r = (await subagents!.handler(
      { action: "spawn_subagent", role: "Demo Agent", task: "build a demo", disposable: "True" },
      { userId: "u1" } as never,
    )) as Record<string, unknown>;
    expect(r.error).toBeUndefined();
    expect(r.task_id).toBeTruthy();
    expect(r.disposable).toBe(true);
  });
});

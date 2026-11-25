// @vitest-environment jsdom
/**
 * Subagent orchestration-tool regressions (user report 2026-11-25):
 *
 *   query_subagent called with ONLY {task_id} — the model polling a task —
 *   fell through to delivery with message=undefined and crashed inside
 *   startSubagentTurn on `userMessage.slice(0, 40)`, surfacing as
 *   DELIVERY_FAILED: Cannot read properties of undefined (reading 'slice').
 *
 * The fix is three layers, each pinned here:
 *   1. query_subagent {task_id} with no message → STATUS CHECK (no delivery).
 *   2. startSubagentTurn itself rejects empty/undefined messages honestly.
 *   3. The umbrella dispatch (consolidated.ts) pre-validates every target
 *      tool's `required` fields BEFORE the handler runs — the crash family
 *      ("all tools erroring" — any handler reading a missing field after
 *      `as string` casts) dies at the boundary with an actionable error.
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

// The runtime's provider resolution is exercised only via its own guard
// test below; import it lazily so the module graph stays mock-clean.
async function loadRuntime() {
  return import("@/lib/agent/subagent-runtime");
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("query_subagent — the DELIVERY_FAILED crash is gone", () => {
  const query = getTool("query_subagent");
  it("is registered", () => expect(query).toBeTruthy());

  it("(the exact report) bare {task_id} becomes a STATUS CHECK, never a delivery", async () => {
    // Seed a task the way spawn_subagent does, then poll it bare.
    const spawn = getTool("spawn_subagent")!;
    const spawned = (await spawn.handler(
      { subagent_name: "Researcher", description: "research composio", task_type: "research" },
      { userId: "u1" } as never,
    )) as { task_id?: string };
    expect(spawned?.task_id).toBeTruthy();

    // THE user payload: task_id ONLY, message absent.
    const r = (await query!.handler({ task_id: spawned.task_id }, { userId: "u1" } as never)) as Record<
      string,
      unknown
    >;
    // No crash, no DELIVERY_FAILED — a structured status payload.
    expect(r.error).toBeUndefined();
    expect(r.status_check).toBe(true);
    expect(r.task_id).toBe(spawned.task_id);
    expect(typeof r.task_status).toBe("string");
    expect((r.note as string).toLowerCase()).toContain("status");
  });

  it("no task_id AND no message → actionable error (message starts a new task)", async () => {
    const r = (await query!.handler({}, { userId: "u1" } as never)) as Record<string, unknown>;
    expect(r.error).toMatch(/message is required/i);
    expect(r.fix).toMatch(/task_id/i);
  });

  it("unknown task_id status-check → honest not-found (not a crash)", async () => {
    const r = (await query!.handler({ task_id: "subagent_NOPE" }, { userId: "u1" } as never)) as Record<
      string,
      unknown
    >;
    expect(r.error).toMatch(/not found/i);
  });
});

describe("startSubagentTurn — delivery guard", () => {
  it("rejects an undefined/empty message honestly instead of `undefined.slice`", async () => {
    const { startSubagentTurn } = await loadRuntime();
    // Seed a real subagent so the guard (not the not-found path) is what fires.
    const spawn = getTool("spawn_subagent")!;
    const spawned = (await spawn.handler(
      { subagent_name: "GuardProbe", description: "x", task_type: "research" },
      { userId: "u1" } as never,
    )) as { task_id?: string; subagent_id?: string };
    // spawn_subagent creates a config entry the runtime can resolve.
    const subagentId = (spawned as { subagent_id?: string }).subagent_id ?? "GuardProbe-config";
    void subagentId;
    // The exact crash precondition: undefined message (after target resolution).
    const store = (await import("@/stores/subagent-store")).useSubagentStore;
    const target = store.getState().subagents[0];
    expect(target).toBeTruthy();
    expect(() => startSubagentTurn(target.id, undefined as unknown as string)).toThrow(/No message provided/);
    expect(() => startSubagentTurn(target.id, "")).toThrow(/No message provided/);
    expect(() => startSubagentTurn(target.id, "   ")).toThrow(/No message provided/);
  });

  it("unknown subagent still fails fast with the honest not-found error", async () => {
    const { startSubagentTurn } = await loadRuntime();
    expect(() => startSubagentTurn("sa_does_not_exist", "hi")).toThrow(/not found/i);
  });
});

describe("steer_subagent — empty-message guard", () => {
  const steer = getTool("steer_subagent");
  it("is registered", () => expect(steer).toBeTruthy());

  it("missing message → actionable error, never pushes undefined into the log", async () => {
    const r = (await steer!.handler({ task_id: "subagent_XDNTSH" }, { userId: "u1" } as never)) as Record<
      string,
      unknown
    >;
    expect(r.error).toMatch(/message is required/i);
  });
});

describe("umbrella dispatch — required-field pre-validation (the 'all tools erroring' family)", () => {
  const subagents = getTool("subagents");

  it("subagents umbrella is registered", () => expect(subagents).toBeTruthy());

  it("missing required fields are caught BEFORE the handler (no undefined.slice anywhere)", async () => {
    // query_subagent requires `message` only in new-task mode… but steer_subagent
    // requires task_id+message; drive through the umbrella with an empty payload.
    const r = (await subagents!.handler(
      { action: "steer_subagent" },
      { userId: "u1" } as never,
    )) as Record<string, unknown>;
    expect(r.error).toMatch(/Missing required field/i);
    expect(r.fix).toMatch(/task_id/);
  });

  it("fields sent alongside `action` pass validation and reach the handler", async () => {
    // complete_subagent requires task_id+result — unknown id, but VALIDATED
    // shape: the handler's own honest not-found fires (not the validator).
    const r = (await subagents!.handler(
      { action: "complete_subagent", task_id: "subagent_NOPE", result: "done" },
      { userId: "u1" } as never,
    )) as Record<string, unknown>;
    expect(r.error).toMatch(/not found/i); // handler-level error, NOT "Missing required"
  });

  it("validation reads the target tool's schema — required list honored per action", async () => {
    // spawn_subagent requires nothing beyond optional fields → passes the
    // validator and reaches the handler (which creates a task).
    const r = (await subagents!.handler(
      { action: "spawn_subagent", subagent_name: "ValidatorProbe", description: "x", task_type: "research" },
      { userId: "u1" } as never,
    )) as Record<string, unknown>;
    expect(r.error).toBeUndefined();
    expect(r.task_id).toBeTruthy();
  });
});

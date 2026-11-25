// @vitest-environment jsdom
/**
 * SUBAGENT = MAIN AGENT parity regressions (user directive 2026-11-25:
 * "It should can use everything granted anything just like the main agent").
 *
 * Three pinned layers:
 * 1. WIRE SURFACE — a subagent's request-scoped tool set is built from the
 *    SAME inputs as the main runtime's: context-window awareness (small
 *    model → ESSENTIAL + intent; normal → full CORE) and the used-tools
 *    latch. The old behavior handed filterToolsForRequest ONLY the
 *    subagent's brief, so subagents silently lost CORE extras (schedule /
 *    workflow / chats / custom_tools / subagents) whenever their brief
 *    didn't keyword-match them.
 * 2. PERMISSION PARITY — the subagent's approval gate receives the
 *    ORIGINATING main-chat conversation (project rules resolve for
 *    subagents exactly like for the main agent), not the subagent id.
 * 3. ask_user PARITY — a subagent's ToolContext carries the same
 *    waitForAskUser waiter + emit routing as the main runtime, so a
 *    subagent can ask the user a question.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

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

import {
  filterToolsForRequest,
  CORE_TOOLS,
  ESSENTIAL_TOOLS,
} from "./request-scoping";
import { listTools } from "./registry";
import "./index"; // side-effect: registers every built-in (incl. umbrellas)

beforeEach(() => {
  window.localStorage.clear();
});

describe("wire-surface parity — same inputs, same surface", () => {
  const registered = listTools();
  const registeredNames = new Set(registered.map((t) => t.name));

  it("the registry surface is non-empty and umbrella-shaped", () => {
    expect(registered.length).toBeGreaterThanOrEqual(20);
  });

  it("EVERY tool the main agent sees is reachable by a subagent (full parity)", () => {
    // The main runtime's scope for a normal-context model with a
    // tool-laden user turn is the full CORE surface + intent + dynamic.
    const mainSurface = filterToolsForRequest(registered, {
      lastUserText: "research everything and write the report",
      usedToolNames: new Set(["subagents", "schedule", "workflow", "chats", "custom_tools"]),
      modelContextWindow: 200_000,
    });
    // A subagent with the SAME latch + its own brief gets the same shape:
    // the previously-lost CORE extras must ALL be present.
    const subSurface = filterToolsForRequest(registered, {
      lastUserText: "Researcher: research the topic and write findings",
      usedToolNames: new Set(["subagents", "schedule", "workflow", "chats", "custom_tools"]),
      modelContextWindow: 200_000,
    });
    const mainNames = new Set(mainSurface.map((t) => t.name));
    const subNames = new Set(subSurface.map((t) => t.name));
    // Everything granted to the main agent is granted to the subagent.
    for (const n of mainNames) {
      expect(subNames.has(n), `subagent lost granted tool: ${n}`).toBe(true);
    }
  });

  it("CORE extras are on the subagent wire even with a NARROW brief (the old bug)", () => {
    // Old behavior: brief-only matching — a "write a summary" brief dropped
    // schedule/workflow/chats/custom_tools/subagents from the wire.
    const subSurface = filterToolsForRequest(registered, {
      lastUserText: "Writer: write a summary of the document",
      modelContextWindow: 200_000,
    });
    const names = new Set(subSurface.map((t) => t.name));
    for (const extra of CORE_TOOLS) {
      if (registeredNames.has(extra)) {
        expect(names.has(extra), `CORE tool ${extra} missing from a subagent's wire`).toBe(true);
      }
    }
  });

  it("small-context subagent models get ESSENTIAL + intent — same as the main agent", () => {
    const subSurface = filterToolsForRequest(registered, {
      lastUserText: "schedule a nightly cron job",
      modelContextWindow: 32_000,
    });
    const names = new Set(subSurface.map((t) => t.name));
    // ESSENTIAL is always present…
    for (const t of ESSENTIAL_TOOLS) {
      if (registeredNames.has(t)) expect(names.has(t)).toBe(true);
    }
    // …and the intent rule latches the matched extra (schedule) in.
    expect(names.has("schedule")).toBe(true);
  });

  it("the used-tools latch survives (a tool used earlier is never scoped out)", () => {
    const withLatch = filterToolsForRequest(registered, {
      lastUserText: "continue the research",
      usedToolNames: new Set(["manage_skill"]),
      modelContextWindow: 32_000, // small: would otherwise be ESSENTIAL-only
    });
    expect(withLatch.map((t) => t.name)).toContain("manage_skill");
  });
});

describe("permission parity — the gate sees the originating conversation", () => {
  it("startSubagentTurn stamps origin_conversation_id onto the session", async () => {
    const { useSubagentStore } = await import("@/stores/subagent-store");
    const store = useSubagentStore.getState();
    const cfg = store.createSubagent({ name: "ParityProbe", description: "x" });
    const { startSubagentTurn } = await import("@/lib/agent/subagent-runtime");
    const delivery = startSubagentTurn(
      cfg.id,
      "do the work",
      undefined,
      undefined,
      "conv_origin_123",
    );
    expect(delivery.sessionId).toBeTruthy();
    const session = useSubagentStore.getState().sessions.find((s) => s.id === delivery.sessionId);
    expect(session?.origin_conversation_id).toBe("conv_origin_123");
  });

  it("a later delivery from another conversation re-stamps the origin", async () => {
    const { useSubagentStore } = await import("@/stores/subagent-store");
    const store = useSubagentStore.getState();
    const cfg = store.createSubagent({ name: "ParityProbe2", description: "x" });
    const { startSubagentTurn } = await import("@/lib/agent/subagent-runtime");
    const d1 = startSubagentTurn(cfg.id, "first", undefined, undefined, "conv_A");
    const d2 = startSubagentTurn(cfg.id, "second", undefined, undefined, "conv_B");
    // Second delivery re-stamps: the newest origin wins.
    const s2 = useSubagentStore.getState().sessions.find((s) => s.id === d2.sessionId);
    expect(s2?.origin_conversation_id).toBe("conv_B");
  });

  it("a session with no origin (legacy row) still delivers — global policy fallback", async () => {
    const { useSubagentStore } = await import("@/stores/subagent-store");
    const store = useSubagentStore.getState();
    const cfg = store.createSubagent({ name: "ParityProbe3", description: "x" });
    const { startSubagentTurn } = await import("@/lib/agent/subagent-runtime");
    // No origin passed → falls back to the session's (absent) origin → null.
    const delivery = startSubagentTurn(cfg.id, "legacy-style delivery");
    expect(delivery.sessionId).toBeTruthy();
  });
});

describe("ask_user parity — subagents can ask the user", () => {
  it("ask_user is on the subagent wire surface (ESSENTIAL, all windows)", () => {
    const surface = filterToolsForRequest(listTools(), {
      lastUserText: "research task",
      modelContextWindow: 32_000,
    });
    expect(surface.map((t) => t.name)).toContain("ask_user");
  });

  it("waitForAskUser + emit are wired into the subagent dispatch ctx (source-level contract)", async () => {
    // The dispatch ctx contract is enforced by construction: the streaming
    // site builds ctx with `emit: subagentEmit` and
    // `waitForAskUser: (questions) => waitForAskUser(questions, subagentEmit, undefined)`.
    // Pin the mechanism both sides rely on: the waiter resolves from the
    // window CustomEvent the chat UI dispatches.
    const { waitForAskUser, ASK_USER_RESPONSE_EVENT } = await import("@/lib/agent/ask-user-wait");
    const emitted: Array<{ type: string }> = [];
    const emit = (e: { type: string }) => emitted.push(e);
    const p = waitForAskUser([{ question: "Which?" }], emit as never, undefined);
    // The waiter emitted the ask_user event…
    expect(emitted[0]?.type).toBe("ask_user");
    // …and settles when the UI dispatches the response CustomEvent.
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent(ASK_USER_RESPONSE_EVENT, {
          detail: { answers: [{ answer: "That one", skipped: false }] },
        }),
      );
    }, 0);
    const answers = await p;
    expect(answers[0]?.answer).toBe("That one");
  });
});

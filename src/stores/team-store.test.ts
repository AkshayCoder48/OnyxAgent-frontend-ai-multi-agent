// @vitest-environment jsdom
/**
 * team-store — AGENT TEAMS roster + run ledger (2026-11-05). Real store
 * against jsdom localStorage (the same persistence contract as the
 * subagent store).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useTeamStore, type TeamConfig } from "./team-store";

function seedTeam(over: Partial<TeamConfig> = {}): TeamConfig {
  return useTeamStore.getState().createTeam({
    name: "Council",
    memberIds: ["m1", "m2", "m3"],
    ...over,
  });
}

beforeEach(() => {
  localStorage.clear();
  useTeamStore.setState({ teams: [], runs: [], activeRunId: null });
});

describe("roster management", () => {
  it("creates a team with deduped members", () => {
    const team = useTeamStore.getState().createTeam({
      name: "Duo",
      memberIds: ["a", "a", "b"],
    });
    expect(team.memberIds).toEqual(["a", "b"]);
    expect(useTeamStore.getState().teams).toHaveLength(1);
  });

  it("updateTeam patches + dedupes members", () => {
    const team = seedTeam();
    useTeamStore.getState().updateTeam(team.id, { memberIds: ["m1", "m1", "m9"], leadId: "m9" });
    const patched = useTeamStore.getState().teams[0]!;
    expect(patched.memberIds).toEqual(["m1", "m9"]);
    expect(patched.leadId).toBe("m9");
  });

  it("deleting a team cascades its runs + clears the active run", () => {
    const team = seedTeam();
    const run = useTeamStore.getState().startRun(team.id, "topic");
    expect(useTeamStore.getState().activeRunId).toBe(run.id);
    useTeamStore.getState().deleteTeam(team.id);
    expect(useTeamStore.getState().teams).toHaveLength(0);
    expect(useTeamStore.getState().runs).toHaveLength(0);
    expect(useTeamStore.getState().activeRunId).toBeNull();
  });
});

describe("the run ledger", () => {
  it("startRun appends round 1 with a pending slot per member", () => {
    const team = seedTeam();
    const run = useTeamStore.getState().startRun(team.id, "Should we ship?");
    expect(run.topic).toBe("Should we ship?");
    expect(run.rounds).toHaveLength(1);
    expect(run.rounds[0]!.index).toBe(1);
    expect(run.rounds[0]!.answers.map((a) => a.subagentId)).toEqual(["m1", "m2", "m3"]);
    expect(run.rounds[0]!.answers.every((a) => a.status === "pending")).toBe(true);
    expect(useTeamStore.getState().activeRunId).toBe(run.id);
  });

  it("appendRound increments + REUSES round-1 sessions (one thread per member per run)", () => {
    const team = seedTeam();
    const runId = useTeamStore.getState().startRun(team.id, "t").id;
    useTeamStore.getState().patchAnswer(runId, 1, "m1", { sessionId: "sess-m1", status: "completed", text: "ok" });
    const round2 = useTeamStore.getState().appendRound(runId);
    expect(round2.index).toBe(2);
    expect(round2.answers.find((a) => a.subagentId === "m1")?.sessionId).toBe("sess-m1");
    expect(round2.answers.find((a) => a.subagentId === "m2")?.sessionId).toBeNull();
  });

  it("patchAnswer updates one member's slot + persists to localStorage", () => {
    const team = seedTeam();
    const runId = useTeamStore.getState().startRun(team.id, "t").id;
    useTeamStore.getState().patchAnswer(runId, 1, "m2", { status: "streaming", text: "partial" });
    const stored = JSON.parse(localStorage.getItem("onyxagent-teams-v1")!) as {
      runs: Array<{ rounds: Array<{ answers: Array<{ subagentId: string; status: string }> }> }>;
    };
    const answer = stored.runs[0]!.rounds[0]!.answers.find((a) => a.subagentId === "m2")!;
    expect(answer.status).toBe("streaming");
  });

  it("setRoundSynthesis stores the lead's take on the round", () => {
    const team = seedTeam();
    const runId = useTeamStore.getState().startRun(team.id, "t").id;
    useTeamStore.getState().setRoundSynthesis(runId, 1, { agentId: "m1", text: "Consensus: ship." });
    const run = useTeamStore.getState().getRun(runId)!;
    expect(run.rounds[0]!.synthesis).toEqual({ agentId: "m1", text: "Consensus: ship." });
  });

  it("runs prepend (newest first) + deleteRun clears the active pointer", () => {
    const team = seedTeam();
    const r1 = useTeamStore.getState().startRun(team.id, "first").id;
    const r2 = useTeamStore.getState().startRun(team.id, "second").id;
    expect(useTeamStore.getState().runs.map((r) => r.topic)).toEqual(["second", "first"]);
    useTeamStore.getState().deleteRun(r2);
    expect(useTeamStore.getState().runs.map((r) => r.id)).toEqual([r1]);
    expect(useTeamStore.getState().activeRunId).toBeNull();
  });

  it("persists across a fresh hydration (loadFromStorage)", () => {
    const team = seedTeam();
    useTeamStore.getState().startRun(team.id, "durable");
    // Simulate a reload: wipe memory, reload from localStorage.
    useTeamStore.setState({ teams: [], runs: [], activeRunId: null });
    useTeamStore.getState().loadFromStorage();
    expect(useTeamStore.getState().teams[0]!.name).toBe("Council");
    expect(useTeamStore.getState().runs[0]!.topic).toBe("durable");
  });
});

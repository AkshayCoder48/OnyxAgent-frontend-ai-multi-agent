// @vitest-environment jsdom
/**
 * team-runner — the AGENT TEAMS roundtable engine (2026-11-05). The
 * subagent runtime is MOCKED (startSubagentTurn returns controllable
 * deliveries); the team + subagent stores are REAL, so the run ledger and
 * session bookkeeping are exercised end-to-end.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const startTurn = vi.hoisted(() => vi.fn());

vi.mock("@/lib/agent/subagent-runtime", () => ({
  startSubagentTurn: startTurn,
}));

import { buildRoundPrompt, buildSynthesisPrompt, runTeamRound, runTeamSynthesis } from "./team-runner";
import { useTeamStore, type TeamRound } from "@/stores/team-store";
import { useSubagentStore } from "@/stores/subagent-store";

function seedMembers() {
  const store = useSubagentStore.getState();
  const a = store.createSubagent({ name: "Researcher", description: "Finds facts" });
  const b = store.createSubagent({ name: "Skeptic", description: "Challenges claims" });
  return [a, b];
}

function seedTeam(leadId: string | null = null) {
  const [a, b] = seedMembers();
  return { members: [a, b], team: useTeamStore.getState().createTeam({ name: "Council", memberIds: [a.id, b.id], leadId }) };
}

/** A round with one answer per member, text customizable. */
function round(answers: Array<{ id: string; text: string }>): TeamRound {
  return {
    index: 1,
    startedAt: "2026-11-05T00:00:00.000Z",
    answers: answers.map((a) => ({ subagentId: a.id, status: "completed" as const, text: a.text })),
  };
}

beforeEach(() => {
  localStorage.clear();
  startTurn.mockReset();
  useTeamStore.setState({ teams: [], runs: [], activeRunId: null });
  useSubagentStore.setState({ subagents: [], sessions: [], activeSessionId: null });
});

describe("buildRoundPrompt — the roundtable prompts", () => {
  it("round 1 asks for the member's INDEPENDENT take (arena)", () => {
    const prompt = buildRoundPrompt({
      memberName: "Skeptic",
      topic: "Should we rewrite the router?",
      round: 1,
      priorRounds: [],
      teammateNames: [],
    });
    expect(prompt).toContain("round 1");
    expect(prompt).toContain("Should we rewrite the router?");
    expect(prompt).toContain("independent");
    expect(prompt).toContain("Skeptic");
    // no teammates yet — nothing to react to
    expect(prompt).not.toContain("What your teammates answered");
  });

  it("round 2+ embeds the teammates' previous answers BY NAME (cross-visibility)", () => {
    const prompt = buildRoundPrompt({
      memberName: "Skeptic",
      topic: "Ship on Friday?",
      round: 2,
      priorRounds: [round([{ id: "m1", text: "Ship it — tests pass." }, { id: "m2", text: "No rollback plan." }])],
      teammateNames: [
        { id: "m1", name: "Researcher" },
        { id: "m2", name: "Skeptic" },
      ],
    });
    expect(prompt).toContain("round 2");
    expect(prompt).toContain("### Researcher");
    expect(prompt).toContain("Ship it — tests pass.");
    expect(prompt).toContain("Build on the strongest points");
    expect(prompt).toContain("Do not repeat your previous answer");
  });

  it("long teammate answers are clipped to the cross-visibility budget", () => {
    const long = "x".repeat(4_500);
    const prompt = buildRoundPrompt({
      memberName: "Skeptic",
      topic: "t",
      round: 2,
      priorRounds: [round([{ id: "m1", text: long }])],
      teammateNames: [{ id: "m1", name: "Researcher" }],
    });
    expect(prompt).toContain("[truncated]");
    expect(prompt).not.toContain("x".repeat(4_100));
  });

  it("missing teammate answers render an honest placeholder", () => {
    const prompt = buildRoundPrompt({
      memberName: "Skeptic",
      topic: "t",
      round: 2,
      priorRounds: [round([{ id: "m1", text: "" }])],
      teammateNames: [{ id: "m1", name: "Researcher" }],
    });
    expect(prompt).toContain("(no answer)");
  });
});

describe("buildSynthesisPrompt — the lead's consolidation", () => {
  it("carries every round + credits members by name", () => {
    const prompt = buildSynthesisPrompt({
      topic: "Ship on Friday?",
      rounds: [
        round([{ id: "m1", text: "Pro." }, { id: "m2", text: "Con." }]),
        { ...round([{ id: "m1", text: "Middle ground." }]), index: 2 },
      ],
      teammateNames: [
        { id: "m1", name: "Researcher" },
        { id: "m2", name: "Skeptic" },
      ],
    });
    expect(prompt).toContain("Ship on Friday?");
    expect(prompt).toContain("## Round 1");
    expect(prompt).toContain("## Round 2");
    expect(prompt).toContain("### Researcher");
    expect(prompt).toContain("### Skeptic");
    expect(prompt).toContain("Credit members by name");
  });
});

describe("runTeamRound — the fan-out", () => {
  it("starts one turn per member (parallel) with one session each, records answers", async () => {
    const { members, team } = seedTeam();
    startTurn.mockImplementation((_id: string, prompt: string, _f: unknown, sessionId?: string) => ({
      sessionId: sessionId ?? "sess",
      userMessageId: "u",
      assistantMessageId: "a",
      completion: Promise.resolve(`Answer to: ${prompt.slice(0, 20)}`),
    }));

    const run = useTeamStore.getState().startRun(team.id, "The topic");
    await runTeamRound(run.id);

    expect(startTurn).toHaveBeenCalledTimes(2);
    const runAfter = useTeamStore.getState().getRun(run.id)!;
    const r1 = runAfter.rounds[0]!;
    expect(r1.answers.every((a) => a.status === "completed")).toBe(true);
    expect(r1.answers.every((a) => typeof a.text === "string" && a.text.startsWith("Answer to:"))).toBe(true);
    // Round-1 answers minted a session per member (reused in later rounds).
    const sessionIds = r1.answers.map((a) => a.sessionId);
    expect(new Set(sessionIds).size).toBe(2);
    // Each member's prompt is round-1 framed (independent take).
    const prompts = startTurn.mock.calls.map((c) => c[1] as string);
    expect(prompts.every((p) => p.includes("round 1"))).toBe(true);
  });

  it("round 2 REUSES each member's session and embeds the teammates' answers", async () => {
    const { team } = seedTeam();
    startTurn.mockImplementation((_id: string, _prompt: string, _f: unknown, sessionId?: string) => ({
      sessionId: sessionId ?? "sess",
      completion: Promise.resolve("round answer"),
    }));
    const run = useTeamStore.getState().startRun(team.id, "The topic");
    await runTeamRound(run.id);
    const r1Sessions = useTeamStore.getState().getRun(run.id)!.rounds[0]!.answers.map((a) => a.sessionId);

    await runTeamRound(run.id);

    const r2 = useTeamStore.getState().getRun(run.id)!.rounds[1]!;
    expect(r2.index).toBe(2);
    expect(r2.answers.map((a) => a.sessionId)).toEqual(r1Sessions);
    // Round-2 prompts carry cross-visibility.
    const round2Prompts = startTurn.mock.calls.slice(2).map((c) => c[1] as string);
    expect(round2Prompts.every((p) => p.includes("What your teammates answered"))).toBe(true);
  });

  it("a failing member records an honest failed slot — the round still settles", async () => {
    const { members, team } = seedTeam();
    startTurn.mockImplementation((memberId: string) => ({
      sessionId: "s",
      completion:
        memberId === members[0].id
          ? Promise.resolve("(error: provider unreachable)")
          : Promise.resolve("Fine."),
    }));
    const run = useTeamStore.getState().startRun(team.id, "t");
    await runTeamRound(run.id);
    const r1 = useTeamStore.getState().getRun(run.id)!.rounds[0]!;
    expect(r1.answers.find((a) => a.subagentId === members[0].id)!.status).toBe("failed");
    expect(r1.answers.find((a) => a.subagentId === members[1].id)!.status).toBe("completed");
  });
});

describe("runTeamSynthesis — the lead's take", () => {
  it("the designated lead synthesizes; the result lands on the round", async () => {
    const { members, team } = seedTeam();
    useTeamStore.getState().updateTeam(team.id, { leadId: members[1].id });
    startTurn.mockImplementation((_id: string, prompt: string, _f: unknown, sessionId?: string) => ({
      sessionId: sessionId ?? "s",
      completion: Promise.resolve("CONSOLIDATED"),
    }));
    const run = useTeamStore.getState().startRun(team.id, "The topic");
    await runTeamRound(run.id);
    await runTeamSynthesis(run.id);

    // The LEAD (member 2) got the synthesis prompt — 3rd call overall.
    const synthCall = startTurn.mock.calls[2]!;
    expect(synthCall[0]).toBe(members[1].id);
    expect((synthCall[1] as string)).toContain("synthesis");
    const r1 = useTeamStore.getState().getRun(run.id)!.rounds[0]!;
    expect(r1.synthesis).toEqual({ agentId: members[1].id, text: "CONSOLIDATED" });
  });

  it("defaults the lead to the FIRST member", async () => {
    const { members, team } = seedTeam(/* no lead */ null);
    startTurn.mockImplementation(() => ({
      sessionId: "s",
      completion: Promise.resolve("ok"),
    }));
    const run = useTeamStore.getState().startRun(team.id, "t");
    await runTeamRound(run.id);
    await runTeamSynthesis(run.id);
    expect(startTurn.mock.calls[2]![0]).toBe(members[0].id);
  });

  it("a synthesis failure records the honest error text", async () => {
    const { team } = seedTeam();
    startTurn.mockImplementation(() => ({
      sessionId: "s",
      completion: Promise.reject(new Error("lead offline")),
    }));
    const run = useTeamStore.getState().startRun(team.id, "t");
    await runTeamRound(run.id);
    await runTeamSynthesis(run.id);
    const r1 = useTeamStore.getState().getRun(run.id)!.rounds[0]!;
    expect(r1.synthesis?.text).toContain("lead offline");
  });
});

// @vitest-environment jsdom
/**
 * TeamPanel — the AGENT TEAMS arena (2026-11-05). The runner is mocked (the
 * engine has its own suite); the team + subagent stores are REAL, so the
 * builder → roster → composer → arena flow is exercised end-to-end.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

const runner = vi.hoisted(() => ({
  runTeamRound: vi.fn(async () => {}),
  runTeamSynthesis: vi.fn(async () => {}),
}));

vi.mock("@/lib/agent/team-runner", () => runner);

import { TeamPanel } from "./team-panel";
import { useTeamStore } from "@/stores/team-store";
import { useSubagentStore } from "@/stores/subagent-store";

function seedRoster() {
  const store = useSubagentStore.getState();
  const a = store.createSubagent({ name: "Researcher", description: "Facts" });
  const b = store.createSubagent({ name: "Skeptic", description: "Doubt" });
  return [a, b];
}

function renderPanel() {
  const { render } = require("@testing-library/react") as typeof import("@testing-library/react");
  return render(<TeamPanel />);
}

beforeEach(() => {
  localStorage.clear();
  runner.runTeamRound.mockClear();
  runner.runTeamSynthesis.mockClear();
  useTeamStore.setState({ teams: [], runs: [], activeRunId: null });
  useSubagentStore.setState({ subagents: [], sessions: [], activeSessionId: null });
});

describe("TeamPanel — the empty state + builder", () => {
  it("no teams → honest empty state; the builder opens with the + button", () => {
    renderPanel();
    expect(screen.getByText("No teams yet")).toBeInTheDocument();
    // TWO "New team" affordances (header icon button + empty-state CTA) —
    // either opens the builder.
    const buttons = screen.getAllByRole("button", { name: "New team" });
    fireEvent.click(buttons[0]!);
    expect(screen.getByLabelText("Team name")).toBeInTheDocument();
  });

  it("builds a team: name + two members + quick-added member → create", async () => {
    seedRoster();
    renderPanel();
    const buttons = screen.getAllByRole("button", { name: "New team" });
    fireEvent.click(buttons[0]!);

    fireEvent.change(screen.getByLabelText("Team name"), { target: { value: "Council" } });
    // select both roster members
    fireEvent.click(screen.getByText("Researcher"));
    fireEvent.click(screen.getByText("Skeptic"));
    // quick-add a third member
    fireEvent.click(screen.getByText("+ Add a member"));
    fireEvent.change(screen.getByLabelText("New member name"), { target: { value: "Designer" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to roster" }));

    fireEvent.click(screen.getByRole("button", { name: "Create team" }));
    // the selector now shows the team with 3 members
    await waitFor(() => {
      const select = screen.getByLabelText("Team") as HTMLSelectElement;
      expect(select.value).toBe(useTeamStore.getState().teams[0]!.id);
    });
    expect(useTeamStore.getState().teams[0]!.memberIds).toHaveLength(3);
    // the quick-added member became a real subagent
    expect(
      useSubagentStore.getState().subagents.some((s) => s.name === "Designer"),
    ).toBe(true);
  });
});

describe("TeamPanel — the roundtable flow", () => {
  function seededWithTeam() {
    const [a, b] = seedRoster();
    const team = useTeamStore.getState().createTeam({
      name: "Council",
      memberIds: [a.id, b.id],
    });
    return { team, members: [a, b] };
  }

  it("Run roundtable starts a run + calls the engine with the fresh run id", async () => {
    const { team } = seededWithTeam();
    renderPanel();
    fireEvent.change(screen.getByLabelText("Team topic"), {
      target: { value: "Ship on Friday?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run roundtable" }));

    await waitFor(() => expect(runner.runTeamRound).toHaveBeenCalledTimes(1));
    const runId = runner.runTeamRound.mock.calls[0]![0] as string;
    expect(useTeamStore.getState().getRun(runId)?.topic).toBe("Ship on Friday?");
    expect(useTeamStore.getState().getRun(runId)?.teamId).toBe(team.id);
  });

  it("the arena renders the round's member cards with status + live session text", async () => {
    const { team, members } = seededWithTeam();
    // A run whose round 1 is streaming, with a live session for member 1.
    const session = useSubagentStore.getState().createSession(members[0].id, "Team · test");
    useSubagentStore.getState().addMessage(session.id, {
      id: "am1",
      role: "assistant",
      content: "Live streamed answer from Researcher…",
      timestamp: new Date().toISOString(),
      isStreaming: true,
    });
    const run = useTeamStore.getState().startRun(team.id, "The topic");
    useTeamStore.getState().patchAnswer(run.rounds[0]!.index === 1 ? run.id : run.id, 1, members[0].id, {
      status: "streaming",
      sessionId: session.id,
    });
    useTeamStore.getState().patchAnswer(run.id, 1, members[1].id, { status: "pending" });

    renderPanel();
    // round header + both member cards (the roster chip ALSO shows the
    // name — the member name appears at least twice)
    expect(screen.getByText("Round 1")).toBeInTheDocument();
    expect(screen.getAllByText("Researcher").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Skeptic").length).toBeGreaterThanOrEqual(2);
    // the LIVE session text renders in the streaming card
    expect(screen.getByText(/Live streamed answer from Researcher/)).toBeInTheDocument();
    expect(screen.getByText("Waiting…")).toBeInTheDocument();
  });

  it("the synthesis card renders once the lead has synthesized", () => {
    const { team, members } = seededWithTeam();
    const run = useTeamStore.getState().startRun(team.id, "The topic");
    useTeamStore.getState().patchAnswer(run.id, 1, members[0].id, { status: "completed", text: "Pro." });
    useTeamStore.getState().patchAnswer(run.id, 1, members[1].id, { status: "completed", text: "Con." });
    useTeamStore.getState().setRoundSynthesis(run.id, 1, {
      agentId: members[0].id,
      text: "Consensus: ship with a rollback plan.",
    });

    renderPanel();
    expect(screen.getByText(/Consensus: ship with a rollback plan/)).toBeInTheDocument();
    expect(screen.getByText(/^Synthesis · Researcher$/)).toBeInTheDocument();
  });

  it("Synthesize is gated until a round has a completed answer", () => {
    seededWithTeam();
    renderPanel();
    const synth = screen.getByRole("button", { name: /synthesize/i });
    expect(synth).toBeDisabled();
  });
});

describe("TeamPanel — wiring into the workspace", () => {
  it("SOURCE PIN: the panel is docked + menu-reachable (the latency-fix idiom)", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const src = readFileSync(
      join(process.cwd(), "src/components/chat/chat-workspace.tsx"),
      "utf8",
    );
    expect(src).toContain('"team" | null');
    expect(src).toContain('toggleSidePanel("team")');
    expect(src).toContain('id="team-panel"');
    expect(src).toContain("<TeamPanel />");
    expect(src).toContain('team: { storageKey: "team-panel-width"');
  });
});

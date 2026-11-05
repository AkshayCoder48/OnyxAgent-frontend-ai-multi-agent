"use client";

/**
 * team-runner — the AGENT TEAMS / ROUNDTABLE engine (2026-11-05).
 *
 * Reuses the subagent machinery end-to-end: every member turn is a
 * startSubagentTurn into the member's OWN session for the run (one coherent
 * thread per member), so members keep their provider/model/system prompt,
 * their tools, the HITL approval gate, and live streaming in the Subagent
 * sidebar. This module adds the roundtable semantics on top:
 *
 *   • ROUND 1 — every member answers the topic independently (arena).
 *   • ROUND 2+ — every member's prompt embeds the teammates' previous
 *     answers (cross-visibility: agree, challenge, refine).
 *   • SYNTHESIS — the team's lead (leadId ?? first member) gets every
 *     round's answers and writes the consolidated take.
 *
 * Answers are recorded into the team store as they settle (status
 * pending → streaming → completed/failed), so the panel renders live
 * progress and the ledger survives refresh.
 */

import { useTeamStore, type TeamRound, type TeamRun } from "@/stores/team-store";
import { useSubagentStore } from "@/stores/subagent-store";

/** How much of each teammate's answer rides into cross-visibility prompts. */
const CROSS_VISIBILITY_CHAR_BUDGET = 4_000;

/**
 * The prompt ONE member receives for a round. Round 1: the topic + the
 * member's framing. Later rounds: the topic + what each teammate answered
 * last round (cross-visibility), with instructions to engage with them.
 * Pure function (unit-pinned).
 */
export function buildRoundPrompt(input: {
  memberName: string;
  topic: string;
  round: number;
  priorRounds: TeamRound[];
  teammateNames: Array<{ id: string; name: string }>;
}): string {
  const { memberName, topic, round, priorRounds, teammateNames } = input;
  const nameOf = (id: string) => teammateNames.find((t) => t.id === id)?.name ?? "teammate";

  const lines: string[] = [];
  lines.push(
    `# Team roundtable — round ${round}`,
    "",
    `You are "${memberName}", one member of a team discussing this topic:`,
    "",
    `> ${topic}`,
    "",
  );

  const lastRound = priorRounds[priorRounds.length - 1];
  if (lastRound && round > 1) {
    lines.push(
      `## What your teammates answered in round ${lastRound.index}`,
      "",
    );
    for (const answer of lastRound.answers) {
      const text = (answer.text ?? "").trim();
      if (!text) {
        lines.push(`### ${nameOf(answer.subagentId)}`, "(no answer)", "");
        continue;
      }
      const clipped = text.length > CROSS_VISIBILITY_CHAR_BUDGET
        ? `${text.slice(0, CROSS_VISIBILITY_CHAR_BUDGET)}… [truncated]`
        : text;
      lines.push(`### ${nameOf(answer.subagentId)}`, "", clipped, "");
    }
    lines.push(
      "## Your task this round",
      "",
      "Build on the strongest points, challenge what you disagree with, and refine your own position. Do not repeat your previous answer — advance it. Answer in your own voice, as a peer in the discussion.",
    );
  } else {
    lines.push(
      "## Your task",
      "",
      "Give YOUR independent take on the topic — your specialty's perspective, your honest opinion, concrete where possible. Other members are answering the same topic in parallel; this is round 1, so answer as you see it.",
    );
  }
  return lines.join("\n");
}

/**
 * The synthesis prompt for the team lead: the topic + every round's
 * answers. Pure function (unit-pinned).
 */
export function buildSynthesisPrompt(input: {
  topic: string;
  rounds: TeamRound[];
  teammateNames: Array<{ id: string; name: string }>;
}): string {
  const { topic, rounds, teammateNames } = input;
  const nameOf = (id: string) => teammateNames.find((t) => t.id === id)?.name ?? "teammate";
  const lines: string[] = [
    "# Team roundtable — synthesis",
    "",
    "You are the team lead. Synthesize the discussion below into ONE consolidated answer for the user:",
    "",
    `> ${topic}`,
    "",
    "Include where the team agreed, the strongest dissenting points worth keeping, and a clear recommendation. Credit members by name. Be concise — this is the takeaway, not a transcript.",
    "",
  ];
  for (const round of rounds) {
    lines.push(`## Round ${round.index}`, "");
    for (const answer of round.answers) {
      const text = (answer.text ?? "").trim();
      if (!text) continue;
      const clipped = text.length > CROSS_VISIBILITY_CHAR_BUDGET
        ? `${text.slice(0, CROSS_VISIBILITY_CHAR_BUDGET)}… [truncated]`
        : text;
      lines.push(`### ${nameOf(answer.subagentId)}`, "", clipped, "");
    }
  }
  return lines.join("\n");
}

/** The member sessions' titles (for read_chat + the sidebar). */
function runTitle(run: TeamRun): string {
  const clipped = run.topic.length > 40 ? `${run.topic.slice(0, 40)}…` : run.topic;
  return `Team · ${clipped}`;
}

/**
 * Run ONE round: fan out a turn per member (parallel), record each answer
 * as it settles. The member's session is created at round 1 and reused, so
 * every round appends to the same thread. NEVER throws — member failures
 * are recorded per-answer.
 */
export async function runTeamRound(runId: string): Promise<void> {
  const store = useTeamStore.getState();
  const run = store.getRun(runId);
  if (!run) return;
  const team = store.teams.find((t) => t.id === run.teamId);
  if (!team || team.memberIds.length === 0) return;

  // The round to run: startRun MINTS round 1 with pending slots (so the UI
  // can show the roster before the turns start) — use it when it is still
  // untouched; otherwise (round 2+, or a resumed round) append the next one.
  const last = run.rounds[run.rounds.length - 1];
  const isUntouched = last && last.answers.every((a) => a.status === "pending" && !a.sessionId);
  const round = isUntouched ? last! : useTeamStore.getState().appendRound(runId);
  const priorRounds = isUntouched
    ? run.rounds.slice(0, run.rounds.length - 1)
    : run.rounds;

  const subagents = useSubagentStore.getState();
  const teammateNames = team.memberIds.map((id) => ({
    id,
    name: subagents.getSubagent(id)?.name ?? "Member",
  }));

  const { startSubagentTurn } = await import("@/lib/agent/subagent-runtime");

  await Promise.all(
    team.memberIds.map(async (memberId) => {
      const member = subagents.getSubagent(memberId);
      if (!member) {
        useTeamStore.getState().patchAnswer(runId, round.index, memberId, {
          status: "failed",
          error: "Member not found (deleted?).",
        });
        return;
      }
      try {
        // One session per member per RUN (round 1 mints it via the answer
        // slot; later rounds reuse it from the run's earlier rounds).
        const existingSessionId =
          priorRounds.flatMap((r) => r.answers).find((a) => a.subagentId === memberId)?.sessionId ?? null;
        let sessionId = existingSessionId;
        if (!sessionId) {
          const session = useSubagentStore.getState().createSession(memberId, runTitle(run));
          sessionId = session.id;
        }
        useTeamStore.getState().patchAnswer(runId, round.index, memberId, {
          status: "streaming",
          sessionId,
        });

        const prompt = buildRoundPrompt({
          memberName: member.name,
          topic: run.topic,
          round: round.index,
          priorRounds,
          teammateNames,
        });

        const delivery = startSubagentTurn(memberId, prompt, undefined, sessionId);
        // completion never rejects (error text resolves instead).
        const text = await delivery.completion;
        const failed = !text.trim() || /^\(error/i.test(text.trim());
        useTeamStore.getState().patchAnswer(runId, round.index, memberId, {
          status: failed ? "failed" : "completed",
          text,
          error: failed ? text.slice(0, 200) || "Empty response" : null,
        });
      } catch (e) {
        useTeamStore.getState().patchAnswer(runId, round.index, memberId, {
          status: "failed",
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }),
  );
}

/**
 * Run the synthesis: the team's lead (leadId ?? first member) answers the
 * synthesis prompt in ITS session; the result is stored on the round.
 */
export async function runTeamSynthesis(runId: string): Promise<void> {
  const store = useTeamStore.getState();
  const run = store.getRun(runId);
  if (!run || run.rounds.length === 0) return;
  const team = store.teams.find((t) => t.id === run.teamId);
  if (!team || team.memberIds.length === 0) return;

  const leadId = team.leadId && team.memberIds.includes(team.leadId)
    ? team.leadId
    : team.memberIds[0]!;
  const round = run.rounds[run.rounds.length - 1]!;
  const subagents = useSubagentStore.getState();
  const lead = subagents.getSubagent(leadId);
  if (!lead) return;

  const teammateNames = team.memberIds.map((id) => ({
    id,
    name: subagents.getSubagent(id)?.name ?? "Member",
  }));
  const prompt = buildSynthesisPrompt({ topic: run.topic, rounds: run.rounds, teammateNames });

  try {
    const sessionId = round.answers.find((a) => a.subagentId === leadId)?.sessionId ?? undefined;
    const { startSubagentTurn } = await import("@/lib/agent/subagent-runtime");
    const delivery = startSubagentTurn(leadId, prompt, undefined, sessionId ?? undefined);
    const text = await delivery.completion;
    useTeamStore.getState().setRoundSynthesis(runId, round.index, {
      agentId: leadId,
      text,
    });
  } catch (e) {
    useTeamStore.getState().setRoundSynthesis(runId, round.index, {
      agentId: leadId,
      text: `(synthesis failed: ${e instanceof Error ? e.message : String(e)})`,
    });
  }
}
